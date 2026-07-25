export class Time {
    /**
     * @param {number} [maxDelta=0.1] Maximum frame delta in seconds. Any longer
     *   stall (tab switch, breakpoint, ...) is clamped so simulations stay sane.
     */
    constructor(maxDelta?: number);
    /** @type {number} Scaled time accumulated since the last reset, seconds. */
    elapsed: number;
    /** @type {number} Unscaled time accumulated since the last reset, seconds. */
    unscaledElapsed: number;
    /** @type {number} Scaled duration of the last frame, seconds. */
    delta: number;
    /** @type {number} Clamped, unscaled duration of the last frame, seconds. */
    unscaledDelta: number;
    /** @type {number} Multiplier applied to `delta` and `elapsed`. */
    timeScale: number;
    /** @type {number} Number of frames processed since the last reset. */
    frame: number;
    /** @type {number} Frames per second averaged over `FPS_WINDOW`. */
    fps: number;
    /** @type {number} Exponentially smoothed unscaled delta, seconds. */
    smoothDelta: number;
    /** @type {number} Delta ceiling in seconds. */
    maxDelta: number;
    /** @type {number} Timestamp of the first accepted sample, seconds. */
    startTime: number;
    /** @type {number} Raw timestamp of the last sample, seconds. */
    now: number;
    /** @private @type {number} Previous timestamp, -1 when unsynced. */
    private _last;
    /** @private @type {number} Start of the current fps window, seconds. */
    private _fpsLast;
    /** @private @type {number} Frames counted in the current fps window. */
    private _fpsFrames;
    /**
     * Advances the clock.
     * @param {number} nowMs Current timestamp in milliseconds (rAF timestamp).
     * @returns {Time} this
     */
    update(nowMs: number): Time;
    /**
     * Drops the timestamp baseline without touching accumulated time. The next
     * `update` therefore reports a zero delta. Use it when resuming from a
     * paused state so the simulation does not jump forward.
     * @returns {Time} this
     */
    resync(): Time;
    /**
     * Fully resets the clock: elapsed time, frame counter and statistics.
     * @returns {Time} this
     */
    reset(): Time;
}
