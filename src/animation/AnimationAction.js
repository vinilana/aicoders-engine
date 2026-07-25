/**
 * AnimationAction - playback state of one {@link AnimationClip} on one root.
 *
 * The action owns everything that is per instance (time, weight, loop mode,
 * fades); the clip stays immutable and shared. Several actions may play the
 * same clip simultaneously - each one keeps its own keyframe cursors, so the
 * shared tracks are never re-seeked because of a neighbour.
 *
 * All of the per frame work is done by `_update`, called by the
 * {@link AnimationMixer}; it allocates nothing.
 *
 * @module animation/AnimationAction
 */

import { EventBus } from '../core/EventBus.js';
import { euclideanModulo } from '../math/MathUtils.js';

/** Supported loop modes. */
export const LoopMode = Object.freeze({
  ONCE: 'once',
  REPEAT: 'repeat',
  PINGPONG: 'pingpong'
});

export class AnimationAction {
  /**
   * Actions are created through `mixer.clipAction(clip)`; constructing one by
   * hand is supported but it must be registered on a mixer to be updated.
   *
   * @param {import('./AnimationMixer.js').AnimationMixer} mixer Owning mixer.
   * @param {import('./AnimationClip.js').AnimationClip} clip Clip to play.
   * @param {import('../scene/Node3D.js').Node3D|null} [root=null] Binding root (defaults to the mixer root).
   */
  constructor(mixer, clip, root = null) {
    /** @type {import('./AnimationMixer.js').AnimationMixer} Owning mixer. */
    this.mixer = mixer;

    /** @type {import('./AnimationClip.js').AnimationClip} Clip being played. */
    this.clip = clip;

    /** @type {import('../scene/Node3D.js').Node3D|null} Binding root. */
    this.root = root !== null ? root : (mixer !== null && mixer !== undefined ? mixer.getRoot() : null);

    /** @type {boolean} When false the action contributes nothing. */
    this.enabled = true;

    /** @type {boolean} When true the pose is held and time stops advancing. */
    this.paused = false;

    /** @type {number} User weight, before any fade ramp. */
    this.weight = 1;

    /** @type {number} Local playback speed (negative plays backwards). */
    this.timeScale = 1;

    /** @type {number} Current clip local time, seconds. */
    this.time = 0;

    /** @type {string} `'once'` | `'repeat'` | `'pingpong'`. */
    this.loop = LoopMode.REPEAT;

    /** @type {number} Number of clip passes before finishing (Infinity = endless). */
    this.repetitions = Infinity;

    /** @type {boolean} Hold the last pose (paused) instead of disabling on finish. */
    this.clampWhenFinished = false;

    /** @type {boolean} Auto stop once a fade out reaches weight 0. */
    this.stopOnFadeOutComplete = true;

    /** @type {?function(AnimationAction):void} Called once when the action finishes. */
    this.onFinished = null;

    /** @type {?function(AnimationAction, number):void} Called on every loop wrap. */
    this.onLoop = null;

    /** @type {Object} Free form user payload. */
    this.userData = {};

    /* ---- internal playback state ---- */

    /** @type {number} Unwrapped time used to detect loop crossings. @private */
    this._rawTime = 0;

    /** @type {number} Loop index of `_rawTime` at the previous update. @private */
    this._loopIndex = 0;

    /** @type {number} Completed clip passes. @private */
    this._completedLoops = 0;

    /** @type {number} Weight applied last frame (weight * fade, 0 when disabled). @private */
    this._effectiveWeight = 1;

    /** @type {number} Persistent fade multiplier in [0,1]. @private */
    this._fadeWeight = 1;

    /** @type {number} Seconds of the running fade (0 = not fading). @private */
    this._fadeDuration = 0;

    /** @type {number} Seconds elapsed inside the running fade. @private */
    this._fadeElapsed = 0;

    /** @type {number} Fade ramp start value. @private */
    this._fadeStart = 1;

    /** @type {number} Fade ramp end value. @private */
    this._fadeEnd = 1;

    /** @type {boolean} True once the action reached its end. @private */
    this._finished = false;

    /** @type {boolean} True while registered in the mixer active list. @private */
    this._active = false;

    /** @type {number} Slot inside the mixer active list (-1 when inactive). @private */
    this._activeIndex = -1;

    /** @type {boolean} Deactivation deferred to the end of the current frame. @private */
    this._pendingStop = false;

    /** @type {Array<Object|null>|null} One property binding per clip track. @private */
    this._bindings = null;

    /** @type {Int32Array|null} Per track keyframe cursors owned by this action. @private */
    this._trackCache = null;

    /** @type {number} Clip version the bindings were built against. @private */
    this._clipVersion = -1;

    /** @type {EventBus|null} Created on first listener registration. @private */
    this._events = null;
  }

