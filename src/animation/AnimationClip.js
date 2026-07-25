/**
 * AnimationClip - a named bundle of {@link KeyframeTrack}s sharing a timeline.
 *
 * A clip owns no playback state: it is immutable data shared by every
 * {@link AnimationAction} that plays it, so the same clip can drive many
 * characters at different times without any per instance cost.
 *
 * @module animation/AnimationClip
 */

import { KeyframeTrack } from './KeyframeTrack.js';

let _nextClipId = 1;

export class AnimationClip {
  /**
   * @param {string} [name=''] Clip name (used by `findByName`).
   * @param {number} [duration=-1] Duration in seconds; negative means "derive from the tracks".
   * @param {Array<KeyframeTrack>} [tracks] Tracks owned by this clip.
   */
  constructor(name = '', duration = -1, tracks = null) {
    /** @type {number} Unique clip id. */
    this.id = _nextClipId++;

    /** @type {string} Clip name. */
    this.name = typeof name === 'string' ? name : '';

    /** @type {Array<KeyframeTrack>} Animated channels. */
    this.tracks = tracks !== null && tracks !== undefined ? tracks : [];

    /** @type {number} Clip length in seconds. */
    this.duration = typeof duration === 'number' ? duration : -1;

    /**
     * Bumped whenever the track list changes. The mixer watches it and rebinds
     * actions whose clip was edited after they were created.
     * @type {number}
     */
    this.version = 0;

    /** @type {Object} Free form user payload (never touched by the engine). */
    this.userData = {};

    if (!(this.duration >= 0)) this.resetDuration();
  }

  /** Number of tracks in the clip. @returns {number} */
  get trackCount() {
    return this.tracks.length;
  }

  /** Approximate CPU memory footprint in bytes. @returns {number} */
  get memoryBytes() {
    let bytes = 0;
    const tracks = this.tracks;
    for (let i = 0, n = tracks.length; i < n; i++) bytes += tracks[i].memoryBytes;
    return bytes;
  }

  /**
   * Recomputes `duration` as the largest keyframe time across all tracks.
   * @returns {AnimationClip} this
   */
  resetDuration() {
    const tracks = this.tracks;
    let duration = 0;
    for (let i = 0, n = tracks.length; i < n; i++) {
      const d = tracks[i].duration;
      if (d > duration) duration = d;
    }
    this.duration = duration;
    return this;
  }

  /**
   * Appends a track.
   * @param {KeyframeTrack} track
   * @returns {AnimationClip} this
   */
  addTrack(track) {
    if (track === null || track === undefined) return this;
    this.tracks.push(track);
    if (track.duration > this.duration) this.duration = track.duration;
    this.version++;
    return this;
  }

  /**
   * Removes a track (by reference or by index).
   * @param {KeyframeTrack|number} track
   * @returns {AnimationClip} this
   */
  removeTrack(track) {
    const index = typeof track === 'number' ? track : this.tracks.indexOf(track);
    if (index >= 0 && index < this.tracks.length) {
      this.tracks.splice(index, 1);
      this.version++;
    }
    return this;
  }

  /**
   * Finds the first track bound to `targetPath`.
   * @param {string} targetPath
   * @returns {KeyframeTrack|null}
   */
  findTrack(targetPath) {
    const tracks = this.tracks;
    for (let i = 0, n = tracks.length; i < n; i++) {
      if (tracks[i].targetPath === targetPath) return tracks[i];
    }
    return null;
  }

  /**
   * Drops redundant keyframes from every track and removes tracks left empty.
   * Offline helper (it allocates); call it once after loading, never per frame.
   *
   * @param {number} [tolerance=1e-4] Absolute component tolerance passed to each track.
   * @returns {AnimationClip} this
   */
  optimize(tolerance = 1e-4) {
    const tracks = this.tracks;
    let write = 0;
    for (let i = 0, n = tracks.length; i < n; i++) {
      const track = tracks[i];
      track.optimize(tolerance);
      if (track.frameCount > 0) tracks[write++] = track;
    }
    if (write !== tracks.length) {
      tracks.length = write;
      this.version++;
    }
    return this;
  }

  /**
   * Shifts every track so the clip starts at t = 0 and updates `duration`.
   * @returns {AnimationClip} this
   */
  trim() {
    const tracks = this.tracks;
    if (tracks.length === 0) return this;
    let start = Infinity;
    for (let i = 0, n = tracks.length; i < n; i++) {
      const s = tracks[i].startTime;
      if (s < start) start = s;
    }
    if (start !== 0 && Number.isFinite(start)) {
      for (let i = 0, n = tracks.length; i < n; i++) tracks[i].shift(-start);
    }
    return this.resetDuration();
  }

  /**
   * Scales the whole timeline (2 = half speed when played at timeScale 1).
   * @param {number} factor
   * @returns {AnimationClip} this
   */
  scaleTime(factor) {
    const tracks = this.tracks;
    for (let i = 0, n = tracks.length; i < n; i++) tracks[i].scaleTime(factor);
    return this.resetDuration();
  }

  /**
   * Validates every track.
   * @returns {Array<string>} Human readable problems (empty when the clip is valid).
   */
  validate() {
    const problems = [];
    const tracks = this.tracks;
    for (let i = 0, n = tracks.length; i < n; i++) {
      const error = tracks[i].validate();
      if (error !== null) problems.push('track ' + i + ' (' + tracks[i].targetPath + '): ' + error);
    }
    if (!(this.duration >= 0)) problems.push('duration is not a positive number');
    return problems;
  }

  /**
   * Deep copy (tracks and their buffers included).
   * @returns {AnimationClip}
   */
  clone() {
    const tracks = this.tracks;
    const copies = new Array(tracks.length);
    for (let i = 0, n = tracks.length; i < n; i++) copies[i] = tracks[i].clone();
    const clip = new AnimationClip(this.name, this.duration, copies);
    clip.userData = this.userData;
    return clip;
  }

  /**
   * Looks a clip up by name.
   * @param {Array<AnimationClip>} clips
   * @param {string} name
   * @returns {AnimationClip|null}
   */
  static findByName(clips, name) {
    if (clips === null || clips === undefined) return null;
    for (let i = 0, n = clips.length; i < n; i++) {
      if (clips[i].name === name) return clips[i];
    }
    return null;
  }
}
