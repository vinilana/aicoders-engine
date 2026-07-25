/**
 * Chunk storage.
 *
 * A chunk is a full vertical column, 16 x 128 x 16, stored as flat typed arrays.
 * The column is the unit of generation and of skylight seeding (both are
 * top-down operations), while the 16-cube *section* is the unit of meshing and
 * drawing, so editing one block never remeshes more than 4096 voxels.
 *
 * Index layout is `x + z * 16 + y * 256`: X varies fastest and Y slowest, which
 * makes a horizontal slice contiguous. Skylight walks down through Y, and the
 * mesher walks slices, so both get sequential reads.
 */

import { AIR, IS_OPAQUE, LIGHT_ABSORB } from './Blocks.js';

/** Horizontal chunk size, in blocks. */
export const CHUNK_X = 16;
export const CHUNK_Z = 16;
/** Vertical extent of the world, in blocks. */
export const WORLD_HEIGHT = 128;
/** Height of one meshed section. */
export const SECTION_H = 16;
/** Sections per column. */
export const SECTION_COUNT = WORLD_HEIGHT / SECTION_H;

/** Blocks per column. */
export const CHUNK_VOLUME = CHUNK_X * CHUNK_Z * WORLD_HEIGHT;
/** Stride constants for the flat index. */
export const STRIDE_Z = CHUNK_X;
export const STRIDE_Y = CHUNK_X * CHUNK_Z;

/**
 * Flat index of a block inside a column.
 * @param {number} x 0..15
 * @param {number} y 0..127
 * @param {number} z 0..15
 * @returns {number}
 */
export function blockIndex(x, y, z) {
  return x + z * STRIDE_Z + y * STRIDE_Y;
}

/** Chunk lifecycle. Transitions only ever move forward, except back to DIRTY. */
export const ChunkState = {
  EMPTY: 0,
  GENERATING: 1,
  GENERATED: 2,
  READY: 3,
};

/**
 * One vertical column of voxels.
 */
export class Chunk {
  /**
   * @param {number} cx Chunk coordinate on X (block x = cx * 16 + local).
   * @param {number} cz Chunk coordinate on Z.
   */
  constructor(cx, cz) {
    /** @type {number} */
    this.cx = cx;
    /** @type {number} */
    this.cz = cz;
    /** @type {string} Map key, cached to avoid rebuilding it every lookup. */
    this.key = cx + ',' + cz;

    /** @type {Uint16Array} Block ids. */
    this.blocks = new Uint16Array(CHUNK_VOLUME);
    /** @type {Uint8Array} Packed light: high nibble sky, low nibble block. */
    this.light = new Uint8Array(CHUNK_VOLUME);
    /**
     * @type {Uint8Array} Per-column height of the highest light-blocking block
     * plus one, i.e. the Y at which skylight is still full strength.
     */
    this.heightmap = new Uint8Array(CHUNK_X * CHUNK_Z);

    /** @type {number} */
    this.state = ChunkState.EMPTY;
    /** @type {boolean} True once the player has edited it, drives persistence. */
    this.modified = false;
    /** @type {boolean} Set while skylight has not been seeded yet. */
    this.needsLightSeed = true;

    /**
     * Per-section render state.
     * @type {Array<{index: number, nonAir: number, dirty: boolean, meshing: boolean,
     *   opaque: Object|null, water: Object|null}>}
     */
    this.sections = new Array(SECTION_COUNT);
    for (let i = 0; i < SECTION_COUNT; i++) {
      this.sections[i] = {
        index: i,
        nonAir: 0,
        dirty: true,
        meshing: false,
        opaque: null,
        water: null,
      };
    }
  }

  /**
   * @param {number} x 0..15
   * @param {number} y 0..127
   * @param {number} z 0..15
   * @returns {number} block id, AIR outside the vertical range
   */
  get(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR;
    return this.blocks[x + z * STRIDE_Z + y * STRIDE_Y];
  }

  /**
   * Writes a block and keeps the section counters and heightmap in sync.
   * Does NOT touch lighting or meshes; the World layer owns that.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} id
   * @returns {number} the previous block id
   */
  set(x, y, z, id) {
    if (y < 0 || y >= WORLD_HEIGHT) return AIR;
    const i = x + z * STRIDE_Z + y * STRIDE_Y;
    const prev = this.blocks[i];
    if (prev === id) return prev;
    this.blocks[i] = id;

    const section = this.sections[y >> 4];
    if (prev === AIR && id !== AIR) section.nonAir++;
    else if (prev !== AIR && id === AIR) section.nonAir--;

    this._updateHeightAt(x, z, y, id, prev);
    return prev;
  }

