/** Numeric interpolation modes (internal fast switch). */
export const InterpolationMode: Readonly<{
    STEP: 0;
    LINEAR: 1;
    CUBICSPLINE: 2;
}>;
export class KeyframeTrack {
    /**
     * @param {string} targetPath Binding path, e.g. `'Hips.quaternion'` or `'.material.opacity'`.
     * @param {ArrayLike<number>} times Keyframe times in seconds, strictly increasing.
     * @param {ArrayLike<number>} values Interleaved keyframe values.
     * @param {number} valueSize Components per keyframe (3 = vec3, 4 = quaternion, N = weights).
     * @param {string|number} [interpolation='linear'] `'step'` | `'linear'` | `'cubicspline'`.
     */
    constructor(targetPath: string, times: ArrayLike<number>, values: ArrayLike<number>, valueSize: number, interpolation?: string | number);
    /** @type {string} Binding path resolved once by the mixer. */
    targetPath: string;
    /** @type {Float32Array} Keyframe times, seconds, strictly increasing. */
    times: Float32Array;
    /** @type {Float32Array} Interleaved keyframe values. */
    values: Float32Array;
    /** @type {number} Components per sampled value. */
    valueSize: number;
    /** @type {number} Numeric interpolation mode. @see InterpolationMode */
    mode: number;
    /** @type {number} Number of components stored per keyframe in `values`. */
    stride: number;
    /** @type {number} Number of keyframes. */
    frameCount: number;
    /**
     * True when the sampled value is a rotation quaternion and must be blended
     * with slerp instead of a component wise lerp. Auto detected from the path
     * (`.quaternion` / `.rotation`) plus `valueSize === 4`; assignable.
     * @type {boolean}
     */
    isQuaternion: boolean;
    /** @type {number} Cursor reused between samples when no external cache is given. @private */
    private _cachedIndex;
    /**
     * Changes the interpolation mode. Switching to/from CUBICSPLINE only makes
     * sense when the value buffer already carries tangents, so the frame count is
     * recomputed from the new stride.
     * @param {string|number} interpolation
     * @returns {KeyframeTrack} this
     */
    set interpolation(arg: string | number);
    /** Interpolation mode as a string. @returns {string} */
    get interpolation(): string | number;
    /**
     * Explicit setter counterpart of the `interpolation` accessor.
     * @param {string|number} interpolation `'step'` | `'linear'` | `'cubicspline'`.
     * @returns {KeyframeTrack} this
     */
    setInterpolation(interpolation: string | number): KeyframeTrack;
    /** Time of the first keyframe, seconds. @returns {number} */
    get startTime(): number;
    /** Time of the last keyframe, seconds. @returns {number} */
    get duration(): number;
    /** Approximate CPU memory footprint in bytes. @returns {number} */
    get memoryBytes(): number;
    /**
     * Samples the track and writes `valueSize` components into `out`.
     * Allocation free.
     *
     * @param {number} time Time in seconds (clamped to the track range).
     * @param {Float32Array|Array<number>} out Destination buffer.
     * @param {number} [outOffset=0] Destination offset.
     * @param {Int32Array|null} [cache=null] Optional external cursor storage.
     * @param {number} [cacheSlot=0] Index inside `cache` owned by the caller.
     * @returns {number} Index of the left keyframe used (-1 for an empty track).
     */
    evaluate(time: number, out: Float32Array | Array<number>, outOffset?: number, cache?: Int32Array | null, cacheSlot?: number): number;
    /**
     * Copies the raw value of one keyframe (skipping tangents for CUBICSPLINE).
     * @param {number} index Keyframe index.
     * @param {Float32Array|Array<number>} out Destination.
     * @param {number} [outOffset=0] Destination offset.
     * @returns {KeyframeTrack} this
     */
    getKeyframeValue(index: number, out: Float32Array | Array<number>, outOffset?: number): KeyframeTrack;
    /**
     * Copies keyframe `index` into `out`.
     * @private
     * @param {number} index
     * @param {Float32Array|Array<number>} out
     * @param {number} outOffset
     * @returns {void}
     */
    private _copyFrame;
    /**
     * Resolves the left keyframe index for `time`, assuming
     * `times[0] < time < times[frameCount - 1]`.
     *
     * Fast paths (no binary search): the cursor is still valid, or it advances /
     * rewinds by exactly one keyframe.
     *
     * @private
     * @param {number} time
     * @param {Int32Array|null} cache
     * @param {number} cacheSlot
     * @returns {number}
     */
    private _seek;
    /**
     * Largest `i` in `[lo, hi]` with `times[i] <= time`.
     * @private
     * @param {number} time
     * @param {number} lo
     * @param {number} hi
     * @returns {number}
     */
    private _binarySearch;
    /**
     * Resets the internal sampling cursor. Call after scrubbing far backwards to
     * skip one wasted comparison (purely an optimisation, never required).
     * @returns {KeyframeTrack} this
     */
    resetCursor(): KeyframeTrack;
    /**
     * Removes redundant keyframes: any keyframe that can be reconstructed from
     * its surviving neighbours (linearly, or by slerp for quaternions) within
     * `tolerance` is dropped. Every dropped keyframe is re-tested against the
     * final segment, so the error stays bounded by `tolerance` instead of
     * accumulating along long runs.
     *
     * CUBICSPLINE tracks only get exact constant runs collapsed, because dropping
     * a control point changes the spline shape everywhere.
     *
     * Offline helper - it allocates and must not be called per frame.
     *
     * @param {number} [tolerance=1e-4] Absolute component tolerance (radians for quaternions).
     * @returns {KeyframeTrack} this
     */
    optimize(tolerance?: number): KeyframeTrack;
    /**
     * Returns a scratch buffer big enough for one sampled value.
     * @private
     * @param {number} size
     * @returns {Float32Array}
     */
    private _optimizeScratch;
    /**
     * Interpolates between two keyframes at an absolute time (optimizer helper).
     * @private
     * @param {number} i0
     * @param {number} i1
     * @param {number} time
     * @param {Float32Array} out
     * @returns {void}
     */
    private _interpolateFrames;
    /**
     * Compares keyframe `index` against a sampled value (optimizer helper).
     * @private
     * @param {number} index
     * @param {Float32Array} sample
     * @param {number} tolerance
     * @returns {boolean}
     */
    private _valueMatches;
    /**
     * True when two keyframes carry the same payload (values plus tangents).
     * @private
     * @param {number} a
     * @param {number} b
     * @param {number} tolerance
     * @returns {boolean}
     */
    private _frameEquals;
    /**
     * Shifts every keyframe time by `offset` seconds.
     * @param {number} offset
     * @returns {KeyframeTrack} this
     */
    shift(offset: number): KeyframeTrack;
    /**
     * Scales every keyframe time (and CUBICSPLINE tangents) by `factor`.
     * @param {number} factor
     * @returns {KeyframeTrack} this
     */
    scaleTime(factor: number): KeyframeTrack;
    /**
     * Validates the internal invariants (strictly increasing times, finite
     * values, consistent buffer sizes).
     * @returns {string|null} Error description, or null when the track is valid.
     */
    validate(): string | null;
    /**
     * Deep copy (buffers included).
     * @returns {KeyframeTrack}
     */
    clone(): KeyframeTrack;
}
