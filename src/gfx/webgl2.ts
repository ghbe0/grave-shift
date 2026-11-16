// WebGL2 fallback. Same instanced PBR lighting, material layers, sun shadow, sky and colour grade
// as the WebGPU path, drawn straight to the canvas (browser MSAA). No bloom, motion blur or DoF.
import { flatMaterial, INSTANCE_FLOATS, LIGHT_FLOATS, MAT_LAYERS, matBytes, matMips, matOffset, MAX_LIGHTS, VERTEX_FLOATS, VIEWMODEL_DEPTH, type Frame, type MeshData, type Quality, type Renderer } from './renderer';

const GRADE = `
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float hash2(vec2 p) { vec2 q = fract(p * vec2(443.897, 441.423)); q += dot(q, q.yx + 19.19); return fract((q.x + q.y) * q.x); }
vec3 grade(vec3 c, float exposure, vec4 g) {
  c = aces(c * exposure);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, g.y);
  c = mix(c, c * vec3(0.92, 1.0, 1.08), (1.0 - smoothstep(0.0, 0.45, luma)) * 0.6);
  c = mix(c, c * vec3(1.06, 1.0, 0.92), smoothstep(0.5, 1.0, luma) * 0.5);
  c = clamp(c, 0.0, 1.0);
  c = mix(c, c * c * (3.0 - 2.0 * c), g.z);
  vec3 o = pow(c, vec3(1.0 / 2.2));
  o += (hash2(gl_FragCoord.xy + fract(g.w * 7.13) * 917.0) - 0.5) * g.x * (1.0 - abs(luma * 2.0 - 1.0));
  return o;
}`;

const VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNormal; layout(location=2) in vec2 aUv;
layout(location=3) in vec4 m0; layout(location=4) in vec4 m1; layout(location=5) in vec4 m2; layout(location=6) in vec4 m3;
layout(location=7) in vec4 aColor; layout(location=8) in vec4 aParams;
uniform mat4 uViewProj, uViewmodelProj, uShadowViewProj;
uniform bool uShadowPass;
out vec3 vWorld; out vec3 vNormal; out vec2 vUv; out vec4 vColor; flat out vec4 vParams; out vec3 vLocal; out vec3 vLocalNormal;
flat out vec3 vN0; flat out vec3 vN1; flat out vec3 vN2;
void main() {
  vec3 world = m0.xyz * aPos.x + m1.xyz * aPos.y + m2.xyz * aPos.z + m3.xyz;
  vN0 = m0.xyz / dot(m0.xyz, m0.xyz); vN1 = m1.xyz / dot(m1.xyz, m1.xyz); vN2 = m2.xyz / dot(m2.xyz, m2.xyz);
  vNormal = vN0 * aNormal.x + vN1 * aNormal.y + vN2 * aNormal.z;
  vWorld = world; vUv = aUv; vColor = aColor; vParams = aParams; vLocalNormal = aNormal;
  vLocal = aPos * vec3(length(m0.xyz), length(m1.xyz), length(m2.xyz));
  vec4 clip;
  if (uShadowPass) {
    clip = uShadowViewProj * vec4(world, 1.0);
  } else if ((int(aParams.w) & 2) != 0) {
    clip = uViewmodelProj * vec4(world, 1.0);
    clip.z *= ${VIEWMODEL_DEPTH};
  } else {
    clip = uViewProj * vec4(world, 1.0);
    clip.z = clip.z * ${1 - VIEWMODEL_DEPTH} + ${VIEWMODEL_DEPTH} * clip.w;
  }
  // Matrices use a 0..1 depth range; GL clip space wants -1..1.
  clip.z = clip.z * 2.0 - clip.w;
  gl_Position = clip;
}`;

const FS = `#version 300 es
precision highp float; precision highp sampler2DShadow; precision highp sampler2DArray;
in vec3 vWorld; in vec3 vNormal; in vec2 vUv; in vec4 vColor; flat in vec4 vParams; in vec3 vLocal; in vec3 vLocalNormal;
flat in vec3 vN0; flat in vec3 vN1; flat in vec3 vN2;
uniform mat4 uShadowViewProj;
uniform vec3 uCamPos, uSunDir, uSunColor, uSky;
uniform float uFog, uExposure, uShadowTexel;
uniform vec4 uGrade;
uniform bool uShadowPass;
uniform int uLightCount;
uniform vec4 uLights[${MAX_LIGHTS * 3}];
uniform vec4 uTiles[5];
uniform sampler2D uBase;
uniform sampler2DShadow uShadow;
uniform sampler2DArray uMatSurface, uMatDetail;
out vec4 outColor;
const float PI = 3.14159265;
${GRADE}
vec3 brdf(vec3 n, vec3 v, vec3 l, vec3 albedo, float metallic, float rough) {
  vec3 h = normalize(v + l);
  float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 f = f0 + (1.0 - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  float a2 = pow(rough, 4.0), d = nh * nh * (a2 - 1.0) + 1.0, k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float D = a2 / (PI * d * d), G = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
  return ((1.0 - f) * (1.0 - metallic) * albedo / PI + D * G * f / (4.0 * nv * nl + 1e-3)) * nl;
}
vec3 unpackN(vec4 d) { vec2 xy = d.xy * 2.0 - 1.0; return vec3(xy, sqrt(max(1.0 - dot(xy, xy), 0.0))); }
void main() {
  if (uShadowPass) { outColor = vec4(1.0); return; }
  int flags = int(vParams.w);
  int layer = int(round(vColor.a)) - 1;
  vec3 v = normalize(uCamPos - vWorld);
  vec3 albedo = vColor.rgb * pow(texture(uBase, vUv).rgb, vec3(2.2));
  float metallic = vParams.x, rough = vParams.y, ao = 1.0;
  vec3 n = normalize(vNormal);
  if (layer >= 0) {
    float scale = 1.0 / uTiles[layer / 4][layer % 4];
    vec3 ln = normalize(vLocalNormal);
    vec3 w = pow(abs(ln), vec3(4.0)); w /= w.x + w.y + w.z;
    vec3 ux = vec3(vLocal.zy * scale, float(layer)), uy = vec3(vLocal.xz * scale, float(layer)), uz = vec3(vLocal.xy * scale, float(layer));
    vec4 s = texture(uMatSurface, ux) * w.x + texture(uMatSurface, uy) * w.y + texture(uMatSurface, uz) * w.z;
    vec4 dx = texture(uMatDetail, ux), dy = texture(uMatDetail, uy), dz = texture(uMatDetail, uz);
    vec4 d = dx * w.x + dy * w.y + dz * w.z;
    vec3 tx = unpackN(dx), ty = unpackN(dy), tz = unpackN(dz);
    vec3 nx = vec3(tx.xy + ln.zy, abs(tx.z) * ln.x), ny = vec3(ty.xy + ln.xz, abs(ty.z) * ln.y), nz = vec3(tz.xy + ln.xy, abs(tz.z) * ln.z);
    vec3 pn = normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
    albedo = vColor.rgb * s.rgb;
    rough = s.a * vParams.y;
    metallic = d.b;
    ao = d.a;
    n = normalize(vN0 * pn.x + vN1 * pn.y + vN2 * pn.z);
  }
  rough = clamp(rough, 0.05, 1.0);
  if (dot(n, v) < 0.0) n = normalize(n + v * (0.01 - dot(n, v)));
  float shadow = 1.0;
  if ((flags & 4) == 0) {
    vec4 p = uShadowViewProj * vec4(vWorld + normalize(vNormal) * 0.05, 1.0);
    vec3 sc = vec3(p.xy * 0.5 + 0.5, p.z - 0.0012);
    if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) {
      shadow = 0.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) shadow += texture(uShadow, sc + vec3(vec2(x, y) * uShadowTexel * 1.5, 0.0));
      shadow /= 9.0;
    }
  }
  vec3 color = brdf(n, v, uSunDir, albedo, metallic, rough) * uSunColor * 3.0 * shadow;
  for (int k = 0; k < uLightCount; k++) {
    vec4 pr = uLights[k * 3], col = uLights[k * 3 + 1], dc = uLights[k * 3 + 2];
    vec3 to = pr.xyz - vWorld; float d = length(to);
    if (d > pr.w) continue;
    vec3 l = to / max(d, 1e-4); float x = d / pr.w;
    float atten = (1.0 - x * x) * (1.0 - x * x) / (1.0 + d * d);
    if (dc.w > 0.0) atten *= smoothstep(dc.w, mix(dc.w, 1.0, 0.35), dot(-l, dc.xyz));
    color += brdf(n, v, l, albedo, metallic, rough) * col.rgb * col.w * atten;
  }
  vec3 hemi = mix(uSky * vec3(0.2, 0.18, 0.17), uSky * 0.75, n.y * 0.5 + 0.5);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 fres = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0) * (1.0 - rough);
  vec3 r = reflect(-v, n);
  vec3 env = mix(uSky * 0.3, uSky * 1.4, clamp(r.y * 0.5 + 0.5, 0.0, 1.0));
  color += (albedo * (1.0 - metallic) * hemi * 0.7 + env * fres * (1.0 - rough * 0.7)) * ao;
  color += vColor.rgb * vParams.z * (layer >= 0 ? albedo * 2.0 / max(vColor.rgb, vec3(1e-3)) : texture(uBase, vUv).rgb);
  if ((flags & 2) == 0) {
    float fogAmount = (1.0 - exp(-length(uCamPos - vWorld) * uFog)) * mix(1.0, 0.55, clamp(vWorld.y / 8.0, 0.0, 1.0));
    color = mix(color, uSky, fogAmount);
  }
  outColor = vec4(grade(color, uExposure, uGrade), 1.0);
}`;

const SKY_VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0); }`;
const SKY_FS = `#version 300 es
precision highp float;
uniform mat4 uInvViewProj; uniform vec3 uCamPos, uSunDir, uSunColor, uSky; uniform vec2 uSize; uniform float uExposure, uTime; uniform vec4 uGrade;
out vec4 outColor;
${GRADE}
void main() {
  vec2 ndc = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec4 far = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCamPos);
  float up = dir.y;
  vec3 zenith = uSky * vec3(0.35, 0.42, 0.62);
  vec3 c = mix(uSky, zenith, smoothstep(0.0, 0.6, up));
  c = mix(c, uSky * 0.45, smoothstep(0.0, -0.25, up));
  float sd = max(dot(dir, uSunDir), 0.0);
  c += uSunColor * (pow(sd, 6.0) * 0.35 + pow(sd, 64.0) * 1.2) + uSunColor * smoothstep(0.9993, 0.9997, sd) * 30.0;
  if (up > 0.02) {
    vec2 p = dir.xz / (up + 0.08) * 0.7 + vec2(uTime * 0.004, 0.0);
    float n = sin(p.x * 1.7 + sin(p.y * 1.3)) * 0.5 + sin(p.y * 3.1 + sin(p.x * 2.3 + 1.7)) * 0.25 + sin((p.x + p.y) * 6.3 + 0.5) * 0.125;
    c = mix(c, uSky * 1.15 + uSunColor * pow(sd, 3.0) * 0.4, smoothstep(0.15, 0.7, n) * smoothstep(0.02, 0.25, up) * 0.55);
  }
  outColor = vec4(grade(c, uExposure, uGrade), 1.0);
}`;