  /* -------------------------------------------------------------------- */
  /* Transport                                                             */
  /* -------------------------------------------------------------------- */

  /**
   * Activates the action on its mixer. A finished action is rewound first.
   * @returns {AnimationAction} this
   */
  play() {
    if (this._finished) this.reset();
    // Replaying an action that was silenced by a completed fade out restores
    // its weight; a fade scheduled just before `play()` (cross fades) is kept.
    if (this._fadeDuration === 0 && this._fadeWeight === 0) {
      this._fadeWeight = 1;
      this._fadeStart = 1;
      this._fadeEnd = 1;
    }
    this.enabled = true;
    this._effectiveWeight = this.weight * this._fadeWeight;
    if (this.mixer !== null && this.mixer !== undefined) this.mixer._activateAction(this);
    return this;
  }

  /**
   * Deactivates the action and rewinds it.
   * @returns {AnimationAction} this
   */
  stop() {
    this._deactivate();
    return this.reset();
  }

  /**
   * Rewinds to the start and clears loop / fade state (keeps `weight`).
   * @returns {AnimationAction} this
   */
  reset() {
    this.time = 0;
    this._rawTime = 0;
    this._loopIndex = 0;
    this._completedLoops = 0;
    this._finished = false;
    this._pendingStop = false;
    this.paused = false;
    this.enabled = true;
    this._fadeWeight = 1;
    this.stopFading();
    this._effectiveWeight = this.weight;
    const cache = this._trackCache;
    if (cache !== null) cache.fill(0);
    return this;
  }

  /**
   * Jumps to an absolute clip time (wrapped / clamped per the loop mode).
   * @param {number} time Seconds.
   * @returns {AnimationAction} this
   */
  setTime(time) {
    const duration = this.clip !== null ? this.clip.duration : 0;
    this._rawTime = time;
    if (duration > 0) {
      this._loopIndex = Math.floor(time / duration);
      this.time = this.loop === LoopMode.PINGPONG
        ? this._pingPongTime(time, duration)
        : (this.loop === LoopMode.REPEAT ? euclideanModulo(time, duration) : (time < 0 ? 0 : (time > duration ? duration : time)));
    } else {
      this._loopIndex = 0;
      this.time = 0;
    }
    const cache = this._trackCache;
    if (cache !== null) cache.fill(0);
    return this;
  }

  /**
   * @returns {boolean} True when the action currently contributes to the pose.
   */
  isRunning() {
    return this._active && this.enabled && !this.paused && this._effectiveWeight > 0;
  }

  /**
   * @returns {boolean} True when the action is registered on the mixer.
   */
  isScheduled() {
    return this._active;
  }

  /**
   * @returns {boolean} True once the action has reached its end.
   */
  isFinished() {
    return this._finished;
  }

  /**
   * Configures looping.
   * @param {string} mode `'once'` | `'repeat'` | `'pingpong'`.
   * @param {number} [repetitions=Infinity] Clip passes before finishing.
   * @returns {AnimationAction} this
   */
  setLoop(mode, repetitions = Infinity) {
    this.loop = mode === LoopMode.ONCE || mode === LoopMode.PINGPONG ? mode : LoopMode.REPEAT;
    this.repetitions = repetitions;
    return this;
  }

