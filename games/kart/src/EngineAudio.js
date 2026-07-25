/**
 * Kart audio, synthesised rather than loaded.
 *
 * There is no sound file anywhere in this project, so the engine note is built
 * as a short looping buffer at runtime and pitched by RPM. That is also how a
 * real engine sound works in a racing game: one loop, `playbackRate` driven by
 * revs, because recording every RPM is impossible and crossfading between a
 * handful of loops is what the technique replaces.
 *
 * Everything goes through positional `AudioSource` nodes, so the kart is heard
 * where it is — which only matters once there is more than one, but costs
 * nothing to do correctly from the start.
 */

import { AudioSource } from '../../../src/audio/AudioSource.js';
import { clamp } from '../../../src/math/MathUtils.js';

/**
 * Builds one cycle-accurate loop of an engine note.
 *
 * A pure tone sounds like a hair dryer. What makes it read as an engine is the
 * harmonic stack — a strong low fundamental with odd harmonics above it — plus
 * a per cycle irregularity standing in for combustion pulses.
 *
 * @param {AudioContext} context
 * @param {Object} [options]
 * @param {number} [options.frequency=48] Fundamental in Hz.
 * @param {number} [options.seconds=1] Loop length.
 * @param {number} [options.roughness=0.35]
 * @returns {AudioBuffer}
 */
export function createEngineBuffer(context, options = {}) {
  const frequency = options.frequency !== undefined ? options.frequency : 48;
  const seconds = options.seconds !== undefined ? options.seconds : 1;
  const roughness = options.roughness !== undefined ? options.roughness : 0.35;

  const rate = context.sampleRate;
  // Round to a whole number of cycles so the loop point is silent.
  const cycles = Math.max(1, Math.round(frequency * seconds));
  const length = Math.round((cycles / frequency) * rate);

  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);

  // Deterministic noise: the same engine every session.
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };

  const harmonics = [
    { mul: 1.0, amp: 1.00 },
    { mul: 2.0, amp: 0.45 },
    { mul: 3.0, amp: 0.32 },
    { mul: 4.0, amp: 0.18 },
    { mul: 5.0, amp: 0.14 },
    { mul: 7.0, amp: 0.09 },
    { mul: 9.0, amp: 0.05 },
  ];

  let peak = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    let sample = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const harmonic = harmonics[h];
      // A slight phase offset per harmonic stops them all spiking together,
      // which would clip the buffer and sound like a click.
      sample += Math.sin(2 * Math.PI * frequency * harmonic.mul * t + h * 1.7) * harmonic.amp;
    }
    // Combustion irregularity, correlated within a cycle.
    const cyclePhase = (frequency * t) % 1;
    sample *= 1 + roughness * Math.sin(cyclePhase * Math.PI * 2 * 2) * 0.5;
    sample += rand() * roughness * 0.12;

    data[i] = sample;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
  }

  // Normalise, leaving headroom so mixing several karts cannot clip.
  const gain = peak > 0 ? 0.55 / peak : 1;
  for (let i = 0; i < length; i++) data[i] *= gain;

  return buffer;
}

/**
 * Short burst of filtered noise: tyre scrub and the barrier hit.
 * @param {AudioContext} context
 * @param {number} seconds
 * @param {number} decay Higher decays faster.
 * @returns {AudioBuffer}
 */
export function createNoiseBuffer(context, seconds, decay) {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.round(seconds * rate));
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);

  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };

  // One pole low pass, so it is a rush rather than a hiss.
  let previous = 0;
  for (let i = 0; i < length; i++) {
    const white = rand();
    previous = previous * 0.72 + white * 0.28;
    const envelope = Math.exp(-(i / length) * decay);
    data[i] = previous * envelope * 0.8;
  }
  return buffer;
}

/**
 * Audio for one kart.
 */
