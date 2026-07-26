/**
 * Water that flows.
 *
 * This is a thin adapter: all of the actual rule set lives in the engine's
 * `CellularFluid`, which knows nothing about chunks, block ids or meshes. What
 * belongs here is only the translation — how a level maps onto a block id, what
 * counts as a wall, and which chunk owns a coordinate.
 *
 * Two invariants tie the fluid array to the block array, and everything else
 * follows from them:
 *
 *   - a cell with level > 0 holds `WATER`;
 *   - a cell with level 0 holds no water (it is `AIR`, or whatever was there).
 *
 * Generated oceans are marked as **sources**, so they never drain and a hole dug
 * in a seabed keeps pouring. Water the player places from the hotbar is a source
 * too, matching the way a bucket behaves. Everything the simulation itself
 * writes is ordinary flowing water, which recedes as soon as its supply is cut.
 */

import { CellularFluid } from '../../../src/physics/CellularFluid.js';
import { AIR, WATER } from './Blocks.js';
import { WORLD_HEIGHT, FLUID_MAX, fluidSurfaceHeight } from './Chunk.js';

export { FLUID_SURFACE_TOP, fluidSurfaceHeight } from './Chunk.js';

/**
 * Voxel water simulation.
 */
export class VoxelFluid {
  /**
   * @param {import('./World.js').World} world
   * @param {Object} [options]
   * @param {number} [options.flowInterval=0.2] Seconds per cell of spread.
   * @param {number} [options.budget=8000] Cells evaluated per tick.
   */
  constructor(world, options = {}) {
    /** @type {import('./World.js').World} */
    this.world = world;

    /** @type {CellularFluid} */
    this.solver = new CellularFluid({
      maxLevel: FLUID_MAX,
      falloff: 1,
      flowInterval: options.flowInterval !== undefined ? options.flowInterval : 0.2,
      budget: options.budget !== undefined ? options.budget : 8000,

      getLevel: (x, y, z) => world.getFluidLevel(x, y, z),
      setLevel: (x, y, z, level) => world.applyFluidLevel(x, y, z, level),
      isSource: (x, y, z) => world.isFluidSource(x, y, z),

      // Hydrostatics on: a room dug below the surface of a lake fills to lake
      // level, not to a single block deep, and a channel dug between two pools
      // levels them out.
      getPressure: (x, y, z) => world.getFluidPressure(x, y, z),
      setPressure: (x, y, z, p) => world.setFluidPressure(x, y, z, p),

      // Anything that is not air and not water stops the flow. Using IS_SOLID
      // would let water pour straight through leaves and glass, which are not
      // solid to an entity but are certainly watertight.
      isSolid: (x, y, z) => {
        const id = world.getBlock(x, y, z);
        return id !== AIR && id !== WATER;
      },

      // A chunk that has not streamed in yet must not read as a wall, or the
      // shoreline of every loaded region would pool against thin air.
      isLoaded: (x, y, z) => y >= 0 && y < WORLD_HEIGHT && world.isLoadedAt(x, z),
    });

    /** @type {{x: number, y: number, z: number}} Scratch for flowAt. */
    this._flow = { x: 0, y: 0, z: 0 };
  }

  /** @returns {boolean} true while water is still moving somewhere. */
  get pending() { return this.solver.pending; }

  /** @returns {number} cells queued. */
  get queueLength() { return this.solver.queueLength; }

  /** @returns {number} cells whose level changed on the last tick. */
  get lastChanged() { return this.solver.lastChanged; }

  /**
   * Reacts to a block edit.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  markDirty(x, y, z) {
    this.solver.markDirty(x, y, z);
  }

  /**
   * Wakes the shared border after a chunk streams in.
   *
   * Water already settled at the edge of the loaded world computed its level
   * with the neighbour missing. Now that the neighbour exists it may have
   * somewhere to go, and the new chunk may have water arriving from outside.
   * Nothing else would ever mark those cells, so a lake would stop dead at a
   * chunk boundary that loaded a second later.
   *
   * @param {import('./Chunk.js').Chunk} chunk
   */
  seedBorders(chunk) {
    const world = this.world;
    const baseX = chunk.cx * 16;
    const baseZ = chunk.cz * 16;

    for (let side = 0; side < 4; side++) {
      const dx = side === 0 ? -1 : side === 1 ? 1 : 0;
      const dz = side === 2 ? -1 : side === 3 ? 1 : 0;
      if (world.getChunk(chunk.cx + dx, chunk.cz + dz) === null) continue;

      for (let i = 0; i < 16; i++) {
        const lx = dx === -1 ? 0 : dx === 1 ? 15 : i;
        const lz = dz === -1 ? 0 : dz === 1 ? 15 : i;
        const wx = baseX + lx;
        const wz = baseZ + lz;

        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const here = chunk.getFluidLevel(lx, y, lz);
          const there = world.getFluidLevel(wx + dx, y, wz + dz);
          // Only a gradient can actually move water. Seeding every wet border
          // cell instead would queue the whole ocean face — tens of thousands of
          // no-ops — every time a chunk appears.
          if (here > 1 && there < here - 1) this.solver.markCell(wx + dx, y, wz + dz);
          else if (there > 1 && here < there - 1) this.solver.markCell(wx, y, wz);
        }
      }
    }
  }

  /**
   * Advances the simulation.
   * @param {number} dt Seconds.
   * @returns {number} cells changed.
   */
  update(dt) {
    return this.solver.update(dt);
  }

  /**
   * Direction the water at a voxel is moving, for pushing entities.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {{x: number, y: number, z: number}} shared scratch, unit length or zero
   */
  flowAt(x, y, z) {
    return this.solver.flowAt(x, y, z, this._flow);
  }

  /**
   * Height of the water surface inside a voxel, 0 when dry.
   * @returns {number} 0..FLUID_SURFACE_TOP
   */
  surfaceHeight(x, y, z) {
    const level = this.world.getFluidLevel(x, y, z);
    return level > 0 ? fluidSurfaceHeight(level) : 0;
  }

  /** Runs to steady state. For tests and for settling a freshly built level. */
  settle(maxTicks) {
    return this.solver.settle(maxTicks);
  }

  /** Drops queued work. */
  clear() {
    this.solver.clear();
  }
}