  /**
   * Keeps `heightmap` correct after a single edit, without rescanning the whole
   * column unless the edit actually removed the previous top block.
   * @private
   */
  _updateHeightAt(x, z, y, id, prev) {
    const hi = x + z * CHUNK_X;
    const top = this.heightmap[hi];
    const blocksLight = LIGHT_ABSORB[id] > 0;
    const didBlockLight = LIGHT_ABSORB[prev] > 0;

    if (blocksLight && y + 1 > top) {
      this.heightmap[hi] = y + 1;
      return;
    }
    if (didBlockLight && !blocksLight && y + 1 === top) {
      // The top block just became transparent: walk down for the new ceiling.
      let ny = y - 1;
      while (ny >= 0 && LIGHT_ABSORB[this.blocks[x + z * STRIDE_Z + ny * STRIDE_Y]] === 0) ny--;
      this.heightmap[hi] = ny + 1;
    }
  }

  /** Recomputes the heightmap and the per-section counters from scratch. */
  rebuildDerived() {
    const blocks = this.blocks;

    for (let i = 0; i < SECTION_COUNT; i++) this.sections[i].nonAir = 0;

    for (let y = 0; y < WORLD_HEIGHT; y++) {
      const section = this.sections[y >> 4];
      const base = y * STRIDE_Y;
      let count = 0;
      for (let i = 0; i < STRIDE_Y; i++) {
        if (blocks[base + i] !== AIR) count++;
      }
      section.nonAir += count;
    }

    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        let y = WORLD_HEIGHT - 1;
        while (y >= 0 && LIGHT_ABSORB[blocks[x + z * STRIDE_Z + y * STRIDE_Y]] === 0) y--;
        this.heightmap[x + z * CHUNK_X] = y + 1;
      }
    }
  }

  /** @returns {number} packed light byte */
  getLight(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return y < 0 ? 0 : 0xf0;
    return this.light[x + z * STRIDE_Z + y * STRIDE_Y];
  }

  /** @returns {number} 0..15 */
  getSkyLight(x, y, z) {
    if (y >= WORLD_HEIGHT) return 15;
    if (y < 0) return 0;
    return this.light[x + z * STRIDE_Z + y * STRIDE_Y] >> 4;
  }

  /** @returns {number} 0..15 */
  getBlockLight(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.light[x + z * STRIDE_Z + y * STRIDE_Y] & 0x0f;
  }

  /** @param {number} value 0..15 */
  setSkyLight(x, y, z, value) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const i = x + z * STRIDE_Z + y * STRIDE_Y;
    this.light[i] = (this.light[i] & 0x0f) | (value << 4);
  }

  /** @param {number} value 0..15 */
  setBlockLight(x, y, z, value) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const i = x + z * STRIDE_Z + y * STRIDE_Y;
    this.light[i] = (this.light[i] & 0xf0) | value;
  }

  /**
   * Marks a section dirty, plus the vertical neighbour when the edit sits on a
   * section boundary (its faces change too).
   * @param {number} y
   */
  markSectionDirty(y) {
    const s = y >> 4;
    if (s < 0 || s >= SECTION_COUNT) return;
    this.sections[s].dirty = true;
    const local = y & 15;
    if (local === 0 && s > 0) this.sections[s - 1].dirty = true;
    if (local === 15 && s < SECTION_COUNT - 1) this.sections[s + 1].dirty = true;
  }

  /** Marks every section dirty (used when a neighbour appears). */
  markAllDirty() {
    for (let i = 0; i < SECTION_COUNT; i++) this.sections[i].dirty = true;
  }

  /** @returns {boolean} true when the whole column is air. */
  isEmpty() {
    for (let i = 0; i < SECTION_COUNT; i++) {
      if (this.sections[i].nonAir > 0) return false;
    }
    return true;
  }

  /**
   * Highest non-air block in a column, used to spawn the player on the surface.
   * @param {number} x 0..15
   * @param {number} z 0..15
   * @returns {number} Y of the topmost solid block, -1 when the column is air.
   */
  surfaceY(x, z) {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = this.blocks[x + z * STRIDE_Z + y * STRIDE_Y];
      if (id !== AIR && IS_OPAQUE[id] === 1) return y;
    }
    return -1;
  }

  /**
   * Serialisable snapshot for persistence. Only stores blocks: light and the
   * derived tables are recomputed on load, which keeps saves small.
   * @returns {{cx: number, cz: number, blocks: Uint16Array}}
   */
  toSave() {
    return { cx: this.cx, cz: this.cz, blocks: this.blocks };
  }
}
