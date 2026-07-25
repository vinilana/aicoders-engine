/**
 * KeyframeTrack - a single animated property channel.
 *
 * Storage is two flat typed arrays: `times` (one entry per keyframe) and
 * `values` (interleaved, `valueSize` components per keyframe, or
 * `3 * valueSize` for CUBICSPLINE where each keyframe stores
 * [inTangent, value, outTangent] exactly like glTF).
 *
 * Sampling never allocates. The keyframe lookup uses a cached cursor: most
 * frames advance by zero or one keyframe, and those two cases are resolved with
 * one or two comparisons. Only a real seek (scrubbing, looping, random access)
 * falls back to a binary search. The cursor can live either on the track
 * (default) or in a caller supplied Int32Array, so several actions can sample
 * the same shared track at different times without thrashing one another.
 *
 * @module animation/KeyframeTrack
 */

import { Quat } from '../math/Quat.js';

/** Numeric interpolation modes (internal fast switch). */
export const InterpolationMode = Object.freeze({
  STEP: 0,
  LINEAR: 1,
  CUBICSPLINE: 2
});

/** Canonical interpolation names indexed by {@link InterpolationMode}. */
const INTERPOLATION_NAMES = ['step', 'linear', 'cubicspline'];

/** Scratch buffer used by the offline optimizer only (never per frame). */
const _sampleA = new Float32Array(64);

/**
 * Normalizes an array-like into a Float32Array without copying when possible.
 * @private
 * @param {ArrayLike<number>|null} source
 * @returns {Float32Array}
 */
function toFloat32(source) {
  if (source === null || source === undefined) return new Float32Array(0);
  if (source instanceof Float32Array) return source;
  const n = source.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = source[i];
  return out;
}

/**
 * Maps an interpolation name (or numeric mode) to a numeric mode.
 * @private
 * @param {string|number} interpolation
 * @returns {number}
 */
function toMode(interpolation) {
  if (typeof interpolation === 'number') {
    return interpolation === 0 || interpolation === 2 ? interpolation : InterpolationMode.LINEAR;
  }
  if (typeof interpolation === 'string') {
    const lower = interpolation.toLowerCase();
    if (lower === 'step' || lower === 'discrete') return InterpolationMode.STEP;
    if (lower === 'cubicspline' || lower === 'cubic') return InterpolationMode.CUBICSPLINE;
  }
  return InterpolationMode.LINEAR;
}

/**
 * Extracts the trailing property name of a track path, ignoring any
 * `[index]` suffix. `'Hips.quaternion'` -> `'quaternion'`.
 * @private
 * @param {string} path
 * @returns {string}
 */
function trailingProperty(path) {
  if (typeof path !== 'string' || path.length === 0) return '';
  let end = path.length;
  const bracket = path.lastIndexOf('[');
  if (bracket !== -1 && path.charCodeAt(path.length - 1) === 93 /* ] */) end = bracket;
  const dot = path.lastIndexOf('.', end - 1);
  return path.slice(dot + 1, end);
}

/**
 * True when a track path addresses a rotation channel.
 * @private
 * @param {string} path
 * @returns {boolean}
 */
function isRotationPath(path) {
  const prop = trailingProperty(path);
  return prop === 'quaternion' || prop === 'rotation';
}

