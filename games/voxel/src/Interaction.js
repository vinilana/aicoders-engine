/**
 * Block picking, breaking and placing.
 *
 * Picking is a DDA ray from the eye; placement uses the face normal the ray
 * reported, so a block always lands on the side you are looking at. The one
 * rule that is easy to get wrong: a block may never be placed inside the
 * player's own box, or you seal yourself into the ground.
 */

import { AABBBody, boxIntersectsSolid } from './VoxelPhysics.js';
import { raycastVoxel, VoxelHit } from './VoxelRaycast.js';
import { AIR, WATER, PLACEABLE, IS_SOLID, blockName } from './Blocks.js';

/** How far the player can reach, in blocks. */
export const REACH = 6;

/**
 * Break/place controller.
 */
export class Interaction {
  /**
   * @param {Object} options
   * @param {import('./World.js').World} options.world
   * @param {import('./Player.js').Player} options.player
   * @param {Object} options.camera
   * @param {Object} options.input
   * @param {Object} [options.debug] Engine DebugRenderer for the selection box.
   */
  constructor(options) {
    this.world = options.world;
    this.player = options.player;
    this.camera = options.camera;
    this.input = options.input;
    this.debug = options.debug || null;

    /** @type {VoxelHit} Current pick result, valid every frame. */
    this.hit = new VoxelHit();

    /** @type {number} Index into PLACEABLE. */
    this.selected = 0;

    /** @type {boolean} Draw the wireframe around the targeted block. */
    this.showHighlight = true;

    /** @type {number} Blocks broken and placed this session, for the overlay. */
    this.broken = 0;
    this.placed = 0;

    /** @type {number} Seconds until the next repeat while a button is held. */
    this._repeatTimer = 0;
    /** @type {number} Delay between repeats when holding a mouse button. */
    this.repeatInterval = 0.22;
  }

  /** @returns {number} the block id currently selected for placement. */
  get selectedBlock() {
    return PLACEABLE[this.selected];
  }

  /** @returns {string} */
  get selectedName() {
    return blockName(this.selectedBlock);
  }

  /**
   * @param {number} delta Steps to move through the placeable list.
   */
  cycleSelection(delta) {
    const n = PLACEABLE.length;
    this.selected = ((this.selected + delta) % n + n) % n;
  }

  /**
   * @param {number} index
   */
  setSelection(index) {
    if (index >= 0 && index < PLACEABLE.length) this.selected = index;
  }

  /**
   * Runs picking and applies edits.
   * @param {number} dt
   */
  update(dt) {
    const input = this.input;

    // --- pick
    const camera = this.camera;
    const m = camera.worldMatrix.elements;
    const dx = -m[8];
    const dy = -m[9];
    const dz = -m[10];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

    raycastVoxel(
      this.world,
      m[12], m[13], m[14],
      dx / len, dy / len, dz / len,
      REACH, this.hit,
    );

    // --- selection via wheel and number keys
    if (input.mouse.wheel !== 0) this.cycleSelection(input.mouse.wheel > 0 ? 1 : -1);
    for (let i = 0; i < 9 && i < PLACEABLE.length; i++) {
      if (input.isKeyPressed('Digit' + (i + 1))) this.setSelection(i);
    }

    // --- edits, only while the pointer is captured so UI clicks do not dig
    if (!input.pointerLocked) {
      this._repeatTimer = 0;
      this._drawHighlight();
      return;
    }

    const breakDown = input.isMouseDown(0);
    const placeDown = input.isMouseDown(2);
    const breakPressed = input.isMousePressed(0);
    const placePressed = input.isMousePressed(2);

    let fire = breakPressed || placePressed;
    if (!fire && (breakDown || placeDown)) {
      this._repeatTimer -= dt;
      if (this._repeatTimer <= 0) fire = true;
    }
    if (!breakDown && !placeDown) this._repeatTimer = 0;

    if (fire) {
      this._repeatTimer = this.repeatInterval;
      if (breakDown || breakPressed) this.breakBlock();
      else if (placeDown || placePressed) this.placeBlock();
    }

    this._drawHighlight();
  }

  /**
   * Removes the targeted block.
   * @returns {boolean} true when a block was removed
   */
  breakBlock() {
    if (!this.hit.hit) return false;
    if (this.world.setBlock(this.hit.x, this.hit.y, this.hit.z, AIR)) {
      this.broken++;
      return true;
    }
    return false;
  }

  /**
   * Places the selected block against the targeted face.
   * @returns {boolean} true when a block was placed
   */
  placeBlock() {
    if (!this.hit.hit) return false;

    const x = this.hit.x + this.hit.nx;
    const y = this.hit.y + this.hit.ny;
    const z = this.hit.z + this.hit.nz;

    const id = this.selectedBlock;

    // Water toggles. The raycast passes straight through liquids on purpose —
    // you have to be able to dig the block behind a waterfall — so aiming at a
    // source is impossible and water placed by hand would otherwise be
    // permanent. Placing onto a cell that already holds a source scoops it back
    // up instead, which is the bucket both ways round.
    if (id === WATER && this.world.isFluidSource(x, y, z)) {
      if (this.world.setBlock(x, y, z, AIR)) {
        this.placed++;
        return true;
      }
      return false;
    }

    // Refuse anything that would intersect the player's own box.
    if (IS_SOLID[id] === 1 && this._wouldTrapPlayer(x, y, z)) return false;

    // Only replace air or fluids.
    const existing = this.world.getBlock(x, y, z);
    if (existing !== AIR && IS_SOLID[existing] === 1) return false;

    if (this.world.setBlock(x, y, z, id)) {
      this.placed++;
      return true;
    }
    return false;
  }

  /**
   * @private
   * @returns {boolean} true when the voxel overlaps the player body
   */
  _wouldTrapPlayer(x, y, z) {
    const body = this.player.body;
    const hw = body.halfWidth;
    const minX = body.x - hw;
    const maxX = body.x + hw;
    const minY = body.y;
    const maxY = body.y + body.height;
    const minZ = body.z - hw;
    const maxZ = body.z + hw;

    return maxX > x && minX < x + 1 &&
           maxY > y && minY < y + 1 &&
           maxZ > z && minZ < z + 1;
  }

  /** @private */
  _drawHighlight() {
    if (this.debug === null || !this.showHighlight || !this.hit.hit) return;
    const e = 0.002; // lift off the surface so the lines do not z-fight
    this.debug.boxMinMax(
      this.hit.x - e, this.hit.y - e, this.hit.z - e,
      this.hit.x + 1 + e, this.hit.y + 1 + e, this.hit.z + 1 + e,
      HIGHLIGHT_COLOR,
    );
  }
}

/** Selection wireframe colour. */
const HIGHLIGHT_COLOR = { r: 0.05, g: 0.05, b: 0.06, a: 1 };
