// Backend-neutral renderer interface. The game builds one `Frame` per tick: a flat instance
// buffer plus draw ranges. Everything (greybox cubes, characters, glTF models) goes through the
// same instanced PBR path, so the WebGPU and WebGL2 backends only differ in how they draw it.
export const VERTEX_FLOATS = 8; // position, normal, uv
export const INSTANCE_FLOATS = 24; // mat4, rgba, (metallic, roughness, emissive, flags)
export const MAX_LIGHTS = 16;
export const LIGHT_FLOATS = 12; // pos+radius, rgb+intensity, dir+cos(cone) (cone 0 = point light)

/** Instance flag bits (params.w). */
export const FLAG_GRID = 1; // procedural greybox grid on top of the base colour
export const FLAG_VIEWMODEL = 2; // first-person weapon: own projection, drawn over the world
export const FLAG_NOSHADOW = 4; // receives no sun shadow (glows, tracers)

/** Depth below this is the viewmodel; the world is squeezed into the rest of the range. */
export const VIEWMODEL_DEPTH = 0.05;

export interface MeshData {
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** Base colour texture (sRGB), or null for plain white. */
  texture?: ImageBitmap | null;
}

export interface Draw { mesh: number; first: number; count: number; shadow: boolean }

export interface PostSettings {
  exposure: number;
  bloom: number;
  /** 0 disables camera motion blur. */
  motionBlur: number;
  /** Focus distance in metres and blur strength (0 disables depth of field). */
  dofFocus: number;
  dofAmount: number;
  vignette: number;
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
  draws: Draw[];
  post: PostSettings;
}

export interface Renderer {
  readonly kind: 'webgpu' | 'webgl2';
  createMesh(data: MeshData): number;
  resize(width: number, height: number): void;
  render(frame: Frame): void;
}

export interface Quality {
  shadowSize: number;
  post: boolean;
  /** WebGPU only: draw into an offscreen texture instead of the canvas (headless tests). */
  offscreen?: boolean;
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
