/**
 * The voxel world: a sparse map of chunk columns plus global block access.
 *
 * Everything above this layer speaks world coordinates and never has to know
 * about chunk boundaries. Everything below it (Chunk, Mesher) works on local
 * indices and never has to bounds check.
 */

import { AIR, IS_SOLID, IS_LIQUID, LIGHT_ABSORB } from './Blocks.js';
import {
  Chunk, CHUNK_X, CHUNK_Z, WORLD_HEIGHT, SECTION_H, SECTION_COUNT,
  STRIDE_Z, STRIDE_Y,
} from './Chunk.js';
import { PAD, PAD_VOLUME, padIndex } from './Mesher.js';
import { Lighting } from './Lighting.js';

/** Scratch neighbourhood buffers, reused for every section meshed. */
const _padBlocks = new Uint16Array(PAD_VOLUME);
const _padLight = new Uint8Array(PAD_VOLUME);

/**
 * A sparse voxel world.
 */
export class World {
  /**
   * @param {Object} [options]
   * @param {number} [options.seed=1337]
   */
  constructor(options = {}) {
    /** @type {number} */
    this.seed = options.seed !== undefined ? options.seed : 1337;

    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();

    /** @type {Lighting} */
    this.lighting = new Lighting(this, { budget: options.lightBudget });

    /**
     * Sections whose mesh no longer matches the data. Stored as
     * `"cx,cz,section"` so a section queued twice in one frame only meshes once.
     * @type {Set<string>}
     */
    this.dirtySections = new Set();

    /** @type {Chunk|null} Last chunk touched, a big win for scanline access. */
    this._cacheChunk = null;
    this._cacheCX = 2147483647;
    this._cacheCZ = 2147483647;

    /** @type {number} Edits applied since load, for the debug overlay. */
    this.editCount = 0;
  }

  /* ------------------------------------------------------------- chunk map */

  /**
   * @param {number} cx
   * @param {number} cz
   * @returns {Chunk|null}
   */
  getChunk(cx, cz) {
    if (cx === this._cacheCX && cz === this._cacheCZ) return this._cacheChunk;
    const chunk = this.chunks.get(cx + ',' + cz) || null;
    this._cacheCX = cx;
    this._cacheCZ = cz;
    this._cacheChunk = chunk;
    return chunk;
  }

  /**
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {Chunk|null}
   */
  getChunkAt(x, z) {
    return this.getChunk(x >> 4, z >> 4);
  }

  /**
   * Registers a generated chunk and wakes up the lighting for it.
   * @param {Chunk} chunk
   */
  addChunk(chunk) {
    this.chunks.set(chunk.key, chunk);
    this._invalidateCache();

    if (chunk.needsLightSeed) this.lighting.seedChunk(chunk);
    chunk.markAllDirty();
    this.markChunkDirty(chunk);

    // The four neighbours can now see across the shared border: their edge
    // faces may need removing and their light may need to spill over.
    for (let i = 0; i < 4; i++) {
      const dx = i === 0 ? 1 : i === 1 ? -1 : 0;
      const dz = i === 2 ? 1 : i === 3 ? -1 : 0;
      const neighbour = this.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (neighbour !== null) {
        neighbour.markAllDirty();
        this.markChunkDirty(neighbour);
      }
    }
    // One call, not one per neighbour: seedBorders compares both sides of each
    // shared face and seeds whichever is brighter, so it already covers the
    // neighbours' side of the exchange.
    this.lighting.seedBorders(chunk);
  }

  /**
   * Drops a chunk and everything derived from it.
   * @param {number} cx
   * @param {number} cz
   * @returns {Chunk|null} the removed chunk, for disposal by the caller
   */
  removeChunk(cx, cz) {
    const key = cx + ',' + cz;
    const chunk = this.chunks.get(key) || null;
    if (chunk === null) return null;
    this.chunks.delete(key);
    this._invalidateCache();
    for (let s = 0; s < SECTION_COUNT; s++) this.dirtySections.delete(key + ',' + s);
    return chunk;
  }

  /** @private */
  _invalidateCache() {
    this._cacheCX = 2147483647;
    this._cacheCZ = 2147483647;
    this._cacheChunk = null;
  }

  /**
   * @param {number} x World X.
   * @param {number} z World Z.
   * @returns {boolean}
   */
  isLoadedAt(x, z) {
    return this.getChunk(x >> 4, z >> 4) !== null;
  }

