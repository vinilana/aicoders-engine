/**
 * Best lap ghost: your own fastest lap, replayed beside you.
 *
 * Recording is a fixed rate sample of position and orientation, kept in flat
 * typed arrays. Playback interpolates between samples — position linearly,
 * orientation by slerp, because interpolating quaternion components directly
 * takes the chord instead of the arc and makes the ghost's nose dip through
 * every corner.
 *
 * A lap is only promoted to ghost when it beats the record, so the thing you
 * are chasing is always the best you have driven.
 */

import { Vec3 } from '../../../src/math/Vec3.js';
import { Quat } from '../../../src/math/Quat.js';

/** Samples per second. Twenty is smooth after interpolation and cheap. */
const SAMPLE_RATE = 20;
/** Longest lap that can be recorded, in seconds. */
const MAX_SECONDS = 300;
const MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS;

/**
 * Records and replays a lap.
 */
export class Ghost {
  constructor() {
    /** @private @type {Float32Array} xyz per sample, being recorded. */
    this._recPos = new Float32Array(MAX_SAMPLES * 3);
    /** @private @type {Float32Array} xyzw per sample. */
    this._recRot = new Float32Array(MAX_SAMPLES * 4);
    /** @private @type {number} */
    this._recCount = 0;
    /** @private @type {number} Seconds since the last sample. */
    this._recTimer = 0;

    /** @type {Float32Array|null} The best lap's positions. */
    this.positions = null;
    /** @type {Float32Array|null} The best lap's rotations. */
    this.rotations = null;
    /** @type {number} Samples in the stored ghost. */
    this.count = 0;
    /** @type {number} Duration of the stored lap, in seconds. */
    this.duration = 0;

    /** @type {boolean} */
    this.playing = false;
    /** @type {number} Playback head, in seconds. */
    this.time = 0;

    /** @type {Vec3} Current interpolated position. */
    this.position = new Vec3();
    /** @type {Quat} Current interpolated rotation. */
    this.quaternion = new Quat();

    /** @private */
    this._a = new Quat();
    /** @private */
    this._b = new Quat();
  }

  /** @returns {boolean} true when there is a lap to chase. */
  get hasGhost() {
    return this.count > 1;
  }

  /** Starts a fresh recording. */
  beginLap() {
    this._recCount = 0;
    this._recTimer = 0;
  }

  /**
   * Feeds the recorder.
   * @param {number} dt
   * @param {Vec3} position
   * @param {Quat} quaternion
   */
  record(dt, position, quaternion) {
    this._recTimer += dt;
    const interval = 1 / SAMPLE_RATE;
    if (this._recCount > 0 && this._recTimer < interval) return;
    if (this._recCount >= MAX_SAMPLES) return;

    this._recTimer = 0;
    const i = this._recCount;
    this._recPos[i * 3] = position.x;
    this._recPos[i * 3 + 1] = position.y;
    this._recPos[i * 3 + 2] = position.z;
    this._recRot[i * 4] = quaternion.x;
    this._recRot[i * 4 + 1] = quaternion.y;
    this._recRot[i * 4 + 2] = quaternion.z;
    this._recRot[i * 4 + 3] = quaternion.w;
    this._recCount++;
  }

  /**
   * Promotes the recording to the ghost when the lap was a new best.
   * @param {number} lapSeconds
   * @param {boolean} isBest
   * @returns {boolean} true when the ghost was replaced
   */
  endLap(lapSeconds, isBest) {
    if (!isBest || this._recCount < 2) {
      this.beginLap();
      return false;
    }
    // Copied, not referenced: the recorder keeps writing into its buffers on
    // the very next lap.
    this.positions = this._recPos.slice(0, this._recCount * 3);
    this.rotations = this._recRot.slice(0, this._recCount * 4);
    this.count = this._recCount;
    this.duration = lapSeconds;
    this.beginLap();
    return true;
  }

  /** Restarts playback from the start line. */
  restart() {
    this.time = 0;
    this.playing = this.hasGhost;
  }

  /** Stops playback and forgets the recording in progress. */
  stop() {
    this.playing = false;
    this.beginLap();
  }

  /**
   * Advances playback and updates `position` / `quaternion`.
   * @param {number} dt
   * @returns {boolean} true while a ghost is being played
   */
  update(dt) {
    if (!this.playing || !this.hasGhost) return false;

    this.time += dt;
    // Loops, so the ghost keeps company for as many laps as you drive.
    if (this.time > this.duration) this.time -= this.duration;

    const t = (this.time / this.duration) * (this.count - 1);
    const i = Math.min(this.count - 2, Math.max(0, Math.floor(t)));
    const f = t - i;

    const p = this.positions;
    this.position.set(
      p[i * 3] + (p[(i + 1) * 3] - p[i * 3]) * f,
      p[i * 3 + 1] + (p[(i + 1) * 3 + 1] - p[i * 3 + 1]) * f,
      p[i * 3 + 2] + (p[(i + 1) * 3 + 2] - p[i * 3 + 2]) * f,
    );

    const r = this.rotations;
    this._a.set(r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3]);
    this._b.set(r[(i + 1) * 4], r[(i + 1) * 4 + 1], r[(i + 1) * 4 + 2], r[(i + 1) * 4 + 3]);
    // Slerp, not lerp: the short way round the sphere, at constant speed.
    this.quaternion.slerpQuaternions(this._a, this._b, f);

    return true;
  }
}
