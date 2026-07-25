/**
 * Driver input from keyboard, gamepad or touch, reduced to four numbers.
 *
 * The vehicle never learns which device is driving it. That matters more than
 * it sounds: a gamepad trigger is analogue and a key is not, so if the physics
 * read keys directly it would only ever see full throttle, and every tuning
 * decision would silently assume that. Ramping the digital inputs into the same
 * 0..1 range the stick already produces keeps one model honest for all three.
 */

import { clamp } from '../../../src/math/MathUtils.js';

/** Standard gamepad mapping (the layout `navigator.getGamepads` promises). */
const PAD = {
  LEFT_STICK_X: 0,
  RIGHT_TRIGGER: 7,
  LEFT_TRIGGER: 6,
  A: 0,
  B: 1,
  START: 9,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

/** Below this a stick is considered centred. */
const STICK_DEADZONE = 0.12;

/**
 * Unified driver input.
 */
export class KartInput {
  /**
   * @param {Object} options
   * @param {import('../../../src/input/Input.js').Input} options.input
   * @param {HTMLCanvasElement} options.canvas
   */
  constructor(options) {
    /** @type {import('../../../src/input/Input.js').Input} */
    this.input = options.input;
    /** @type {HTMLCanvasElement} */
    this.canvas = options.canvas;

    /** @type {number} -1..1, negative reverses. */
    this.throttle = 0;
    /** @type {number} 0..1 */
    this.brake = 0;
    /** @type {number} -1..1 */
    this.steer = 0;
    /** @type {boolean} */
    this.handbrake = false;
    /** @type {boolean} True during the frame a reset was requested. */
    this.resetPressed = false;

    /** @type {string} Which device last produced input; shown in the HUD. */
    this.device = 'teclado';

    /** @type {number} Seconds for a key to reach full throttle. */
    this.rampUp = 2.6;
    /** @type {number} Seconds for a released key to return to zero. */
    this.rampDown = 4.5;
    /** @type {number} Steering ramp for digital input. */
    this.steerRamp = 3.4;

    /** @private Touch state. */
    this._touch = {
      steerId: -1, steerStartX: 0, steerValue: 0,
      pedalId: -1, pedalThrottle: 0, pedalBrake: 0,
      active: false,
    };

    this._bindTouch();
  }

  /** @private */
  _bindTouch() {
    const canvas = this.canvas;
    const t = this._touch;

    const rect = () => canvas.getBoundingClientRect();

    canvas.addEventListener('touchstart', (event) => {
      const r = rect();
      for (const touch of event.changedTouches) {
        const x = touch.clientX - r.left;
        const y = touch.clientY - r.top;
        // Left half steers, right half is the pedal area: the layout every
        // touch racer uses, because thumbs do not move.
        if (x < r.width * 0.5 && t.steerId === -1) {
          t.steerId = touch.identifier;
          t.steerStartX = x;
        } else if (x >= r.width * 0.5 && t.pedalId === -1) {
          t.pedalId = touch.identifier;
          const upper = y < r.height * 0.55;
          t.pedalThrottle = upper ? 1 : 0;
          t.pedalBrake = upper ? 0 : 1;
        }
      }
      t.active = true;
      event.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', (event) => {
      const r = rect();
      for (const touch of event.changedTouches) {
        if (touch.identifier === t.steerId) {
          const x = touch.clientX - r.left;
          // Full lock after dragging a fifth of the screen width.
          t.steerValue = clamp((x - t.steerStartX) / (r.width * 0.2), -1, 1);
        } else if (touch.identifier === t.pedalId) {
          const y = touch.clientY - r.top;
          const upper = y < r.height * 0.55;
          t.pedalThrottle = upper ? 1 : 0;
          t.pedalBrake = upper ? 0 : 1;
        }
      }
      event.preventDefault();
    }, { passive: false });

    const end = (event) => {
      for (const touch of event.changedTouches) {
        if (touch.identifier === t.steerId) { t.steerId = -1; t.steerValue = 0; }
        else if (touch.identifier === t.pedalId) {
          t.pedalId = -1; t.pedalThrottle = 0; t.pedalBrake = 0;
        }
      }
      if (t.steerId === -1 && t.pedalId === -1) t.active = false;
    };
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('touchcancel', end);
  }

  /**
   * Reads every device and produces the frame's control values.
   * @param {number} dt
   */
  update(dt) {
    const input = this.input;
    this.resetPressed = false;

    // ---- gamepad: analogue, so it wins when present ---------------------
    const padSteer = input.getGamepadAxis(0, PAD.LEFT_STICK_X);
    const padThrottle = input.getGamepadButton(0, PAD.RIGHT_TRIGGER);
    const padBrake = input.getGamepadButton(0, PAD.LEFT_TRIGGER);
    const padActive = Math.abs(padSteer) > STICK_DEADZONE ||
      padThrottle > 0.02 || padBrake > 0.02;

    if (padActive) {
      this.device = 'gamepad';
      const dead = Math.abs(padSteer) < STICK_DEADZONE ? 0 : padSteer;
      // Square the stick: fine control near centre, full lock still reachable.
      this.steer = Math.sign(dead) * dead * dead;
      this.throttle = padThrottle;
      this.brake = padBrake;
      this.handbrake = input.isGamepadButtonDown(0, PAD.A);
      if (input.isGamepadButtonPressed(0, PAD.B)) this.resetPressed = true;
      return;
    }

    // ---- touch -----------------------------------------------------------
    const t = this._touch;
    if (t.active) {
      this.device = 'toque';
      this.steer = t.steerValue;
      this.throttle = t.pedalThrottle;
      this.brake = t.pedalBrake;
      this.handbrake = false;
      return;
    }

    // ---- keyboard: digital, ramped into the same range -------------------
    this.device = 'teclado';

    let throttleTarget = 0;
    if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) throttleTarget += 1;
    if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) throttleTarget -= 1;

    const ramp = throttleTarget !== 0 ? this.rampUp : this.rampDown;
    this.throttle += (throttleTarget - this.throttle) * Math.min(1, ramp * dt);
    if (Math.abs(this.throttle) < 0.01) this.throttle = 0;

    let steerTarget = 0;
    if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) steerTarget -= 1;
    if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) steerTarget += 1;
    // Returning to centre is faster than turning in, same as the steering rack.
    const steerRate = steerTarget !== 0 ? this.steerRamp : this.steerRamp * 2.2;
    this.steer += (steerTarget - this.steer) * Math.min(1, steerRate * dt);
    if (Math.abs(this.steer) < 0.01) this.steer = 0;

    this.brake = input.isKeyDown('Space') ? 1 : 0;
    this.handbrake = input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight');
    if (input.isKeyPressed('KeyR')) this.resetPressed = true;
  }
}
