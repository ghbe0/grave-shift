// WebGL2 fallback. Same instanced PBR lighting and sun shadow as the WebGPU path, drawn straight
// to the canvas with tone mapping in the fragment shader. No bloom, motion blur or depth of field.
import { INSTANCE_FLOATS, LIGHT_FLOATS, MAX_LIGHTS, VERTEX_FLOATS, VIEWMODEL_DEPTH, type Frame, type MeshData, type Quality, type Renderer } from './renderer';

const VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNormal; layout(location=2) in vec2 aUv;
layout(location=3) in vec4 m0; layout(location=4) in vec4 m1; layout(location=5) in vec4 m2; layout(location=6) in vec4 m3;
layout(location=7) in vec4 aColor; layout(location=8) in vec4 aParams;
uniform mat4 uViewProj, uViewmodelProj, uShadowViewProj;
uniform bool uShadowPass;
out vec3 vWorld; out vec3 vNormal; out vec2 vUv; out vec4 vColor; flat out vec4 vParams; out vec3 vLocal;
void main() {
  vec3 world = m0.xyz * aPos.x + m1.xyz * aPos.y + m2.xyz * aPos.z + m3.xyz;
  vNormal = m0.xyz * (aNormal.x / dot(m0.xyz, m0.xyz)) + m1.xyz * (aNormal.y / dot(m1.xyz, m1.xyz)) + m2.xyz * (aNormal.z / dot(m2.xyz, m2.xyz));
  vWorld = world; vUv = aUv; vColor = aColor; vParams = aParams;
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
precision highp float; precision highp sampler2DShadow;
in vec3 vWorld; in vec3 vNormal; in vec2 vUv; in vec4 vColor; flat in vec4 vParams; in vec3 vLocal;
uniform mat4 uShadowViewProj;
uniform vec3 uCamPos, uSunDir, uSunColor, uSky;
uniform float uFog, uExposure, uShadowTexel;
uniform bool uShadowPass;
uniform int uLightCount;
uniform vec4 uLights[${MAX_LIGHTS * 3}];
uniform sampler2D uBase;
uniform sampler2DShadow uShadow;
out vec4 outColor;
const float PI = 3.14159265;
vec3 brdf(vec3 n, vec3 v, vec3 l, vec3 albedo, float metallic, float rough) {
  vec3 h = normalize(v + l);
  float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 f = f0 + (1.0 - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  float a2 = pow(rough, 4.0), d = nh * nh * (a2 - 1.0) + 1.0, k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float D = a2 / (PI * d * d), G = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
  return ((1.0 - f) * (1.0 - metallic) * albedo / PI + D * G * f / (4.0 * nv * nl + 1e-3)) * nl;
}
float grid(vec3 local, vec3 n) {
  vec3 an = abs(n);
  vec2 c = an.x > an.y && an.x > an.z ? local.zy : (an.z > an.y ? local.xy : local.xz);
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-4));
  return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
}
void main() {
  if (uShadowPass) { outColor = vec4(1.0); return; }
  int flags = int(vParams.w);
  vec3 n = normalize(vNormal), v = normalize(uCamPos - vWorld);
  vec3 tex = texture(uBase, vUv).rgb;
  vec3 albedo = vColor.rgb * pow(tex, vec3(2.2));
  if ((flags & 1) != 0) albedo = mix(albedo, albedo * 0.55, grid(vLocal, n));
  float metallic = vParams.x, rough = clamp(vParams.y, 0.06, 1.0);
  float shadow = 1.0;
  if ((flags & 4) == 0) {
    vec4 p = uShadowViewProj * vec4(vWorld + n * 0.06, 1.0);
    vec3 s = vec3(p.xy * 0.5 + 0.5, p.z - 0.0015);
    if (s.x > 0.0 && s.x < 1.0 && s.y > 0.0 && s.y < 1.0 && s.z < 1.0) {
      shadow = 0.0;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) shadow += texture(uShadow, s + vec3(vec2(x, y) * uShadowTexel, 0.0));
      shadow /= 9.0;
    }
  }
  vec3 color = brdf(n, v, uSunDir, albedo, metallic, rough) * uSunColor * 3.2 * shadow;
  for (int k = 0; k < uLightCount; k++) {
    vec4 pr = uLights[k * 3], col = uLights[k * 3 + 1], dc = uLights[k * 3 + 2];
    vec3 to = pr.xyz - vWorld; float d = length(to);
    if (d > pr.w) continue;
    vec3 l = to / max(d, 1e-4); float x = d / pr.w;
    float atten = (1.0 - x * x) * (1.0 - x * x) / (1.0 + d * d);
    if (dc.w > 0.0) atten *= smoothstep(dc.w, mix(dc.w, 1.0, 0.35), dot(-l, dc.xyz));
    color += brdf(n, v, l, albedo, metallic, rough) * col.rgb * col.w * atten;
  }
  color += albedo * mix(uSky * 0.25, uSky, n.y * 0.5 + 0.5) * (1.0 - metallic * 0.6) * 0.55;
  color += vColor.rgb * vParams.z;
  if ((flags & 2) == 0) color = mix(color, uSky, 1.0 - exp(-length(uCamPos - vWorld) * uFog));
  color *= uExposure;
  color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(color, vec3(1.0 / 2.2)), 1.0);
}`;

interface GlMesh { vao: WebGLVertexArrayObject; count: number; type: number; texture: WebGLTexture }

export class WebGL2Renderer implements Renderer {
  readonly kind = 'webgl2' as const;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private meshes: GlMesh[] = [];
  private instanceBuf: WebGLBuffer;
  private instanceCap = 0;
  private shadowFbo: WebGLFramebuffer;
  private shadowTex: WebGLTexture;
  private white: WebGLTexture;
  private size: [number, number] = [1, 1];

  constructor(canvas: HTMLCanvasElement, private quality: Quality) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser supports neither WebGPU nor WebGL2');
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
      return s;
    };
    const p = (this.program = gl.createProgram()!);
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed');
    for (const name of ['uViewProj', 'uViewmodelProj', 'uShadowViewProj', 'uShadowPass', 'uCamPos', 'uSunDir', 'uSunColor', 'uSky', 'uFog', 'uExposure', 'uShadowTexel', 'uLightCount', 'uLights', 'uBase', 'uShadow']) {
      this.u[name] = gl.getUniformLocation(p, name);
    }
    this.instanceBuf = gl.createBuffer()!;
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

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
    gl.uniform1f(u.uShadowTexel, 1 / this.quality.shadowSize);
    gl.uniform1i(u.uLightCount, Math.min(f.lightCount, MAX_LIGHTS));
    gl.uniform4fv(u.uLights, f.lights.subarray(0, MAX_LIGHTS * LIGHT_FLOATS));
    gl.uniform1i(u.uBase, 0);
    gl.uniform1i(u.uShadow, 1);

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
    const sky = f.sky.length ? f.sky : [0, 0, 0];
    gl.clearColor(Math.pow(sky[0], 1 / 2.2), Math.pow(sky[1], 1 / 2.2), Math.pow(sky[2], 1 / 2.2), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.uniform1i(u.uShadowPass, 0);
    drawAll(false);
    gl.bindVertexArray(null);
  }
}
