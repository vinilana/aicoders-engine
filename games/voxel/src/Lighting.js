/**
 * Voxel light propagation.
 *
 * Two independent 4-bit channels flood through the world:
 *   - **sky**, seeded at full strength everywhere the sky is visible and, unlike
 *     every other direction, falling straight down without attenuation;
 *   - **block**, seeded by emissive blocks such as glowstone.
 *
 * Both use a breadth-first flood, which is what makes light bend around corners
 * and pool correctly in caves. Removal is the hard half: deleting a light source
 * cannot simply zero its cell, it has to erase exactly the region that source
 * lit and then let brighter neighbours flow back in. That is the classic
 * two-queue algorithm implemented below.
 *
 * Everything is time budgeted. A single torch placed underground can touch tens
 * of thousands of voxels; `update()` processes a bounded number per call so the
 * frame never stalls, and the remainder simply continues next frame.
 */

import { LIGHT_ABSORB, LIGHT_EMISSION } from './Blocks.js';
import { WORLD_HEIGHT } from './Chunk.js';

/** Neighbour offsets: +X, -X, +Y, -Y, +Z, -Z. */
const NEIGHBOURS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/**
 * Growable FIFO of 4-int records. A plain array of small objects would allocate
 * once per visited voxel, which is exactly what this must not do.
 */
class IntQueue {
  constructor(capacity = 4096) {
    this.data = new Int32Array(capacity * 4);
    this.capacity = capacity;
    this.head = 0;
    this.tail = 0;
  }

  get size() { return this.tail - this.head; }

  /** @param {number} a @param {number} b @param {number} c @param {number} d */
  push(a, b, c, d) {
    if (this.tail === this.capacity) this._compact();
    const o = this.tail * 4;
    this.data[o] = a;
    this.data[o + 1] = b;
    this.data[o + 2] = c;
    this.data[o + 3] = d;
    this.tail++;
  }

  /** Slides live entries to the front, doubling only when genuinely full. */
  _compact() {
    const live = this.tail - this.head;
    if (this.head > 0 && live < this.capacity * 0.75) {
      this.data.copyWithin(0, this.head * 4, this.tail * 4);
    } else {
      const next = new Int32Array(this.capacity * 2 * 4);
      next.set(this.data.subarray(this.head * 4, this.tail * 4));
      this.data = next;
      this.capacity *= 2;
    }
    this.tail = live;
    this.head = 0;
  }

  clear() { this.head = 0; this.tail = 0; }
}

/**
 * Light engine bound to a world.
 */
export class Lighting {
  /**
   * @param {import('./World.js').World} world
   * @param {Object} [options]
   * @param {number} [options.budget=60000] Voxels processed per update() call.
   */
  constructor(world, options = {}) {
    /** @type {import('./World.js').World} */
    this.world = world;
    /** @type {number} */
    this.budget = options.budget !== undefined ? options.budget : 60000;

    this.skyAdd = new IntQueue(8192);
    this.skyRemove = new IntQueue(2048);
    this.blockAdd = new IntQueue(2048);
    this.blockRemove = new IntQueue(1024);

    /** @type {number} Voxels touched during the last update, for the debug HUD. */
    this.lastProcessed = 0;
  }

  /** @returns {boolean} true when there is queued work. */
  get pending() {
    return this.skyAdd.size > 0 || this.skyRemove.size > 0 ||
      this.blockAdd.size > 0 || this.blockRemove.size > 0;
  }

  /** @returns {number} total queued voxels. */
  get queueLength() {
    return this.skyAdd.size + this.skyRemove.size + this.blockAdd.size + this.blockRemove.size;
  }

