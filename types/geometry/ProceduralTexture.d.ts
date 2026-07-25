/**
 * sRGB (0..1) to linear.
 * @param {number} c
 * @returns {number}
 */
export function srgbToLinear(c: number): number;
/**
 * Linear (0..1) to sRGB.
 * @param {number} c
 * @returns {number}
 */
export function linearToSrgb(c: number): number;
/**
 * Periodic classic Perlin noise. Periods of 0 disable wrapping on that axis.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} px
 * @param {number} py
 * @param {number} pz
 * @returns {number} Value roughly in -1..1.
 */
export function perlin3Periodic(x: number, y: number, z: number, px: number, py: number, pz: number): number;
/**
 * Classic 3D Perlin noise.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number} Value roughly in -1..1.
 */
export function perlin3(x: number, y: number, z: number): number;
/**
 * 3D simplex noise (Perlin's improved lattice), deterministic.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number} Value roughly in -1..1.
 */
export function simplex3(x: number, y: number, z: number): number;
/**
 * Fractal Brownian motion built on classic Perlin noise.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [octaves]
 * @param {number} [lacunarity]
 * @param {number} [gain]
 * @returns {number} Normalized to roughly -1..1.
 */
export function fbm(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
/**
 * Tileable fbm: every octave wraps on the given integer period.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} period Base period, in lattice cells.
 * @param {number} [octaves]
 * @param {number} [lacunarity]
 * @param {number} [gain]
 * @returns {number}
 */
export function fbmPeriodic(x: number, y: number, z: number, period: number, octaves?: number, lacunarity?: number, gain?: number): number;
/**
 * Ridged multifractal noise, useful for terrain and rock surfaces.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [octaves]
 * @param {number} [lacunarity]
 * @param {number} [gain]
 * @returns {number} Value in 0..1.
 */
export function ridgedFbm(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
/**
 * Generates a checkerboard color texture (sRGB encoded).
 * @param {WebGL2RenderingContext} gl
 * @param {number} [size] Edge length in texels.
 * @param {number|object|Array<number>} [color1]
 * @param {number|object|Array<number>} [color2]
 * @param {object} [options]
 * @param {number} [options.cells] Checker cells per edge (8).
 * @param {boolean} [options.mipmaps] Generate mipmaps (true).
 * @param {boolean} [options.smooth] Use linear magnification (false).
 * @returns {Texture}
 */
export function checkerTexture(gl: WebGL2RenderingContext, size?: number, color1?: number | object | Array<number>, color2?: number | object | Array<number>, options?: {
    cells?: number;
    mipmaps?: boolean;
    smooth?: boolean;
}): Texture;
/**
 * Generates a seamlessly tiling grayscale fbm noise texture (linear data).
 *
 * The noise is periodic on the texture borders, so the result can be tiled with
 * `REPEAT` without any visible discontinuity.
 * @param {WebGL2RenderingContext} gl
 * @param {number} [size]
 * @param {number} [octaves]
 * @param {object} [options]
 * @param {number} [options.frequency] Base period in lattice cells (4).
 * @param {number} [options.lacunarity] Frequency multiplier per octave (2).
 * @param {number} [options.gain] Amplitude multiplier per octave (0.5).
 * @param {number} [options.z] Slice of the 3D noise field to sample (0).
 * @param {boolean} [options.ridged] Use ridged multifractal instead of fbm.
 * @returns {Texture}
 */
export function noiseTexture(gl: WebGL2RenderingContext, size?: number, octaves?: number, options?: {
    frequency?: number;
    lacunarity?: number;
    gain?: number;
    z?: number;
    ridged?: boolean;
}): Texture;
/**
 * Generates a horizontal color ramp of `size` x 1 texels (sRGB encoded).
 *
 * Stops are interpolated in LINEAR space (physically correct) and re-encoded to
 * sRGB for storage. Accepted stop forms: `{t, color}`, `{offset, color}` or the
 * tuple `[t, color]`.
 * @param {WebGL2RenderingContext} gl
 * @param {number} [size]
 * @param {Array<object|Array<number>>} [stops]
 * @param {object} [options]
 * @returns {Texture}
 */
export function gradientTexture(gl: WebGL2RenderingContext, size?: number, stops?: Array<object | Array<number>>, options?: object): Texture;
/**
 * Converts a height field into a tangent space normal map (linear RGBA8).
 *
 * The alpha channel keeps the original height, which is handy for parallax
 * occlusion mapping. Sampling wraps around, so tiling height fields stay
 * seamless.
 * @param {WebGL2RenderingContext} gl
 * @param {ArrayBufferView|Array<number>} heightData Length `size*size` (1 channel) or `size*size*4` (RGBA, R used).
 * @param {number} size Edge length in texels.
 * @param {number} [strength] Slope multiplier.
 * @param {object} [options]
 * @returns {Texture}
 */
export function normalMapFromHeight(gl: WebGL2RenderingContext, heightData: ArrayBufferView | Array<number>, size: number, strength?: number, options?: object): Texture;
/**
 * Generates a UV calibration grid (sRGB encoded): per-cell hue, white cell
 * borders, colored center axes (red = U, green = V) and binary markers encoding
 * the column (top row of dots) and row (bottom row of dots) of each cell.
 * @param {WebGL2RenderingContext} gl
 * @param {number} [size]
 * @param {object} [options]
 * @param {number} [options.cells] Cells per edge (8).
 * @returns {Texture}
 */
export function uvGridTexture(gl: WebGL2RenderingContext, size?: number, options?: {
    cells?: number;
}): Texture;
/**
 * Generates the split-sum BRDF integration LUT on the CPU (RG16F).
 *
 * X axis = dot(N, V), Y axis = roughness. This is the fallback used when the
 * GPU path in `IBL.js` is unavailable; the result is identical up to sampling
 * noise.
 * @param {WebGL2RenderingContext} gl
 * @param {number} [size]
 * @param {number} [sampleCount] Hammersley samples per texel.
 * @returns {Texture}
 */
export function brdfLUTTexture(gl: WebGL2RenderingContext, size?: number, sampleCount?: number): Texture;
/**
 * Generates a solid color texture, handy as a default map.
 * @param {WebGL2RenderingContext} gl
 * @param {number|object|Array<number>} [color]
 * @param {number} [size]
 * @returns {Texture}
 */
export function solidColorTexture(gl: WebGL2RenderingContext, color?: number | object | Array<number>, size?: number): Texture;
/**
 * Builds a height field by sampling tileable fbm noise; feed it to
 * {@link normalMapFromHeight} or to `createTerrain`.
 * @param {number} size
 * @param {number} [frequency]
 * @param {number} [octaves]
 * @param {number} [z]
 * @returns {Float32Array} `size * size` values in 0..1.
 */
export function noiseHeightField(size: number, frequency?: number, octaves?: number, z?: number): Float32Array;
import { Texture } from "../render/Texture.js";
