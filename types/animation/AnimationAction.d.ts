/** Supported loop modes. */
export const LoopMode: Readonly<{
    ONCE: "once";
    REPEAT: "repeat";
    PINGPONG: "pingpong";
}>;
export class AnimationAction {
    /**
     * Actions are created through `mixer.clipAction(clip)`; constructing one by
     * hand is supported but it must be registered on a mixer to be updated.
     *
     * @param {import('./AnimationMixer.js').AnimationMixer} mixer Owning mixer.
     * @param {import('./AnimationClip.js').AnimationClip} clip Clip to play.
     * @param {import('../scene/Node3D.js').Node3D|null} [root=null] Binding root (defaults to the mixer root).
     */
    constructor(mixer: import('./AnimationMixer.js').AnimationMixer, clip: import('./AnimationClip.js').AnimationClip, root?: import('../scene/Node3D.js').Node3D | null);
    /** @type {import('./AnimationMixer.js').AnimationMixer} Owning mixer. */
    mixer: import('./AnimationMixer.js').AnimationMixer;
    /** @type {import('./AnimationClip.js').AnimationClip} Clip being played. */
    clip: import('./AnimationClip.js').AnimationClip;
    /** @type {import('../scene/Node3D.js').Node3D|null} Binding root. */
    root: import('../scene/Node3D.js').Node3D | null;
    /** @type {boolean} When false the action contributes nothing. */
    enabled: boolean;
    /** @type {boolean} When true the pose is held and time stops advancing. */
    paused: boolean;
    /** @type {number} User weight, before any fade ramp. */
    weight: number;
    /** @type {number} Local playback speed (negative plays backwards). */
    timeScale: number;
    /** @type {number} Current clip local time, seconds. */
    time: number;
    /** @type {string} `'once'` | `'repeat'` | `'pingpong'`. */
    loop: string;
    /** @type {number} Number of clip passes before finishing (Infinity = endless). */
    repetitions: number;
    /** @type {boolean} Hold the last pose (paused) instead of disabling on finish. */
    clampWhenFinished: boolean;
    /** @type {boolean} Auto stop once a fade out reaches weight 0. */
    stopOnFadeOutComplete: boolean;
    /** @type {?function(AnimationAction):void} Called once when the action finishes. */
    onFinished: (arg0: AnimationAction) => void;
    /** @type {?function(AnimationAction, number):void} Called on every loop wrap. */
    onLoop: (arg0: AnimationAction, arg1: number) => void;
    /** @type {Object} Free form user payload. */
    userData: any;
    /** @type {number} Unwrapped time used to detect loop crossings. @private */
    private _rawTime;
    /** @type {number} Loop index of `_rawTime` at the previous update. @private */
    private _loopIndex;
    /** @type {number} Completed clip passes. @private */
    private _completedLoops;
    /** @type {number} Weight applied last frame (weight * fade, 0 when disabled). @private */
    private _effectiveWeight;
    /** @type {number} Persistent fade multiplier in [0,1]. @private */
    private _fadeWeight;
    /** @type {number} Seconds of the running fade (0 = not fading). @private */
    private _fadeDuration;
    /** @type {number} Seconds elapsed inside the running fade. @private */
    private _fadeElapsed;
    /** @type {number} Fade ramp start value. @private */
    private _fadeStart;
    /** @type {number} Fade ramp end value. @private */
    private _fadeEnd;
    /** @type {boolean} True once the action reached its end. @private */
    private _finished;
    /** @type {boolean} True while registered in the mixer active list. @private */
    private _active;
    /** @type {number} Slot inside the mixer active list (-1 when inactive). @private */
    private _activeIndex;
    /** @type {boolean} Deactivation deferred to the end of the current frame. @private */
    private _pendingStop;
    /** @type {Array<Object|null>|null} One property binding per clip track. @private */
    private _bindings;
    /** @type {Int32Array|null} Per track keyframe cursors owned by this action. @private */
    private _trackCache;
    /** @type {number} Clip version the bindings were built against. @private */
    private _clipVersion;
    /** @type {EventBus|null} Created on first listener registration. @private */
    private _events;
    /**
     * Activates the action on its mixer. A finished action is rewound first.
     * @returns {AnimationAction} this
     */
    play(): AnimationAction;
    /**
     * Deactivates the action and rewinds it.
     * @returns {AnimationAction} this
     */
    stop(): AnimationAction;
    /**
     * Rewinds to the start and clears loop / fade state (keeps `weight`).
     * @returns {AnimationAction} this
     */
    reset(): AnimationAction;
    /**
     * Jumps to an absolute clip time (wrapped / clamped per the loop mode).
     * @param {number} time Seconds.
     * @returns {AnimationAction} this
     */
    setTime(time: number): AnimationAction;
    /**
     * @returns {boolean} True when the action currently contributes to the pose.
     */
    isRunning(): boolean;
    /**
     * @returns {boolean} True when the action is registered on the mixer.
     */
    isScheduled(): boolean;
    /**
     * @returns {boolean} True once the action has reached its end.
     */
    isFinished(): boolean;
    /**
     * Configures looping.
     * @param {string} mode `'once'` | `'repeat'` | `'pingpong'`.
     * @param {number} [repetitions=Infinity] Clip passes before finishing.
     * @returns {AnimationAction} this
     */
    setLoop(mode: string, repetitions?: number): AnimationAction;
    /**
     * Sets `timeScale` so one clip pass takes exactly `duration` seconds.
     * @param {number} duration Seconds (must be > 0).
     * @returns {AnimationAction} this
     */
    setDuration(duration: number): AnimationAction;
    /**
     * Copies another action's normalized playback phase onto this one.
     * @param {AnimationAction} other
     * @returns {AnimationAction} this
     */
    syncWith(other: AnimationAction): AnimationAction;
    /**
     * Sets the weight and cancels any running fade, so `weight` becomes the
     * effective weight immediately.
     * @param {number} weight
     * @returns {AnimationAction} this
     */
    setEffectiveWeight(weight: number): AnimationAction;
    /**
     * @returns {number} Weight applied during the last update (0 when disabled).
     */
    getEffectiveWeight(): number;
    /**
     * Sets the local playback speed.
     * @param {number} timeScale
     * @returns {AnimationAction} this
     */
    setEffectiveTimeScale(timeScale: number): AnimationAction;
    /** @returns {number} Local playback speed. */
    getEffectiveTimeScale(): number;
    /**
     * Ramps the fade multiplier up to 1 over `duration` seconds.
     * @param {number} duration Seconds (<= 0 applies instantly).
     * @returns {AnimationAction} this
     */
    fadeIn(duration: number): AnimationAction;
    /**
     * Ramps the fade multiplier down to 0 over `duration` seconds. When
     * `stopOnFadeOutComplete` is true (default) the action is stopped once the
     * ramp reaches zero.
     * @param {number} duration Seconds (<= 0 applies instantly).
     * @returns {AnimationAction} this
     */
    fadeOut(duration: number): AnimationAction;
    /**
     * Fades this action out while fading `other` in, and starts `other`.
     * @param {AnimationAction} other Incoming action.
     * @param {number} duration Cross fade length in seconds.
     * @param {boolean} [warp=false] Also match `other`'s speed and phase to this action.
     * @returns {AnimationAction} this
     */
    crossFadeTo(other: AnimationAction, duration: number, warp?: boolean): AnimationAction;
    /**
     * Inverse of {@link crossFadeTo}: fades `other` out and this action in.
     * @param {AnimationAction} other Outgoing action.
     * @param {number} duration Cross fade length in seconds.
     * @param {boolean} [warp=false] Match this action's speed and phase to `other`.
     * @returns {AnimationAction} this
     */
    crossFadeFrom(other: AnimationAction, duration: number, warp?: boolean): AnimationAction;
    /**
     * Fades out and stops, whatever `stopOnFadeOutComplete` says.
     * @param {number} duration Seconds.
     * @returns {AnimationAction} this
     */
    halt(duration: number): AnimationAction;
    /**
     * Cancels a running fade, keeping the multiplier reached so far.
     * @returns {AnimationAction} this
     */
    stopFading(): AnimationAction;
    /**
     * Starts a weight ramp from `from` toward `target`.
     * @private
     * @param {number} target Final fade multiplier.
     * @param {number} duration Seconds (<= 0 applies `target` instantly).
     * @param {number} from Initial fade multiplier.
     * @returns {AnimationAction} this
     */
    private _scheduleFade;
    /**
     * Registers a listener. Types: `'finished'`, `'loop'`.
     * @param {string} type
     * @param {function(AnimationAction, number):void} fn
     * @returns {AnimationAction} this
     */
    on(type: string, fn: (arg0: AnimationAction, arg1: number) => void): AnimationAction;
    /**
     * Registers a one shot listener.
     * @param {string} type
     * @param {function(AnimationAction, number):void} fn
     * @returns {AnimationAction} this
     */
    once(type: string, fn: (arg0: AnimationAction, arg1: number) => void): AnimationAction;
    /**
     * Removes a listener.
     * @param {string} type
     * @param {function(AnimationAction, number):void} fn
     * @returns {AnimationAction} this
     */
    off(type: string, fn: (arg0: AnimationAction, arg1: number) => void): AnimationAction;
    /**
     * Advances weight and time by one frame.
     * @private
     * @param {number} delta Mixer scaled delta in seconds.
     * @returns {number} Effective weight for this frame.
     */
    private _update;
    /**
     * Advances the fade ramp and recomputes the effective weight.
     * @private
     * @param {number} delta Seconds (sign ignored - fades run in wall clock time).
     * @returns {number}
     */
    private _updateWeight;
    /**
     * Advances the clip time, handling loop wrapping and the end of playback.
     * @private
     * @param {number} delta Seconds, already multiplied by `timeScale`.
     * @returns {void}
     */
    private _updateTime;
    /**
     * Maps an unwrapped time onto a ping pong timeline.
     * @private
     * @param {number} raw
     * @param {number} duration
     * @returns {number}
     */
    private _pingPongTime;
    /**
     * Ends playback, honouring `clampWhenFinished`, and fires the events.
     * @private
     * @returns {void}
     */
    private _finish;
    /**
     * Removes the action from the mixer active list immediately.
     * @private
     * @returns {void}
     */
    private _deactivate;
}