  /**
   * Seeds sky light for a freshly generated chunk.
   *
   * Everything above the column's height gets full strength directly, then only
   * the lowest full-strength cell of each column is queued. The flood takes care
   * of overhangs, cave mouths and spilling into neighbouring chunks.
   *
   * @param {import('./Chunk.js').Chunk} chunk
   */
  seedChunk(chunk) {
    const baseX = chunk.cx * 16;
    const baseZ = chunk.cz * 16;

    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const h = chunk.heightmap[x + z * 16];
        for (let y = WORLD_HEIGHT - 1; y >= h; y--) {
          chunk.setSkyLight(x, y, z, 15);
        }
        this.skyAdd.push(baseX + x, h, baseZ + z, 0);
        // The cell just under the ceiling also needs a seed when the column is
        // fully open, otherwise nothing ever spreads sideways at ground level.
        if (h > 0) this.skyAdd.push(baseX + x, h - 1, baseZ + z, 0);
      }
    }

    // Emissive blocks placed by generation (glowstone in caves, for instance).
    const blocks = chunk.blocks;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const id = blocks[x + z * 16 + y * 256];
          const emission = LIGHT_EMISSION[id];
          if (emission > 0) {
            chunk.setBlockLight(x, y, z, emission);
            this.blockAdd.push(baseX + x, y, baseZ + z, 0);
          }
        }
      }
    }

    chunk.needsLightSeed = false;
  }

  /**
   * Re-seeds the shared border after a neighbour appears, so light that stopped
   * at the edge of the loaded world continues into the new chunk.
   * @param {import('./Chunk.js').Chunk} chunk
   */
  seedBorders(chunk) {
    const baseX = chunk.cx * 16;
    const baseZ = chunk.cz * 16;
    const world = this.world;

    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let i = 0; i < 16; i++) {
        this._seedIfLit(world, baseX + i, y, baseZ);
        this._seedIfLit(world, baseX + i, y, baseZ + 15);
        this._seedIfLit(world, baseX, y, baseZ + i);
        this._seedIfLit(world, baseX + 15, y, baseZ + i);
      }
    }
  }

  /** @private */
  _seedIfLit(world, x, y, z) {
    if (world.getSkyLight(x, y, z) > 0) this.skyAdd.push(x, y, z, 0);
    if (world.getBlockLight(x, y, z) > 0) this.blockAdd.push(x, y, z, 0);
  }

  /**
   * Reacts to a block change at world coordinates.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} prevId
   * @param {number} nextId
   */
  onBlockChanged(x, y, z, prevId, nextId) {
    const world = this.world;

    // --- block light channel
    const prevEmission = LIGHT_EMISSION[prevId];
    const nextEmission = LIGHT_EMISSION[nextId];

    if (prevEmission > 0) {
      world.setBlockLight(x, y, z, 0);
      this.blockRemove.push(x, y, z, prevEmission);
    }

    const currentBlock = world.getBlockLight(x, y, z);
    if (LIGHT_ABSORB[nextId] >= 15 && currentBlock > 0) {
      world.setBlockLight(x, y, z, 0);
      this.blockRemove.push(x, y, z, currentBlock);
    }

    if (nextEmission > 0) {
      world.setBlockLight(x, y, z, nextEmission);
      this.blockAdd.push(x, y, z, 0);
    } else {
      // A block was cleared: neighbours may now flow in.
      for (let i = 0; i < 6; i++) {
        const n = NEIGHBOURS[i];
        if (world.getBlockLight(x + n[0], y + n[1], z + n[2]) > 0) {
          this.blockAdd.push(x + n[0], y + n[1], z + n[2], 0);
        }
      }
    }

    // --- sky light channel
    const currentSky = world.getSkyLight(x, y, z);
    if (LIGHT_ABSORB[nextId] > 0 && currentSky > 0) {
      // The new block shadows everything below it.
      world.setSkyLight(x, y, z, 0);
      this.skyRemove.push(x, y, z, currentSky);
    } else if (LIGHT_ABSORB[nextId] === 0) {
      // The block became transparent: re-open the column and let light back in.
      for (let i = 0; i < 6; i++) {
        const n = NEIGHBOURS[i];
        if (world.getSkyLight(x + n[0], y + n[1], z + n[2]) > 0) {
          this.skyAdd.push(x + n[0], y + n[1], z + n[2], 0);
        }
      }
      // Direct sky above means this cell is full strength immediately.
      if (world.hasSkyAccess(x, y, z)) {
        world.setSkyLight(x, y, z, 15);
        this.skyAdd.push(x, y, z, 0);
      }
    }
  }

  /**
   * Runs queued propagation within the frame budget.
   * Removal always runs before addition: erasing first and refilling after is
   * what keeps the result independent of the order edits arrived in.
   *
   * @returns {number} voxels processed
   */
  update() {
    let budget = this.budget;
    budget -= this._processRemoval(this.skyRemove, this.skyAdd, true, budget);
    budget -= this._processRemoval(this.blockRemove, this.blockAdd, false, budget);
    budget -= this._processAdd(this.skyAdd, true, budget);
    budget -= this._processAdd(this.blockAdd, false, budget);
    this.lastProcessed = this.budget - budget;
    return this.lastProcessed;
  }

  /**
   * Flood fill that raises light levels.
   * @private
   */
  _processAdd(queue, isSky, budget) {
    const world = this.world;
    let used = 0;

    while (queue.size > 0 && used < budget) {
      const o = queue.head * 4;
      const x = queue.data[o];
      const y = queue.data[o + 1];
      const z = queue.data[o + 2];
      queue.head++;
      used++;

      const level = isSky ? world.getSkyLight(x, y, z) : world.getBlockLight(x, y, z);
      if (level <= 1) continue;

      for (let i = 0; i < 6; i++) {
        const n = NEIGHBOURS[i];
        const nx = x + n[0];
        const ny = y + n[1];
        const nz = z + n[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (!world.isLoadedAt(nx, nz)) continue;

        const absorb = LIGHT_ABSORB[world.getBlock(nx, ny, nz)];
        if (absorb >= 15) continue;

        // Sky light at full strength falls straight down for free; that is what
        // makes a shaft of daylight reach the bottom of a pit undimmed.
        const straightDown = isSky && n[1] === -1 && level === 15 && absorb === 0;
        const next = straightDown ? 15 : level - (absorb > 0 ? absorb : 1);
        if (next <= 0) continue;

        const current = isSky ? world.getSkyLight(nx, ny, nz) : world.getBlockLight(nx, ny, nz);
        if (next > current) {
          if (isSky) world.setSkyLight(nx, ny, nz, next);
          else world.setBlockLight(nx, ny, nz, next);
          world.markLightDirty(nx, ny, nz);
          queue.push(nx, ny, nz, 0);
        }
      }
    }

    return used;
  }

  /**
   * Flood fill that erases the region lit by a removed source, queueing any
   * brighter boundary cell for re-propagation.
   * @private
   */
  _processRemoval(queue, addQueue, isSky, budget) {
    const world = this.world;
    let used = 0;

    while (queue.size > 0 && used < budget) {
      const o = queue.head * 4;
      const x = queue.data[o];
      const y = queue.data[o + 1];
      const z = queue.data[o + 2];
      const oldLevel = queue.data[o + 3];
      queue.head++;
      used++;

      for (let i = 0; i < 6; i++) {
        const n = NEIGHBOURS[i];
        const nx = x + n[0];
        const ny = y + n[1];
        const nz = z + n[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (!world.isLoadedAt(nx, nz)) continue;

        const current = isSky ? world.getSkyLight(nx, ny, nz) : world.getBlockLight(nx, ny, nz);
        if (current === 0) continue;

        // A column of full-strength sky light below the removal point was lit
        // from above, not sideways, so it has to be erased too.
        const litFromHere = current < oldLevel ||
          (isSky && n[1] === -1 && current === 15 && oldLevel === 15);

        if (litFromHere) {
          if (isSky) world.setSkyLight(nx, ny, nz, 0);
          else world.setBlockLight(nx, ny, nz, 0);
          world.markLightDirty(nx, ny, nz);
          queue.push(nx, ny, nz, current);
        } else {
          // Brighter than what we erased: it survives and refills the hole.
          addQueue.push(nx, ny, nz, 0);
        }
      }
    }

    return used;
  }

  /** Drops all queued work, used when the world is reset. */
  clear() {
    this.skyAdd.clear();
    this.skyRemove.clear();
    this.blockAdd.clear();
    this.blockRemove.clear();
  }
}
