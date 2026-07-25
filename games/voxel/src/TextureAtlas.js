/**
 * Procedural block textures baked into a 2D **array** texture.
 *
 * An array texture rather than a classic atlas is the whole reason greedy
 * meshing works cleanly here: a merged quad spanning N blocks just needs UVs
 * running 0..N with REPEAT wrapping, which an atlas cannot do without bleeding
 * into its neighbours. Mipmaps are also per-layer, so distant terrain filters
 * correctly instead of smearing unrelated textures together.
 *
 * Everything is generated from an integer hash, so the result is identical on
 * every machine and no asset ever has to be downloaded.
 */

import { createTextureArray } from '../../../src/render/Texture.js';
import { TEXTURE_NAMES, LAYER_BY_NAME } from './Blocks.js';

/** Edge length of one block texture, in texels. */
export const TILE = 16;

/* ------------------------------------------------------------------ noise */

/**
 * Deterministic 2D integer hash in [0,1).
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
function hash2(x, y, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2246822519;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep weight. */
function fade(t) { return t * t * (3 - 2 * t); }

/**
 * Tiling value noise: the lattice wraps on `period`, so the texture is seamless
 * when repeated across a greedy quad.
 * @param {number} x
 * @param {number} y
 * @param {number} period Lattice cells across the tile.
 * @param {number} seed
 * @returns {number} 0..1
 */
function valueNoise(x, y, period, seed) {
  const fx = x * period / TILE;
  const fy = y * period / TILE;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fade(fx - x0);
  const ty = fade(fy - y0);
  const wrap = (v) => ((v % period) + period) % period;
  const x0w = wrap(x0);
  const y0w = wrap(y0);
  const x1w = wrap(x0 + 1);
  const y1w = wrap(y0 + 1);
  const n00 = hash2(x0w, y0w, seed);
  const n10 = hash2(x1w, y0w, seed);
  const n01 = hash2(x0w, y1w, seed);
  const n11 = hash2(x1w, y1w, seed);
  const a = n00 + (n10 - n00) * tx;
  const b = n01 + (n11 - n01) * tx;
  return a + (b - a) * ty;
}

/**
 * Fractal sum of tiling value noise.
 * @param {number} x
 * @param {number} y
 * @param {number} period
 * @param {number} octaves
 * @param {number} seed
 * @returns {number} 0..1
 */
function fbm(x, y, period, octaves, seed) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x, y, p, seed + i * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------- generators */

/**
 * Runs `fn(x, y)` over the tile and packs the result into RGBA8.
 * @param {function(number, number): number[]} fn Returns [r,g,b,a] in 0..255.
 * @returns {Uint8Array}
 */
function paint(fn) {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const c = fn(x, y);
      const o = (y * TILE + x) * 4;
      out[o] = c[0] < 0 ? 0 : c[0] > 255 ? 255 : c[0];
      out[o + 1] = c[1] < 0 ? 0 : c[1] > 255 ? 255 : c[1];
      out[o + 2] = c[2] < 0 ? 0 : c[2] > 255 ? 255 : c[2];
      out[o + 3] = c[3] === undefined ? 255 : c[3];
    }
  }
  return out;
}

/** Tints a base colour by a scalar factor. */
function tint(base, f, a) {
  return [base[0] * f, base[1] * f, base[2] * f, a === undefined ? 255 : a];
}

/**
 * Speckled mineral surface: a base colour modulated by two noise octaves plus
 * sparse darker grains.
 */
function speckled(base, seed, contrast, grain) {
  return (x, y) => {
    const n = fbm(x, y, 4, 3, seed);
    let f = 1 - contrast * 0.5 + n * contrast;
    if (hash2(x, y, seed + 555) < grain) f *= 0.82;
    return tint(base, f);
  };
}

/** Cobble/gravel style: rounded cells with dark mortar between them. */
function cellular(base, seed, cells, mortar) {
  const pts = [];
  for (let i = 0; i < cells; i++) {
    pts.push([hash2(i, 0, seed) * TILE, hash2(0, i, seed + 31) * TILE]);
  }
  return (x, y) => {
    let d0 = 1e9;
    let d1 = 1e9;
    for (let i = 0; i < pts.length; i++) {
      // Toroidal distance keeps the pattern seamless across tile borders.
      let dx = Math.abs(pts[i][0] - x - 0.5);
      let dy = Math.abs(pts[i][1] - y - 0.5);
      if (dx > TILE * 0.5) dx = TILE - dx;
      if (dy > TILE * 0.5) dy = TILE - dy;
      const d = dx * dx + dy * dy;
      if (d < d0) { d1 = d0; d0 = d; } else if (d < d1) { d1 = d; }
    }
    const edge = Math.sqrt(d1) - Math.sqrt(d0);
    let f = 0.86 + fbm(x, y, 8, 2, seed + 9) * 0.3;
    if (edge < mortar) f *= 0.6;
    return tint(base, f);
  };
}

