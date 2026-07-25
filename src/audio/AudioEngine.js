/**
 * @fileoverview Native WebAudio engine: decoded buffer cache, named volume
 * buses (master/music/sfx), 3D listener driven by a camera, HRTF positional
 * one-shots and automatic context resume on the first user gesture.
 *
 * Everything degrades to a silent no-op when WebAudio is unavailable (server
 * side rendering, headless tests), so the engine can always be constructed.
 */

import { AudioSource } from './AudioSource.js';

/** Default smoothing time constant for listener parameter ramps, in seconds. */
const LISTENER_SMOOTHING = 0.02;
/** Default smoothing time constant for gain ramps, in seconds. */
const GAIN_SMOOTHING = 0.015;
/** Events that count as a user gesture for unlocking the context. */
const GESTURE_EVENTS = ['pointerdown', 'touchend', 'mousedown', 'keydown'];

/**
 * A playing one-shot. Instances are pooled: the wrapper, its gain node and its
 * panner node are reused, only the (single use) buffer source is recreated.
 */
class AudioVoice {
  /**
   * @param {AudioEngine} engine Owning engine.
   */
  constructor(engine) {
    /** @type {AudioEngine} */
    this.engine = engine;
    /** @type {*} */
    this.context = engine.context;
    /** @type {*} */
    this.gain = this.context.createGain();
    /** @type {*} */
    this.panner = null;
    /** @type {*} */
    this.source = null;
    /** @type {boolean} */
    this.active = false;
    /** @type {boolean} */
    this.positional = false;
    /** @type {number} Monotonic id, invalidated on stop. */
    this.generation = 0;
    /** @type {Function} */
    this._onEnded = () => { this.engine._recycleVoice(this); };
  }

  /**
   * Lazily creates the panner node used for positional playback.
   * @returns {*} The panner node.
   */
  ensurePanner() {
    if (this.panner === null) {
      const p = this.context.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.coneInnerAngle = 360;
      p.coneOuterAngle = 360;
      p.coneOuterGain = 0;
      this.panner = p;
    }
    return this.panner;
  }

  /**
   * Sets the voice gain, optionally ramping.
   * @param {number} value Linear gain.
   * @param {number} [rampSeconds=0] Ramp duration in seconds.
   */
  setVolume(value, rampSeconds) {
    const t = this.context.currentTime;
    const param = this.gain.gain;
    if (rampSeconds !== undefined && rampSeconds > 0) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + rampSeconds);
    } else {
      param.setValueAtTime(value, t);
    }
  }

  /**
   * Moves the voice in world space (positional voices only).
   * @param {number} x World X.
   * @param {number} y World Y.
   * @param {number} z World Z.
   */
  setPosition(x, y, z) {
    if (this.panner === null) return;
    const p = this.panner;
    const t = this.context.currentTime;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, t, LISTENER_SMOOTHING);
      p.positionY.setTargetAtTime(y, t, LISTENER_SMOOTHING);
      p.positionZ.setTargetAtTime(z, t, LISTENER_SMOOTHING);
    } else if (typeof p.setPosition === 'function') {
      p.setPosition(x, y, z);
    }
  }

  /**
   * Stops playback.
   * @param {number} [fadeSeconds=0] Optional fade-out before stopping.
   */
  stop(fadeSeconds) {
    if (!this.active || this.source === null) return;
    const t = this.context.currentTime;
    if (fadeSeconds !== undefined && fadeSeconds > 0) {
      this.setVolume(0, fadeSeconds);
      try {
        this.source.stop(t + fadeSeconds);
      } catch (e) {
        this.engine._recycleVoice(this);
      }
    } else {
      try {
        this.source.stop(t);
      } catch (e) {
        this.engine._recycleVoice(this);
      }
    }
  }
}

/**
 * WebAudio front-end for the engine.
 */