export class KeyframeTrack {
  /**
   * @param {string} targetPath Binding path, e.g. `'Hips.quaternion'` or `'.material.opacity'`.
   * @param {ArrayLike<number>} times Keyframe times in seconds, strictly increasing.
   * @param {ArrayLike<number>} values Interleaved keyframe values.
   * @param {number} valueSize Components per keyframe (3 = vec3, 4 = quaternion, N = weights).
   * @param {string|number} [interpolation='linear'] `'step'` | `'linear'` | `'cubicspline'`.
   */
  constructor(targetPath, times, values, valueSize, interpolation = 'linear') {
    /** @type {string} Binding path resolved once by the mixer. */
    this.targetPath = typeof targetPath === 'string' ? targetPath : '';

    /** @type {Float32Array} Keyframe times, seconds, strictly increasing. */
    this.times = toFloat32(times);

    /** @type {Float32Array} Interleaved keyframe values. */
    this.values = toFloat32(values);

    /** @type {number} Components per sampled value. */
    this.valueSize = valueSize > 0 ? valueSize | 0 : 1;

    /** @type {number} Numeric interpolation mode. @see InterpolationMode */
    this.mode = toMode(interpolation);

    /** @type {number} Number of components stored per keyframe in `values`. */
    this.stride = this.mode === InterpolationMode.CUBICSPLINE ? this.valueSize * 3 : this.valueSize;

    /** @type {number} Number of keyframes. */
    this.frameCount = this.stride > 0 ? Math.min(this.times.length, (this.values.length / this.stride) | 0) : 0;

    /**
     * True when the sampled value is a rotation quaternion and must be blended
     * with slerp instead of a component wise lerp. Auto detected from the path
     * (`.quaternion` / `.rotation`) plus `valueSize === 4`; assignable.
     * @type {boolean}
     */
    this.isQuaternion = this.valueSize === 4 && isRotationPath(this.targetPath);

    /** @type {number} Cursor reused between samples when no external cache is given. @private */
    this._cachedIndex = 0;
  }

  /** Interpolation mode as a string. @returns {string} */
  get interpolation() {
    return INTERPOLATION_NAMES[this.mode];
  }

  /**
   * Changes the interpolation mode. Switching to/from CUBICSPLINE only makes
   * sense when the value buffer already carries tangents, so the frame count is
   * recomputed from the new stride.
   * @param {string|number} interpolation
   * @returns {KeyframeTrack} this
   */
  set interpolation(interpolation) {
    this.setInterpolation(interpolation);
  }

  /**
   * Explicit setter counterpart of the `interpolation` accessor.
   * @param {string|number} interpolation `'step'` | `'linear'` | `'cubicspline'`.
   * @returns {KeyframeTrack} this
   */
  setInterpolation(interpolation) {
    this.mode = toMode(interpolation);
    this.stride = this.mode === InterpolationMode.CUBICSPLINE ? this.valueSize * 3 : this.valueSize;
    this.frameCount = this.stride > 0 ? Math.min(this.times.length, (this.values.length / this.stride) | 0) : 0;
    this._cachedIndex = 0;
    return this;
  }

  /** Time of the first keyframe, seconds. @returns {number} */
  get startTime() {
    return this.frameCount > 0 ? this.times[0] : 0;
  }

  /** Time of the last keyframe, seconds. @returns {number} */
  get duration() {
    return this.frameCount > 0 ? this.times[this.frameCount - 1] : 0;
  }

  /** Approximate CPU memory footprint in bytes. @returns {number} */
  get memoryBytes() {
    return this.times.byteLength + this.values.byteLength;
  }

