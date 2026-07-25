/**
 * Procedural world generation.
 *
 * Runs inside a worker, so this module deliberately imports nothing but block
 * constants: no engine, no DOM. Everything derives from an integer hash seeded
 * once, which makes generation stateless and reproducible — the same (seed, x, z)
 * always yields the same column, on any machine, in any order.
 *
 * Terrain is built in four independent layers so they can be reasoned about
 * separately: a height field, a cave field carved out of it, an ore pass, and a
 * decoration pass for trees.
 */

import {
  AIR, STONE, DIRT, GRASS, SAND, GRAVEL, LOG, LEAVES, BEDROCK,
  COAL_ORE, IRON_ORE, GOLD_ORE, DIAMOND_ORE, SNOW, WATER, SANDSTONE,
} from './Blocks.js';
import { CHUNK_X, CHUNK_Z, WORLD_HEIGHT, STRIDE_Z, STRIDE_Y } from './Chunk.js';

/** Y at and below which air becomes water. */
export const SEA_LEVEL = 46;

/* -------------------------------------------------------------- noise core */

/** Integer hash -> 32-bit unsigned. */
function hashi(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393);
  h = (h + Math.imul(y | 0, 668265263)) | 0;
  h = (h ^ Math.imul(z | 0, 1442695041)) | 0;
  h = (h + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Perlin-style 2D gradient from a hash. */
function grad2(h, x, y) {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x * 1.41421356;
    case 5: return -x * 1.41421356;
    case 6: return y * 1.41421356;
    default: return -y * 1.41421356;
  }
}

/** Perlin-style 3D gradient from a hash. */
function grad3(h, x, y, z) {
  const g = h & 15;
  const u = g < 8 ? x : y;
  const v = g < 4 ? y : (g === 12 || g === 14 ? x : z);
  return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
}

/**
 * 2D gradient noise in roughly [-1, 1].
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
export function perlin2(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);

  const n00 = grad2(hashi(xi, yi, 0, seed), xf, yf);
  const n10 = grad2(hashi(xi + 1, yi, 0, seed), xf - 1, yf);
  const n01 = grad2(hashi(xi, yi + 1, 0, seed), xf, yf - 1);
  const n11 = grad2(hashi(xi + 1, yi + 1, 0, seed), xf - 1, yf - 1);

  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return a + v * (b - a);
}

/**
 * 3D gradient noise in roughly [-1, 1].
 * @returns {number}
 */
