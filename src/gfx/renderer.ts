// Backend-neutral renderer interface. The game builds one `Frame` per tick: a flat instance
// buffer plus draw ranges. Everything (greybox cubes, characters, glTF models) goes through the
// same instanced PBR path, so the WebGPU and WebGL2 backends only differ in how they draw it.
export const VERTEX_FLOATS = 8; // position, normal, uv
/** Procedural material layers (see crates/sim/src/texgen.rs). */
export const MAT_LAYERS = 20;

/** Texture quality presets: material resolution and anisotropic filtering. */
export const TEXTURE_QUALITY = {
  low: { size: 128, anisotropy: 1, label: 'Low' },
  medium: { size: 256, anisotropy: 4, label: 'Medium' },
  high: { size: 512, anisotropy: 8, label: 'High' },
  ultra: { size: 1024, anisotropy: 16, label: 'Ultra' },
} as const;
export type TextureQuality = keyof typeof TEXTURE_QUALITY;
export const matMips = (size: number) => Math.log2(size) + 1;
export const MAT = { concrete: 0, floor: 1, painted: 2, rust: 3, wood: 4, brick: 5, gunmetal: 6, fabric: 7, skin: 8, polymer: 9, woodland: 10, digital: 11, desert: 12, tiger: 13, arctic: 14, carbon: 15, gilded: 16, leaves: 17, bark: 18, ground: 19 } as const;
export const INSTANCE_FLOATS = 24; // mat4, (rgb tint, material layer + 1), (metallic, roughness, emissive, flags)
export const MAX_LIGHTS = 16;
export const LIGHT_FLOATS = 12; // pos+radius, rgb+intensity, dir+cos(cone) (cone 0 = point light)

/** Instance flag bits (params.w). */
export const FLAG_GRID = 1; // procedural greybox grid on top of the base colour
export const FLAG_VIEWMODEL = 2; // first-person weapon: own projection, drawn over the world
export const FLAG_NOSHADOW = 4; // receives no sun shadow (glows, tracers)
export const FLAG_FOLIAGE = 8; // leaves: gaps in the leaf material are cut out, light shines through, sways in the wind
export const FLAG_GRASS = 16; // grass blades: bend from the root in gusts, shaded dark root to light tip
export const FLAG_CLOTH = 32; // flags and tarps: pinned along local x = -0.5, ripple in the wind
export const FLAG_WATER = 64; // puddles: rippling mirror surface
export const FLAG_CABLE = 128; // hanging cables: swing at mid-span

/** Depth below this is the viewmodel; the world is squeezed into the rest of the range. */
export const VIEWMODEL_DEPTH = 0.05;

export interface MeshData {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Base colour texture (sRGB), or null for plain white. */
  texture?: ImageBitmap | null;
}

/** `shadow`: drawn into the sun's shadow map; `main` (default true): drawn in the camera pass. */
export interface Draw { mesh: number; first: number; count: number; shadow: boolean; main?: boolean }

export interface PostSettings {
  exposure: number;
  bloom: number;
  /** 0 disables camera motion blur. */
  motionBlur: number;
  /** Focus distance in metres and blur strength (0 disables depth of field). */
  dofFocus: number;
  dofAmount: number;
  vignette: number;
  /** Film grain strength, saturation (1 = unchanged) and S-curve contrast (0 = none). */
  grain: number;
  saturation: number;
  contrast: number;
  /** Red edge flash when hurt, 0..1. */
  damage: number;
  time: number;
}

export interface Frame {
  viewProj: Float32Array;
  invViewProj: Float32Array;
  prevViewProj: Float32Array;
  viewmodelProj: Float32Array;
  shadowViewProj: Float32Array;
  camPos: ArrayLike<number>;
  sunDir: ArrayLike<number>;
  sunColor: ArrayLike<number>;
  sky: ArrayLike<number>;
  fog: number;
  lights: Float32Array;
  lightCount: number;
  instances: Float32Array;
  instanceCount: number;
  /** The first `staticCount` instances are the same every frame while `staticId` stays the same. */
  staticCount?: number;
  staticId?: number;
  draws: Draw[];
  post: PostSettings;
}

export interface Renderer {
  readonly kind: 'webgpu' | 'webgl2';
  createMesh(data: MeshData): number;
  /**
   * Reallocates the material textures at `size` (a power of two) with the given anisotropic
   * filtering. Layers show neutral grey until `setMaterial` fills them again.
   */
  setMaterialQuality(size: number, anisotropy: number): void;
  /**
   * Uploads one material layer: `data` is the surface mip chain followed by the detail mip chain
   * (RGBA8, the current material size square down to 1x1). `tile` is metres per repeat.
   * Data generated for a different size is ignored.
   */
  setMaterial(layer: number, data: Uint8Array, tile: number): void;
  resize(width: number, height: number): void;
  render(frame: Frame): void;
}