  /* -------------------------------------------------------------------- */
  /* Sampling                                                              */
  /* -------------------------------------------------------------------- */

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
  evaluate(time, out, outOffset = 0, cache = null, cacheSlot = 0) {
    const n = this.frameCount;
    const vs = this.valueSize;

    if (n === 0) {
      for (let k = 0; k < vs; k++) out[outOffset + k] = 0;
      if (this.isQuaternion) out[outOffset + 3] = 1;
      return -1;
    }

    const times = this.times;
    if (n === 1 || time <= times[0]) {
      this._copyFrame(0, out, outOffset);
      return 0;
    }

    const last = n - 1;
    if (time >= times[last]) {
      this._copyFrame(last, out, outOffset);
      return last;
    }

    const i = this._seek(time, cache, cacheSlot);
    const t0 = times[i];
    const t1 = times[i + 1];
    const span = t1 - t0;
    const alpha = span > 0 ? (time - t0) / span : 0;

    const values = this.values;
    const stride = this.stride;

    if (this.mode === InterpolationMode.STEP) {
      this._copyFrame(i, out, outOffset);
      return i;
    }

    if (this.mode === InterpolationMode.LINEAR) {
      const o0 = i * stride;
      const o1 = o0 + stride;
      if (this.isQuaternion) {
        Quat.slerpFlat(out, outOffset, values, o0, values, o1, alpha);
      } else {
        const inv = 1 - alpha;
        for (let k = 0; k < vs; k++) {
          out[outOffset + k] = values[o0 + k] * inv + values[o1 + k] * alpha;
        }
      }
      return i;
    }

    // CUBICSPLINE (glTF Hermite): per keyframe [inTangent, value, outTangent].
    const o0 = i * stride;
    const o1 = o0 + stride;
    const a = alpha;
    const a2 = a * a;
    const a3 = a2 * a;
    const h00 = 2 * a3 - 3 * a2 + 1;
    const h10 = a3 - 2 * a2 + a;
    const h01 = -2 * a3 + 3 * a2;
    const h11 = a3 - a2;

    const p0 = o0 + vs;          // value of keyframe i
    const m0 = o0 + vs + vs;     // outTangent of keyframe i
    const m1 = o1;               // inTangent of keyframe i + 1
    const p1 = o1 + vs;          // value of keyframe i + 1

    for (let k = 0; k < vs; k++) {
      out[outOffset + k] =
        h00 * values[p0 + k] +
        h10 * span * values[m0 + k] +
        h01 * values[p1 + k] +
        h11 * span * values[m1 + k];
    }

    if (this.isQuaternion) {
      const x = out[outOffset];
      const y = out[outOffset + 1];
      const z = out[outOffset + 2];
      const w = out[outOffset + 3];
      const lenSq = x * x + y * y + z * z + w * w;
      if (lenSq > 0) {
        const inv = 1 / Math.sqrt(lenSq);
        out[outOffset] = x * inv;
        out[outOffset + 1] = y * inv;
        out[outOffset + 2] = z * inv;
        out[outOffset + 3] = w * inv;
      } else {
        out[outOffset] = 0;
        out[outOffset + 1] = 0;
        out[outOffset + 2] = 0;
        out[outOffset + 3] = 1;
      }
    }

    return i;
  }

  /**
   * Copies the raw value of one keyframe (skipping tangents for CUBICSPLINE).
   * @param {number} index Keyframe index.
   * @param {Float32Array|Array<number>} out Destination.
   * @param {number} [outOffset=0] Destination offset.
   * @returns {KeyframeTrack} this
   */
  getKeyframeValue(index, out, outOffset = 0) {
    this._copyFrame(index < 0 ? 0 : (index >= this.frameCount ? this.frameCount - 1 : index), out, outOffset);
    return this;
  }

  /**
   * Copies keyframe `index` into `out`.
   * @private
   * @param {number} index
   * @param {Float32Array|Array<number>} out
   * @param {number} outOffset
   * @returns {void}
   */
  _copyFrame(index, out, outOffset) {
    const vs = this.valueSize;
    const values = this.values;
    let base = index * this.stride;
    if (this.mode === InterpolationMode.CUBICSPLINE) base += vs;
    for (let k = 0; k < vs; k++) out[outOffset + k] = values[base + k];
  }

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
  _seek(time, cache, cacheSlot) {
    const times = this.times;
    const maxIndex = this.frameCount - 2;

    let i = cache !== null ? cache[cacheSlot] : this._cachedIndex;
    if (i < 0) i = 0;
    else if (i > maxIndex) i = maxIndex;

    if (time >= times[i]) {
      if (time >= times[i + 1]) {
        if (i + 1 > maxIndex || time < times[i + 2]) {
          i = i + 1 > maxIndex ? maxIndex : i + 1;
        } else {
          i = this._binarySearch(time, i + 2 > maxIndex ? maxIndex : i + 2, maxIndex);
        }
      }
    } else if (i > 0 && time >= times[i - 1]) {
      i--;
    } else {
      i = this._binarySearch(time, 0, i > 2 ? i - 2 : 0);
    }

    if (cache !== null) cache[cacheSlot] = i;
    else this._cachedIndex = i;
    return i;
  }

