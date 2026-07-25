/**
 * Time - frame clock.
 *
 * The clock is fed from the outside (`update(nowMs)`), typically with the
 * timestamp handed over by requestAnimationFrame, so the module never touches
 * `performance` and stays usable headless.
 *
 * @module core/Time
 */

/** Hard ceiling applied to the raw frame delta, in seconds. */
const MAX_DELTA = 0.1;
/** Exponential smoothing factor used by `smoothDelta`. */
const SMOOTH_FACTOR = 0.1;
/** Window, in seconds, over which the fps average is computed. */
const FPS_WINDOW = 0.5;

export class Time {
  /**
   * @param {number} [maxDelta=0.1] Maximum frame delta in seconds. Any longer
   *   stall (tab switch, breakpoint, ...) is clamped so simulations stay sane.
   */
  constructor(maxDelta = MAX_DELTA) {
    /** @type {number} Scaled time accumulated since the last reset, seconds. */
    this.elapsed = 0;
    /** @type {number} Unscaled time accumulated since the last reset, seconds. */
    this.unscaledElapsed = 0;
    /** @type {number} Scaled duration of the last frame, seconds. */
    this.delta = 0;
    /** @type {number} Clamped, unscaled duration of the last frame, seconds. */
    this.unscaledDelta = 0;
    /** @type {number} Multiplier applied to `delta` and `elapsed`. */
    this.timeScale = 1;
    /** @type {number} Number of frames processed since the last reset. */
    this.frame = 0;
    /** @type {number} Frames per second averaged over `FPS_WINDOW`. */
    this.fps = 0;
    /** @type {number} Exponentially smoothed unscaled delta, seconds. */
    this.smoothDelta = 1 / 60;
    /** @type {number} Delta ceiling in seconds. */
    this.maxDelta = maxDelta;
    /** @type {number} Timestamp of the first accepted sample, seconds. */
    this.startTime = 0;
    /** @type {number} Raw timestamp of the last sample, seconds. */
    this.now = 0;

    /** @private @type {number} Previous timestamp, -1 when unsynced. */
    this._last = -1;
    /** @private @type {number} Start of the current fps window, seconds. */
    this._fpsLast = 0;
    /** @private @type {number} Frames counted in the current fps window. */
    this._fpsFrames = 0;
  }

  /**
   * Advances the clock.
   * @param {number} nowMs Current timestamp in milliseconds (rAF timestamp).
   * @returns {Time} this
   */
  update(nowMs) {
    const now = nowMs * 0.001;
    this.now = now;

    if (this._last < 0) {
      // First sample after construction/reset/resync: no elapsed time yet.
      this._last = now;
      this._fpsLast = now;
      this._fpsFrames = 0;
      if (this.frame === 0) this.startTime = now;
      this.unscaledDelta = 0;
      this.delta = 0;
      this.frame++;
      return this;
    }

    let dt = now - this._last;
    this._last = now;
    if (dt < 0) dt = 0;
    else if (dt > this.maxDelta) dt = this.maxDelta;

    this.unscaledDelta = dt;
    this.delta = dt * this.timeScale;
    this.unscaledElapsed += dt;
    this.elapsed += this.delta;
    this.frame++;
    this.smoothDelta += (dt - this.smoothDelta) * SMOOTH_FACTOR;

    this._fpsFrames++;
    const span = now - this._fpsLast;
    if (span >= FPS_WINDOW) {
      this.fps = this._fpsFrames / span;
      this._fpsLast = now;
      this._fpsFrames = 0;
    }

    return this;
  }

  /**
   * Drops the timestamp baseline without touching accumulated time. The next
   * `update` therefore reports a zero delta. Use it when resuming from a
   * paused state so the simulation does not jump forward.
   * @returns {Time} this
   */
  resync() {
    this._last = -1;
    this.delta = 0;
    this.unscaledDelta = 0;
    this._fpsFrames = 0;
    return this;
  }

  /**
   * Fully resets the clock: elapsed time, frame counter and statistics.
   * @returns {Time} this
   */
  reset() {
    this.elapsed = 0;
    this.unscaledElapsed = 0;
    this.delta = 0;
    this.unscaledDelta = 0;
    this.frame = 0;
    this.fps = 0;
    this.smoothDelta = 1 / 60;
    this.startTime = 0;
    this.now = 0;
    this._last = -1;
    this._fpsLast = 0;
    this._fpsFrames = 0;
    return this;
  }
}