export class KartAudio {
  /**
   * @param {Object} options
   * @param {import('../../../src/audio/AudioEngine.js').AudioEngine} options.audio
   * @param {import('../../../src/scene/Node3D.js').Node3D} [options.node] Followed for position.
   */
  constructor(options) {
    /** @type {import('../../../src/audio/AudioEngine.js').AudioEngine} */
    this.audio = options.audio;
    /** @type {boolean} */
    this.ready = false;
    /** @type {boolean} */
    this.muted = false;

    /** @type {AudioSource|null} */
    this.engineSource = null;
    /** @type {AudioSource|null} */
    this.skidSource = null;

    /** @type {number} Playback rate at idle. */
    this.idleRate = 0.55;
    /** @type {number} Playback rate at the limiter. */
    this.maxRate = 3.4;

    /** @private */
    this._node = options.node || null;
    /** @private */
    this._skidLevel = 0;
    /** @private */
    this._impactBuffer = null;
  }

  /**
   * Builds the sources. Must run after a user gesture, because that is when the
   * audio context is allowed to start.
   * @returns {boolean} true when audio is live
   */
  start() {
    if (this.ready) return true;
    const audio = this.audio;
    const context = audio !== null && audio !== undefined ? audio.context : null;
    if (context === null || context === undefined) return false;

    const engineBuffer = createEngineBuffer(context, { frequency: 46, seconds: 1 });
    /** @type {AudioBuffer|null} Kept so the note can be inspected and retuned. */
    this.engineBuffer = engineBuffer;
    const skidBuffer = createNoiseBuffer(context, 1.0, 0.2);
    this._impactBuffer = createNoiseBuffer(context, 0.35, 6.0);

    this.engineSource = new AudioSource(audio, engineBuffer, {
      loop: true,
      volume: 0.0,
      bus: 'sfx',
      positional: this._node !== null,
      refDistance: 6,
      maxDistance: 220,
      rolloffFactor: 0.9,
    });
    if (this._node !== null) this.engineSource.position.copy(this._node.position);

    this.skidSource = new AudioSource(audio, skidBuffer, {
      loop: true,
      volume: 0.0,
      bus: 'sfx',
      positional: this._node !== null,
      refDistance: 5,
      maxDistance: 120,
    });

    this.engineSource.play();
    this.skidSource.play();
    this.ready = true;
    return true;
  }

  /**
   * @param {number} rpm 0..1
   * @param {number} slip 0..1
   * @param {number} dt
   * @param {import('../../../src/math/Vec3.js').Vec3} [position]
   */
  update(rpm, slip, dt, position) {
    if (!this.ready) return;

    const engine = this.engineSource;
    if (engine !== null) {
      // Pitch is the whole illusion: one loop, rate from revs.
      engine.playbackRate = this.idleRate + (this.maxRate - this.idleRate) * clamp(rpm, 0, 1);
      // Louder as it works harder, but never silent at idle.
      engine.volume = this.muted ? 0 : 0.10 + 0.35 * clamp(rpm, 0, 1);
      if (position !== undefined && position !== null) {
        engine.position.copy(position);
        engine.updateFromNode(true);
      }
    }

    const skid = this.skidSource;
    if (skid !== null) {
      // Smoothed, because raw slip flickers frame to frame and a scrub that
      // flickers sounds broken.
      const target = clamp((slip - 0.18) / 0.6, 0, 1);
      this._skidLevel += (target - this._skidLevel) * Math.min(1, 9 * dt);
      skid.volume = this.muted ? 0 : this._skidLevel * 0.5;
      skid.playbackRate = 0.85 + this._skidLevel * 0.5;
      if (position !== undefined && position !== null) {
        skid.position.copy(position);
        skid.updateFromNode(true);
      }
    }
  }

  /**
   * One-shot impact, scaled by how hard the hit was.
   * @param {number} strength 0..1
   * @param {import('../../../src/math/Vec3.js').Vec3} [position]
   */
  impact(strength, position) {
    if (!this.ready || this.muted || this._impactBuffer === null) return;
    const source = new AudioSource(this.audio, this._impactBuffer, {
      volume: clamp(strength, 0, 1) * 0.7,
      bus: 'sfx',
      positional: position !== undefined,
      refDistance: 8,
    });
    if (position !== undefined && position !== null) {
      source.position.copy(position);
      source.updateFromNode(true);
    }
    source.onEnded = () => source.dispose();
    source.play();
  }

  /** @param {boolean} value */
  setMuted(value) {
    this.muted = value === true;
  }

  dispose() {
    if (this.engineSource !== null) this.engineSource.dispose();
    if (this.skidSource !== null) this.skidSource.dispose();
    this.ready = false;
  }
}
