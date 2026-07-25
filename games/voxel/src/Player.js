/**
 * First person player controller.
 *
 * Drives an AABB body through the voxel world and parents the camera to it.
 * Three movement modes share one code path: walking (gravity, jumping, step-up),
 * swimming (buoyancy, damped speed) and flying (no gravity, free vertical
 * control), because they differ only in how the target velocity and the
 * acceleration constants are chosen.
 */

import { Euler } from '../../../src/math/Euler.js';
import { AABBBody, moveBody, resolveOverlap, MoveResult } from './VoxelPhysics.js';
import { IS_LIQUID } from './Blocks.js';

/** Player box, matching the classic 0.6 x 1.8 proportions. */
const PLAYER_WIDTH = 0.6;
const PLAYER_HEIGHT = 1.8;
/** Eye offset from the feet. */
const EYE_HEIGHT = 1.62;
const CROUCH_EYE_HEIGHT = 1.32;

const GRAVITY = -28.0;
const TERMINAL_VELOCITY = -60.0;
const JUMP_SPEED = 8.6;

const WALK_SPEED = 4.4;
const SPRINT_SPEED = 7.2;
const CROUCH_SPEED = 1.9;
const SWIM_SPEED = 3.2;
const FLY_SPEED = 12.0;
const FLY_SPRINT_SPEED = 34.0;

/** How fast horizontal velocity converges on the target, per mode. */
const GROUND_ACCEL = 14.0;
const AIR_ACCEL = 3.2;
const FLY_ACCEL = 12.0;
const SWIM_ACCEL = 6.0;

const PITCH_LIMIT = Math.PI * 0.5 - 0.001;

const _euler = new Euler(0, 0, 0, 'YXZ');
const _move = new MoveResult();

/**
 * Player state and controller.
 */