  /* ---------------------------------------------------------- block access */

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} block id; AIR outside the world or in unloaded chunks
   */
  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR;
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return AIR;
    return chunk.blocks[(x & 15) + (z & 15) * STRIDE_Z + y * STRIDE_Y];
  }

  /** @returns {boolean} true when the voxel stops an entity. */
  isSolid(x, y, z) {
    return IS_SOLID[this.getBlock(x, y, z)] === 1;
  }

  /** @returns {boolean} true when the voxel is a fluid. */
  isLiquid(x, y, z) {
    return IS_LIQUID[this.getBlock(x, y, z)] === 1;
  }

  /**
   * Writes a block and drives every consequence: section invalidation across
   * chunk borders, light propagation and the modified flag for persistence.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} id
   * @returns {boolean} false when the write was rejected or a no-op
   */
  setBlock(x, y, z, id) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return false;

    const lx = x & 15;
    const lz = z & 15;
    const prev = chunk.set(lx, y, lz, id);
    if (prev === id) return false;

    chunk.modified = true;
    this.editCount++;

    this._dirtyAround(chunk, lx, y, lz);
    this.lighting.onBlockChanged(x, y, z, prev, id);
    return true;
  }

  /**
   * Marks the section owning a voxel dirty, plus any neighbouring section or
   * chunk whose faces touch it.
   * @private
   */
  _dirtyAround(chunk, lx, y, lz) {
    chunk.markSectionDirty(y);
    this.markChunkDirty(chunk, y >> 4);
    if (y > 0) this.markChunkDirty(chunk, (y - 1) >> 4);
    if (y < WORLD_HEIGHT - 1) this.markChunkDirty(chunk, (y + 1) >> 4);

    if (lx === 0) this._dirtyNeighbour(chunk.cx - 1, chunk.cz, y);
    else if (lx === 15) this._dirtyNeighbour(chunk.cx + 1, chunk.cz, y);
    if (lz === 0) this._dirtyNeighbour(chunk.cx, chunk.cz - 1, y);
    else if (lz === 15) this._dirtyNeighbour(chunk.cx, chunk.cz + 1, y);
  }

  /** @private */
  _dirtyNeighbour(cx, cz, y) {
    const chunk = this.getChunk(cx, cz);
    if (chunk === null) return;
    chunk.markSectionDirty(y);
    this.markChunkDirty(chunk, y >> 4);
  }

  /* ---------------------------------------------------------- light access */

  /** @returns {number} 0..15 */
  getSkyLight(x, y, z) {
    if (y >= WORLD_HEIGHT) return 15;
    if (y < 0) return 0;
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return 0;
    return chunk.light[(x & 15) + (z & 15) * STRIDE_Z + y * STRIDE_Y] >> 4;
  }

  /** @returns {number} 0..15 */
  getBlockLight(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return 0;
    return chunk.light[(x & 15) + (z & 15) * STRIDE_Z + y * STRIDE_Y] & 15;
  }

  /** @param {number} value 0..15 */
  setSkyLight(x, y, z, value) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return;
    const i = (x & 15) + (z & 15) * STRIDE_Z + y * STRIDE_Y;
    chunk.light[i] = (chunk.light[i] & 0x0f) | (value << 4);
  }

  /** @param {number} value 0..15 */
  setBlockLight(x, y, z, value) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return;
    const i = (x & 15) + (z & 15) * STRIDE_Z + y * STRIDE_Y;
    chunk.light[i] = (chunk.light[i] & 0xf0) | value;
  }

  /**
   * @returns {boolean} true when nothing blocks the sky above this voxel.
   */
  hasSkyAccess(x, y, z) {
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return false;
    return chunk.heightmap[(x & 15) + (z & 15) * CHUNK_X] <= y;
  }

  /**
   * Called by the light engine whenever a light value changed, so the affected
   * section (and its neighbours across a border) get remeshed.
   */
  markLightDirty(x, y, z) {
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return;
    const lx = x & 15;
    const lz = z & 15;
    chunk.markSectionDirty(y);
    this.markChunkDirty(chunk, y >> 4);
    if (lx === 0) this._dirtyNeighbour(chunk.cx - 1, chunk.cz, y);
    else if (lx === 15) this._dirtyNeighbour(chunk.cx + 1, chunk.cz, y);
    if (lz === 0) this._dirtyNeighbour(chunk.cx, chunk.cz - 1, y);
    else if (lz === 15) this._dirtyNeighbour(chunk.cx, chunk.cz + 1, y);
  }

  /* -------------------------------------------------------- dirty tracking */

  /**
   * Queues a section (or the whole column) for remeshing.
   * @param {Chunk} chunk
   * @param {number} [section] Omit to queue every section.
   */
  markChunkDirty(chunk, section) {
    if (section === undefined) {
      for (let s = 0; s < SECTION_COUNT; s++) {
        if (chunk.sections[s].nonAir > 0 || chunk.sections[s].opaque !== null) {
          this.dirtySections.add(chunk.key + ',' + s);
        }
      }
      return;
    }
    if (section < 0 || section >= SECTION_COUNT) return;
    this.dirtySections.add(chunk.key + ',' + section);
  }

  /* ---------------------------------------------------- padded neighbourhood */

  /**
   * Assembles the 18^3 block and light neighbourhood the mesher needs.
   *
   * The 16^3 interior is copied row by row straight out of the column, which is
   * contiguous memory; only the 1736 shell cells go through the generic global
   * lookup. Doing it naively — one `getBlock` per cell — costs three times more
   * and shows up immediately when a light edit dirties dozens of sections.
   *
   * @param {Chunk} chunk
   * @param {number} sectionIndex
   * @returns {{blocks: Uint16Array, light: Uint8Array}} shared scratch buffers
   */
  buildPadded(chunk, sectionIndex) {
    const baseY = sectionIndex * SECTION_H;
    const baseX = chunk.cx * CHUNK_X;
    const baseZ = chunk.cz * CHUNK_Z;
    const blocks = chunk.blocks;
    const light = chunk.light;

    // --- interior: 16 x 16 x 16 straight from the column
    for (let y = 0; y < SECTION_H; y++) {
      const srcY = (baseY + y) * STRIDE_Y;
      for (let z = 0; z < CHUNK_Z; z++) {
        const src = srcY + z * STRIDE_Z;
        const dst = padIndex(0, y, z);
        for (let x = 0; x < CHUNK_X; x++) {
          _padBlocks[dst + x] = blocks[src + x];
          _padLight[dst + x] = light[src + x];
        }
      }
    }

    // --- shell: everything with at least one coordinate at -1 or 16
    for (let y = -1; y <= SECTION_H; y++) {
      const wy = baseY + y;
      const insideY = y >= 0 && y < SECTION_H;
      for (let z = -1; z <= CHUNK_Z; z++) {
        const insideZ = z >= 0 && z < CHUNK_Z;
        for (let x = -1; x <= CHUNK_X; x++) {
          if (insideY && insideZ && x >= 0 && x < CHUNK_X) continue;
          const pi = padIndex(x, y, z);

          if (wy < 0) {
            // Below bedrock: treat as solid so the bottom face is never drawn.
            _padBlocks[pi] = AIR;
            _padLight[pi] = 0;
            continue;
          }
          if (wy >= WORLD_HEIGHT) {
            // Above the world: open sky at full strength.
            _padBlocks[pi] = AIR;
            _padLight[pi] = 0xf0;
            continue;
          }

          const wx = baseX + x;
          const wz = baseZ + z;
          const nc = this.getChunk(wx >> 4, wz >> 4);
          if (nc === null) {
            // Unloaded neighbour: pretend it is air lit by full sky, so the
            // border does not flash black before the chunk arrives.
            _padBlocks[pi] = AIR;
            _padLight[pi] = 0xf0;
            continue;
          }
          const i = (wx & 15) + (wz & 15) * STRIDE_Z + wy * STRIDE_Y;
          _padBlocks[pi] = nc.blocks[i];
          _padLight[pi] = nc.light[i];
        }
      }
    }

    return { blocks: _padBlocks, light: _padLight };
  }

  /**
   * Highest solid block in a column, for spawning and teleporting.
   * @param {number} x
   * @param {number} z
   * @returns {number} Y of the surface, or -1
   */
  surfaceY(x, z) {
    const chunk = this.getChunk(x >> 4, z >> 4);
    if (chunk === null) return -1;
    return chunk.surfaceY(x & 15, z & 15);
  }

  /** @returns {number} loaded chunk count. */
  get chunkCount() { return this.chunks.size; }

  /** Removes every chunk and queued light. */
  clear() {
    this.chunks.clear();
    this.dirtySections.clear();
    this.lighting.clear();
    this._invalidateCache();
  }
}

export { PAD, LIGHT_ABSORB };
