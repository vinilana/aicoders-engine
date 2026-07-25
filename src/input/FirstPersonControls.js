/**
 * @fileoverview First person camera controller. WASD movement with sprint and
 * jump, mouse look through pointer lock, clamped pitch and exponential
 * acceleration/deceleration. When `options.controller` is supplied the desired
 * velocity is handed to a CharacterController instead of integrating the camera
 * position directly.
 */

import { Vec3 } from '../math/Vec3.js';
import { clamp, DEG2RAD } from '../math/MathUtils.js';

/** Scratch vectors reused every frame. */
const _desired = new Vec3();
const _move = new Vec3();

/** Default key map, using KeyboardEvent.code values. */
const DEFAULT_KEYS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  up: 'Space',
  down: 'ControlLeft',
  sprint: 'ShiftLeft',
  jump: 'Space',
  crouch: 'KeyC'
};

/**
 * Free-look first person controller.
 */
export class FirstPersonControls {
  /**
   * @param {import('../scene/Camera.js').Camera} camera Camera to drive.
   * @param {import('./Input.js').Input} input Shared input state.
   * @param {Object} [options] Behaviour options.
   * @param {*} [options.controller] Optional CharacterController to drive.
   * @param {number} [options.moveSpeed=6] Walk speed in units per second.
   * @param {number} [options.sprintMultiplier=2.2] Speed factor while sprinting.
   * @param {number} [options.crouchMultiplier=0.45] Speed factor while crouching.
   * @param {number} [options.lookSensitivity=0.0022] Radians per mouse pixel.
   * @param {number} [options.acceleration=48] Velocity response while accelerating.
   * @param {number} [options.deceleration=32] Velocity response while stopping.
   * @param {boolean} [options.fly] Free flight (defaults to true without a controller).
   * @param {number} [options.eyeHeight=1.7] Camera height above the controller origin.
   * @param {number} [options.gravity=-24] Gravity applied in walk mode without a controller.
   * @param {number} [options.jumpSpeed=7] Vertical launch speed.
   * @param {number} [options.groundHeight=0] Floor height used in walk mode without a controller.
   * @param {boolean} [options.requirePointerLock=true] Only look while locked or dragging.
   * @param {boolean} [options.dragToLook=true] Allow looking while holding the left button.
   * @param {Object} [options.keys] Key map overrides.
   */
  constructor(camera, input, options) {
    const opts = options || {};

    /** @type {*} Controlled camera. */
    this.camera = camera;
    /** @type {*} Input source. */
    this.input = input;
    /** @type {*} Optional CharacterController receiving the desired velocity. */
    this.controller = opts.controller || null;

    /** @type {boolean} Master switch. */
    this.enabled = opts.enabled !== false;
    /** @type {number} Walk speed in units per second. */
    this.moveSpeed = opts.moveSpeed !== undefined ? opts.moveSpeed : 6;
    /** @type {number} Sprint speed factor. */
    this.sprintMultiplier = opts.sprintMultiplier !== undefined ? opts.sprintMultiplier : 2.2;
    /** @type {number} Crouch speed factor. */
    this.crouchMultiplier = opts.crouchMultiplier !== undefined ? opts.crouchMultiplier : 0.45;
    /** @type {number} Radians of yaw/pitch per mouse pixel. */
    this.lookSensitivity = opts.lookSensitivity !== undefined ? opts.lookSensitivity : 0.0022;
    /** @type {number} Radians per second for gamepad look. */
    this.gamepadLookSpeed = opts.gamepadLookSpeed !== undefined ? opts.gamepadLookSpeed : 2.8;
    /** @type {number} Velocity response while accelerating. */
    this.acceleration = opts.acceleration !== undefined ? opts.acceleration : 48;
    /** @type {number} Velocity response while stopping. */
    this.deceleration = opts.deceleration !== undefined ? opts.deceleration : 32;
    /** @type {number} Response factor applied while airborne. */
    this.airControl = opts.airControl !== undefined ? opts.airControl : 0.25;

    /** @type {boolean} Free flight mode (no gravity, pitch affects movement). */
    this.fly = opts.fly !== undefined ? opts.fly : !this.controller;
    /** @type {number} Camera offset above the controller origin. */
    this.eyeHeight = opts.eyeHeight !== undefined ? opts.eyeHeight : 1.7;
    /** @type {number} Gravity used only in the built-in walk integrator. */
    this.gravity = opts.gravity !== undefined ? opts.gravity : -24;
    /** @type {number} Vertical launch speed. */
    this.jumpSpeed = opts.jumpSpeed !== undefined ? opts.jumpSpeed : 7;
    /**
     * @type {number} Vertical speed requested while swimming, in m/s. Applied
     * only when the attached controller reports `swimming`.
     */
    this.swimVerticalSpeed = opts.swimVerticalSpeed !== undefined ? opts.swimVerticalSpeed : 3.6;
    /** @type {number} Floor height for the built-in walk integrator. */
    this.groundHeight = opts.groundHeight !== undefined ? opts.groundHeight : 0;

    /** @type {number} Lowest pitch in radians. */
    this.minPitch = opts.minPitch !== undefined ? opts.minPitch : -89 * DEG2RAD;
    /** @type {number} Highest pitch in radians. */
    this.maxPitch = opts.maxPitch !== undefined ? opts.maxPitch : 89 * DEG2RAD;
    /** @type {boolean} Invert the vertical look axis. */
    this.invertY = opts.invertY === true;

    /** @type {boolean} Only look while pointer locked (or dragging). */
    this.requirePointerLock = opts.requirePointerLock !== false;
    /** @type {boolean} Allow looking while the left mouse button is held. */
    this.dragToLook = opts.dragToLook !== false;

    /** @type {Object} Key map. */
    this.keys = {
      forward: opts.keys && opts.keys.forward ? opts.keys.forward : DEFAULT_KEYS.forward,
      back: opts.keys && opts.keys.back ? opts.keys.back : DEFAULT_KEYS.back,
      left: opts.keys && opts.keys.left ? opts.keys.left : DEFAULT_KEYS.left,
      right: opts.keys && opts.keys.right ? opts.keys.right : DEFAULT_KEYS.right,
      up: opts.keys && opts.keys.up ? opts.keys.up : DEFAULT_KEYS.up,
      down: opts.keys && opts.keys.down ? opts.keys.down : DEFAULT_KEYS.down,
      sprint: opts.keys && opts.keys.sprint ? opts.keys.sprint : DEFAULT_KEYS.sprint,
      jump: opts.keys && opts.keys.jump ? opts.keys.jump : DEFAULT_KEYS.jump,
      crouch: opts.keys && opts.keys.crouch ? opts.keys.crouch : DEFAULT_KEYS.crouch
    };

    /** @type {number} Current yaw in radians. */
    this.yaw = 0;
    /** @type {number} Current pitch in radians. */
    this.pitch = 0;
    /** @type {Vec3} Smoothed world velocity. */
    this.velocity = new Vec3();
    /** @type {boolean} Ground state (mirrors the controller when present). */
    this.isGrounded = true;
    /** @type {boolean} True while the sprint key is held and moving. */
    this.isSprinting = false;
    /** @type {boolean} True while the crouch key is held. */
    this.isCrouching = false;
    /** @type {number} Gamepad slot used for movement and look. */
    this.gamepadIndex = opts.gamepadIndex !== undefined ? opts.gamepadIndex | 0 : 0;

    this.syncFromCamera();
  }