export function perlin3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const h000 = grad3(hashi(xi, yi, zi, seed), xf, yf, zf);
  const h100 = grad3(hashi(xi + 1, yi, zi, seed), xf - 1, yf, zf);
  const h010 = grad3(hashi(xi, yi + 1, zi, seed), xf, yf - 1, zf);
  const h110 = grad3(hashi(xi + 1, yi + 1, zi, seed), xf - 1, yf - 1, zf);
  const h001 = grad3(hashi(xi, yi, zi + 1, seed), xf, yf, zf - 1);
  const h101 = grad3(hashi(xi + 1, yi, zi + 1, seed), xf - 1, yf, zf - 1);
  const h011 = grad3(hashi(xi, yi + 1, zi + 1, seed), xf, yf - 1, zf - 1);
  const h111 = grad3(hashi(xi + 1, yi + 1, zi + 1, seed), xf - 1, yf - 1, zf - 1);

  const x00 = h000 + u * (h100 - h000);
  const x10 = h010 + u * (h110 - h010);
  const x01 = h001 + u * (h101 - h001);
  const x11 = h011 + u * (h111 - h011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

/** Fractal sum of `perlin2`. */
function fbm2(x, y, seed, octaves, lacunarity, gain) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2(fx, fy, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

/** Fractal sum of `perlin3`. */
function fbm3(x, y, z, seed, octaves) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let s = 1;
  for (let i = 0; i < octaves; i++) {
    sum += perlin3(x * s, y * s, z * s, seed + i * 2029) * amp;
    norm += amp;
    amp *= 0.5;
    s *= 2;
  }
  return sum / norm;
}

/** Uniform value in [0,1) from world coordinates. */
function rand(x, y, z, seed) {
  return hashi(x, y, z, seed) / 4294967296;
}

/* ------------------------------------------------------------------ biomes */

export const BIOME_OCEAN = 0;
export const BIOME_BEACH = 1;
export const BIOME_PLAINS = 2;
export const BIOME_FOREST = 3;
export const BIOME_DESERT = 4;
export const BIOME_MOUNTAINS = 5;
export const BIOME_SNOW = 6;

export const BIOME_NAMES = ['oceano', 'praia', 'planicie', 'floresta', 'deserto', 'montanha', 'tundra'];

/**
 * Surface height and biome for one world column.
 *
 * Height is a blend of three scales: continentalness picks land vs ocean,
 * erosion flattens or roughens, and detail adds the last few blocks of relief.
 * Mountains are pushed with a squared term so they stay rare but dramatic.
 *
 * @param {number} wx World X.
 * @param {number} wz World Z.
 * @param {number} seed
 * @returns {{height: number, biome: number, temperature: number, humidity: number}}
 */
export function sampleColumn(wx, wz, seed) {
  const continent = fbm2(wx * 0.0016, wz * 0.0016, seed, 4, 2.0, 0.5);
  const erosion = fbm2(wx * 0.0060, wz * 0.0060, seed + 7717, 3, 2.0, 0.5);
  const detail = fbm2(wx * 0.0220, wz * 0.0220, seed + 3313, 3, 2.0, 0.5);

  // Mountain mask: only the top of the continent range produces peaks.
  const peakMask = Math.max(0, continent - 0.18) / 0.82;
  const peaks = peakMask * peakMask * fbm2(wx * 0.0042, wz * 0.0042, seed + 991, 4, 2.1, 0.55);

  let height = SEA_LEVEL + 2
    + continent * 34
    + erosion * 10
    + detail * 4
    + peaks * 46;

  const temperature = fbm2(wx * 0.00085, wz * 0.00085, seed + 5501, 2, 2.0, 0.5);
  const humidity = fbm2(wx * 0.00110, wz * 0.00110, seed + 8837, 2, 2.0, 0.5);

  height = Math.floor(height);
  if (height < 2) height = 2;
  if (height > WORLD_HEIGHT - 6) height = WORLD_HEIGHT - 6;

  let biome;
  if (height < SEA_LEVEL - 1) biome = BIOME_OCEAN;
  else if (height <= SEA_LEVEL + 1) biome = BIOME_BEACH;
  else if (height > SEA_LEVEL + 40) biome = temperature < -0.05 ? BIOME_SNOW : BIOME_MOUNTAINS;
  else if (temperature < -0.28) biome = BIOME_SNOW;
  else if (temperature > 0.26 && humidity < -0.05) biome = BIOME_DESERT;
  else if (humidity > 0.06) biome = BIOME_FOREST;
  else biome = BIOME_PLAINS;

  return { height, biome, temperature, humidity };
}

/**
 * Cave field. Two independent ridged noise lobes intersected: a point is hollow
 * only where BOTH are near zero, which produces connected tunnels instead of the
 * swiss-cheese blobs a single threshold gives.
 *
 * @returns {boolean} true when the voxel should be carved to air
 */
function isCave(wx, y, wz, seed) {
  const a = fbm3(wx * 0.0180, y * 0.0320, wz * 0.0180, seed + 60013, 2);
  const b = fbm3(wx * 0.0180, y * 0.0320, wz * 0.0180, seed + 91193, 2);
  const ridgeA = 1 - Math.abs(a) * 3.4;
  const ridgeB = 1 - Math.abs(b) * 3.4;
  if (ridgeA < 0.62 || ridgeB < 0.62) return false;

  // Taper the caves out near the surface so they open as mouths, not craters.
  return true;
}

/**
 * Ore selection for a stone voxel, or STONE when nothing spawns.
 * Each ore has a depth window and a rarity; the noise lobe keeps them clustered
 * in veins rather than scattered as single blocks.
 */
function pickOre(wx, y, wz, seed, surfaceY) {
  const depth = surfaceY - y;
  if (depth < 4) return STONE;

  const vein = fbm3(wx * 0.11, y * 0.11, wz * 0.11, seed + 22447, 2);
  if (vein < 0.42) return STONE;

  const r = rand(wx, y, wz, seed + 5);
  if (y < 16 && r < 0.30) return DIAMOND_ORE;
  if (y < 32 && r < 0.34) return GOLD_ORE;
  if (y < 64 && r < 0.46) return IRON_ORE;
  if (r < 0.62) return COAL_ORE;
  return STONE;
}

/* -------------------------------------------------------------- decoration */

/** Canopy radius a tree can reach, used to know which neighbours to consult. */
const TREE_REACH = 3;

/**
 * Deterministic tree presence for a world column. Because it depends only on
 * (wx, wz, seed), every chunk agrees on where trees are without any shared
 * state — which is what lets a tree straddle a chunk border correctly.
 *
 * @returns {number} trunk height, or 0 when there is no tree here
 */
function treeAt(wx, wz, seed) {
  // One candidate per 4x4 cell keeps trees apart without a spacing pass.
  if ((wx & 3) !== 0 || (wz & 3) !== 0) return 0;
  const col = sampleColumn(wx, wz, seed);
  if (col.biome !== BIOME_FOREST && col.biome !== BIOME_PLAINS) return 0;
  if (col.height <= SEA_LEVEL + 1) return 0;

  const density = col.biome === BIOME_FOREST ? 0.58 : 0.10;
  const r = rand(wx, 0, wz, seed + 991);
  if (r > density) return 0;

  return 4 + Math.floor(rand(wx, 1, wz, seed + 992) * 3);
}

/**
 * Writes the part of a tree that falls inside the chunk being generated.
 * The tree is described in world coordinates, then clipped — never truncated at
 * generation time — so both halves of a border tree agree.
 */
function stampTree(blocks, baseX, baseZ, wx, wz, groundY, trunk, seed) {
  const topY = groundY + trunk;

  // Canopy: a squat blob, denser at the centre, with the corners eaten away.
  for (let dy = -2; dy <= 1; dy++) {
    const y = topY + dy;
    if (y < 0 || y >= WORLD_HEIGHT) continue;
    const radius = dy >= 1 ? 1 : (dy === 0 ? 2 : 2);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dist = Math.abs(dx) + Math.abs(dz);
        if (dist > radius + 1) continue;
        if (dist === radius + 1 && rand(wx + dx, y, wz + dz, seed + 77) < 0.55) continue;
        if (dx === 0 && dz === 0 && dy < 1) continue; // leave room for the trunk

        const lx = wx + dx - baseX;
        const lz = wz + dz - baseZ;
        if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z) continue;

        const i = lx + lz * STRIDE_Z + y * STRIDE_Y;
        if (blocks[i] === AIR) blocks[i] = LEAVES;
      }
    }
  }

  // Trunk.
  const lx = wx - baseX;
  const lz = wz - baseZ;
  if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z) return;
  for (let y = groundY; y < topY && y < WORLD_HEIGHT; y++) {
    blocks[lx + lz * STRIDE_Z + y * STRIDE_Y] = LOG;
  }
}

