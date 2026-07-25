/**
 * Voxel ray traversal (Amanatides & Woo).
 *
 * Walks the grid one cell at a time along the ray, always stepping the axis
 * whose next boundary is nearest. Unlike sampling the ray at fixed intervals it
 * cannot skip a block or hit the same one twice, and the cost is proportional to
 * the number of cells crossed rather than to the distance.
 *
 * It also reports which face was entered, which is exactly what block placement
 * needs: the new block goes in the cell the ray came from.
 */

import { BLOCKS, AIR } from './Blocks.js';

/**
 * Result record. Reused between calls so picking every frame allocates nothing.
 */
export class VoxelHit {
  constructor() {
    /** @type {boolean} */
    this.hit = false;
    /** @type {number} Block coordinates of the voxel that was hit. */
    this.x = 0;
    this.y = 0;
    this.z = 0;
    /** @type {number} Face normal of the entered face. */
    this.nx = 0;
    this.ny = 0;
    this.nz = 0;
    /** @type {number} Block id at the hit. */
    this.block = AIR;
    /** @type {number} Distance along the ray. */
    this.distance = 0;
    /** @type {number} Exact world-space contact point. */
    this.px = 0;
    this.py = 0;
    this.pz = 0;
  }

  /** Coordinates of the empty cell in front of the hit face. */
  adjacent(out) {
    out.x = this.x + this.nx;
    out.y = this.y + this.ny;
    out.z = this.z + this.nz;
    return out;
  }
}

const _shared = new VoxelHit();

/**
 * Casts a ray through the voxel grid.
 *
 * @param {import('./World.js').World} world
 * @param {number} ox Ray origin.
 * @param {number} oy
 * @param {number} oz
 * @param {number} dx Ray direction, expected normalised.
 * @param {number} dy
 * @param {number} dz
 * @param {number} maxDistance
 * @param {VoxelHit} [out] Destination; a shared record is used when omitted.
 * @param {function(number): boolean} [filter] Returns true when a block id should
 *   stop the ray. Defaults to "anything pickable".
 * @returns {VoxelHit} `hit` is false when nothing was found.
 */
export function raycastVoxel(world, ox, oy, oz, dx, dy, dz, maxDistance, out, filter) {
  const hit = out || _shared;
  hit.hit = false;
  hit.distance = 0;

  // Current cell.
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  // Step direction per axis.
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  // Distance along the ray between successive boundaries of each axis.
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

  // Distance to the first boundary of each axis.
  let tMaxX = stepX !== 0 ? ((stepX > 0 ? x + 1 - ox : ox - x) * tDeltaX) : Infinity;
  let tMaxY = stepY !== 0 ? ((stepY > 0 ? y + 1 - oy : oy - y) * tDeltaY) : Infinity;
  let tMaxZ = stepZ !== 0 ? ((stepZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ) : Infinity;

  let t = 0;
  let nx = 0;
  let ny = 0;
  let nz = 0;

  // Bounded so a ray fired along an axis into unloaded space still terminates.
  const maxSteps = Math.ceil(maxDistance * 3) + 3;

  for (let i = 0; i < maxSteps; i++) {
    const id = world.getBlock(x, y, z);
    const stops = filter !== undefined
      ? filter(id)
      : (id !== AIR && BLOCKS[id] !== undefined && BLOCKS[id].pickable);

    if (stops) {
      hit.hit = true;
      hit.x = x; hit.y = y; hit.z = z;
      hit.nx = nx; hit.ny = ny; hit.nz = nz;
      hit.block = id;
      hit.distance = t;
      hit.px = ox + dx * t;
      hit.py = oy + dy * t;
      hit.pz = oz + dz * t;
      return hit;
    }

    // Advance along whichever axis reaches its next boundary first.
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        if (tMaxX > maxDistance) break;
        x += stepX; t = tMaxX; tMaxX += tDeltaX;
        nx = -stepX; ny = 0; nz = 0;
      } else {
        if (tMaxZ > maxDistance) break;
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
        nx = 0; ny = 0; nz = -stepZ;
      }
    } else {
      if (tMaxY < tMaxZ) {
        if (tMaxY > maxDistance) break;
        y += stepY; t = tMaxY; tMaxY += tDeltaY;
        nx = 0; ny = -stepY; nz = 0;
      } else {
        if (tMaxZ > maxDistance) break;
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
        nx = 0; ny = 0; nz = -stepZ;
      }
    }
  }

  return hit;
}

/**
 * Convenience wrapper that casts from a camera along its forward axis.
 *
 * @param {import('./World.js').World} world
 * @param {Object} camera Engine camera.
 * @param {number} reach
 * @param {VoxelHit} [out]
 * @returns {VoxelHit}
 */
export function raycastFromCamera(world, camera, reach, out) {
  const m = camera.worldMatrix.elements;
  // Column 2 of the world matrix is the camera's +Z; it looks down -Z.
  const dx = -m[8];
  const dy = -m[9];
  const dz = -m[10];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  return raycastVoxel(
    world,
    m[12], m[13], m[14],
    dx / len, dy / len, dz / len,
    reach, out,
  );
}
