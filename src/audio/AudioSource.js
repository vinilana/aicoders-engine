/**
 * @fileoverview Positional audio emitter that lives in the scene graph. It is a
 * Node3D, so it can be parented to any object; `updateFromNode()` pushes the
 * world matrix into the PannerNode (position and cone orientation).
 */

import { Node3D } from '../scene/Node3D.js';

/** Smoothing time constant for panner parameter ramps, in seconds. */
const PARAM_SMOOTHING = 0.02;
/** Squared distance below which the panner is not re-uploaded. */
const MOVE_EPSILON_SQ = 1e-8;

/**
 * A scene-graph node that plays an AudioBuffer, optionally in 3D.
 */
export class AudioSource extends Node3D {
  /**
   * @param {import('./AudioEngine.js').AudioEngine} engine Owning engine.
   * @param {*} [buffer] Decoded AudioBuffer (may be assigned later).
   * @param {Object} [options] Source options.
   * @param {boolean} [options.positional=true] Use an HRTF PannerNode.
   * @param {boolean} [options.loop=false] Loop playback.
   * @param {number} [options.volume=1] Linear gain.
   * @param {number} [options.playbackRate=1] Playback rate.
   * @param {number} [options.detune=0] Detune in cents.
   * @param {string} [options.bus='sfx'] Destination bus name.
   * @param {number} [options.refDistance=1] Distance at which the volume is unattenuated.
   * @param {number} [options.maxDistance=10000] Distance beyond which attenuation stops.
   * @param {number} [options.rolloffFactor=1] Attenuation steepness.
   * @param {string} [options.distanceModel='inverse'] 'linear' | 'inverse' | 'exponential'.
   * @param {string} [options.panningModel='HRTF'] 'equalpower' | 'HRTF'.
   * @param {number} [options.coneInnerAngle=360] Inner cone angle in degrees.
   * @param {number} [options.coneOuterAngle=360] Outer cone angle in degrees.
   * @param {number} [options.coneOuterGain=0] Gain outside the outer cone.
   * @param {boolean} [options.autoplay=false] Start as soon as a buffer exists.
   * @param {string} [options.name] Node name.
   */
  constructor(engine, buffer, options) {
    super();
    const opts = options || {};

    /** @type {boolean} Type flag for fast checks. */
    this.isAudioSource = true;
    /** @type {*} Owning AudioEngine. */
    this.engine = engine || null;
    /** @type {*} Shortcut to the AudioContext, or null when unsupported. */
    this.context = engine && engine.context ? engine.context : null;
    if (opts.name) this.name = opts.name;

    /** @type {*} Decoded AudioBuffer. */
    this.buffer = buffer || null;
    /** @type {boolean} Whether the source is routed through a PannerNode. */
    this.positional = opts.positional !== false;
    /** @type {boolean} True while a buffer source is running. */
    this.isPlaying = false;
    /** @type {boolean} True when playback was paused (offset retained). */
    this.isPaused = false;
    /** @type {boolean} Start automatically once a buffer is present. */
    this.autoplay = opts.autoplay === true;

    /** @type {*} GainNode used for the source volume. */
    this._gain = null;
    /** @type {*} PannerNode used for 3D placement. */
    this._panner = null;
    /** @type {*} Currently running AudioBufferSourceNode. */
    this._source = null;
    /** @type {*} Destination bus. */
    this._bus = engine ? engine.getBus(opts.bus) : null;
    /** @type {string} Destination bus name. */
    this.busName = opts.bus || (this._bus ? this._bus.name : 'sfx');

    /** @type {number} Playback offset in seconds used by play()/pause(). */
    this._offset = 0;
    /** @type {number} Context time at which the current source started. */
    this._startedAt = 0;
    /** @type {number} Last uploaded panner X. */
    this._lastX = NaN;
    /** @type {number} Last uploaded panner Y. */
    this._lastY = NaN;
    /** @type {number} Last uploaded panner Z. */
    this._lastZ = NaN;

    /** @type {number} Backing field for the `volume` accessor. */
    this._volume = opts.volume !== undefined ? opts.volume : 1;
    /** @type {boolean} Backing field for the `loop` accessor. */
    this._loop = opts.loop === true;
    /** @type {number} Backing field for the `playbackRate` accessor. */
    this._playbackRate = opts.playbackRate !== undefined ? opts.playbackRate : 1;
    /** @type {number} Backing field for the `detune` accessor. */
    this._detune = opts.detune !== undefined ? opts.detune : 0;
    /** @type {number} Backing field for the `refDistance` accessor. */
    this._refDistance = opts.refDistance !== undefined ? opts.refDistance : 1;
    /** @type {number} Backing field for the `maxDistance` accessor. */
    this._maxDistance = opts.maxDistance !== undefined ? opts.maxDistance : 10000;
    /** @type {number} Backing field for the `rolloffFactor` accessor. */
    this._rolloffFactor = opts.rolloffFactor !== undefined ? opts.rolloffFactor : 1;
    /** @type {string} Distance attenuation model. */
    this.distanceModel = opts.distanceModel || 'inverse';
    /** @type {string} Panning model. */
    this.panningModel = opts.panningModel || 'HRTF';
    /** @type {number} Inner cone angle in degrees. */
    this.coneInnerAngle = opts.coneInnerAngle !== undefined ? opts.coneInnerAngle : 360;
    /** @type {number} Outer cone angle in degrees. */
    this.coneOuterAngle = opts.coneOuterAngle !== undefined ? opts.coneOuterAngle : 360;
    /** @type {number} Gain applied outside the outer cone. */
    this.coneOuterGain = opts.coneOuterGain !== undefined ? opts.coneOuterGain : 0;

    /** @type {Function|null} Called when a non-looping buffer finishes. */
    this.onEnded = opts.onEnded || null;
    /** @type {Function} Internal ended handler. */
    this._endedHandler = () => this._handleEnded();

    this._buildGraph();
    if (this.engine && typeof this.engine.registerSource === 'function') {
      this.engine.registerSource(this);
    }
    if (this.autoplay && this.buffer) this.play();
  }

