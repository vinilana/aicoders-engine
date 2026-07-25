/**
 * @fileoverview Deterministic procedural noise and CPU generated textures.
 *
 * All noise functions use a fixed permutation table (no `Math.random`), so the
 * exact same values are produced on every machine and on every run, which makes
 * generated content reproducible across clients.
 *
 * Color textures are uploaded as `SRGB8_ALPHA8` so the GPU decodes them to
 * linear space for free; pure data textures (noise, normal maps, BRDF LUT) use
 * linear formats.
 */

import { Texture } from '../render/Texture.js';

/* -------------------------------------------------------------------------- */
/* Color helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * sRGB (0..1) to linear.
 * @param {number} c
 * @returns {number}
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Linear (0..1) to sRGB.
 * @param {number} c
 * @returns {number}
 */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Clamps a float to 0..255 and rounds it.
 * @param {number} v
 * @returns {number}
 */
function toByte(v) {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : (b > 255 ? 255 : b);
}

/**
 * Encodes a user supplied color into sRGB bytes.
 *
 * Accepted forms:
 *  - `number`: 0xRRGGBB, already sRGB encoded.
 *  - `{r, g, b, a?}` (a {@link Color}): linear values, converted to sRGB.
 *  - `[r, g, b, a?]`: linear values in 0..1.
 * @param {number|object|Array<number>} color
 * @param {Uint8Array} out
 * @param {number} [offset]
 */
function encodeColor(color, out, offset = 0) {
  if (typeof color === 'number') {
    const h = Math.floor(color);
    out[offset] = (h >> 16) & 255;
    out[offset + 1] = (h >> 8) & 255;
    out[offset + 2] = h & 255;
    out[offset + 3] = 255;
    return;
  }
  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    out[offset] = toByte(linearToSrgb(color[0] || 0));
    out[offset + 1] = toByte(linearToSrgb(color[1] || 0));
    out[offset + 2] = toByte(linearToSrgb(color[2] || 0));
    out[offset + 3] = color.length > 3 ? toByte(color[3]) : 255;
    return;
  }
  if (color && typeof color === 'object') {
    out[offset] = toByte(linearToSrgb(color.r || 0));
    out[offset + 1] = toByte(linearToSrgb(color.g || 0));
    out[offset + 2] = toByte(linearToSrgb(color.b || 0));
    out[offset + 3] = color.a !== undefined ? toByte(color.a) : 255;
    return;
  }
  out[offset] = 255;
  out[offset + 1] = 0;
  out[offset + 2] = 255;
  out[offset + 3] = 255;
}

/**
 * Single channel of the HSL to RGB conversion.
 * @param {number} p
 * @param {number} q
 * @param {number} t
 * @returns {number}
 */
function hueToRgb(p, q, t) {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

/**
 * Converts HSL to sRGB (0..1 components).
 * @param {number} h Hue in 0..1.
 * @param {number} s Saturation in 0..1.
 * @param {number} l Lightness in 0..1.
 * @param {Float32Array} out
 * @param {number} [offset]
 */
function hslToSrgb(h, s, l, out, offset = 0) {
  const hue = ((h % 1) + 1) % 1;
  if (s === 0) {
    out[offset] = l;
    out[offset + 1] = l;
    out[offset + 2] = l;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[offset] = hueToRgb(p, q, hue + 1 / 3);
  out[offset + 1] = hueToRgb(p, q, hue);
  out[offset + 2] = hueToRgb(p, q, hue - 1 / 3);
}

/* -------------------------------------------------------------------------- */
/* Noise                                                                       */
/* -------------------------------------------------------------------------- */

/** Classic Perlin permutation table (fixed, never randomized). */
const PERM_SOURCE = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
  140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
  247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
  57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
  74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
  60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
  65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64,
  52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212,
  207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
  119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
  129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104,
  218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
  81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
  184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
  222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180
];

/**
 * Builds the doubled permutation table, which avoids a modulo in the inner
 * loops. Pure function: no observable side effect at module evaluation time.
 * @returns {Uint8Array}
 */
function buildPermutation() {
  const table = new Uint8Array(512);
  for (let i = 0; i < 512; i++) table[i] = PERM_SOURCE[i & 255];
  return table;
}

/** Doubled permutation table (512 entries). */
const PERM = buildPermutation();

/** 12 gradient directions of the simplex lattice. */
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);