export interface Quality {
  shadowSize: number;
  post: boolean;
  /** Initial material resolution and anisotropic filtering (see TEXTURE_QUALITY). */
  textureSize: number;
  anisotropy: number;
  /** WebGPU only: draw into an offscreen texture instead of the canvas (headless tests). */
  offscreen?: boolean;
  /** Point lights shaded per pixel (phones use fewer). */
  maxLights?: number;
}

/** Picks WebGPU when the browser has a working adapter, otherwise WebGL2. `prefer` forces one. */
export async function createRenderer(canvas: HTMLCanvasElement, prefer: string | null, quality: Quality): Promise<Renderer> {
  if (prefer !== 'webgl2' && 'gpu' in navigator) {
    try {
      const { WebGPURenderer } = await import('./webgpu');
      return await WebGPURenderer.create(canvas, quality);
    } catch (e) {
      console.warn('WebGPU unavailable, falling back to WebGL2:', e);
      if (prefer === 'webgpu') throw e;
      // A canvas that handed out a WebGPU context cannot also give a WebGL one.
      const fresh = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
  }
  const { WebGL2Renderer } = await import('./webgl2');
  return new WebGL2Renderer(canvas, quality);
}

/** Unit cube centred on the origin with per-face normals. */
export function cubeMesh(): MeshData {
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const v: number[] = [], idx: number[] = [];
  faces.forEach(([n, u, w], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.push((n[0] + u[0] * a + w[0] * b) / 2, (n[1] + u[1] * a + w[1] * b) / 2, (n[2] + u[2] * a + w[2] * b) / 2, n[0], n[1], n[2], (a + 1) / 2, (1 - b) / 2);
    }
    idx.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Byte offset of mip `level` of map `map` (0 surface, 1 detail) in a material layer upload of `size`. */
export function matOffset(map: number, level: number, size: number): number {
  let off = 0;
  for (let m = 0; m <= map; m++) {
    for (let l = 0; l < matMips(size); l++) {
      if (m === map && l === level) return off;
      const s = size >> l;
      off += s * s * 4;
    }
  }
  return off;
}
/** Total bytes of one material layer upload of `size`. */
export const matBytes = (size: number) => matOffset(1, 0, size) * 2;

/** A neutral layer (mid-grey, rough, flat) shown until the generated one arrives. */
export function flatMaterial(size: number): Uint8Array {
  const out = new Uint8Array(matBytes(size));
  const half = matOffset(1, 0, size);
  for (let map = 0; map < 2; map++) {
    const texel = map === 0 ? [118, 118, 118, 217] : [128, 128, 0, 255];
    for (let i = map * half; i < (map + 1) * half; i += 4) out.set(texel, i);
  }
  return out;
}

/**
 * Unit sphere (radius 0.5) with smooth normals. Scaled along one axis it becomes the rounded,
 * tapered limb and body shapes the characters are built from.
 */
export function sphereMesh(rings = 10, segs = 16): MeshData {
  const v: number[] = [], idx: number[] = [];
  const r = 0.5, half = 0.0;
  // Hemisphere rings from the top pole to the bottom pole; the straight part has zero length so
  // scaling Y stretches it into a rounded cylinder.
  const rows: [number, number, number][] = [];
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * (Math.PI / 2);
    rows.push([Math.sin(a) * r, half + Math.cos(a) * r, Math.cos(a)]);
  }
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * (Math.PI / 2);
    rows.push([Math.cos(a) * r, -half - Math.sin(a) * r, -Math.sin(a)]);
  }
  rows.forEach(([rad, y, ny], ri) => {
    for (let j = 0; j <= segs; j++) {
      const t = (j / segs) * Math.PI * 2;
      const nx = Math.cos(t), nz = Math.sin(t);
      const hn = Math.sqrt(Math.max(0, 1 - ny * ny));
      v.push(nx * rad, y, nz * rad, nx * hn, ny, nz * hn, j / segs, ri / (rows.length - 1));
    }
  });
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Unit cylinder (radius 0.5, height 1, along Y, centred) with capped ends, for pipes and barrels. */
export function cylinderMesh(segs = 16): MeshData {
  const v: number[] = [], idx: number[] = [];
  for (let j = 0; j <= segs; j++) {
    const t = (j / segs) * Math.PI * 2, x = Math.cos(t), z = Math.sin(t);
    v.push(x * 0.5, 0.5, z * 0.5, x, 0, z, j / segs, 0, x * 0.5, -0.5, z * 0.5, x, 0, z, j / segs, 1);
  }
  for (let j = 0; j < segs; j++) { const a = j * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
  for (const [y, ny] of [[0.5, 1], [-0.5, -1]]) {
    const c = v.length / 8;
    v.push(0, y, 0, 0, ny, 0, 0.5, 0.5);
    for (let j = 0; j <= segs; j++) { const t = (j / segs) * Math.PI * 2; v.push(Math.cos(t) * 0.5, y, Math.sin(t) * 0.5, 0, ny, 0, 0.5 + Math.cos(t) * 0.5, 0.5 + Math.sin(t) * 0.5); }
    for (let j = 0; j < segs; j++) idx.push(...(ny > 0 ? [c, c + j + 2, c + j + 1] : [c, c + j + 1, c + j + 2]));
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}
