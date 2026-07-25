export class AnimationClip {
    /**
     * Looks a clip up by name.
     * @param {Array<AnimationClip>} clips
     * @param {string} name
     * @returns {AnimationClip|null}
     */
    static findByName(clips: Array<AnimationClip>, name: string): AnimationClip | null;
    /**
     * @param {string} [name=''] Clip name (used by `findByName`).
     * @param {number} [duration=-1] Duration in seconds; negative means "derive from the tracks".
     * @param {Array<KeyframeTrack>} [tracks] Tracks owned by this clip.
     */
    constructor(name?: string, duration?: number, tracks?: Array<KeyframeTrack>);
    /** @type {number} Unique clip id. */
    id: number;
    /** @type {string} Clip name. */
    name: string;
    /** @type {Array<KeyframeTrack>} Animated channels. */
    tracks: Array<KeyframeTrack>;
    /** @type {number} Clip length in seconds. */
    duration: number;
    /**
     * Bumped whenever the track list changes. The mixer watches it and rebinds
     * actions whose clip was edited after they were created.
     * @type {number}
     */
    version: number;
    /** @type {Object} Free form user payload (never touched by the engine). */
    userData: any;
    /** Number of tracks in the clip. @returns {number} */
    get trackCount(): number;
    /** Approximate CPU memory footprint in bytes. @returns {number} */
    get memoryBytes(): number;
    /**
     * Recomputes `duration` as the largest keyframe time across all tracks.
     * @returns {AnimationClip} this
     */
    resetDuration(): AnimationClip;
    /**
     * Appends a track.
     * @param {KeyframeTrack} track
     * @returns {AnimationClip} this
     */
    addTrack(track: KeyframeTrack): AnimationClip;
    /**
     * Removes a track (by reference or by index).
     * @param {KeyframeTrack|number} track
     * @returns {AnimationClip} this
     */
    removeTrack(track: KeyframeTrack | number): AnimationClip;
    /**
     * Finds the first track bound to `targetPath`.
     * @param {string} targetPath
     * @returns {KeyframeTrack|null}
     */
    findTrack(targetPath: string): KeyframeTrack | null;
    /**
     * Drops redundant keyframes from every track and removes tracks left empty.
     * Offline helper (it allocates); call it once after loading, never per frame.
     *
     * @param {number} [tolerance=1e-4] Absolute component tolerance passed to each track.
     * @returns {AnimationClip} this
     */
    optimize(tolerance?: number): AnimationClip;
    /**
     * Shifts every track so the clip starts at t = 0 and updates `duration`.
     * @returns {AnimationClip} this
     */
    trim(): AnimationClip;
    /**
     * Scales the whole timeline (2 = half speed when played at timeScale 1).
     * @param {number} factor
     * @returns {AnimationClip} this
     */
    scaleTime(factor: number): AnimationClip;
    /**
     * Validates every track.
     * @returns {Array<string>} Human readable problems (empty when the clip is valid).
     */
    validate(): Array<string>;
    /**
     * Deep copy (tracks and their buffers included).
     * @returns {AnimationClip}
     */
    clone(): AnimationClip;
}
import { KeyframeTrack } from "./KeyframeTrack.js";
