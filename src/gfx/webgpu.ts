// WebGPU backend: shadow pass -> 4x MSAA HDR forward PBR pass -> bloom chain -> composite (sky,
// motion blur, depth of field, tone map, grade, grain) to the canvas.
import { flatMaterial, INSTANCE_FLOATS, LIGHT_FLOATS, MAT_LAYERS, matBytes, matMips, matOffset, MAX_LIGHTS, VERTEX_FLOATS, VIEWMODEL_DEPTH, type Frame, type MeshData, type Quality, type Renderer } from './renderer';
import postSrc from './shaders/post.wgsl?raw';
import sceneSrc from './shaders/scene.wgsl?raw';

interface GpuMesh { vertices: GPUBuffer; indices: GPUBuffer; count: number; format: GPUIndexFormat; bind: GPUBindGroup }

const HDR: GPUTextureFormat = 'rgba16float';
const DEPTH: GPUTextureFormat = 'depth32float';
const SAMPLES = 4;
const GLOBALS_FLOATS = 16 * 3 + 4 * 5 + 20 + MAX_LIGHTS * LIGHT_FLOATS;
const POST_FLOATS = 16 * 2 + 4 * 7;
const BLOOM_LEVELS = 4;

export class WebGPURenderer implements Renderer {
  readonly kind = 'webgpu' as const;
  private meshes: GpuMesh[] = [];
  private globals = new Float32Array(GLOBALS_FLOATS);
  private tiles = new Float32Array(20).fill(2);
  private postData = new Float32Array(POST_FLOATS);
  private globalsBuf: GPUBuffer;
  private postBuf: GPUBuffer;
  private instanceBuf: GPUBuffer;
  private instanceCap = 4096;
  private scenePipe: GPURenderPipeline;
  private shadowPipe: GPURenderPipeline;
  private brightPipe: GPURenderPipeline;
  private downPipe: GPURenderPipeline;
  private upPipe: GPURenderPipeline;
  private compositePipe: GPURenderPipeline;
  private texLayout: GPUBindGroupLayout;
  private postLayout: GPUBindGroupLayout;
  private sceneBind!: GPUBindGroup;
  private shadowBind: GPUBindGroup;
  private shadowView: GPUTextureView;
  private linear: GPUSampler;
  /** Mesh textures (glTF). Material layers get their own sampler, rebuilt with the quality setting. */
  private repeat: GPUSampler;
  private white: GPUTexture;
  private matSurface!: GPUTexture;
  private matDetail!: GPUTexture;
  private matSize = 0;
  private sceneLayout: GPUBindGroupLayout;
  private shadowCompare: GPUSampler;
  private hdrMs!: GPUTexture;
  private hdr!: GPUTexture;
  private depth!: GPUTexture;
  private offscreen: GPUTexture | null = null;
  private bloom: GPUTexture[] = [];
  private staticId = -1;
  private captureNext: ((img: ImageData) => void) | null = null;
  /** Offscreen only: a frame is still executing on the GPU. */
  private busy = false;
  private postBinds: { bright: GPUBindGroup; down: GPUBindGroup[]; up: GPUBindGroup[]; composite: GPUBindGroup } | null = null;