const F3 = 1 / 3;
const G3 = 1 / 6;

/**
 * Quintic interpolation curve.
 * @param {number} t
 * @returns {number}
 */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Perlin gradient dot product.
 * @param {number} hash
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
function grad(hash, x, y, z) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/**
 * Wraps an integer lattice coordinate to a period.
 * @param {number} v
 * @param {number} period
 * @returns {number}
 */
function wrapInt(v, period) {
  if (period <= 0) return v;
  const p = period | 0;
  return ((v % p) + p) % p;
}

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
export function perlin3Periodic(x, y, z, px, py, pz) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;

  const X0 = wrapInt(xi, px) & 255;
  const Y0 = wrapInt(yi, py) & 255;
  const Z0 = wrapInt(zi, pz) & 255;
  const X1 = wrapInt(xi + 1, px) & 255;
  const Y1 = wrapInt(yi + 1, py) & 255;
  const Z1 = wrapInt(zi + 1, pz) & 255;

  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  // Lattice hashes are resolved per corner (instead of the classic "+1" trick)
  // so that a wrapped coordinate still lands on the right gradient.
  const A = PERM[X0] + Y0;
  const AA = PERM[A & 255] + Z0;
  const B = PERM[X1] + Y0;
  const BA = PERM[B & 255] + Z0;

  const A1 = PERM[X0] + Y1;
  const AA1 = PERM[A1 & 255] + Z0;
  const B1 = PERM[X1] + Y1;
  const BA1 = PERM[B1 & 255] + Z0;

  const g000 = grad(PERM[AA & 255], xf, yf, zf);
  const g100 = grad(PERM[BA & 255], xf - 1, yf, zf);
  const g010 = grad(PERM[AA1 & 255], xf, yf - 1, zf);
  const g110 = grad(PERM[BA1 & 255], xf - 1, yf - 1, zf);

  const AAz = PERM[A & 255] + Z1;
  const BAz = PERM[B & 255] + Z1;
  const AA1z = PERM[A1 & 255] + Z1;
  const BA1z = PERM[B1 & 255] + Z1;

  const g001 = grad(PERM[AAz & 255], xf, yf, zf - 1);
  const g101 = grad(PERM[BAz & 255], xf - 1, yf, zf - 1);
  const g011 = grad(PERM[AA1z & 255], xf, yf - 1, zf - 1);
  const g111 = grad(PERM[BA1z & 255], xf - 1, yf - 1, zf - 1);

  const x00 = g000 + u * (g100 - g000);
  const x10 = g010 + u * (g110 - g010);
  const x01 = g001 + u * (g101 - g001);
  const x11 = g011 + u * (g111 - g011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

/**
 * Classic 3D Perlin noise.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number} Value roughly in -1..1.
 */
export function perlin3(x, y, z) {
  return perlin3Periodic(x, y, z, 0, 0, 0);
}

/**
 * 3D simplex noise (Perlin's improved lattice), deterministic.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number} Value roughly in -1..1.
 */
export function simplex3(x, y, z) {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);

  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }

  const x1 = x0 - i1 + G3;
  const y1 = y0 - j1 + G3;
  const z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3;
  const y2 = y0 - j2 + 2 * G3;
  const z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3;
  const y3 = y0 - 1 + 3 * G3;
  const z3 = z0 - 1 + 3 * G3;

  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;

  const gi0 = (PERM[ii + PERM[(jj + PERM[kk]) & 255]] % 12) * 3;
  const gi1 = (PERM[(ii + i1 + PERM[(jj + j1 + PERM[(kk + k1) & 255]) & 255]) & 255] % 12) * 3;
  const gi2 = (PERM[(ii + i2 + PERM[(jj + j2 + PERM[(kk + k2) & 255]) & 255]) & 255] % 12) * 3;
  const gi3 = (PERM[(ii + 1 + PERM[(jj + 1 + PERM[(kk + 1) & 255]) & 255]) & 255] % 12) * 3;

  let n = 0;
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0) {
    t0 *= t0;
    n += t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0 + GRAD3[gi0 + 2] * z0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0) {
    t1 *= t1;
    n += t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1 + GRAD3[gi1 + 2] * z1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0) {
    t2 *= t2;
    n += t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2 + GRAD3[gi2 + 2] * z2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0) {
    t3 *= t3;
    n += t3 * t3 * (GRAD3[gi3] * x3 + GRAD3[gi3 + 1] * y3 + GRAD3[gi3 + 2] * z3);
  }
  return 32 * n;
}

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
export function fbm(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  const n = Math.max(1, octaves | 0);
  for (let i = 0; i < n; i++) {
    sum += amplitude * perlin3(x * frequency, y * frequency, z * frequency);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

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
export function fbmPeriodic(x, y, z, period, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  const n = Math.max(1, octaves | 0);
  for (let i = 0; i < n; i++) {
    const p = Math.max(1, Math.round(period * frequency));
    sum += amplitude * perlin3Periodic(x * frequency, y * frequency, z * frequency, p, p, p);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

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
export function ridgedFbm(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  const n = Math.max(1, octaves | 0);
  for (let i = 0; i < n; i++) {
    const value = 1 - Math.abs(perlin3(x * frequency, y * frequency, z * frequency));
    sum += amplitude * value * value;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/* -------------------------------------------------------------------------- */
/* Texture helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Creates a 2D texture from CPU generated data.
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @param {ArrayBufferView} data
 * @param {object} options
 * @returns {Texture}
 */
function makeTexture(gl, width, height, data, options) {
  return new Texture(gl, {
    target: '2d',
    width,
    height,
    data,
    internalFormat: options.internalFormat,
    format: options.format,
    type: options.type,
    minFilter: options.minFilter,
    magFilter: options.magFilter,
    wrapS: options.wrapS,
    wrapT: options.wrapT,
    anisotropy: options.anisotropy || 1,
    generateMipmaps: !!options.generateMipmaps,
    flipY: false,
    premultiply: false
  });
}

/* -------------------------------------------------------------------------- */
/* Textures                                                                    */
/* -------------------------------------------------------------------------- */

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
export function checkerTexture(gl, size = 256, color1 = 0xffffff, color2 = 0x808080, options = {}) {
  const s = Math.max(2, size | 0);
  const cells = Math.max(1, (options.cells !== undefined ? options.cells : 8) | 0);
  const cellSize = s / cells;
  const data = new Uint8Array(s * s * 4);
  const c1 = new Uint8Array(4);
  const c2 = new Uint8Array(4);
  encodeColor(color1, c1, 0);
  encodeColor(color2, c2, 0);

  for (let y = 0; y < s; y++) {
    const cy = Math.floor(y / cellSize);
    for (let x = 0; x < s; x++) {
      const cx = Math.floor(x / cellSize);
      const c = ((cx + cy) & 1) === 0 ? c1 : c2;
      const o = (y * s + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = c[3];
    }
  }

  const mipmaps = options.mipmaps !== false;
  return makeTexture(gl, s, s, data, {
    internalFormat: gl.SRGB8_ALPHA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    minFilter: mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    magFilter: options.smooth ? gl.LINEAR : gl.NEAREST,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
    anisotropy: options.anisotropy || 4,
    generateMipmaps: mipmaps
  });
}

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
export function noiseTexture(gl, size = 256, octaves = 4, options = {}) {
  const s = Math.max(2, size | 0);
  const oct = Math.max(1, octaves | 0);
  const frequency = Math.max(1, (options.frequency !== undefined ? options.frequency : 4) | 0);
  const lacunarity = options.lacunarity !== undefined ? options.lacunarity : 2;
  const gain = options.gain !== undefined ? options.gain : 0.5;
  const z = options.z !== undefined ? options.z : 0;
  const ridged = !!options.ridged;
  const data = new Uint8Array(s * s * 4);
  const inv = frequency / s;

  for (let y = 0; y < s; y++) {
    const ny = y * inv;
    for (let x = 0; x < s; x++) {
      const nx = x * inv;
      let v;
      if (ridged) {
        v = 0;
        let amplitude = 1;
        let freq = 1;
        let norm = 0;
        for (let i = 0; i < oct; i++) {
          const p = Math.max(1, Math.round(frequency * freq));
          const raw = perlin3Periodic(nx * freq, ny * freq, z * freq, p, p, p);
          const ridge = 1 - Math.abs(raw);
          v += amplitude * ridge * ridge;
          norm += amplitude;
          amplitude *= gain;
          freq *= lacunarity;
        }
        v = norm > 0 ? v / norm : 0;
      } else {
        v = fbmPeriodic(nx, ny, z, frequency, oct, lacunarity, gain) * 0.5 + 0.5;
      }
      const b = toByte(v);
      const o = (y * s + x) * 4;
      data[o] = b;
      data[o + 1] = b;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }

  return makeTexture(gl, s, s, data, {
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    minFilter: gl.LINEAR_MIPMAP_LINEAR,
    magFilter: gl.LINEAR,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
    anisotropy: options.anisotropy || 1,
    generateMipmaps: true
  });
}

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
export function gradientTexture(gl, size = 256, stops = null, options = {}) {
  const s = Math.max(2, size | 0);
  const list = [];
  const source = stops && stops.length > 0 ? stops : [[0, 0x000000], [1, 0xffffff]];

  const rgba = new Uint8Array(4);
  for (let i = 0, n = source.length; i < n; i++) {
    const stop = source[i];
    let t;
    let color;
    if (Array.isArray(stop)) {
      t = stop[0];
      color = stop[1];
    } else {
      t = stop.t !== undefined ? stop.t : (stop.offset !== undefined ? stop.offset : i / Math.max(1, n - 1));
      color = stop.color !== undefined ? stop.color : stop;
    }
    encodeColor(color, rgba, 0);
    list.push({
      t: Math.max(0, Math.min(1, t)),
      r: srgbToLinear(rgba[0] / 255),
      g: srgbToLinear(rgba[1] / 255),
      b: srgbToLinear(rgba[2] / 255),
      a: rgba[3] / 255
    });
  }
  list.sort((a, b) => a.t - b.t);

  const data = new Uint8Array(s * 4);
  let cursor = 0;
  for (let x = 0; x < s; x++) {
    const t = s > 1 ? x / (s - 1) : 0;
    while (cursor < list.length - 2 && list[cursor + 1].t < t) cursor++;
    const a = list[cursor];
    const b = list[Math.min(cursor + 1, list.length - 1)];
    const span = b.t - a.t;
    let k = span > 1e-8 ? (t - a.t) / span : 0;
    if (k < 0) k = 0;
    else if (k > 1) k = 1;

    const o = x * 4;
    data[o] = toByte(linearToSrgb(a.r + (b.r - a.r) * k));
    data[o + 1] = toByte(linearToSrgb(a.g + (b.g - a.g) * k));
    data[o + 2] = toByte(linearToSrgb(a.b + (b.b - a.b) * k));
    data[o + 3] = toByte(a.a + (b.a - a.a) * k);
  }

  return makeTexture(gl, s, 1, data, {
    internalFormat: gl.SRGB8_ALPHA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
    wrapS: options.wrap !== undefined ? options.wrap : gl.CLAMP_TO_EDGE,
    wrapT: gl.CLAMP_TO_EDGE,
    generateMipmaps: false
  });
}

/**
 * Reads a height sample from a user supplied buffer with wrap-around.
 * @param {ArrayBufferView|Array<number>} heights
 * @param {number} size
 * @param {number} channels
 * @param {number} scale Normalization factor (1/255 for byte data).
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function sampleHeight(heights, size, channels, scale, x, y) {
  const xi = ((x % size) + size) % size;
  const yi = ((y % size) + size) % size;
  return heights[(yi * size + xi) * channels] * scale;
}

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
export function normalMapFromHeight(gl, heightData, size, strength = 1, options = {}) {
  const s = Math.max(2, size | 0);
  const channels = heightData.length >= s * s * 4 ? 4 : 1;
  const isByte = heightData instanceof Uint8Array || heightData instanceof Uint8ClampedArray;
  const scale = isByte ? 1 / 255 : 1;
  const data = new Uint8Array(s * s * 4);

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const h00 = sampleHeight(heightData, s, channels, scale, x - 1, y - 1);
      const h10 = sampleHeight(heightData, s, channels, scale, x, y - 1);
      const h20 = sampleHeight(heightData, s, channels, scale, x + 1, y - 1);
      const h01 = sampleHeight(heightData, s, channels, scale, x - 1, y);
      const h11 = sampleHeight(heightData, s, channels, scale, x, y);
      const h21 = sampleHeight(heightData, s, channels, scale, x + 1, y);
      const h02 = sampleHeight(heightData, s, channels, scale, x - 1, y + 1);
      const h12 = sampleHeight(heightData, s, channels, scale, x, y + 1);
      const h22 = sampleHeight(heightData, s, channels, scale, x + 1, y + 1);

      // Sobel operator.
      const dx = (h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02);
      const dy = (h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20);

      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;

      const o = (y * s + x) * 4;
      data[o] = toByte(nx * 0.5 + 0.5);
      data[o + 1] = toByte(ny * 0.5 + 0.5);
      data[o + 2] = toByte(nz * 0.5 + 0.5);
      data[o + 3] = toByte(h11);
    }
  }

  return makeTexture(gl, s, s, data, {
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    minFilter: gl.LINEAR_MIPMAP_LINEAR,
    magFilter: gl.LINEAR,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
    anisotropy: options.anisotropy || 1,
    generateMipmaps: true
  });
}

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
export function uvGridTexture(gl, size = 512, options = {}) {
  const s = Math.max(8, size | 0);
  const cells = Math.max(1, (options.cells !== undefined ? options.cells : 8) | 0);
  const cellSize = s / cells;
  const border = Math.max(1, Math.round(s / 256));
  const axis = Math.max(2, Math.round(s / 128));
  const data = new Uint8Array(s * s * 4);
  const rgb = new Float32Array(3);
  const dotSize = Math.max(2, Math.round(cellSize / 12));
  const dotPad = Math.max(2, Math.round(cellSize / 10));

  for (let y = 0; y < s; y++) {
    const cy = Math.min(cells - 1, Math.floor(y / cellSize));
    const localY = y - cy * cellSize;
    for (let x = 0; x < s; x++) {
      const cx = Math.min(cells - 1, Math.floor(x / cellSize));
      const localX = x - cx * cellSize;
      const index = cy * cells + cx;

      // Base cell color: golden ratio hue rotation + checker lightness.
      hslToSrgb(index * 0.381966011, 0.55, ((cx + cy) & 1) === 0 ? 0.55 : 0.4, rgb, 0);
      let r = rgb[0];
      let g = rgb[1];
      let b = rgb[2];

      // Cell borders.
      if (localX < border || localY < border || localX >= cellSize - border || localY >= cellSize - border) {
        r = 0.92; g = 0.92; b = 0.92;
      }

      // Binary markers: column bits on the top row, row bits below.
      const bitRow = Math.floor((localY - dotPad) / (dotSize * 2));
      if (localX >= dotPad && localY >= dotPad && (bitRow === 0 || bitRow === 1)) {
        const bitIndex = Math.floor((localX - dotPad) / (dotSize * 2));
        const inDotX = (localX - dotPad) % (dotSize * 2) < dotSize;
        const inDotY = (localY - dotPad) % (dotSize * 2) < dotSize;
        if (bitIndex < 6 && inDotX && inDotY) {
          const value = bitRow === 0 ? cx : cy;
          const on = ((value >> (5 - bitIndex)) & 1) === 1;
          if (on) { r = 0.02; g = 0.02; b = 0.02; }
        }
      }

      // Texture center axes.
      const half = s * 0.5;
      if (Math.abs(x - half) < axis) { r = 0.05; g = 0.85; b = 0.15; }
      if (Math.abs(y - half) < axis) { r = 0.9; g = 0.1; b = 0.1; }

      const o = (y * s + x) * 4;
      data[o] = toByte(r);
      data[o + 1] = toByte(g);
      data[o + 2] = toByte(b);
      data[o + 3] = 255;
    }
  }

  return makeTexture(gl, s, s, data, {
    internalFormat: gl.SRGB8_ALPHA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    minFilter: gl.LINEAR_MIPMAP_LINEAR,
    magFilter: gl.LINEAR,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
    anisotropy: options.anisotropy || 4,
    generateMipmaps: true
  });
}

/**
 * Van der Corput radical inverse (base 2) for the Hammersley sequence.
 * @param {number} i
 * @returns {number}
 */
function radicalInverse(i) {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

/**
 * Smith geometry term with the IBL remapping (k = a^2 / 2).
 * @param {number} nDotV
 * @param {number} nDotL
 * @param {number} roughness
 * @returns {number}
 */
function smithGeometryIBL(nDotV, nDotL, roughness) {
  const a = roughness * roughness;
  const k = a * 0.5;
  const gv = nDotV / (nDotV * (1 - k) + k);
  const gl2 = nDotL / (nDotL * (1 - k) + k);
  return gv * gl2;
}

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
export function brdfLUTTexture(gl, size = 256, sampleCount = 64) {
  const s = Math.max(4, size | 0);
  const samples = Math.max(8, sampleCount | 0);
  const data = new Float32Array(s * s * 2);

  for (let y = 0; y < s; y++) {
    const roughness = Math.max(1e-3, (y + 0.5) / s);
    const alpha = roughness * roughness;
    for (let x = 0; x < s; x++) {
      const nDotV = Math.max(1e-3, (x + 0.5) / s);
      const vx = Math.sqrt(Math.max(0, 1 - nDotV * nDotV));
      const vz = nDotV;

      let A = 0;
      let B = 0;
      for (let i = 0; i < samples; i++) {
        const u1 = i / samples;
        const u2 = radicalInverse(i);

        // GGX importance sampling around N = (0, 0, 1).
        const phi = 2 * Math.PI * u1;
        const cosTheta = Math.sqrt((1 - u2) / (1 + (alpha * alpha - 1) * u2));
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        // V lies in the XZ plane, so H.y never contributes to dot(V, H).
        const hx = sinTheta * Math.cos(phi);
        const hz = cosTheta;

        // L = reflect(-V, H); with N = (0,0,1) only L.z is needed for N.L.
        const vDotH = vx * hx + vz * hz;
        const nDotL = 2 * vDotH * hz - vz;
        if (nDotL <= 0) continue;
        const nDotH = Math.max(0, hz);
        const vDotHc = Math.max(0, vDotH);

        const g = smithGeometryIBL(nDotV, nDotL, roughness);
        const gVis = (g * vDotHc) / Math.max(1e-6, nDotH * nDotV);
        const fc = Math.pow(1 - vDotHc, 5);

        A += (1 - fc) * gVis;
        B += fc * gVis;
      }

      const o = (y * s + x) * 2;
      data[o] = A / samples;
      data[o + 1] = B / samples;
    }
  }

  return makeTexture(gl, s, s, data, {
    internalFormat: gl.RG16F,
    format: gl.RG,
    type: gl.FLOAT,
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
    wrapS: gl.CLAMP_TO_EDGE,
    wrapT: gl.CLAMP_TO_EDGE,
    generateMipmaps: false
  });
}

/**
 * Generates a solid color texture, handy as a default map.
 * @param {WebGL2RenderingContext} gl
 * @param {number|object|Array<number>} [color]
 * @param {number} [size]
 * @returns {Texture}
 */
export function solidColorTexture(gl, color = 0xffffff, size = 4) {
  const s = Math.max(1, size | 0);
  const data = new Uint8Array(s * s * 4);
  const c = new Uint8Array(4);
  encodeColor(color, c, 0);
  for (let i = 0, n = s * s; i < n; i++) {
    const o = i * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = c[3];
  }
  return makeTexture(gl, s, s, data, {
    internalFormat: gl.SRGB8_ALPHA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
    generateMipmaps: false
  });
}

/**
 * Builds a height field by sampling tileable fbm noise; feed it to
 * {@link normalMapFromHeight} or to `createTerrain`.
 * @param {number} size
 * @param {number} [frequency]
 * @param {number} [octaves]
 * @param {number} [z]
 * @returns {Float32Array} `size * size` values in 0..1.
 */
export function noiseHeightField(size, frequency = 4, octaves = 5, z = 0) {
  const s = Math.max(2, size | 0);
  const freq = Math.max(1, frequency | 0);
  const out = new Float32Array(s * s);
  const inv = freq / s;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      out[y * s + x] = fbmPeriodic(x * inv, y * inv, z, freq, octaves) * 0.5 + 0.5;
    }
  }
  return out;
}