  /**
   * Sets `timeScale` so one clip pass takes exactly `duration` seconds.
   * @param {number} duration Seconds (must be > 0).
   * @returns {AnimationAction} this
   */
  setDuration(duration) {
    const clipDuration = this.clip !== null ? this.clip.duration : 0;
    this.timeScale = duration > 0 && clipDuration > 0 ? clipDuration / duration : 1;
    return this;
  }

  /**
   * Copies another action's normalized playback phase onto this one.
   * @param {AnimationAction} other
   * @returns {AnimationAction} this
   */
  syncWith(other) {
    if (other === null || other === undefined) return this;
    const otherDuration = other.clip !== null ? other.clip.duration : 0;
    const duration = this.clip !== null ? this.clip.duration : 0;
    if (otherDuration > 0 && duration > 0) {
      this.setTime((other.time / otherDuration) * duration);
    } else {
      this.setTime(other.time);
    }
    this.timeScale = other.timeScale;
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Weight and fading                                                     */
  /* -------------------------------------------------------------------- */

  /**
   * Sets the weight and cancels any running fade, so `weight` becomes the
   * effective weight immediately.
   * @param {number} weight
   * @returns {AnimationAction} this
   */
  setEffectiveWeight(weight) {
    this.weight = weight;
    this._fadeWeight = 1;
    this.stopFading();
    this._effectiveWeight = this.enabled ? weight : 0;
    return this;
  }

  /**
   * @returns {number} Weight applied during the last update (0 when disabled).
   */
  getEffectiveWeight() {
    return this._effectiveWeight;
  }

  /**
   * Sets the local playback speed.
   * @param {number} timeScale
   * @returns {AnimationAction} this
   */
  setEffectiveTimeScale(timeScale) {
    this.timeScale = timeScale;
    return this;
  }

  /** @returns {number} Local playback speed. */
  getEffectiveTimeScale() {
    return this.timeScale;
  }

  /**
   * Ramps the fade multiplier up to 1 over `duration` seconds.
   * @param {number} duration Seconds (<= 0 applies instantly).
   * @returns {AnimationAction} this
   */
  fadeIn(duration) {
    // A fade already in flight continues from where it is (no pop when a fade
    // out is interrupted); otherwise the ramp starts from silence.
    return this._scheduleFade(1, duration, this._fadeDuration > 0 ? this._fadeWeight : 0);
  }

  /**
   * Ramps the fade multiplier down to 0 over `duration` seconds. When
   * `stopOnFadeOutComplete` is true (default) the action is stopped once the
   * ramp reaches zero.
   * @param {number} duration Seconds (<= 0 applies instantly).
   * @returns {AnimationAction} this
   */
  fadeOut(duration) {
    return this._scheduleFade(0, duration, this._fadeWeight);
  }

  /**
   * Fades this action out while fading `other` in, and starts `other`.
   * @param {AnimationAction} other Incoming action.
   * @param {number} duration Cross fade length in seconds.
   * @param {boolean} [warp=false] Also match `other`'s speed and phase to this action.
   * @returns {AnimationAction} this
   */
  crossFadeTo(other, duration, warp = false) {
    if (other === null || other === undefined || other === this) return this;
    if (warp === true) {
      const a = this.clip !== null ? this.clip.duration : 0;
      const b = other.clip !== null ? other.clip.duration : 0;
      if (a > 0 && b > 0) {
        other.timeScale = this.timeScale * (b / a);
        other.setTime((this.time / a) * b);
      }
    }
    this.fadeOut(duration);
    other.fadeIn(duration);
    other.play();
    return this;
  }

  /**
   * Inverse of {@link crossFadeTo}: fades `other` out and this action in.
   * @param {AnimationAction} other Outgoing action.
   * @param {number} duration Cross fade length in seconds.
   * @param {boolean} [warp=false] Match this action's speed and phase to `other`.
   * @returns {AnimationAction} this
   */
  crossFadeFrom(other, duration, warp = false) {
    if (other === null || other === undefined || other === this) return this;
    other.crossFadeTo(this, duration, warp);
    return this;
  }

  /**
   * Fades out and stops, whatever `stopOnFadeOutComplete` says.
   * @param {number} duration Seconds.
   * @returns {AnimationAction} this
   */
  halt(duration) {
    this.stopOnFadeOutComplete = true;
    return this.fadeOut(duration);
  }

  /**
   * Cancels a running fade, keeping the multiplier reached so far.
   * @returns {AnimationAction} this
   */
  stopFading() {
    this._fadeDuration = 0;
    this._fadeElapsed = 0;
    this._fadeStart = this._fadeWeight;
    this._fadeEnd = this._fadeWeight;
    return this;
  }

  /**
   * Starts a weight ramp from `from` toward `target`.
   * @private
   * @param {number} target Final fade multiplier.
   * @param {number} duration Seconds (<= 0 applies `target` instantly).
   * @param {number} from Initial fade multiplier.
   * @returns {AnimationAction} this
   */
  _scheduleFade(target, duration, from) {
    if (!(duration > 0)) {
      this._fadeWeight = target;
      this._fadeDuration = 0;
      this._fadeElapsed = 0;
      this._fadeStart = target;
      this._fadeEnd = target;
      this._effectiveWeight = this.enabled ? this.weight * target : 0;
      if (target === 0 && this.stopOnFadeOutComplete) {
        this.enabled = false;
        this._effectiveWeight = 0;
        this._deactivate();
      }
      return this;
    }
    this._fadeWeight = from;
    this._fadeStart = from;
    this._fadeEnd = target;
    this._fadeDuration = duration;
    this._fadeElapsed = 0;
    this._effectiveWeight = this.enabled ? this.weight * from : 0;
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Events                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Registers a listener. Types: `'finished'`, `'loop'`.
   * @param {string} type
   * @param {function(AnimationAction, number):void} fn
   * @returns {AnimationAction} this
   */
  on(type, fn) {
    if (this._events === null) this._events = new EventBus();
    this._events.on(type, fn);
    return this;
  }

  /**
   * Registers a one shot listener.
   * @param {string} type
   * @param {function(AnimationAction, number):void} fn
   * @returns {AnimationAction} this
   */
  once(type, fn) {
    if (this._events === null) this._events = new EventBus();
    this._events.once(type, fn);
    return this;
  }

  /**
   * Removes a listener.
   * @param {string} type
   * @param {function(AnimationAction, number):void} fn
   * @returns {AnimationAction} this
   */
  off(type, fn) {
    if (this._events !== null) this._events.off(type, fn);
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Per frame update (called by the mixer)                                */
  /* -------------------------------------------------------------------- */

  /**
   * Advances weight and time by one frame.
   * @private
   * @param {number} delta Mixer scaled delta in seconds.
   * @returns {number} Effective weight for this frame.
   */
  _update(delta) {
    if (!this.enabled) {
      this._effectiveWeight = 0;
      return 0;
    }

    const weight = this._updateWeight(delta);
    if (!this.paused && this.clip !== null) {
      const scaled = delta * this.timeScale;
      if (scaled !== 0) this._updateTime(scaled);
    }
    return weight;
  }

  /**
   * Advances the fade ramp and recomputes the effective weight.
   * @private
   * @param {number} delta Seconds (sign ignored - fades run in wall clock time).
   * @returns {number}
   */
  _updateWeight(delta) {
    let fade = this._fadeWeight;
    const duration = this._fadeDuration;

    if (duration > 0) {
      this._fadeElapsed += delta < 0 ? -delta : delta;
      let p = this._fadeElapsed / duration;
      if (p >= 1) p = 1;
      fade = this._fadeStart + (this._fadeEnd - this._fadeStart) * p;
      this._fadeWeight = fade;
      if (p === 1) {
        this._fadeDuration = 0;
        this._fadeElapsed = 0;
        this._fadeStart = fade;
        if (fade === 0 && this.stopOnFadeOutComplete) {
          this.enabled = false;
          this._effectiveWeight = 0;
          this._deactivate();
          return 0;
        }
      }
    }

    const weight = this.weight * fade;
    this._effectiveWeight = weight > 0 ? weight : 0;
    return this._effectiveWeight;
  }

  /**
   * Advances the clip time, handling loop wrapping and the end of playback.
   * @private
   * @param {number} delta Seconds, already multiplied by `timeScale`.
   * @returns {void}
   */
  _updateTime(delta) {
    const duration = this.clip.duration;

    if (!(duration > 0)) {
      this.time = 0;
      this._rawTime = 0;
      if (this.loop === LoopMode.ONCE && !this._finished) this._finish();
      return;
    }

    const raw = this._rawTime + delta;
    const loop = this.loop;

    if (loop === LoopMode.ONCE) {
      if (raw >= duration) {
        this._rawTime = duration;
        this.time = duration;
        if (!this._finished) this._finish();
      } else if (raw <= 0) {
        this._rawTime = 0;
        this.time = 0;
        if (delta < 0 && !this._finished) this._finish();
      } else {
        this._rawTime = raw;
        this.time = raw;
      }
      return;
    }

    const loopIndex = Math.floor(raw / duration);
    const previous = this._loopIndex;
    let crossings = loopIndex - previous;
    if (crossings < 0) crossings = -crossings;

    if (crossings > 0) {
      const remaining = this.repetitions - this._completedLoops;
      if (crossings >= remaining) {
        // Stop exactly on the boundary of the last allowed repetition.
        const forward = delta >= 0;
        const endLoop = previous + (forward ? remaining : -remaining);
        const endRaw = endLoop * duration;
        this._rawTime = endRaw;
        this._loopIndex = endLoop;
        this._completedLoops = this.repetitions;
        this.time = loop === LoopMode.PINGPONG
          ? this._pingPongTime(endRaw, duration)
          : (forward ? duration : 0);
        if (!this._finished) this._finish();
        return;
      }
      this._completedLoops += crossings;
      this._loopIndex = loopIndex;
    }

    this._rawTime = raw;
    this.time = loop === LoopMode.PINGPONG
      ? this._pingPongTime(raw, duration)
      : euclideanModulo(raw, duration);

    if (crossings > 0) {
      const cache = this._trackCache;
      if (cache !== null) cache.fill(0);
      if (this.onLoop !== null) this.onLoop(this, crossings);
      if (this._events !== null) this._events.emit('loop', this, crossings);
      const mixer = this.mixer;
      if (mixer !== null && mixer !== undefined) mixer._onActionLoop(this, crossings);
    }
  }

  /**
   * Maps an unwrapped time onto a ping pong timeline.
   * @private
   * @param {number} raw
   * @param {number} duration
   * @returns {number}
   */
  _pingPongTime(raw, duration) {
    const period = duration * 2;
    const u = euclideanModulo(raw, period);
    return u <= duration ? u : period - u;
  }

  /**
   * Ends playback, honouring `clampWhenFinished`, and fires the events.
   * @private
   * @returns {void}
   */
  _finish() {
    this._finished = true;
    if (this.clampWhenFinished) {
      this.paused = true;
    } else {
      // `enabled` stops the action from being advanced again, but the weight is
      // deliberately kept so the frame that reached the end still writes the
      // final pose. The mixer removes the action once the frame is done.
      this.enabled = false;
      this._pendingStop = true;
    }

    if (this.onFinished !== null) this.onFinished(this);
    if (this._events !== null) this._events.emit('finished', this, 0);
    const mixer = this.mixer;
    if (mixer !== null && mixer !== undefined) mixer._onActionFinished(this);
  }

  /**
   * Removes the action from the mixer active list immediately.
   * @private
   * @returns {void}
   */
  _deactivate() {
    this._pendingStop = false;
    const mixer = this.mixer;
    if (mixer !== null && mixer !== undefined) mixer._deactivateAction(this);
  }
}