/**
 * Ore: stone base with a few blobs of the ore colour.
 * @param {number[]} oreColor
 */
function ore(oreColor, seed, blobs, radius) {
  const stone = speckled([124, 124, 124], 11, 0.34, 0.12);
  const pts = [];
  for (let i = 0; i < blobs; i++) {
    pts.push([2 + hash2(i, 3, seed) * (TILE - 4), 2 + hash2(3, i, seed + 17) * (TILE - 4)]);
  }
  return (x, y) => {
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - x - 0.5;
      const dy = pts[i][1] - y - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = radius * (0.7 + hash2(i, x ^ y, seed + 5) * 0.6);
      if (d < r) {
        const f = 0.78 + (1 - d / r) * 0.45;
        return tint(oreColor, f);
      }
    }
    return stone(x, y);
  };
}

/**
 * The texture table. Every entry is `name -> (x, y) => [r,g,b,a]`.
 * Colours are authored in sRGB; the atlas is uploaded as SRGB8_ALPHA8 so the
 * GPU linearises on sample and the shader never has to convert.
 */
const GENERATORS = {
  stone: speckled([128, 128, 128], 11, 0.34, 0.12),
  dirt: speckled([134, 96, 67], 23, 0.36, 0.18),
  sand: speckled([219, 207, 160], 31, 0.22, 0.1),
  gravel: cellular([136, 130, 127], 47, 9, 1.1),
  cobblestone: cellular([122, 122, 122], 53, 7, 1.6),
  bedrock: speckled([76, 76, 78], 61, 0.85, 0.34),
  snow: speckled([242, 246, 250], 67, 0.1, 0.05),

  grass_top: (x, y) => {
    const n = fbm(x, y, 4, 3, 71);
    const f = 0.8 + n * 0.42;
    return tint([106, 156, 74], f);
  },

  /** Dirt with a ragged green cap, height driven by noise so it never looks cut. */
  grass_side: (x, y) => {
    const edge = 3 + Math.floor(hash2(x, 0, 73) * 2.6);
    if (y < edge) {
      const f = 0.8 + fbm(x, y, 4, 3, 71) * 0.42;
      return tint([106, 156, 74], f);
    }
    if (y === edge) {
      const f = 0.62 + fbm(x, y, 4, 2, 71) * 0.3;
      return tint([92, 132, 62], f);
    }
    const n = fbm(x, y, 4, 3, 23);
    return tint([134, 96, 67], 0.82 + n * 0.36);
  },

  /** Vertical bark streaks. */
  log_side: (x, y) => {
    const streak = fbm(x, y * 0.25, 6, 2, 83);
    const f = 0.74 + streak * 0.44;
    return tint([104, 78, 47], f);
  },

  /** Concentric growth rings around the tile centre. */
  log_top: (x, y) => {
    const dx = x - TILE * 0.5 + 0.5;
    const dy = y - TILE * 0.5 + 0.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    const rings = Math.sin(d * 2.2 + fbm(x, y, 4, 2, 89) * 1.6) * 0.5 + 0.5;
    const f = 0.78 + rings * 0.34;
    return tint([160, 128, 82], f);
  },

  /** Cutout foliage: holes in the alpha channel, not a flat green square. */
  leaves: (x, y) => {
    const n = fbm(x, y, 5, 3, 97);
    if (n < 0.36) return [0, 0, 0, 0];
    const f = 0.62 + n * 0.7;
    return tint([74, 128, 52], f, 255);
  },

  /** Horizontal boards with darker seams every four texels. */
  planks: (x, y) => {
    const board = Math.floor(y / 4);
    const seam = (y % 4) === 0;
    const grain = fbm(x, board * 4, 8, 2, 101 + board * 13);
    let f = 0.82 + grain * 0.36;
    if (seam) f *= 0.68;
    return tint([164, 130, 82], f);
  },

  sandstone_top: speckled([222, 210, 160], 103, 0.18, 0.08),

  /** Layered sedimentary bands. */
  sandstone_side: (x, y) => {
    const band = Math.floor(y / 5);
    const n = fbm(x, y, 6, 2, 107 + band * 17);
    const f = (band % 2 === 0 ? 0.92 : 0.82) + n * 0.24;
    return tint([220, 206, 156], f);
  },

  /** Translucent blue with a faint ripple; alpha drives the blended pass. */
  water: (x, y) => {
    const n = fbm(x, y, 4, 3, 109);
    const f = 0.78 + n * 0.4;
    return tint([56, 108, 196], f, 190);
  },

  /** Mostly empty with a visible frame, so panes read as panes. */
  glass: (x, y) => {
    const border = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
    if (border) return [206, 226, 234, 235];
    const spark = (x === 3 && y < 6) || (y === 3 && x > 9);
    if (spark) return [226, 240, 246, 140];
    return [0, 0, 0, 0];
  },

  /** Emissive-looking speckle; the actual light comes from the light engine. */
  glowstone: (x, y) => {
    const n = fbm(x, y, 5, 3, 113);
    const f = 0.72 + n * 0.62;
    return tint([236, 196, 110], f);
  },

  coal_ore: ore([44, 44, 46], 127, 5, 2.4),
  iron_ore: ore([196, 152, 118], 131, 5, 2.3),
  gold_ore: ore([238, 200, 84], 137, 4, 2.2),
  diamond_ore: ore([104, 224, 224], 139, 4, 2.1),
};