  // ---------------------------------------------------------------------------
  // Graph
  // ---------------------------------------------------------------------------

  /**
   * Builds the gain -> [panner] -> bus chain.
   * @private
   */
  _buildGraph() {
    const ctx = this.context;
    if (!ctx) return;
    this._gain = ctx.createGain();
    this._gain.gain.value = this._volume;
    if (this.positional) {
      const p = ctx.createPanner();
      p.panningModel = this.panningModel;
      p.distanceModel = this.distanceModel;
      p.refDistance = this._refDistance;
      p.maxDistance = this._maxDistance;
      p.rolloffFactor = this._rolloffFactor;
      p.coneInnerAngle = this.coneInnerAngle;
      p.coneOuterAngle = this.coneOuterAngle;
      p.coneOuterGain = this.coneOuterGain;
      this._panner = p;
      this._gain.connect(p);
      this._connectOutput(p);
    } else {
      this._connectOutput(this._gain);
    }
    this.updateFromNode(true);
  }

  /**
   * Connects the tail of the chain to the destination bus.
   * @param {*} node Tail node.
   * @private
   */
  _connectOutput(node) {
    const engine = this.engine;
    const bus = this._bus || (engine ? engine.getBus(this.busName) : null);
    if (bus && bus.gain) {
      this._bus = bus;
      node.connect(bus.gain);
    } else if (engine && engine.masterGain) {
      node.connect(engine.masterGain);
    } else if (this.context) {
      node.connect(this.context.destination);
    }
  }