export class AudioEngine {
  /**
   * @param {Object} [options] Engine options.
   * @param {string} [options.basePath=''] Prefix applied to relative sound URLs.
   * @param {number} [options.masterVolume=1] Initial master volume.
   * @param {boolean} [options.unlockOnGesture=true] Resume on the first user gesture.
   * @param {string[]} [options.buses] Extra bus names to create (music/sfx always exist).
   * @param {*} [options.target] Event target used for the gesture unlock (defaults to window).
   * @param {Object} [options.contextOptions] Options forwarded to the AudioContext.
   */
  constructor(options) {
    const opts = options || {};
    const g = globalThis;

    /** @type {string} Prefix applied to relative URLs. */
    this.basePath = opts.basePath || '';
    /** @type {*} Underlying AudioContext, or null when unsupported. */
    this.context = null;
    /** @type {*} AudioListener, or null when unsupported. */
    this.listener = null;
    /** @type {*} Master GainNode, or null when unsupported. */
    this.masterGain = null;
    /** @type {boolean} Whether WebAudio is usable. */
    this.supported = false;
    /** @type {Map<string, {name:string, gain:*, volume:number, muted:boolean}>} */
    this.buses = new Map();
    /** @type {AudioSource[]} Registered spatial sources. */
    this.sources = [];
    /** @type {AudioVoice[]} Currently playing one-shots. */
    this.voices = [];
    /** @type {AudioVoice[]} Recycled voices. */
    this._voicePool = [];
    /** @type {Map<string, *>} url -> AudioBuffer. */
    this._buffers = new Map();
    /** @type {Map<string, Promise<*>>} url -> in-flight decode. */
    this._loading = new Map();
    /** @type {Array<*>} Registered gesture listeners, for dispose(). */
    this._gestureListeners = [];
    /** @type {number} Cached master volume, kept even when muted. */
    this._masterVolume = opts.masterVolume !== undefined ? opts.masterVolume : 1;
    /** @type {boolean} */
    this.muted = false;

    const Ctor = (g && (g.AudioContext || g.webkitAudioContext)) || null;
    if (Ctor !== null) {
      this.context = opts.contextOptions ? new Ctor(opts.contextOptions) : new Ctor();
      this.listener = this.context.listener;
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this._masterVolume;
      this.masterGain.connect(this.context.destination);
      this.supported = true;

      this.buses.set('master', {
        name: 'master', gain: this.masterGain, volume: this._masterVolume, muted: false
      });
      this.createBus('music');
      this.createBus('sfx');
      const extra = opts.buses;
      if (extra) {
        for (let i = 0, n = extra.length; i < n; i++) this.createBus(extra[i]);
      }
    }

    /** @type {*} Target used for the gesture unlock. */
    this.gestureTarget = opts.target || (g && g.window) || null;
    if (this.supported && opts.unlockOnGesture !== false) this.unlockOnGesture();
  }

  // ---------------------------------------------------------------------------
  // Context lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Current context state ('running' | 'suspended' | 'closed' | 'unsupported').
   * @returns {string} State string.
   */
  get state() {
    return this.context ? this.context.state : 'unsupported';
  }

  /**
   * Resumes the audio context. Safe to call at any time.
   * @returns {Promise<void>} Resolves once the context is running.
   */
  resume() {
    const ctx = this.context;
    if (!ctx) return Promise.resolve();
    if (ctx.state === 'running' || typeof ctx.resume !== 'function') return Promise.resolve();
    const r = ctx.resume();
    return r && typeof r.then === 'function' ? r.then(() => undefined) : Promise.resolve();
  }

  /**
   * Suspends the audio context (for example while the tab is hidden).
   * @returns {Promise<void>} Resolves once suspended.
   */
  suspend() {
    const ctx = this.context;
    if (!ctx || typeof ctx.suspend !== 'function' || ctx.state !== 'running') return Promise.resolve();
    const r = ctx.suspend();
    return r && typeof r.then === 'function' ? r.then(() => undefined) : Promise.resolve();
  }

  /**
   * Installs one-shot listeners that resume the context on the first user
   * gesture, as required by browser autoplay policies.
   */
  unlockOnGesture() {
    const target = this.gestureTarget;
    if (!target || typeof target.addEventListener !== 'function') return;
    if (this._gestureListeners.length > 0) return;
    const handler = () => {
      this.resume();
      this._removeGestureListeners();
    };
    const opts = { passive: true, capture: true };
    for (let i = 0, n = GESTURE_EVENTS.length; i < n; i++) {
      target.addEventListener(GESTURE_EVENTS[i], handler, opts);
      this._gestureListeners.push(target, GESTURE_EVENTS[i], handler, opts);
    }
  }