/**
 * Builds the block texture array and wires the layer indices into the block
 * registry.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [options]
 * @param {number} [options.anisotropy=8]
 * @returns {{texture: import('../../../src/render/Texture.js').Texture, layerByName: Map<string, number>, layerCount: number}}
 */
export function buildBlockAtlas(gl, options = {}) {
  // Layer order comes from Blocks.TEXTURE_NAMES, never from the key order of
  // GENERATORS: the workers derive their indices from that same constant list
  // and the two must not be able to drift apart.
  const names = TEXTURE_NAMES;
  const layerCount = names.length;

  for (let i = 0; i < layerCount; i++) {
    if (GENERATORS[names[i]] === undefined) {
      throw new Error('TextureAtlas: falta o gerador da textura "' + names[i] + '".');
    }
  }

  const texture = createTextureArray(gl, {
    width: TILE,
    height: TILE,
    depth: layerCount,
    internalFormat: 'srgb8_alpha8',
    // Nearest magnification is the whole aesthetic; trilinear minification keeps
    // distant terrain from aliasing into noise.
    magFilter: 'nearest',
    minFilter: 'nearest-mipmap-linear',
    wrapS: 'repeat',
    wrapT: 'repeat',
    // Must be requested up front: the texture uses immutable storage, so the mip
    // chain has to be allocated by texStorage3D before any layer is uploaded.
    generateMipmaps: true,
    anisotropy: options.anisotropy !== undefined ? options.anisotropy : 8,
    flipY: false,
  });

  for (let i = 0; i < layerCount; i++) {
    texture.uploadLayer(paint(GENERATORS[names[i]]), i);
  }

  texture.generateMipmaps();

  return { texture, layerByName: LAYER_BY_NAME, layerCount };
}

/**
 * Renders one block texture into a canvas, for hotbar icons and the block
 * picker. Returns a data URL so the HUD can use it straight from CSS.
 *
 * @param {string} name
 * @param {number} [scale=4]
 * @returns {string} data URL
 */
export function textureToDataURL(name, scale = 4) {
  const gen = GENERATORS[name];
  const canvas = document.createElement('canvas');
  canvas.width = TILE * scale;
  canvas.height = TILE * scale;
  const ctx = canvas.getContext('2d');
  if (gen === undefined || ctx === null) return canvas.toDataURL();

  const px = paint(gen);
  const img = ctx.createImageData(TILE, TILE);
  img.data.set(px);

  // Draw at 1:1 into a scratch canvas, then upscale with smoothing off so the
  // icon keeps hard texel edges.
  const scratch = document.createElement('canvas');
  scratch.width = TILE;
  scratch.height = TILE;
  const sctx = scratch.getContext('2d');
  if (sctx === null) return canvas.toDataURL();
  sctx.putImageData(img, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}

/** @returns {string[]} every texture name, in layer order. */
export function atlasTextureNames() {
  return TEXTURE_NAMES.slice();
}