  /**
   * Largest `i` in `[lo, hi]` with `times[i] <= time`.
   * @private
   * @param {number} time
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  _binarySearch(time, lo, hi) {
    const times = this.times;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (times[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Resets the internal sampling cursor. Call after scrubbing far backwards to
   * skip one wasted comparison (purely an optimisation, never required).
   * @returns {KeyframeTrack} this
   */
  resetCursor() {
    this._cachedIndex = 0;
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Editing / offline utilities                                            */
  /* -------------------------------------------------------------------- */

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
  optimize(tolerance = 1e-4) {
    const n = this.frameCount;
    if (n < 3) return this;

    const tol = tolerance > 0 ? tolerance : 0;
    const stride = this.stride;
    const vs = this.valueSize;
    const times = this.times;
    const values = this.values;

    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;

    if (this.mode === InterpolationMode.CUBICSPLINE) {
      for (let i = 1; i < n - 1; i++) {
        if (!this._frameEquals(i - 1, i, tol) || !this._frameEquals(i, i + 1, tol)) keep[i] = 1;
      }
    } else if (this.mode === InterpolationMode.STEP) {
      for (let i = 1; i < n - 1; i++) {
        if (!this._frameEquals(i - 1, i, tol)) keep[i] = 1;
      }
    } else {
      const scratch = this._optimizeScratch(vs);
      let anchor = 0;
      for (let i = 1; i < n - 1; i++) {
        const next = i + 1;
        let ok = true;
        // Corridor test: every candidate dropped between anchor and next must
        // still be reproduced by the anchor -> next segment.
        for (let j = anchor + 1; j <= i; j++) {
          this._interpolateFrames(anchor, next, times[j], scratch);
          if (!this._valueMatches(j, scratch, tol)) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          keep[i] = 1;
          anchor = i;
        }
      }
    }

    let kept = 0;
    for (let i = 0; i < n; i++) kept += keep[i];

    // Collapse a fully constant track down to a single keyframe.
    if (kept === 2 && this._frameEquals(0, n - 1, tol)) {
      const newTimes = new Float32Array(1);
      const newValues = new Float32Array(stride);
      newTimes[0] = times[0];
      for (let k = 0; k < stride; k++) newValues[k] = values[k];
      this.times = newTimes;
      this.values = newValues;
      this.frameCount = 1;
      this._cachedIndex = 0;
      return this;
    }

    if (kept === n) return this;

    const newTimes = new Float32Array(kept);
    const newValues = new Float32Array(kept * stride);
    let w = 0;
    for (let i = 0; i < n; i++) {
      if (keep[i] === 0) continue;
      newTimes[w] = times[i];
      const src = i * stride;
      const dst = w * stride;
      for (let k = 0; k < stride; k++) newValues[dst + k] = values[src + k];
      w++;
    }

    this.times = newTimes;
    this.values = newValues;
    this.frameCount = kept;
    this._cachedIndex = 0;
    return this;
  }

  /**
   * Returns a scratch buffer big enough for one sampled value.
   * @private
   * @param {number} size
   * @returns {Float32Array}
   */
  _optimizeScratch(size) {
    return size <= _sampleA.length ? _sampleA : new Float32Array(size);
  }

  /**
   * Interpolates between two keyframes at an absolute time (optimizer helper).
   * @private
   * @param {number} i0
   * @param {number} i1
   * @param {number} time
   * @param {Float32Array} out
   * @returns {void}
   */
  _interpolateFrames(i0, i1, time, out) {
    const times = this.times;
    const values = this.values;
    const stride = this.stride;
    const vs = this.valueSize;
    const t0 = times[i0];
    const t1 = times[i1];
    const span = t1 - t0;
    const a = span > 0 ? (time - t0) / span : 0;
    const o0 = i0 * stride;
    const o1 = i1 * stride;
    if (this.isQuaternion) {
      Quat.slerpFlat(out, 0, values, o0, values, o1, a);
    } else {
      const inv = 1 - a;
      for (let k = 0; k < vs; k++) out[k] = values[o0 + k] * inv + values[o1 + k] * a;
    }
  }

  /**
   * Compares keyframe `index` against a sampled value (optimizer helper).
   * @private
   * @param {number} index
   * @param {Float32Array} sample
   * @param {number} tolerance
   * @returns {boolean}
   */
  _valueMatches(index, sample, tolerance) {
    const values = this.values;
    const vs = this.valueSize;
    let base = index * this.stride;
    if (this.mode === InterpolationMode.CUBICSPLINE) base += vs;

    if (this.isQuaternion) {
      let dot = 0;
      for (let k = 0; k < 4; k++) dot += values[base + k] * sample[k];
      if (dot < 0) dot = -dot;
      if (dot > 1) dot = 1;
      return 2 * Math.acos(dot) <= tolerance;
    }

    for (let k = 0; k < vs; k++) {
      const d = values[base + k] - sample[k];
      if (d > tolerance || d < -tolerance) return false;
    }
    return true;
  }

  /**
   * True when two keyframes carry the same payload (values plus tangents).
   * @private
   * @param {number} a
   * @param {number} b
   * @param {number} tolerance
   * @returns {boolean}
   */
  _frameEquals(a, b, tolerance) {
    const values = this.values;
    const stride = this.stride;
    const oa = a * stride;
    const ob = b * stride;
    for (let k = 0; k < stride; k++) {
      const d = values[oa + k] - values[ob + k];
      if (d > tolerance || d < -tolerance) return false;
    }
    return true;
  }

  /**
   * Shifts every keyframe time by `offset` seconds.
   * @param {number} offset
   * @returns {KeyframeTrack} this
   */
  shift(offset) {
    if (offset === 0) return this;
    const times = this.times;
    for (let i = 0, n = this.frameCount; i < n; i++) times[i] += offset;
    this._cachedIndex = 0;
    return this;
  }

  /**
   * Scales every keyframe time (and CUBICSPLINE tangents) by `factor`.
   * @param {number} factor
   * @returns {KeyframeTrack} this
   */
  scaleTime(factor) {
    if (factor === 1) return this;
    const times = this.times;
    for (let i = 0, n = this.frameCount; i < n; i++) times[i] *= factor;
    if (this.mode === InterpolationMode.CUBICSPLINE) {
      const values = this.values;
      const vs = this.valueSize;
      const stride = this.stride;
      const inv = factor !== 0 ? 1 / factor : 0;
      for (let i = 0, n = this.frameCount; i < n; i++) {
        const base = i * stride;
        for (let k = 0; k < vs; k++) {
          values[base + k] *= inv;
          values[base + vs + vs + k] *= inv;
        }
      }
    }
    this._cachedIndex = 0;
    return this;
  }

  /**
   * Validates the internal invariants (strictly increasing times, finite
   * values, consistent buffer sizes).
   * @returns {string|null} Error description, or null when the track is valid.
   */
  validate() {
    if (this.valueSize <= 0) return 'valueSize must be > 0';
    if (this.frameCount === 0) return 'track has no keyframes';
    if (this.values.length < this.frameCount * this.stride) return 'values buffer is too small';
    const times = this.times;
    for (let i = 0, n = this.frameCount; i < n; i++) {
      const t = times[i];
      if (!Number.isFinite(t)) return 'non finite time at keyframe ' + i;
      if (i > 0 && t < times[i - 1]) return 'times are not sorted at keyframe ' + i;
    }
    const values = this.values;
    for (let i = 0, n = this.frameCount * this.stride; i < n; i++) {
      if (!Number.isFinite(values[i])) return 'non finite value at component ' + i;
    }
    return null;
  }

  /**
   * Deep copy (buffers included).
   * @returns {KeyframeTrack}
   */
  clone() {
    const track = new KeyframeTrack(
      this.targetPath,
      new Float32Array(this.times.subarray(0, this.frameCount)),
      new Float32Array(this.values.subarray(0, this.frameCount * this.stride)),
      this.valueSize,
      this.mode
    );
    track.isQuaternion = this.isQuaternion;
    return track;
  }
}