  /**
   * Reads yaw and pitch back from the camera's current orientation.
   */
  syncFromCamera() {
    const cam = this.camera;
    if (!cam || !cam.quaternion) return;
    const q = cam.quaternion;
    // Forward is the negated third column of the rotation matrix built from q.
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fy = -2 * (q.y * q.z - q.w * q.x);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    if (!isFinite(fx) || !isFinite(fy) || !isFinite(fz)) return;
    this.pitch = clamp(Math.asin(clamp(fy, -1, 1)), this.minPitch, this.maxPitch);
    this.yaw = Math.atan2(-fx, -fz);
  }

  /**
   * Sets the look angles directly.
   * @param {number} yaw Yaw in radians.
   * @param {number} pitch Pitch in radians.
   */
  setRotation(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = clamp(pitch, this.minPitch, this.maxPitch);
    this._applyRotation();
  }

  /**
   * Writes the yaw/pitch quaternion to the camera.
   * @private
   */
  _applyRotation() {
    const cam = this.camera;
    if (!cam || !cam.quaternion) return;
    const hy = this.yaw * 0.5;
    const hp = this.pitch * 0.5;
    const sy = Math.sin(hy);
    const cy = Math.cos(hy);
    const sx = Math.sin(hp);
    const cx = Math.cos(hp);
    // q = Qy(yaw) * Qx(pitch)
    cam.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx);
    cam.matrixWorldNeedsUpdate = true;
    if (cam.matrixAutoUpdate === false && typeof cam.updateMatrix === 'function') {
      cam.updateMatrix();
    }
  }

  /**
   * Writes the camera forward vector.
   * @param {Vec3} out Destination vector.
   * @returns {Vec3} The destination vector.
   */
  getDirection(out) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /**
   * Reads the look delta from mouse and gamepad and updates yaw/pitch.
   * @param {number} dt Frame time in seconds.
   * @private
   */
  _updateLook(dt) {
    const input = this.input;
    if (!input) return;
    let allowMouse = true;
    if (this.requirePointerLock) {
      allowMouse = input.pointerLocked === true ||
        (this.dragToLook && typeof input.isMouseDown === 'function' && input.isMouseDown(0));
    }
    if (allowMouse && input.mouse) {
      const s = this.lookSensitivity;
      this.yaw -= input.mouse.dx * s;
      this.pitch += (this.invertY ? input.mouse.dy : -input.mouse.dy) * s;
    }
    if (typeof input.getGamepadAxis === 'function') {
      const gx = input.getGamepadAxis(this.gamepadIndex, 2);
      const gy = input.getGamepadAxis(this.gamepadIndex, 3);
      if (gx !== 0 || gy !== 0) {
        const s = this.gamepadLookSpeed * dt;
        this.yaw -= gx * s;
        this.pitch += (this.invertY ? gy : -gy) * s;
      }
    }
    if (this.pitch < this.minPitch) this.pitch = this.minPitch;
    else if (this.pitch > this.maxPitch) this.pitch = this.maxPitch;
    const twoPi = Math.PI * 2;
    if (this.yaw > twoPi || this.yaw < -twoPi) this.yaw -= twoPi * Math.round(this.yaw / twoPi);
  }

  /**
   * Builds the normalized movement intent in local space (x = strafe,
   * y = vertical, z = forward).
   * @param {Vec3} out Destination vector.
   * @private
   */
  _readMoveIntent(out) {
    const input = this.input;
    out.set(0, 0, 0);
    if (!input) return;
    const keys = this.keys;
    if (typeof input.isKeyDown === 'function') {
      if (input.isKeyDown(keys.forward)) out.z += 1;
      if (input.isKeyDown(keys.back)) out.z -= 1;
      if (input.isKeyDown(keys.right)) out.x += 1;
      if (input.isKeyDown(keys.left)) out.x -= 1;
      // Read the vertical intent unconditionally. Flying uses it directly, and
      // swimming needs it too: in water the up axis belongs to the player, not
      // to gravity. Walking simply ignores it.
      if (input.isKeyDown(keys.up)) out.y += 1;
      if (input.isKeyDown(keys.down)) out.y -= 1;
    }
    if (typeof input.getGamepadAxis === 'function') {
      const gx = input.getGamepadAxis(this.gamepadIndex, 0);
      const gy = input.getGamepadAxis(this.gamepadIndex, 1);
      if (gx !== 0) out.x += gx;
      if (gy !== 0) out.z -= gy;
    }
    const lenSq = out.x * out.x + out.z * out.z;
    if (lenSq > 1) {
      const inv = 1 / Math.sqrt(lenSq);
      out.x *= inv;
      out.z *= inv;
    }
    if (out.y > 1) out.y = 1;
    else if (out.y < -1) out.y = -1;
  }

  /**
   * True while the sprint key or gamepad button is held.
   * @returns {boolean} Sprint state.
   * @private
   */
  _readSprint() {
    const input = this.input;
    if (!input) return false;
    if (typeof input.isKeyDown === 'function' && input.isKeyDown(this.keys.sprint)) return true;
    if (typeof input.isGamepadButtonDown === 'function' &&
      input.isGamepadButtonDown(this.gamepadIndex, 10)) return true;
    return false;
  }

  /**
   * True during the frame the jump control was activated.
   * @returns {boolean} Jump request.
   * @private
   */
  _readJump() {
    const input = this.input;
    if (!input) return false;
    if (typeof input.isKeyPressed === 'function' && input.isKeyPressed(this.keys.jump)) return true;
    if (typeof input.isGamepadButtonPressed === 'function' &&
      input.isGamepadButtonPressed(this.gamepadIndex, 0)) return true;
    return false;
  }

  /**
   * Advances the controller.
   * @param {number} dt Frame time in seconds.
   */
  update(dt) {
    if (!this.enabled) return;
    const step = dt > 0 ? (dt > 0.1 ? 0.1 : dt) : 0;
    if (step === 0) return;
    const cam = this.camera;
    if (!cam || !cam.position) return;

    this._updateLook(step);
    this._applyRotation();
    this._readMoveIntent(_move);

    const input = this.input;
    this.isCrouching = !!(input && typeof input.isKeyDown === 'function' &&
      input.isKeyDown(this.keys.crouch));
    const wantsMove = _move.x !== 0 || _move.y !== 0 || _move.z !== 0;
    this.isSprinting = wantsMove && this._readSprint();

    let speed = this.moveSpeed;
    if (this.isSprinting) speed *= this.sprintMultiplier;
    if (this.isCrouching) speed *= this.crouchMultiplier;

    // Local intent -> world space. Yaw only, unless flying.
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    if (this.fly) {
      const cp = Math.cos(this.pitch);
      const sp = Math.sin(this.pitch);
      const fx = -sy * cp;
      const fy = sp;
      const fz = -cy * cp;
      _desired.set(
        (cy * _move.x + fx * _move.z) * speed,
        (fy * _move.z + _move.y) * speed,
        (-sy * _move.x + fz * _move.z) * speed
      );
    } else {
      _desired.set(
        (cy * _move.x - sy * _move.z) * speed,
        0,
        (-sy * _move.x - cy * _move.z) * speed
      );
    }

    const grounded = this.controller ? this.controller.isGrounded !== false : this.isGrounded;
    let response = wantsMove ? this.acceleration : this.deceleration;
    if (!this.fly && !grounded) response *= this.airControl;
    const blend = 1 - Math.exp(-response * step);

    this.velocity.x += (_desired.x - this.velocity.x) * blend;
    this.velocity.z += (_desired.z - this.velocity.z) * blend;

    if (this.fly) {
      this.velocity.y += (_desired.y - this.velocity.y) * blend;
      cam.position.x += this.velocity.x * step;
      cam.position.y += this.velocity.y * step;
      cam.position.z += this.velocity.z * step;
      this.isGrounded = false;
    } else if (this.controller) {
      // The character controller owns gravity and collision; hand it the desired
      // horizontal velocity plus an impulse on the frame the jump is requested.
      if (this.controller.swimming === true) {
        // Swimming: the vertical axis is an input, not a consequence. Zeroing it
        // here — which is right on land, where gravity owns Y — is exactly what
        // makes a swimmer unable to dive or surface under their own power.
        this.velocity.y = _move.y * this.swimVerticalSpeed;
      } else {
        this.velocity.y = (grounded && this._readJump()) ? this.jumpSpeed : 0;
      }
      this.controller.move(this.velocity, step);
      this.isGrounded = this.controller.isGrounded !== false;
      const p = this.controller.position;
      if (p) cam.position.set(p.x, p.y + this.eyeHeight, p.z);
    } else {
      // Built-in fallback integrator: gravity plus a flat floor.
      if (this.isGrounded && this._readJump()) {
        this.velocity.y = this.jumpSpeed;
        this.isGrounded = false;
      } else if (!this.isGrounded) {
        this.velocity.y += this.gravity * step;
      }
      cam.position.x += this.velocity.x * step;
      cam.position.y += this.velocity.y * step;
      cam.position.z += this.velocity.z * step;
      const floor = this.groundHeight + this.eyeHeight;
      if (cam.position.y <= floor) {
        cam.position.y = floor;
        if (this.velocity.y < 0) this.velocity.y = 0;
        this.isGrounded = true;
      }
    }

    cam.matrixWorldNeedsUpdate = true;
    if (cam.matrixAutoUpdate === false && typeof cam.updateMatrix === 'function') {
      cam.updateMatrix();
    }
  }

  /**
   * Stops all motion without changing the orientation.
   */
  stop() {
    this.velocity.set(0, 0, 0);
  }

  /**
   * Releases references. The controller owns no listeners of its own.
   */
  dispose() {
    this.enabled = false;
    this.input = null;
    this.controller = null;
  }
}
