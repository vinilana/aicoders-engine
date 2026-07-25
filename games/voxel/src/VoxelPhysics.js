/**
 * Entity collision against the voxel grid.
 *
 * An axis-aligned box is swept one axis at a time and snapped out of whatever it
 * overlaps. Resolving axes separately is what produces sliding along walls for
 * free: blocking X leaves Z untouched, so running into a wall at an angle keeps
 * the tangential motion instead of stopping dead.
 *
 * Movement is split into sub-steps no longer than a third of a block, so a
 * falling entity can never tunnel through a floor no matter how large the frame
 * delta gets.
 */

import { IS_SOLID, IS_LIQUID } from './Blocks.js';

/** Pushed away from a contact face so the entity never rests exactly on it. */
const SKIN = 1e-3;
/** Longest distance moved in one sub-step. */
const MAX_STEP = 0.33;

/**
 * Movement result, reused to avoid per-frame allocation.
 */
export class MoveResult {
  constructor() {
    this.collidedX = false;
    this.collidedY = false;
    this.collidedZ = false;
    /** @type {boolean} True when the entity is standing on something. */
    this.grounded = false;
    /** @type {boolean} True when the head hit a ceiling. */
    this.ceiling = false;
    /** @type {boolean} True when the entity's centre is inside a fluid. */
    this.inLiquid = false;
    /** @type {boolean} True when a step-up was performed this frame. */
    this.stepped = false;
  }

  reset() {
    this.collidedX = false;
    this.collidedY = false;
    this.collidedZ = false;
    this.grounded = false;
    this.ceiling = false;
    this.inLiquid = false;
    this.stepped = false;
    return this;
  }
}

/**
 * Tests whether an axis-aligned box overlaps any solid voxel.
 *
 * @param {import('./World.js').World} world
 * @param {number} minX
 * @param {number} minY
 * @param {number} minZ
 * @param {number} maxX
 * @param {number} maxY
 * @param {number} maxZ
 * @returns {boolean}
 */
export function boxIntersectsSolid(world, minX, minY, minZ, maxX, maxY, maxZ) {
  const x0 = Math.floor(minX);
  const x1 = Math.floor(maxX);
  const y0 = Math.floor(minY);
  const y1 = Math.floor(maxY);
  const z0 = Math.floor(minZ);
  const z1 = Math.floor(maxZ);

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (IS_SOLID[world.getBlock(x, y, z)] === 1) return true;
      }
    }
  }
  return false;
}

/**
 * An axis-aligned entity body.
 */
export class AABBBody {
  /**
   * @param {number} width Full width on X and Z.
   * @param {number} height Full height on Y.
   */
  constructor(width, height) {
    /** @type {number} */
    this.halfWidth = width * 0.5;
    /** @type {number} */
    this.height = height;
    /** @type {number} Feet position. */
    this.x = 0;
    this.y = 0;
    this.z = 0;
    /** @type {number} Highest ledge that can be climbed without jumping. */
    this.stepHeight = 0.6;
  }

  /** @param {number} x @param {number} y @param {number} z */
  setPosition(x, y, z) {
    this.x = x; this.y = y; this.z = z;
    return this;
  }
}

const _result = new MoveResult();

/**
 * Moves a body by a delta, resolving collisions against the world.
 *
 * @param {import('./World.js').World} world
 * @param {AABBBody} body
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @param {MoveResult} [out]
 * @returns {MoveResult}
 */
export function moveBody(world, body, dx, dy, dz, out) {
  const res = (out || _result).reset();

  // Sub-step so no single move can exceed a third of a block on any axis.
  const longest = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const steps = longest > MAX_STEP ? Math.ceil(longest / MAX_STEP) : 1;
  const sx = dx / steps;
  const sy = dy / steps;
  const sz = dz / steps;

  for (let i = 0; i < steps; i++) {
    // Y first: landing before horizontal resolution is what lets an entity walk
    // off a ledge and onto the block below in the same frame.
    if (sy !== 0) moveAxisY(world, body, sy, res);
    if (sx !== 0) moveAxisHorizontal(world, body, sx, 0, res);
    if (sz !== 0) moveAxisHorizontal(world, body, 0, sz, res);
  }

  // Grounded test: a hair below the feet.
  const hw = body.halfWidth;
  res.grounded = boxIntersectsSolid(
    world,
    body.x - hw + SKIN, body.y - 0.02, body.z - hw + SKIN,
    body.x + hw - SKIN, body.y - 0.01, body.z + hw - SKIN,
  );

  res.inLiquid = IS_LIQUID[world.getBlock(
    Math.floor(body.x),
    Math.floor(body.y + body.height * 0.5),
    Math.floor(body.z),
  )] === 1;

  return res;
}