  /**
   * Removes the gesture unlock listeners.
   * @private
   */
  _removeGestureListeners() {
    const l = this._gestureListeners;
    for (let i = 0; i < l.length; i += 4) {
      const el = l[i];
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener(l[i + 1], l[i + 2], l[i + 3]);
      }
    }
    l.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Buses
  // ---------------------------------------------------------------------------

  /**
   * Creates (or returns) a named volume bus routed into the master gain.
   * @param {string} name Bus name.
   * @param {number} [volume=1] Initial linear volume.
   * @returns {{name:string, gain:*, volume:number, muted:boolean}|null} The bus.
   */
  createBus(name, volume) {
    if (!this.supported) return null;
    const existing = this.buses.get(name);
    if (existing !== undefined) return existing;
    const gain = this.context.createGain();
    gain.gain.value = volume !== undefined ? volume : 1;
    gain.connect(this.masterGain);
    const bus = { name, gain, volume: gain.gain.value, muted: false };
    this.buses.set(name, bus);
    return bus;
  }

  /**
   * Returns a bus by name, falling back to 'sfx' then 'master'.
   * @param {string} [name] Bus name.
   * @returns {{name:string, gain:*, volume:number, muted:boolean}|null} The bus.
   */
  getBus(name) {
    if (!this.supported) return null;
    if (name) {
      const bus = this.buses.get(name);
      if (bus !== undefined) return bus;
    }
    const sfx = this.buses.get('sfx');
    return sfx !== undefined ? sfx : this.buses.get('master') || null;
  }

  /**
   * Sets the linear volume of a bus.
   * @param {string} name Bus name.
   * @param {number} volume Linear volume.
   * @param {number} [rampSeconds] Optional ramp duration.
   * @returns {boolean} Whether the bus existed.
   */
  setBusVolume(name, volume, rampSeconds) {
    const bus = this.buses.get(name);
    if (bus === undefined) return false;
    bus.volume = volume;
    this._rampParam(bus.gain.gain, bus.muted ? 0 : volume, rampSeconds);
    if (name === 'master') this._masterVolume = volume;
    return true;
  }

  /**
   * Reads the linear volume of a bus.
   * @param {string} name Bus name.
   * @returns {number} Linear volume, 0 when unknown.
   */
  getBusVolume(name) {
    const bus = this.buses.get(name);
    return bus !== undefined ? bus.volume : 0;
  }

  /**
   * Mutes or unmutes a bus without losing its volume setting.
   * @param {string} name Bus name.
   * @param {boolean} muted Mute state.
   * @returns {boolean} Whether the bus existed.
   */
  setBusMuted(name, muted) {
    const bus = this.buses.get(name);
    if (bus === undefined) return false;
    bus.muted = muted;
    this._rampParam(bus.gain.gain, muted ? 0 : bus.volume, GAIN_SMOOTHING);
    if (name === 'master') this.muted = muted;
    return true;
  }

  /**
   * Sets the master volume.
   * @param {number} volume Linear volume.
   * @param {number} [rampSeconds] Optional ramp duration.
   */
  setMasterVolume(volume, rampSeconds) {
    this._masterVolume = volume;
    if (!this.supported) return;
    this.setBusVolume('master', volume, rampSeconds);
  }

  /**
   * Reads the master volume.
   * @returns {number} Linear volume.
   */
  getMasterVolume() {
    return this._masterVolume;
  }