export class Player {
  /**
   * @param {Object} options
   * @param {import('./World.js').World} options.world
   * @param {Object} options.camera Engine camera.
   * @param {Object} options.input Engine Input.
   */
  constructor(options) {
    this.world = options.world;
    this.camera = options.camera;
    this.input = options.input;

    /** @type {AABBBody} */
    this.body = new AABBBody(PLAYER_WIDTH, PLAYER_HEIGHT);

    /** @type {number} Horizontal velocity. */
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;

    /** @type {number} Look angles, radians. */
    this.yaw = 0;
    this.pitch = 0;

    /** @type {number} Radians per pixel of mouse movement. */
    this.lookSensitivity = 0.0022;

    /** @type {boolean} */
    this.flying = false;
    /** @type {boolean} */
    this.grounded = false;
    /** @type {boolean} */
    this.inLiquid = false;
    /** @type {boolean} */
    this.crouching = false;
    /** @type {boolean} True when the head is inside a fluid, for the tint. */
    this.headInLiquid = false;

    /** @type {boolean} Set while the world under the player has not loaded. */
    this.suspended = true;

    /** @type {number} Timestamp of the last space press, for the fly toggle. */
    this._lastJumpTap = -1;
    this._elapsed = 0;
    /** @type {boolean} */
    this._jumpWasDown = false;

    /** @type {number} Distance fallen, exposed for the HUD. */
    this.fallDistance = 0;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  setPosition(x, y, z) {
    this.body.setPosition(x, y, z);
    this.vx = this.vy = this.vz = 0;
    this.fallDistance = 0;
    return this;
  }

  /** @returns {number} camera height above the feet right now. */
  get eyeHeight() {
    return this.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
  }

  /**
   * Applies mouse look. Called even while the simulation is suspended so the
   * player can look around during world load.
   * @param {number} dx
   * @param {number} dy
   */
  applyLook(dx, dy) {
    this.yaw -= dx * this.lookSensitivity;
    this.pitch -= dy * this.lookSensitivity;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;

    // Keep yaw bounded so it never loses precision in a long session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /**
   * Advances the player one frame.
   * @param {number} dt Seconds.
   */
  update(dt) {
    this._elapsed += dt;
    const input = this.input;

    if (input.pointerLocked) {
      this.applyLook(input.mouse.dx, input.mouse.dy);
    }

    this._updateCamera();

    if (this.suspended) return;

    // --- intent
    let forward = 0;
    let strafe = 0;
    if (input.isKeyDown('KeyW')) forward += 1;
    if (input.isKeyDown('KeyS')) forward -= 1;
    if (input.isKeyDown('KeyD')) strafe += 1;
    if (input.isKeyDown('KeyA')) strafe -= 1;

    const jumpDown = input.isKeyDown('Space');
    const sprinting = input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight');
    this.crouching = !this.flying && input.isKeyDown('ControlLeft');

    // Double tap space toggles flight.
    if (jumpDown && !this._jumpWasDown) {
      if (this._lastJumpTap > 0 && this._elapsed - this._lastJumpTap < 0.32) {
        this.flying = !this.flying;
        this.vy = 0;
        this._lastJumpTap = -1;
      } else {
        this._lastJumpTap = this._elapsed;
      }
    }
    this._jumpWasDown = jumpDown;

    // Normalise the input vector so diagonals are not faster.
    const len = Math.sqrt(forward * forward + strafe * strafe);
    if (len > 1) { forward /= len; strafe /= len; }

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Camera looks down -Z, so forward in world space is (-sin, 0, -cos).
    const dirX = -sin * forward + cos * strafe;
    const dirZ = -cos * forward - sin * strafe;

    // --- mode specific integration
    if (this.flying) {
      this._updateFlying(dt, dirX, dirZ, jumpDown, sprinting);
    } else if (this.inLiquid) {
      this._updateSwimming(dt, dirX, dirZ, jumpDown);
    } else {
      this._updateWalking(dt, dirX, dirZ, jumpDown, sprinting);
    }

    // --- integrate and collide
    const res = moveBody(this.world, this.body, this.vx * dt, this.vy * dt, this.vz * dt, _move);

    this.grounded = res.grounded;
    this.inLiquid = res.inLiquid;

    if (res.collidedY) {
      if (this.vy < 0) {
        this.fallDistance = 0;
        this.flying = this.flying && false;
      }
      this.vy = 0;
    } else if (this.vy < 0) {
      this.fallDistance += -this.vy * dt;
    }

    if (res.collidedX) this.vx = 0;
    if (res.collidedZ) this.vz = 0;

    this.headInLiquid = IS_LIQUID[this.world.getBlock(
      Math.floor(this.body.x),
      Math.floor(this.body.y + this.eyeHeight),
      Math.floor(this.body.z),
    )] === 1;

    this._updateCamera();
  }

  /** @private */
  _updateWalking(dt, dirX, dirZ, jumpDown, sprinting) {
    const speed = this.crouching ? CROUCH_SPEED : (sprinting ? SPRINT_SPEED : WALK_SPEED);
    const accel = this.grounded ? GROUND_ACCEL : AIR_ACCEL;

    const targetX = dirX * speed;
    const targetZ = dirZ * speed;
    const t = Math.min(1, accel * dt);
    this.vx += (targetX - this.vx) * t;
    this.vz += (targetZ - this.vz) * t;

    this.vy += GRAVITY * dt;
    if (this.vy < TERMINAL_VELOCITY) this.vy = TERMINAL_VELOCITY;

    if (jumpDown && this.grounded) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
    }
  }

  /** @private */
  _updateSwimming(dt, dirX, dirZ, jumpDown) {
    const targetX = dirX * SWIM_SPEED;
    const targetZ = dirZ * SWIM_SPEED;
    const t = Math.min(1, SWIM_ACCEL * dt);
    this.vx += (targetX - this.vx) * t;
    this.vz += (targetZ - this.vz) * t;

    // Buoyancy plus heavy drag: sinking is slow and swimming up is possible.
    this.vy += GRAVITY * 0.22 * dt;
    if (jumpDown) this.vy += 22.0 * dt;
    this.vy *= Math.pow(0.06, dt);
    this.fallDistance = 0;
  }

  /** @private */
  _updateFlying(dt, dirX, dirZ, jumpDown, sprinting) {
    const speed = sprinting ? FLY_SPRINT_SPEED : FLY_SPEED;
    const targetX = dirX * speed;
    const targetZ = dirZ * speed;

    let targetY = 0;
    if (jumpDown) targetY += speed;
    if (this.input.isKeyDown('ControlLeft')) targetY -= speed;

    const t = Math.min(1, FLY_ACCEL * dt);
    this.vx += (targetX - this.vx) * t;
    this.vz += (targetZ - this.vz) * t;
    this.vy += (targetY - this.vy) * t;
    this.fallDistance = 0;
  }

  /** @private */
  _updateCamera() {
    const camera = this.camera;
    camera.position.set(
      this.body.x,
      this.body.y + this.eyeHeight,
      this.body.z,
    );
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(_euler);
    camera.updateMatrix();
    camera.updateWorldMatrix(true);
  }

  /**
   * Drops the player onto the surface once the spawn chunk exists.
   * @returns {boolean} true once the player is standing on solid ground
   */
  settle() {
    const surface = this.world.surfaceY(Math.floor(this.body.x), Math.floor(this.body.z));
    if (surface < 0) return false;
    this.body.y = surface + 1.02;
    resolveOverlap(this.world, this.body, 12);
    this.vx = this.vy = this.vz = 0;
    this.suspended = false;
    return true;
  }
}