/**
 * Vertical sweep.
 * @private
 */
function moveAxisY(world, body, dy, res) {
  const hw = body.halfWidth - SKIN;
  const ny = body.y + dy;

  const minX = body.x - hw;
  const maxX = body.x + hw;
  const minZ = body.z - hw;
  const maxZ = body.z + hw;

  if (dy > 0) {
    const top = ny + body.height;
    if (boxIntersectsSolid(world, minX, ny, minZ, maxX, top, maxZ)) {
      // Snap the head just under the block boundary it crossed.
      body.y = Math.floor(top) - body.height - SKIN;
      res.collidedY = true;
      res.ceiling = true;
      return;
    }
  } else {
    if (boxIntersectsSolid(world, minX, ny, minZ, maxX, ny + body.height, maxZ)) {
      body.y = Math.floor(ny) + 1 + SKIN;
      res.collidedY = true;
      res.grounded = true;
      return;
    }
  }

  body.y = ny;
}

/**
 * Horizontal sweep with automatic step-up.
 * @private
 */
function moveAxisHorizontal(world, body, dx, dz, res) {
  const hw = body.halfWidth - SKIN;
  const nx = body.x + dx;
  const nz = body.z + dz;

  const minY = body.y + SKIN;
  const maxY = body.y + body.height - SKIN;

  if (!boxIntersectsSolid(world, nx - hw, minY, nz - hw, nx + hw, maxY, nz + hw)) {
    body.x = nx;
    body.z = nz;
    return;
  }

  // Blocked. Try climbing the obstacle before giving up: lift the box by the
  // step height, retry, and drop it back down onto the ledge.
  if (body.stepHeight > 0) {
    const liftedY = body.y + body.stepHeight;
    const clearAbove = !boxIntersectsSolid(
      world,
      body.x - hw, body.y + body.height - SKIN, body.z - hw,
      body.x + hw, liftedY + body.height - SKIN, body.z + hw,
    );
    const clearTarget = !boxIntersectsSolid(
      world,
      nx - hw, liftedY + SKIN, nz - hw,
      nx + hw, liftedY + body.height - SKIN, nz + hw,
    );

    if (clearAbove && clearTarget) {
      // Settle onto the ledge instead of hovering at full step height.
      let settled = liftedY;
      for (let probe = 0; probe <= body.stepHeight; probe += 0.05) {
        const testY = liftedY - probe;
        if (boxIntersectsSolid(
          world,
          nx - hw, testY + SKIN, nz - hw,
          nx + hw, testY + body.height - SKIN, nz + hw,
        )) break;
        settled = testY;
      }
      body.x = nx;
      body.z = nz;
      body.y = settled;
      res.stepped = true;
      return;
    }
  }

  // Genuinely blocked: snap flush against the face so there is no visible gap.
  if (dx !== 0) {
    body.x = dx > 0
      ? Math.floor(nx + hw) - body.halfWidth - SKIN
      : Math.floor(nx - hw) + 1 + body.halfWidth + SKIN;
    res.collidedX = true;
  }
  if (dz !== 0) {
    body.z = dz > 0
      ? Math.floor(nz + hw) - body.halfWidth - SKIN
      : Math.floor(nz - hw) + 1 + body.halfWidth + SKIN;
    res.collidedZ = true;
  }
}

/**
 * Pushes a body straight up until it is no longer inside geometry. Used after
 * teleporting or when the world loads under the player.
 *
 * @param {import('./World.js').World} world
 * @param {AABBBody} body
 * @param {number} [maxLift=8]
 * @returns {boolean} true when a free position was found
 */
export function resolveOverlap(world, body, maxLift = 8) {
  const hw = body.halfWidth - SKIN;
  for (let lift = 0; lift <= maxLift; lift += 0.25) {
    const y = body.y + lift;
    if (!boxIntersectsSolid(
      world,
      body.x - hw, y + SKIN, body.z - hw,
      body.x + hw, y + body.height - SKIN, body.z + hw,
    )) {
      body.y = y;
      return true;
    }
  }
  return false;
}