  /**
   * Applies a value to an AudioParam, ramping when a duration is given.
   * @param {*} param Target AudioParam.
   * @param {number} value New value.
   * @param {number} [rampSeconds] Ramp duration in seconds.
   * @private
   */
  _rampParam(param, value, rampSeconds) {
    if (!param) return;
    const t = this.context ? this.context.currentTime : 0;
    if (rampSeconds !== undefined && rampSeconds > 0) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + rampSeconds);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(value, t);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /**
   * Resolves a URL against `basePath`.
   * @param {string} url Relative or absolute URL.
   * @returns {string} Resolved URL.
   * @private
   */
  _resolveUrl(url) {
    if (!this.basePath) return url;
    if (/^(?:[a-z]+:)?\/\//i.test(url) || url.charCodeAt(0) === 47 || url.startsWith('data:')) return url;
    const base = this.basePath.endsWith('/') ? this.basePath : this.basePath + '/';
    return base + url;
  }

  /**
   * Decodes an ArrayBuffer, supporting both the promise and callback flavours of
   * `decodeAudioData`.
   * @param {ArrayBuffer} arrayBuffer Encoded audio data.
   * @returns {Promise<*>} Decoded AudioBuffer.
   */
  decodeAudioData(arrayBuffer) {
    const ctx = this.context;
    if (!ctx) return Promise.reject(new Error('AudioEngine: WebAudio nao esta disponivel neste ambiente.'));
    return new Promise((resolve, reject) => {
      const ret = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
  }

  /**
   * Loads and decodes a sound, caching the result by resolved URL.
   * @param {string} url Sound URL.
   * @returns {Promise<*>} Decoded AudioBuffer.
   */
  loadSound(url) {
    const key = this._resolveUrl(url);
    const cached = this._buffers.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this._loading.get(key);
    if (pending !== undefined) return pending;
    if (!this.supported) {
      return Promise.reject(new Error('AudioEngine: WebAudio nao esta disponivel neste ambiente.'));
    }
    const g = globalThis;
    if (!g || typeof g.fetch !== 'function') {
      return Promise.reject(new Error('AudioEngine: fetch nao esta disponivel neste ambiente.'));
    }
    const promise = g.fetch(key)
      .then((response) => {
        if (!response.ok) throw new Error('AudioEngine: falha ao carregar "' + key + '" (' + response.status + ').');
        return response.arrayBuffer();
      })
      .then((data) => this.decodeAudioData(data))
      .then((buffer) => {
        this._buffers.set(key, buffer);
        this._loading.delete(key);
        return buffer;
      })
      .catch((error) => {
        this._loading.delete(key);
        throw error;
      });
    this._loading.set(key, promise);
    return promise;
  }

  /**
   * Loads several sounds at once.
   * @param {string[]} urls Sound URLs.
   * @returns {Promise<Map<string, *>>} Map of url -> AudioBuffer.
   */
  loadMany(urls) {
    const jobs = [];
    for (let i = 0, n = urls.length; i < n; i++) jobs.push(this.loadSound(urls[i]));
    return Promise.all(jobs).then((buffers) => {
      const map = new Map();
      for (let i = 0, n = urls.length; i < n; i++) map.set(urls[i], buffers[i]);
      return map;
    });
  }

  /**
   * Returns a cached buffer without loading.
   * @param {string} url Sound URL.
   * @returns {*} AudioBuffer or null.
   */
  getBuffer(url) {
    const b = this._buffers.get(this._resolveUrl(url));
    return b !== undefined ? b : null;
  }

  /**
   * Drops a cached buffer.
   * @param {string} url Sound URL.
   * @returns {boolean} Whether it was cached.
   */
  unload(url) {
    return this._buffers.delete(this._resolveUrl(url));
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  /**
   * Plays a decoded buffer as a fire-and-forget voice.
   * @param {*} buffer Decoded AudioBuffer.
   * @param {Object} [options] Playback options.
   * @param {number} [options.volume=1] Linear gain.
   * @param {boolean} [options.loop=false] Loop the buffer.
   * @param {number} [options.playbackRate=1] Playback rate.
   * @param {number} [options.detune=0] Detune in cents (when supported).
   * @param {string} [options.bus='sfx'] Destination bus.
   * @param {number} [options.offset=0] Start offset in seconds.
   * @param {number} [options.delay=0] Delay before starting, in seconds.
   * @param {number} [options.fadeIn=0] Fade-in duration in seconds.
   * @param {{x:number,y:number,z:number}} [options.position] World position for 3D playback.
   * @param {number} [options.refDistance=1] Panner reference distance.
   * @param {number} [options.maxDistance=10000] Panner maximum distance.
   * @param {number} [options.rolloffFactor=1] Panner rolloff.
   * @returns {AudioVoice|null} The playing voice, or null when unsupported.
   */
  play(buffer, options) {
    if (!this.supported || !buffer) return null;
    const opts = options || {};
    const ctx = this.context;
    const voice = this._voicePool.length > 0 ? this._voicePool.pop() : new AudioVoice(this);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = opts.loop === true;
    if (source.playbackRate) source.playbackRate.value = opts.playbackRate !== undefined ? opts.playbackRate : 1;
    if (source.detune && opts.detune !== undefined) source.detune.value = opts.detune;
    source.onended = voice._onEnded;

    const volume = opts.volume !== undefined ? opts.volume : 1;
    const fadeIn = opts.fadeIn !== undefined ? opts.fadeIn : 0;
    const now = ctx.currentTime;
    const gainParam = voice.gain.gain;
    gainParam.cancelScheduledValues(now);
    if (fadeIn > 0) {
      gainParam.setValueAtTime(0, now);
      gainParam.linearRampToValueAtTime(volume, now + fadeIn);
    } else {
      gainParam.setValueAtTime(volume, now);
    }

    const bus = this.getBus(opts.bus);
    const destination = bus !== null ? bus.gain : this.masterGain;

    voice.gain.disconnect();
    if (opts.position) {
      const panner = voice.ensurePanner();
      panner.refDistance = opts.refDistance !== undefined ? opts.refDistance : 1;
      panner.maxDistance = opts.maxDistance !== undefined ? opts.maxDistance : 10000;
      panner.rolloffFactor = opts.rolloffFactor !== undefined ? opts.rolloffFactor : 1;
      panner.distanceModel = opts.distanceModel || 'inverse';
      panner.disconnect();
      voice.gain.connect(panner);
      panner.connect(destination);
      voice.positional = true;
      voice.setPosition(opts.position.x, opts.position.y, opts.position.z);
    } else {
      if (voice.panner !== null) voice.panner.disconnect();
      voice.gain.connect(destination);
      voice.positional = false;
    }

    source.connect(voice.gain);
    voice.source = source;
    voice.active = true;
    voice.generation++;
    this.voices.push(voice);

    const when = now + (opts.delay !== undefined ? opts.delay : 0);
    const offset = opts.offset !== undefined ? opts.offset : 0;
    if (opts.duration !== undefined) source.start(when, offset, opts.duration);
    else source.start(when, offset);
    return voice;
  }

  /**
   * Loads (or reuses) a sound and plays it.
   * @param {string} url Sound URL.
   * @param {Object} [options] Playback options, see `play`.
   * @returns {Promise<AudioVoice|null>} The playing voice.
   */
  playSound(url, options) {
    return this.loadSound(url).then((buffer) => this.play(buffer, options));
  }

  /**
   * Returns a finished voice to the pool.
   * @param {AudioVoice} voice Voice to recycle.
   * @private
   */
  _recycleVoice(voice) {
    if (!voice.active) return;
    voice.active = false;
    const list = this.voices;
    for (let i = 0, n = list.length; i < n; i++) {
      if (list[i] === voice) {
        list.splice(i, 1);
        break;
      }
    }
    if (voice.source !== null) {
      voice.source.onended = null;
      try {
        voice.source.disconnect();
      } catch (e) {
        // Already disconnected.
      }
      voice.source = null;
    }
    this._voicePool.push(voice);
  }

  /**
   * Stops every playing voice and every registered source.
   * @param {number} [fadeSeconds=0] Optional fade-out.
   */
  stopAll(fadeSeconds) {
    const voices = this.voices;
    for (let i = voices.length - 1; i >= 0; i--) voices[i].stop(fadeSeconds);
    const sources = this.sources;
    for (let i = 0, n = sources.length; i < n; i++) sources[i].stop();
  }

  /**
   * Creates a spatial source node bound to this engine.
   * @param {*} buffer Decoded AudioBuffer (may be null and set later).
   * @param {Object} [options] Source options, see AudioSource.
   * @returns {AudioSource} The created source.
   */
  createSource(buffer, options) {
    const source = new AudioSource(this, buffer, options);
    return source;
  }

  /**
   * Registers a source so `update()` refreshes its panner automatically.
   * @param {AudioSource} source Source to register.
   */
  registerSource(source) {
    if (this.sources.indexOf(source) === -1) this.sources.push(source);
  }

  /**
   * Unregisters a previously registered source.
   * @param {AudioSource} source Source to remove.
   */
  unregisterSource(source) {
    const i = this.sources.indexOf(source);
    if (i !== -1) this.sources.splice(i, 1);
  }

  // ---------------------------------------------------------------------------
  // Listener
  // ---------------------------------------------------------------------------

  /**
   * Updates the 3D listener from a camera's world transform. Uses the AudioParam
   * interface when available and falls back to the deprecated setters.
   * @param {*} camera Camera (or any Node3D) to follow.
   */
  setListenerFromCamera(camera) {
    const l = this.listener;
    if (!l || !camera) return;

    let px = 0;
    let py = 0;
    let pz = 0;
    let fx = 0;
    let fy = 0;
    let fz = -1;
    let ux = 0;
    let uy = 1;
    let uz = 0;

    const wm = camera.worldMatrix;
    if (wm && wm.elements) {
      const e = wm.elements;
      px = e[12];
      py = e[13];
      pz = e[14];
      fx = -e[8];
      fy = -e[9];
      fz = -e[10];
      ux = e[4];
      uy = e[5];
      uz = e[6];
    } else if (camera.quaternion && camera.position) {
      const q = camera.quaternion;
      px = camera.position.x;
      py = camera.position.y;
      pz = camera.position.z;
      fx = -2 * (q.x * q.z + q.w * q.y);
      fy = -2 * (q.y * q.z - q.w * q.x);
      fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      ux = 2 * (q.x * q.y - q.w * q.z);
      uy = 1 - 2 * (q.x * q.x + q.z * q.z);
      uz = 2 * (q.y * q.z + q.w * q.x);
    }

    let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (len > 0) {
      len = 1 / len;
      fx *= len;
      fy *= len;
      fz *= len;
    }
    len = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (len > 0) {
      len = 1 / len;
      ux *= len;
      uy *= len;
      uz *= len;
    }

    const t = this.context.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, t, LISTENER_SMOOTHING);
      l.positionY.setTargetAtTime(py, t, LISTENER_SMOOTHING);
      l.positionZ.setTargetAtTime(pz, t, LISTENER_SMOOTHING);
      l.forwardX.setTargetAtTime(fx, t, LISTENER_SMOOTHING);
      l.forwardY.setTargetAtTime(fy, t, LISTENER_SMOOTHING);
      l.forwardZ.setTargetAtTime(fz, t, LISTENER_SMOOTHING);
      l.upX.setTargetAtTime(ux, t, LISTENER_SMOOTHING);
      l.upY.setTargetAtTime(uy, t, LISTENER_SMOOTHING);
      l.upZ.setTargetAtTime(uz, t, LISTENER_SMOOTHING);
    } else {
      if (typeof l.setPosition === 'function') l.setPosition(px, py, pz);
      if (typeof l.setOrientation === 'function') l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /**
   * Refreshes every registered spatial source. Call once per frame.
   * @param {number} [dt] Frame time in seconds (unused, kept for symmetry).
   */
  update(dt) {
    const sources = this.sources;
    for (let i = 0, n = sources.length; i < n; i++) sources[i].updateFromNode();
  }

  /**
   * Stops everything, releases the graph and closes the context.
   */
  dispose() {
    this._removeGestureListeners();
    this.stopAll();
    const sources = this.sources.slice();
    for (let i = 0, n = sources.length; i < n; i++) sources[i].dispose();
    this.sources.length = 0;

    const voices = this.voices.slice();
    for (let i = 0, n = voices.length; i < n; i++) this._recycleVoice(voices[i]);
    this.voices.length = 0;
    const pool = this._voicePool;
    for (let i = 0, n = pool.length; i < n; i++) {
      const v = pool[i];
      if (v.panner) v.panner.disconnect();
      v.gain.disconnect();
    }
    pool.length = 0;

    for (const bus of this.buses.values()) {
      if (bus.gain) bus.gain.disconnect();
    }
    this.buses.clear();
    this._buffers.clear();
    this._loading.clear();

    if (this.context && typeof this.context.close === 'function' && this.context.state !== 'closed') {
      const r = this.context.close();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
    this.masterGain = null;
    this.listener = null;
    this.context = null;
    this.supported = false;
  }
}