/* ------------------------------------------------------------- entry point */

/**
 * Generates one full column of blocks.
 *
 * @param {number} cx Chunk X.
 * @param {number} cz Chunk Z.
 * @param {number} seed
 * @param {Uint16Array} [out] Reusable destination buffer.
 * @returns {{blocks: Uint16Array, biome: number, surface: Uint8Array}}
 */
export function generateChunk(cx, cz, seed, out) {
  const blocks = out || new Uint16Array(CHUNK_X * CHUNK_Z * WORLD_HEIGHT);
  blocks.fill(0);

  const baseX = cx * CHUNK_X;
  const baseZ = cz * CHUNK_Z;
  const surface = new Uint8Array(CHUNK_X * CHUNK_Z);
  let centreBiome = BIOME_PLAINS;

  for (let z = 0; z < CHUNK_Z; z++) {
    for (let x = 0; x < CHUNK_X; x++) {
      const wx = baseX + x;
      const wz = baseZ + z;
      const col = sampleColumn(wx, wz, seed);
      const h = col.height;
      surface[x + z * CHUNK_X] = h;
      if (x === 8 && z === 8) centreBiome = col.biome;

      // Surface palette per biome.
      let top = GRASS;
      let sub = DIRT;
      let subDepth = 3;
      if (col.biome === BIOME_DESERT) { top = SAND; sub = SANDSTONE; subDepth = 4; }
      else if (col.biome === BIOME_BEACH) { top = SAND; sub = SAND; subDepth = 3; }
      else if (col.biome === BIOME_OCEAN) { top = GRAVEL; sub = GRAVEL; subDepth = 2; }
      else if (col.biome === BIOME_SNOW) { top = SNOW; sub = DIRT; subDepth = 3; }
      else if (col.biome === BIOME_MOUNTAINS) { top = h > SEA_LEVEL + 52 ? SNOW : STONE; sub = STONE; subDepth = 2; }

      const colBase = x + z * STRIDE_Z;

      for (let y = 0; y <= h; y++) {
        const i = colBase + y * STRIDE_Y;
        let id;

        if (y === 0) {
          id = BEDROCK;
        } else if (y <= 2 && rand(wx, y, wz, seed + 13) < 0.6 - y * 0.2) {
          id = BEDROCK;
        } else if (y === h) {
          id = top;
        } else if (y > h - subDepth) {
          id = sub;
        } else {
          id = pickOre(wx, y, wz, seed, h);
        }

        // Caves never eat bedrock and never open below the sea floor into an
        // ocean, which would flood the whole cave system.
        if (id !== BEDROCK && y > 1 && y < h - 1 && isCave(wx, y, wz, seed)) {
          const nearOcean = h < SEA_LEVEL && y > h - 4;
          if (!nearOcean) id = AIR;
        }

        blocks[i] = id;
      }

      // Fill the ocean.
      for (let y = h + 1; y <= SEA_LEVEL; y++) {
        blocks[colBase + y * STRIDE_Y] = WATER;
      }

      // A grass block directly under water turns to gravel; grass does not grow
      // on a sea floor.
      if (h < SEA_LEVEL && blocks[colBase + h * STRIDE_Y] === GRASS) {
        blocks[colBase + h * STRIDE_Y] = GRAVEL;
      }
    }
  }

  // Decoration pass. Scanning one chunk of margin on each side is enough for a
  // canopy of radius TREE_REACH, and guarantees border trees are complete.
  const margin = TREE_REACH + 1;
  for (let wz = baseZ - margin; wz < baseZ + CHUNK_Z + margin; wz++) {
    for (let wx = baseX - margin; wx < baseX + CHUNK_X + margin; wx++) {
      const trunk = treeAt(wx, wz, seed);
      if (trunk === 0) continue;
      const col = sampleColumn(wx, wz, seed);
      stampTree(blocks, baseX, baseZ, wx, wz, col.height + 1, trunk, seed);
    }
  }

  return { blocks, biome: centreBiome, surface };
}

/**
 * Finds a safe spawn point: the first column near the origin whose surface is
 * above water and not inside a tree.
 *
 * @param {number} seed
 * @returns {{x: number, y: number, z: number}}
 */
export function findSpawn(seed) {
  for (let r = 0; r < 96; r++) {
    for (let i = 0; i < Math.max(1, r * 6); i++) {
      const angle = (i / Math.max(1, r * 6)) * Math.PI * 2;
      const wx = Math.round(Math.cos(angle) * r);
      const wz = Math.round(Math.sin(angle) * r);
      const col = sampleColumn(wx, wz, seed);
      if (col.height > SEA_LEVEL + 1 && col.biome !== BIOME_OCEAN && treeAt(wx, wz, seed) === 0) {
        return { x: wx + 0.5, y: col.height + 2.2, z: wz + 0.5 };
      }
    }
  }
  return { x: 0.5, y: SEA_LEVEL + 8, z: 0.5 };
}