interface GlMesh { vao: WebGLVertexArrayObject; count: number; type: number; texture: WebGLTexture }

export class WebGL2Renderer implements Renderer {
  readonly kind = 'webgl2' as const;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private skyProgram: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private su: Record<string, WebGLUniformLocation | null> = {};
  private meshes: GlMesh[] = [];
  private instanceBuf: WebGLBuffer;
  private instanceCap = 0;
  private shadowFbo: WebGLFramebuffer;
  private shadowTex: WebGLTexture;
  private white: WebGLTexture;
  private matSurface: WebGLTexture | null = null;
  private matDetail: WebGLTexture | null = null;
  private matSize = 0;
  private tiles = new Float32Array(20).fill(2);
  private emptyVao: WebGLVertexArrayObject;
  private size: [number, number] = [1, 1];

  constructor(canvas: HTMLCanvasElement, private quality: Quality) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser supports neither WebGPU nor WebGL2');
    this.gl = gl;
    const link = (vs: string, fs: string) => {
      const compile = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
        return s;
      };
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed');
      return p;
    };
    this.program = link(VS, FS);
    this.skyProgram = link(SKY_VS, SKY_FS);
    for (const name of ['uViewProj', 'uViewmodelProj', 'uShadowViewProj', 'uShadowPass', 'uCamPos', 'uSunDir', 'uSunColor', 'uSky', 'uFog', 'uExposure', 'uShadowTexel', 'uLightCount', 'uLights', 'uBase', 'uShadow', 'uGrade', 'uTiles', 'uMatSurface', 'uMatDetail']) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    for (const name of ['uInvViewProj', 'uCamPos', 'uSunDir', 'uSunColor', 'uSky', 'uSize', 'uExposure', 'uTime', 'uGrade']) this.su[name] = gl.getUniformLocation(this.skyProgram, name);
    this.emptyVao = gl.createVertexArray()!;
    this.instanceBuf = gl.createBuffer()!;
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

    this.setMaterialQuality(quality.textureSize, quality.anisotropy);

    const s = quality.shadowSize;
    this.shadowTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, s, s, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LESS);
    this.shadowFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DEPTH_TEST);
    this.resize(canvas.width, canvas.height);
  }

  setMaterialQuality(size: number, anisotropy: number): void {
    const gl = this.gl;
    if (this.matSurface) gl.deleteTexture(this.matSurface);
    if (this.matDetail) gl.deleteTexture(this.matDetail);
    this.matSize = size;
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    const maxAniso = ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number : 1;
    const matTex = (format: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, matMips(size), format, size, size, MAT_LAYERS);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (ext) gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.max(1, Math.min(maxAniso, anisotropy)));
      return t;
    };
    this.matSurface = matTex(gl.SRGB8_ALPHA8);
    this.matDetail = matTex(gl.RGBA8);
    const flat = flatMaterial(size);
    for (let layer = 0; layer < MAT_LAYERS; layer++) this.uploadLayer(layer, flat);
  }

  private uploadLayer(layer: number, data: Uint8Array): void {
    const gl = this.gl;
    const size = this.matSize;
    for (const [map, tex] of [[0, this.matSurface], [1, this.matDetail]] as const) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      for (let level = 0; level < matMips(size); level++) {
        const s = size >> level;
        const off = matOffset(map, level, size);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, s, s, 1, gl.RGBA, gl.UNSIGNED_BYTE, data.subarray(off, off + s * s * 4));
      }
    }
  }

  setMaterial(layer: number, data: Uint8Array, tile: number): void {
    if (layer < 0 || layer >= MAT_LAYERS || data.length !== matBytes(this.matSize)) return;
    this.uploadLayer(layer, data);
    this.tiles[layer] = tile;
  }

  createMesh(data: MeshData): number {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    const stride = VERTEX_FLOATS * 4;
    [[0, 3, 0], [1, 3, 12], [2, 2, 24]].forEach(([loc, size, off]) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off); });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    for (let i = 0; i < 6; i++) {
      gl.enableVertexAttribArray(3 + i);
      gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(3 + i, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    let texture = this.white;
    if (data.texture) {
      texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.meshes.push({ vao, count: data.indices.length, type: data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, texture });
    return this.meshes.length - 1;
  }

  resize(width: number, height: number): void { this.size = [Math.max(1, width), Math.max(1, height)]; }

  render(f: Frame): void {
    const gl = this.gl, u = this.u;
    const gradeVec = [this.quality.post ? f.post.grain : 0, f.post.saturation, f.post.contrast, f.post.time] as const;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const data = f.instances.subarray(0, f.instanceCount * INSTANCE_FLOATS);
    if (f.instanceCount > this.instanceCap) {
      this.instanceCap = Math.max(4096, f.instanceCount * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceCap * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);

    gl.uniformMatrix4fv(u.uViewProj, false, f.viewProj);
    gl.uniformMatrix4fv(u.uViewmodelProj, false, f.viewmodelProj);
    gl.uniformMatrix4fv(u.uShadowViewProj, false, f.shadowViewProj);
    gl.uniform3f(u.uCamPos, f.camPos[0], f.camPos[1], f.camPos[2]);
    gl.uniform3f(u.uSunDir, f.sunDir[0], f.sunDir[1], f.sunDir[2]);
    gl.uniform3f(u.uSunColor, f.sunColor[0], f.sunColor[1], f.sunColor[2]);
    gl.uniform3f(u.uSky, f.sky[0], f.sky[1], f.sky[2]);
    gl.uniform1f(u.uFog, f.fog);
    gl.uniform1f(u.uExposure, f.post.exposure);
    gl.uniform4f(u.uGrade, ...gradeVec);
    gl.uniform1f(u.uShadowTexel, 1 / this.quality.shadowSize);
    gl.uniform1i(u.uLightCount, Math.min(f.lightCount, MAX_LIGHTS));
    gl.uniform4fv(u.uLights, f.lights.subarray(0, MAX_LIGHTS * LIGHT_FLOATS));
    gl.uniform4fv(u.uTiles, this.tiles);
    gl.uniform1i(u.uBase, 0);
    gl.uniform1i(u.uShadow, 1);
    gl.uniform1i(u.uMatSurface, 2);
    gl.uniform1i(u.uMatDetail, 3);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.matSurface);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.matDetail);

    const drawAll = (shadow: boolean) => {
      for (const dr of f.draws) {
        if ((shadow && !dr.shadow) || !dr.count) continue;
        const m = this.meshes[dr.mesh];
        if (!m) continue;
        gl.bindVertexArray(m.vao);
        // Instance attributes are re-pointed per draw so each range starts at its first instance.
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
        for (let i = 0; i < 6; i++) gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, dr.first * INSTANCE_FLOATS * 4 + i * 16);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, m.texture);
        gl.drawElementsInstanced(gl.TRIANGLES, m.count, m.type, 0, dr.count);
      }
    };

    // Sun shadow map. Nothing samples the depth texture while it is the render target.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, this.quality.shadowSize, this.quality.shadowSize);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 2);
    gl.uniform1i(u.uShadowPass, 1);
    drawAll(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sky first, at the far plane, without writing depth.
    gl.useProgram(this.skyProgram);
    const su = this.su;
    gl.uniformMatrix4fv(su.uInvViewProj, false, f.invViewProj);
    gl.uniform3f(su.uCamPos, f.camPos[0], f.camPos[1], f.camPos[2]);
    gl.uniform3f(su.uSunDir, f.sunDir[0], f.sunDir[1], f.sunDir[2]);
    gl.uniform3f(su.uSunColor, f.sunColor[0], f.sunColor[1], f.sunColor[2]);
    gl.uniform3f(su.uSky, f.sky[0], f.sky[1], f.sky[2]);
    gl.uniform2f(su.uSize, this.size[0], this.size[1]);
    gl.uniform1f(su.uExposure, f.post.exposure);
    gl.uniform1f(su.uTime, f.post.time);
    gl.uniform4f(su.uGrade, ...gradeVec);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);

    gl.useProgram(this.program);
    gl.enable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(u.uShadowPass, 0);
    drawAll(false);
    gl.bindVertexArray(null);
  }
}
