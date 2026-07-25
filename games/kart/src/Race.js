/**
 * Lap timing and checkpoint progress.
 *
 * Checkpoints must be taken in order. That single rule is what makes the timer
 * trustworthy: without it, reversing over the start line scores a lap, and any
 * shortcut across the infield counts. The kart's progress is tracked as "the
 * next checkpoint I owe", and a lap only closes when the last one has been
 * paid and the line is crossed going the right way.
 */

import { Vec3 } from '../../../src/math/Vec3.js';

const _toKart = new Vec3();

/** Race phases. */
export const RaceState = Object.freeze({
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
});

/**
 * Formats seconds as m:ss.mmm.
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return String(m) + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}

/**
 * Race progress for a single kart.
 */
export class Race {
  /**
   * @param {Object} options
   * @param {import('./Track.js').Track} options.track
   * @param {number} [options.totalLaps=3]
   * @param {number} [options.countdownSeconds=3.2]
   */
  constructor(options) {
    /** @type {import('./Track.js').Track} */
    this.track = options.track;
    /** @type {number} */
    this.totalLaps = options.totalLaps !== undefined ? options.totalLaps : 3;
    /** @type {number} */
    this.countdownSeconds = options.countdownSeconds !== undefined
      ? options.countdownSeconds : 3.2;

    /** @type {string} */
    this.state = RaceState.COUNTDOWN;
    /** @type {number} Seconds left before the green light. */
    this.countdown = this.countdownSeconds;
    /** @type {number} Completed laps. */
    this.lap = 0;
    /** @type {number} Seconds into the current lap. */
    this.lapTime = 0;
    /** @type {number} Seconds since the start. */
    this.totalTime = 0;
    /** @type {number} Best lap so far, Infinity until one is set. */
    this.bestLap = Infinity;
    /** @type {number} The lap just completed, for the split display. */
    this.lastLap = Infinity;
    /** @type {number[]} Every completed lap time. */
    this.lapTimes = [];
    /** @type {boolean} True during the frame a lap was completed. */
    this.lapCompleted = false;
    /** @type {boolean} True during the frame a new best was set. */
    this.newBest = false;

    /** @type {number} Index of the checkpoint the kart still owes. */
    this.nextCheckpoint = 1;
    /** @type {number} Fraction of the lap completed, 0..1. */
    this.progress = 0;
    /** @type {boolean} True when driving against the racing direction. */
    this.wrongWay = false;

    /** @type {number} How far along the lap, in metres. */
    this.distance = 0;
  }

  /** Puts the race back on the grid. */
  reset() {
    this.state = RaceState.COUNTDOWN;
    this.countdown = this.countdownSeconds;
    this.lap = 0;
    this.lapTime = 0;
    this.totalTime = 0;
    this.lapTimes.length = 0;
    this.lastLap = Infinity;
    this.nextCheckpoint = 1;
    this.progress = 0;
    this.wrongWay = false;
    this.lapCompleted = false;
    this.newBest = false;
    // bestLap deliberately survives a reset: it is the session record.
  }

  /** @returns {boolean} true while the kart must stay still. */
  get locked() {
    return this.state === RaceState.COUNTDOWN;
  }

  /**
   * @param {number} dt
   * @param {Vec3} position Kart position.
   * @param {Vec3} forward Kart forward vector.
   */
  update(dt, position, forward) {
    this.lapCompleted = false;
    this.newBest = false;

    if (this.state === RaceState.COUNTDOWN) {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.state = RaceState.RACING;
      }
      return;
    }
    if (this.state === RaceState.FINISHED) return;

    this.lapTime += dt;
    this.totalTime += dt;

    const checkpoints = this.track.checkpoints;
    const count = checkpoints.length;
    const target = checkpoints[this.nextCheckpoint % count];

    // A checkpoint is a plane across the track. Crossing it means going from
    // behind that plane to in front of it, which a dot product answers directly
    // and which no amount of cutting the corner can fake.
    _toKart.subVectors(position, target.position);
    const ahead = _toKart.dot(target.forward);
    const lateral = Math.abs(_toKart.dot(target.right));

    if (ahead > 0 && ahead < 14 && lateral < 16) {
      this.nextCheckpoint++;
      if (this.nextCheckpoint > count) {
        // Lap closed.
        this.nextCheckpoint = 1;
        this.lap++;
        this.lastLap = this.lapTime;
        this.lapTimes.push(this.lapTime);
        this.lapCompleted = true;
        if (this.lapTime < this.bestLap) {
          this.bestLap = this.lapTime;
          this.newBest = true;
        }
        this.lapTime = 0;
        if (this.lap >= this.totalLaps) this.state = RaceState.FINISHED;
      }
    }

    // Progress and wrong way, from the nearest point on the centre line.
    const near = this.track.nearest(position);
    this.distance = near.distance;
    this.progress = near.distance / this.track.length;
    this.wrongWay = forward.dot(near.sample.forward) < -0.35;
  }
}