  static async create(canvas: HTMLCanvasElement, quality: Quality): Promise<WebGPURenderer> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    let context: GPUCanvasContext | null = null;
    let format: GPUTextureFormat = 'rgba8unorm';
    if (!quality.offscreen) {
      context = canvas.getContext('webgpu');
      if (!context) throw new Error('No WebGPU canvas context');
      format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });
    }
    device.addEventListener('uncapturederror', e => console.error('WebGPU:', (e as GPUUncapturedErrorEvent).error.message));
    return new WebGPURenderer(device, context, format, quality, canvas);
  }

  /**
   * Reads back the next frame. Only available with `quality.offscreen`, which automated browser
   * tests use because headless software adapters cannot present or read back a WebGPU canvas.
   */
  capture(): Promise<ImageData> { return new Promise(resolve => (this.captureNext = resolve)); }

  private constructor(private device: GPUDevice, private context: GPUCanvasContext | null, private format: GPUTextureFormat, private quality: Quality, canvas: HTMLCanvasElement) {
    const d = device;
    this.globalsBuf = d.createBuffer({ size: GLOBALS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postBuf = d.createBuffer({ size: POST_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.instanceBuf = this.makeInstanceBuffer();
    this.linear = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.repeat = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
    this.white = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);

    const shadowTex = d.createTexture({ size: [quality.shadowSize, quality.shadowSize], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowView = shadowTex.createView();

    const uniform: GPUBindGroupLayoutEntry = { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} };
    const shadowLayout = d.createBindGroupLayout({ entries: [uniform] });
    const sceneLayout = (this.sceneLayout = d.createBindGroupLayout({
      entries: [
        uniform,
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    }));
    this.texLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', multisampled: true } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.shadowBind = d.createBindGroup({ layout: shadowLayout, entries: [{ binding: 0, resource: { buffer: this.globalsBuf } }] });
    this.shadowCompare = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.setMaterialQuality(quality.textureSize, quality.anisotropy);

    const scene = d.createShaderModule({ code: sceneSrc });
    const post = d.createShaderModule({ code: postSrc });
    const vec4 = (location: number, offset: number): GPUVertexAttribute => ({ shaderLocation: location, offset, format: 'float32x4' });
    const buffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: VERTEX_FLOATS * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x2' },
        ],
      },
      { arrayStride: INSTANCE_FLOATS * 4, stepMode: 'instance', attributes: [vec4(3, 0), vec4(4, 16), vec4(5, 32), vec4(6, 48), vec4(7, 64), vec4(8, 80)] },
    ];
    this.scenePipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [sceneLayout, this.texLayout] }),
      vertex: { module: scene, entryPoint: 'vs', buffers },
      fragment: { module: scene, entryPoint: 'fs', targets: [{ format: HDR }] },
      primitive: { cullMode: 'back' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });
    this.shadowPipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [shadowLayout] }),
      vertex: { module: scene, entryPoint: 'vs_shadow', buffers },
      primitive: { cullMode: 'none' },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    });
    const postLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] });
    const fullscreen = (entryPoint: string, target: GPUColorTargetState) =>
      d.createRenderPipeline({ layout: postLayout, vertex: { module: post, entryPoint: 'vs' }, fragment: { module: post, entryPoint, targets: [target] } });
    this.brightPipe = fullscreen('fs_bright', { format: HDR });
    this.downPipe = fullscreen('fs_down', { format: HDR });
    this.upPipe = fullscreen('fs_up', { format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } });
    this.compositePipe = fullscreen('fs_composite', { format });
    this.resize(canvas.width, canvas.height);
  }

  private makeInstanceBuffer(): GPUBuffer {
    return this.device.createBuffer({ size: this.instanceCap * INSTANCE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  setMaterialQuality(size: number, anisotropy: number): void {
    const d = this.device;
    this.matSurface?.destroy();
    this.matDetail?.destroy();
    this.matSize = size;
    const matTex = (format: GPUTextureFormat) => d.createTexture({ size: [size, size, MAT_LAYERS], format, mipLevelCount: matMips(size), usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.matSurface = matTex('rgba8unorm-srgb');
    this.matDetail = matTex('rgba8unorm');
    const flat = flatMaterial(size);
    for (let layer = 0; layer < MAT_LAYERS; layer++) this.uploadLayer(layer, flat);
    const sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: Math.max(1, Math.min(16, anisotropy)) });
    this.sceneBind = d.createBindGroup({
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.globalsBuf } },
        { binding: 1, resource: this.shadowView },
        { binding: 2, resource: this.shadowCompare },
        { binding: 3, resource: this.matSurface.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: this.matDetail.createView({ dimension: '2d-array' }) },
        { binding: 5, resource: sampler },
      ],
    });
  }

  private uploadLayer(layer: number, data: Uint8Array): void {
    const size = this.matSize;
    for (const [map, tex] of [[0, this.matSurface], [1, this.matDetail]] as const) {
      for (let level = 0; level < matMips(size); level++) {
        const s = size >> level;
        const off = matOffset(map, level, size);
        this.device.queue.writeTexture({ texture: tex, mipLevel: level, origin: [0, 0, layer] }, data.subarray(off, off + s * s * 4) as Uint8Array<ArrayBuffer>, { bytesPerRow: s * 4, rowsPerImage: s }, [s, s, 1]);
      }
    }
  }

  setMaterial(layer: number, data: Uint8Array, tile: number): void {
    if (layer < 0 || layer >= MAT_LAYERS || data.length !== matBytes(this.matSize)) return;
    this.uploadLayer(layer, data);
    this.tiles[layer] = tile;
  }

  createMesh(data: MeshData): number {
    const d = this.device;
    const vertices = d.createBuffer({ size: data.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(vertices, 0, data.vertices as Float32Array<ArrayBuffer>);
    // Index data must be a multiple of 4 bytes.
    const padded = data.indices.byteLength % 4 ? new Uint16Array([...data.indices, 0]) : data.indices;
    const indices = d.createBuffer({ size: padded.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(indices, 0, padded as Uint16Array<ArrayBuffer>);
    let texture = this.white;
    if (data.texture) {
      // Read pixels through a 2D canvas and upload with writeTexture. copyExternalImageToTexture
      // is faster but fails on some adapters (including software ones).
      const { width, height } = data.texture;
      const ctx = new OffscreenCanvas(width, height).getContext('2d')!;
      ctx.drawImage(data.texture, 0, 0);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      texture = d.createTexture({ size: [width, height], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      d.queue.writeTexture({ texture }, pixels, { bytesPerRow: width * 4 }, [width, height]);
    }
    const bind = d.createBindGroup({ layout: this.texLayout, entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: this.repeat }] });
    this.meshes.push({ vertices, indices, count: data.indices.length, format: data.indices instanceof Uint32Array ? 'uint32' : 'uint16', bind });
    return this.meshes.length - 1;
  }

  resize(width: number, height: number): void {
    const d = this.device;
    const [w, h] = [Math.max(1, width), Math.max(1, height)];
    for (const t of [this.hdrMs, this.hdr, this.depth, this.offscreen, ...this.bloom]) t?.destroy();
    const target = (tw: number, th: number, format: GPUTextureFormat, sampleCount = 1) =>
      d.createTexture({ size: [Math.max(1, tw), Math.max(1, th)], format, sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.hdrMs = target(w, h, HDR, SAMPLES);
    this.hdr = target(w, h, HDR);
    this.depth = target(w, h, DEPTH, SAMPLES);
    if (!this.context) this.offscreen = d.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.bloom = Array.from({ length: BLOOM_LEVELS }, (_, i) => target(w >> (i + 1), h >> (i + 1), HDR));
    const depthView = this.depth.createView();
    const dummy = this.white.createView();
    const bind = (src: GPUTexture, bloom: GPUTextureView) =>
      d.createBindGroup({
        layout: this.postLayout,
        entries: [
          { binding: 0, resource: { buffer: this.postBuf } },
          { binding: 1, resource: src.createView() },
          { binding: 2, resource: this.linear },
          { binding: 3, resource: depthView },
          { binding: 4, resource: bloom },
        ],
      });
    this.postBinds = {
      bright: bind(this.hdr, dummy),
      down: this.bloom.slice(0, -1).map(t => bind(t, dummy)),
      up: this.bloom.slice(1).map(t => bind(t, dummy)),
      composite: bind(this.hdr, this.bloom[0].createView()),
    };
  }

  render(f: Frame): void {
    // A canvas is throttled by presentation; offscreen rendering is not, so without this the queue
    // would grow without bound on a slow (software) adapter.
    if (this.busy) return;
    const d = this.device;
    const g = this.globals;
    g.set(f.viewProj, 0);
    g.set(f.viewmodelProj, 16);
    g.set(f.shadowViewProj, 32);
    g.set([f.camPos[0], f.camPos[1], f.camPos[2], 1, f.sunDir[0], f.sunDir[1], f.sunDir[2], 0, f.sunColor[0], f.sunColor[1], f.sunColor[2], 3.0, f.sky[0], f.sky[1], f.sky[2], f.fog,
      Math.min(f.lightCount, this.quality.maxLights ?? MAX_LIGHTS), f.post.time, 1 / this.quality.shadowSize, VIEWMODEL_DEPTH], 48);
    g.set(this.tiles, 68);
    g.set(f.lights.subarray(0, MAX_LIGHTS * LIGHT_FLOATS), 88);
    d.queue.writeBuffer(this.globalsBuf, 0, g);

    if (f.instanceCount > this.instanceCap) {
      while (this.instanceCap < f.instanceCount) this.instanceCap *= 2;
      this.instanceBuf.destroy();
      this.instanceBuf = this.makeInstanceBuffer();
      this.staticId = -1;
    }
    // Upload the unchanging level once; after that only the moving instances.
    const from = f.staticId !== undefined && f.staticId === this.staticId ? (f.staticCount ?? 0) * INSTANCE_FLOATS : 0;
    if (f.instanceCount * INSTANCE_FLOATS > from) d.queue.writeBuffer(this.instanceBuf, from * 4, f.instances as Float32Array<ArrayBuffer>, from, f.instanceCount * INSTANCE_FLOATS - from);
    this.staticId = f.staticId ?? -1;

    const p = this.postData;
    p.set(f.invViewProj, 0);
    p.set(f.prevViewProj, 16);
    const post = this.quality.post;
    p.set([f.camPos[0], f.camPos[1], f.camPos[2], 1,
      f.post.exposure, post ? f.post.bloom : 0, post ? f.post.motionBlur : 0, f.post.dofFocus,
      post ? f.post.dofAmount : 0, f.post.vignette, f.post.damage, f.post.time,
      VIEWMODEL_DEPTH, post ? f.post.grain : 0, f.post.saturation, f.post.contrast,
      f.sunDir[0], f.sunDir[1], f.sunDir[2], 0, f.sunColor[0], f.sunColor[1], f.sunColor[2], 1, f.sky[0], f.sky[1], f.sky[2], 1], 32);
    d.queue.writeBuffer(this.postBuf, 0, p);

    const enc = d.createCommandEncoder();
    const drawAll = (pass: GPURenderPassEncoder, shadow: boolean) => {
      pass.setVertexBuffer(1, this.instanceBuf);
      for (const dr of f.draws) {
        if (shadow && !dr.shadow) continue;
        const m = this.meshes[dr.mesh];
        if (!m || !dr.count) continue;
        if (!shadow) pass.setBindGroup(1, m.bind);
        pass.setVertexBuffer(0, m.vertices);
        pass.setIndexBuffer(m.indices, m.format);
        pass.drawIndexed(m.count, dr.count, 0, 0, dr.first);
      }
      pass.end();
    };

    const shadow = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.shadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    shadow.setPipeline(this.shadowPipe);
    shadow.setBindGroup(0, this.shadowBind);
    drawAll(shadow, true);

    const main = enc.beginRenderPass({
      colorAttachments: [{ view: this.hdrMs.createView(), resolveTarget: this.hdr.createView(), clearValue: { r: f.sky[0], g: f.sky[1], b: f.sky[2], a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    main.setPipeline(this.scenePipe);
    main.setBindGroup(0, this.sceneBind);
    drawAll(main, false);

    const binds = this.postBinds!;
    const fullscreen = (pipe: GPURenderPipeline, bind: GPUBindGroup, view: GPUTextureView, load: GPULoadOp) => {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    };
    if (post && f.post.bloom > 0) {
      fullscreen(this.brightPipe, binds.bright, this.bloom[0].createView(), 'clear');
      for (let i = 1; i < BLOOM_LEVELS; i++) fullscreen(this.downPipe, binds.down[i - 1], this.bloom[i].createView(), 'clear');
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) fullscreen(this.upPipe, binds.up[i], this.bloom[i].createView(), 'load');
    }
    const out = this.context ? this.context.getCurrentTexture() : this.offscreen!;
    fullscreen(this.compositePipe, binds.composite, out.createView(), 'clear');
    const resolve = this.captureNext;
    let readback: GPUBuffer | null = null;
    const bytesPerRow = Math.ceil((out.width * 4) / 256) * 256;
    if (resolve && !this.context) {
      this.captureNext = null;
      readback = d.createBuffer({ size: bytesPerRow * out.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      enc.copyTextureToBuffer({ texture: out }, { buffer: readback, bytesPerRow }, [out.width, out.height]);
    }
    d.queue.submit([enc.finish()]);
    if (!this.context) {
      this.busy = true;
      void d.queue.onSubmittedWorkDone().then(() => (this.busy = false));
    }
    if (resolve && readback) {
      const [w, h, bgra] = [out.width, out.height, out.format.startsWith('bgra')];
      void readback.mapAsync(GPUMapMode.READ).then(() => {
        const src = new Uint8Array(readback!.getMappedRange());
        const px = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * bytesPerRow + x * 4, o = (y * w + x) * 4;
            px[o] = src[i + (bgra ? 2 : 0)]; px[o + 1] = src[i + 1]; px[o + 2] = src[i + (bgra ? 0 : 2)]; px[o + 3] = 255;
          }
        }
        readback!.destroy();
        resolve(new ImageData(px, w, h));
      });
    }
  }
}