  /**
   * Routes the source to another bus.
   * @param {string} name Bus name.
   */
  setBus(name) {
    const engine = this.engine;
    if (!engine || !this.context) return;
    const bus = engine.getBus(name);
    if (!bus) return;
    const tail = this._panner !== null ? this._panner : this._gain;
    if (tail === null) return;
    tail.disconnect();
    this._bus = bus;
    this.busName = bus.name;
    tail.connect(bus.gain);
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Linear output gain.
   * @returns {number} Current volume.
   */
  get volume() {
    return this._volume;
  }

  /**
   * @param {number} value Linear gain.
   */
  set volume(value) {
    this._volume = value;
    if (this._gain !== null) {
      const t = this.context.currentTime;
      this._gain.gain.cancelScheduledValues(t);
      this._gain.gain.setTargetAtTime(value, t, PARAM_SMOOTHING);
    }
  }

  /**
   * Whether playback repeats.
   * @returns {boolean} Loop flag.
   */
  get loop() {
    return this._loop;
  }

  /**
   * @param {boolean} value Loop flag.
   */
  set loop(value) {
    this._loop = value === true;
    if (this._source !== null) this._source.loop = this._loop;
  }

  /**
   * Playback rate multiplier.
   * @returns {number} Rate.
   */
  get playbackRate() {
    return this._playbackRate;
  }

  /**
   * @param {number} value Rate multiplier.
   */
  set playbackRate(value) {
    this._playbackRate = value;
    if (this._source !== null && this._source.playbackRate) {
      this._source.playbackRate.value = value;
    }
  }

  /**
   * Detune in cents.
   * @returns {number} Detune.
   */
  get detune() {
    return this._detune;
  }

  /**
   * @param {number} value Detune in cents.
   */
  set detune(value) {
    this._detune = value;
    if (this._source !== null && this._source.detune) this._source.detune.value = value;
  }

  /**
   * Distance at which the volume is unattenuated.
   * @returns {number} Reference distance.
   */
  get refDistance() {
    return this._refDistance;
  }

  /**
   * @param {number} value Reference distance.
   */
  set refDistance(value) {
    this._refDistance = value;
    if (this._panner !== null) this._panner.refDistance = value;
  }

  /**
   * Distance beyond which attenuation stops growing.
   * @returns {number} Maximum distance.
   */
  get maxDistance() {
    return this._maxDistance;
  }

  /**
   * @param {number} value Maximum distance.
   */
  set maxDistance(value) {
    this._maxDistance = value;
    if (this._panner !== null) this._panner.maxDistance = value;
  }

  /**
   * Attenuation steepness.
   * @returns {number} Rolloff factor.
   */
  get rolloffFactor() {
    return this._rolloffFactor;
  }

  /**
   * @param {number} value Rolloff factor.
   */
  set rolloffFactor(value) {
    this._rolloffFactor = value;
    if (this._panner !== null) this._panner.rolloffFactor = value;
  }

  /**
   * Duration of the assigned buffer in seconds.
   * @returns {number} Duration, 0 when no buffer is set.
   */
  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /**
   * Current playback head in seconds.
   * @returns {number} Playback position.
   */
  get currentTime() {
    if (!this.isPlaying || this.context === null) return this._offset;
    const elapsed = (this.context.currentTime - this._startedAt) * this._playbackRate;
    const time = this._offset + elapsed;
    const d = this.duration;
    if (this._loop && d > 0) return time % d;
    return time > d ? d : time;
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /**
   * Assigns a new buffer, stopping any current playback.
   * @param {*} buffer Decoded AudioBuffer.
   * @returns {AudioSource} This instance.
   */
  setBuffer(buffer) {
    if (this.isPlaying) this.stop();
    this.buffer = buffer || null;
    this._offset = 0;
    if (this.autoplay && this.buffer) this.play();
    return this;
  }

  /**
   * Starts (or restarts) playback.
   * @param {number} [offset] Start offset in seconds; defaults to the paused offset.
   * @param {number} [delay=0] Delay before starting, in seconds.
   * @returns {AudioSource} This instance.
   */
  play(offset, delay) {
    const ctx = this.context;
    if (!ctx || !this.buffer || this._gain === null) return this;
    if (this.isPlaying) this.stop();

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = this._loop;
    if (source.playbackRate) source.playbackRate.value = this._playbackRate;
    if (source.detune) source.detune.value = this._detune;
    source.onended = this._endedHandler;
    source.connect(this._gain);

    const start = offset !== undefined ? offset : this._offset;
    const when = ctx.currentTime + (delay !== undefined ? delay : 0);
    this._offset = start;
    this._startedAt = when;
    this._source = source;
    this.isPlaying = true;
    this.isPaused = false;
    this.updateFromNode(true);
    source.start(when, this._loop ? start % (this.buffer.duration || 1) : start);
    return this;
  }

  /**
   * Stops playback and rewinds to the beginning.
   * @returns {AudioSource} This instance.
   */
  stop() {
    this._offset = 0;
    this.isPaused = false;
    this._teardownSource();
    return this;
  }

  /**
   * Pauses playback, retaining the playback head.
   * @returns {AudioSource} This instance.
   */
  pause() {
    if (!this.isPlaying) return this;
    this._offset = this.currentTime;
    this.isPaused = true;
    this._teardownSource();
    return this;
  }

  /**
   * Stops and releases the current buffer source node.
   * @private
   */
  _teardownSource() {
    const source = this._source;
    this.isPlaying = false;
    this._source = null;
    if (source === null) return;
    source.onended = null;
    try {
      source.stop(0);
    } catch (e) {
      // Already stopped or never started.
    }
    source.disconnect();
  }

  /**
   * Handles natural end of playback.
   * @private
   */
  _handleEnded() {
    if (this._source === null) return;
    this._source.onended = null;
    this._source.disconnect();
    this._source = null;
    this.isPlaying = false;
    this.isPaused = false;
    this._offset = 0;
    if (this.onEnded !== null) this.onEnded(this);
  }

  // ---------------------------------------------------------------------------
  // Spatialization
  // ---------------------------------------------------------------------------

  /**
   * Pushes the node's world transform into the PannerNode. Cheap and safe to
   * call every frame: uploads are skipped while the source does not move.
   * @param {boolean} [force=false] Upload even when the position is unchanged.
   */
  updateFromNode(force) {
    const p = this._panner;
    if (p === null || this.context === null) return;
    const wm = this.worldMatrix;
    if (!wm || !wm.elements) return;
    const e = wm.elements;
    const x = e[12];
    const y = e[13];
    const z = e[14];

    const dx = x - this._lastX;
    const dy = y - this._lastY;
    const dz = z - this._lastZ;
    if (force !== true && (dx * dx + dy * dy + dz * dz) < MOVE_EPSILON_SQ) return;
    this._lastX = x;
    this._lastY = y;
    this._lastZ = z;

    const t = this.context.currentTime;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, t, PARAM_SMOOTHING);
      p.positionY.setTargetAtTime(y, t, PARAM_SMOOTHING);
      p.positionZ.setTargetAtTime(z, t, PARAM_SMOOTHING);
    } else if (typeof p.setPosition === 'function') {
      p.setPosition(x, y, z);
    }

    // Cones point down the node's local -Z axis, matching the camera convention.
    if (this.coneInnerAngle < 360 || this.coneOuterAngle < 360) {
      let fx = -e[8];
      let fy = -e[9];
      let fz = -e[10];
      let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (len > 0) {
        len = 1 / len;
        fx *= len;
        fy *= len;
        fz *= len;
      }
      if (p.orientationX) {
        p.orientationX.setTargetAtTime(fx, t, PARAM_SMOOTHING);
        p.orientationY.setTargetAtTime(fy, t, PARAM_SMOOTHING);
        p.orientationZ.setTargetAtTime(fz, t, PARAM_SMOOTHING);
      } else if (typeof p.setOrientation === 'function') {
        p.setOrientation(fx, fy, fz);
      }
    }
  }

  /**
   * Stops playback, tears down the audio graph and detaches the node.
   */
  dispose() {
    this._teardownSource();
    if (this.engine && typeof this.engine.unregisterSource === 'function') {
      this.engine.unregisterSource(this);
    }
    if (this._panner !== null) {
      this._panner.disconnect();
      this._panner = null;
    }
    if (this._gain !== null) {
      this._gain.disconnect();
      this._gain = null;
    }
    this.buffer = null;
    this.engine = null;
    this.context = null;
    this._bus = null;
    if (typeof super.dispose === 'function') super.dispose();
  }
}
