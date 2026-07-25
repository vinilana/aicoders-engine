/**
 * TypedArrayUtils - allocation-conscious helpers for bulk numeric data.
 *
 * Every function in this module is designed to be usable on the hot path:
 * scratch buffers live at module scope and are reused across calls, and no
 * intermediate objects (views, closures, boxed numbers) are created per call.
 *
 * @module util/TypedArrayUtils
 */

/** Scratch used for float32 <-> uint32 bit reinterpretation (half float packing). */
const _f32 = new Float32Array(1);
/** Uint32 view aliasing {@link _f32}. */
const _u32 = new Uint32Array(_f32.buffer);

/** Four 256-entry histograms (one per radix pass), reused by radixSortUint32. */
const _histogram = new Uint32Array(1024);

/** Reusable scratch permutation buffer, grown on demand. */
let _scratchIndices = new Uint32Array(0);
/** Reusable scratch key buffer, grown on demand. */
let _scratchKeys = new Uint32Array(0);
/** Reusable scratch value buffer, grown on demand. */
let _scratchValues = new Uint32Array(0);

/** 2^-24, the value of the smallest positive half-float subnormal. */
const HALF_SUBNORMAL_SCALE = 5.960464477539063e-8;

/**
 * Returns a typed array of the same kind as `arr` with at least `newLength`
 * elements, copying the existing contents. If the array is already large
 * enough the very same instance is returned (no copy, no allocation).
 *
 * @param {TypedArray} arr Source array.
 * @param {number} newLength Desired element count.
 * @returns {TypedArray} `arr` or a larger copy.
 */
export function growTypedArray(arr, newLength) {
  if (arr === null || arr === undefined) {
    throw new Error('growTypedArray: array de origem invalido.');
  }
  const len = arr.length;
  if (newLength <= len) return arr;
  const out = new arr.constructor(newLength);
  out.set(arr);
  return out;
}

/**
 * Geometric growth helper: returns an array able to hold `required` elements,
 * doubling the current capacity to amortize repeated growth.
 *
 * @param {TypedArray|null} arr Existing array (may be null).
 * @param {number} required Required element count.
 * @param {Function} [Ctor] Constructor used when `arr` is null.
 * @returns {TypedArray} An array with `length >= required`.
 */
export function ensureCapacity(arr, required, Ctor) {
  if (arr === null || arr === undefined) {
    const C = Ctor || Float32Array;
    return new C(required > 0 ? required : 1);
  }
  const len = arr.length;
  if (len >= required) return arr;
  let next = len > 0 ? len : 1;
  while (next < required) next *= 2;
  const out = new arr.constructor(next);
  out.set(arr);
  return out;
}

/**
 * Concatenates a list of typed arrays into a single new array.
 *
 * @param {TypedArray[]} list Arrays to join (may be empty).
 * @param {Function} [Ctor] Constructor for the result; defaults to the
 *   constructor of the first entry.
 * @returns {TypedArray|null} The joined array, or null when nothing to join.
 */
export function concatTypedArrays(list, Ctor) {
  const n = list ? list.length : 0;
  if (n === 0) return Ctor ? new Ctor(0) : null;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    if (a !== null && a !== undefined) total += a.length;
  }
  const C = Ctor || list[0].constructor;
  const out = new C(total);
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    if (a === null || a === undefined || a.length === 0) continue;
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * Copies `count` elements from `src[srcOffset]` into `dst[dstOffset]` without
 * creating subarray views.
 *
 * @param {TypedArray} src Source array.
 * @param {number} srcOffset Source element offset.
 * @param {TypedArray} dst Destination array.
 * @param {number} dstOffset Destination element offset.
 * @param {number} count Element count.
 */
export function copyRange(src, srcOffset, dst, dstOffset, count) {
  for (let i = 0; i < count; i++) dst[dstOffset + i] = src[srcOffset + i];
}

/**
 * Fills a range of a typed array with a constant value (no view allocation).
 *
 * @param {TypedArray} arr Target array.
 * @param {number} value Value to write.
 * @param {number} [start=0] First index.
 * @param {number} [end=arr.length] End index (exclusive).
 */
export function fillRange(arr, value, start, end) {
  const s = start === undefined ? 0 : start;
  const e = end === undefined ? arr.length : end;
  for (let i = s; i < e; i++) arr[i] = value;
}

/* ------------------------------------------------------------------------ */
/* Fixed point packing                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Packs a normalized float in [0,1] into an unsigned 8 bit integer.
 *
 * @param {number} value Value in [0,1] (clamped).
 * @returns {number} Integer in [0,255].
 */
export function packUnorm8(value) {
  const v = value < 0 ? 0 : (value > 1 ? 1 : value);
  return (v * 255 + 0.5) | 0;
}

/**
 * Unpacks an unsigned 8 bit integer back into a normalized float.
 *
 * @param {number} value Integer in [0,255].
 * @returns {number} Float in [0,1].
 */
export function unpackUnorm8(value) {
  return (value & 0xff) * 0.00392156862745098;
}

/**
 * Packs a normalized float in [-1,1] into a signed 8 bit integer stored in the
 * low byte of the result.
 *
 * @param {number} value Value in [-1,1] (clamped).
 * @returns {number} Integer in [0,255] representing an int8 two's complement.
 */
export function packSnorm8(value) {
  const v = value < -1 ? -1 : (value > 1 ? 1 : value);
  return Math.round(v * 127) & 0xff;
}

/**
 * Unpacks a signed 8 bit integer into a normalized float in [-1,1].
 *
 * @param {number} value Integer in [0,255] (int8 two's complement).
 * @returns {number} Float in [-1,1].
 */
export function unpackSnorm8(value) {
  const i = (value & 0xff) << 24 >> 24;
  const f = i * 0.007874015748031496;
  return f < -1 ? -1 : f;
}

/**
 * Packs a normalized float in [0,1] into an unsigned 16 bit integer.
 *
 * @param {number} value Value in [0,1] (clamped).
 * @returns {number} Integer in [0,65535].
 */
export function packUnorm16(value) {
  const v = value < 0 ? 0 : (value > 1 ? 1 : value);
  return (v * 65535 + 0.5) | 0;
}

/**
 * Unpacks an unsigned 16 bit integer into a normalized float in [0,1].
 *
 * @param {number} value Integer in [0,65535].
 * @returns {number} Float in [0,1].
 */
export function unpackUnorm16(value) {
  return (value & 0xffff) * 1.5259021896696422e-5;
}

/**
 * Packs a normalized float in [-1,1] into a signed 16 bit integer stored in
 * the low 16 bits of the result.
 *
 * @param {number} value Value in [-1,1] (clamped).
 * @returns {number} Integer in [0,65535] representing an int16 two's complement.
 */
export function packSnorm16(value) {
  const v = value < -1 ? -1 : (value > 1 ? 1 : value);
  return Math.round(v * 32767) & 0xffff;
}

/**
 * Unpacks a signed 16 bit integer into a normalized float in [-1,1].
 *
 * @param {number} value Integer in [0,65535] (int16 two's complement).
 * @returns {number} Float in [-1,1].
 */
export function unpackSnorm16(value) {
  const i = (value & 0xffff) << 16 >> 16;
  const f = i * 3.0518509475997192e-5;
  return f < -1 ? -1 : f;
}

/* ------------------------------------------------------------------------ */
/* Half float (IEEE 754 binary16)                                            */
/* ------------------------------------------------------------------------ */

/**
 * Converts a 32 bit float into an IEEE 754 binary16 bit pattern.
 * Handles subnormals, infinities and NaN, and rounds to nearest even.
 *
 * @param {number} value Float value.
 * @returns {number} Unsigned 16 bit integer with the half float bits.
 */
export function packHalfFloat(value) {
  _f32[0] = value;
  const bits = _u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    // Infinity or NaN: keep NaN payload non-zero so it stays a NaN.
    return (sign | 0x7c00 | (mantissa !== 0 ? 0x0200 : 0)) & 0xffff;
  }

  const e = exponent - 127 + 15;

  if (e >= 0x1f) return (sign | 0x7c00) & 0xffff; // overflow -> infinity
  if (e <= 0) {
    if (e < -10) return sign & 0xffff; // underflow -> signed zero
    // Subnormal: restore the implicit leading bit then round to nearest.
    const m = mantissa | 0x800000;
    const shift = 14 - e;
    const half = (m + (1 << (shift - 1))) >>> shift;
    return (sign | half) & 0xffff;
  }

  let half = (e << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) half++;
  return (sign | half) & 0xffff;
}

/**
 * Converts an IEEE 754 binary16 bit pattern back into a JavaScript number.
 *
 * @param {number} half Unsigned 16 bit integer.
 * @returns {number} The decoded float value.
 */
export function unpackHalfFloat(half) {
  const h = half & 0xffff;
  const sign = (h & 0x8000) << 16;
  const exponent = (h >>> 10) & 0x1f;
  const mantissa = h & 0x03ff;

  if (exponent === 0) {
    if (mantissa === 0) {
      _u32[0] = sign;
      return _f32[0];
    }
    // Normalize the subnormal into a float32 normal.
    let m = mantissa;
    let shift = -1;
    do {
      m <<= 1;
      shift++;
    } while ((m & 0x400) === 0);
    _u32[0] = sign | ((127 - 15 - shift) << 23) | ((m & 0x3ff) << 13);
    return _f32[0];
  }

  if (exponent === 0x1f) {
    _u32[0] = sign | 0x7f800000 | (mantissa << 13);
    return _f32[0];
  }

  _u32[0] = sign | ((exponent + 112) << 23) | (mantissa << 13);
  return _f32[0];
}

/**
 * Fills a Uint16Array with the half float encoding of a Float32Array.
 *
 * @param {Float32Array|number[]} src Source values.
 * @param {Uint16Array} dst Destination (must hold `count` entries).
 * @param {number} [count=src.length] Number of values to convert.
 * @returns {Uint16Array} `dst`.
 */
export function packHalfFloatArray(src, dst, count) {
  const n = count === undefined ? src.length : count;
  for (let i = 0; i < n; i++) dst[i] = packHalfFloat(src[i]);
  return dst;
}

/**
 * Fills a Float32Array from a Uint16Array of half floats.
 *
 * @param {Uint16Array} src Source half floats.
 * @param {Float32Array} dst Destination.
 * @param {number} [count=src.length] Number of values to convert.
 * @returns {Float32Array} `dst`.
 */
export function unpackHalfFloatArray(src, dst, count) {
  const n = count === undefined ? src.length : count;
  for (let i = 0; i < n; i++) dst[i] = unpackHalfFloat(src[i]);
  return dst;
}

/* ------------------------------------------------------------------------ */
/* Sorting                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Stable LSD radix sort of a permutation array by 32 bit unsigned keys.
 *
 * Contract of the arguments (important - the render list relies on it):
 *  - `keys[e]` is the sort key of element `e`.
 *  - `indices` holds the element ids to sort (usually initialised to 0..n-1).
 *  - After the call, `indices` is reordered so that
 *    `keys[indices[0]] <= keys[indices[1]] <= ...`, with ties keeping their
 *    previous relative order. `keys` is never modified.
 *
 * Four 8 bit passes, histograms computed in a single sweep, passes whose byte
 * is constant are skipped. All work buffers are reused; the function performs
 * zero allocations after warm up.
 *
 * @param {Uint32Array} keys Keys indexed by element id.
 * @param {Uint32Array} indices Permutation to sort (modified in place).
 * @param {Uint32Array} [tmp] Scratch of at least `count` entries. When omitted
 *   (or too small) an internal reusable buffer is used.
 * @param {number} [count=indices.length] Number of entries to sort.
 * @returns {Uint32Array} `indices`.
 */
export function radixSortUint32(keys, indices, tmp, count) {
  const n = count === undefined ? indices.length : count;
  if (n < 2) return indices;

  let scratch = tmp;
  if (scratch === undefined || scratch === null || scratch.length < n) {
    if (_scratchIndices.length < n) _scratchIndices = new Uint32Array(n);
    scratch = _scratchIndices;
  }

  const hist = _histogram;
  for (let i = 0; i < 1024; i++) hist[i] = 0;

  for (let i = 0; i < n; i++) {
    const k = keys[indices[i]] >>> 0;
    hist[k & 0xff]++;
    hist[256 + ((k >>> 8) & 0xff)]++;
    hist[512 + ((k >>> 16) & 0xff)]++;
    hist[768 + ((k >>> 24) & 0xff)]++;
  }

  let src = indices;
  let dst = scratch;

  for (let pass = 0; pass < 4; pass++) {
    const shift = pass << 3;
    const base = pass << 8;

    // Skip the pass entirely when every key shares the same byte.
    const firstByte = (keys[src[0]] >>> shift) & 0xff;
    if (hist[base + firstByte] === n) continue;

    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = hist[base + b];
      hist[base + b] = sum;
      sum += c;
    }

    for (let i = 0; i < n; i++) {
      const id = src[i];
      const bucket = base + ((keys[id] >>> shift) & 0xff);
      dst[hist[bucket]++] = id;
    }

    const swap = src;
    src = dst;
    dst = swap;
  }

  if (src !== indices) {
    for (let i = 0; i < n; i++) indices[i] = src[i];
  }
  return indices;
}

/**
 * Stable LSD radix sort of parallel key/value arrays. Both arrays are permuted
 * together, so after the call `keys` is sorted ascending and `values[i]` still
 * belongs to `keys[i]`.
 *
 * Useful when the caller stores the payload (object index, draw id, ...) in a
 * second array instead of using an indirection table.
 *
 * @param {Uint32Array} keys Keys, sorted in place.
 * @param {Uint32Array} values Payload, permuted alongside the keys.
 * @param {number} [count=keys.length] Number of entries to sort.
 * @returns {Uint32Array} `keys`.
 */
export function radixSortUint32Pairs(keys, values, count) {
  const n = count === undefined ? keys.length : count;
  if (n < 2) return keys;

  if (_scratchKeys.length < n) _scratchKeys = new Uint32Array(n);
  if (_scratchValues.length < n) _scratchValues = new Uint32Array(n);

  const hist = _histogram;
  for (let i = 0; i < 1024; i++) hist[i] = 0;

  for (let i = 0; i < n; i++) {
    const k = keys[i] >>> 0;
    hist[k & 0xff]++;
    hist[256 + ((k >>> 8) & 0xff)]++;
    hist[512 + ((k >>> 16) & 0xff)]++;
    hist[768 + ((k >>> 24) & 0xff)]++;
  }

  let srcK = keys;
  let srcV = values;
  let dstK = _scratchKeys;
  let dstV = _scratchValues;

  for (let pass = 0; pass < 4; pass++) {
    const shift = pass << 3;
    const base = pass << 8;

    const firstByte = (srcK[0] >>> shift) & 0xff;
    if (hist[base + firstByte] === n) continue;

    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = hist[base + b];
      hist[base + b] = sum;
      sum += c;
    }

    for (let i = 0; i < n; i++) {
      const k = srcK[i];
      const slot = hist[base + ((k >>> shift) & 0xff)]++;
      dstK[slot] = k;
      dstV[slot] = srcV[i];
    }

    let swap = srcK; srcK = dstK; dstK = swap;
    swap = srcV; srcV = dstV; dstV = swap;
  }

  if (srcK !== keys) {
    for (let i = 0; i < n; i++) {
      keys[i] = srcK[i];
      values[i] = srcV[i];
    }
  }
  return keys;
}

/**
 * In-place, allocation free, stable insertion sort driven by a comparator.
 * Elements are shifted with a compare-and-swap style inner loop, which makes
 * it the fastest option for small or already nearly sorted ranges - exactly
 * the shape of a per frame transparent render list.
 *
 * @param {Array|TypedArray} array Array to sort.
 * @param {Function} compare `compare(a, b)` returning < 0, 0 or > 0.
 * @param {number} [start=0] First index of the range.
 * @param {number} [end=array.length] End index of the range (exclusive).
 * @returns {Array|TypedArray} `array`.
 */
export function compareAndSwapSort(array, compare, start, end) {
  const s = start === undefined ? 0 : start;
  const e = end === undefined ? array.length : end;
  for (let i = s + 1; i < e; i++) {
    const item = array[i];
    let j = i - 1;
    while (j >= s && compare(array[j], item) > 0) {
      array[j + 1] = array[j];
      j--;
    }
    array[j + 1] = item;
  }
  return array;
}

/**
 * Same as {@link compareAndSwapSort} but ordering a permutation array by the
 * floating point keys stored in a parallel array. Stable and allocation free.
 *
 * @param {Uint32Array|Array} indices Permutation to sort.
 * @param {Float32Array|Float64Array} keys Keys indexed by element id.
 * @param {number} [count=indices.length] Entries to sort.
 * @param {boolean} [descending=false] Sort from largest to smallest key.
 * @returns {Uint32Array|Array} `indices`.
 */
export function insertionSortByKey(indices, keys, count, descending) {
  const n = count === undefined ? indices.length : count;
  const dir = descending === true ? -1 : 1;
  for (let i = 1; i < n; i++) {
    const id = indices[i];
    const key = keys[id] * dir;
    let j = i - 1;
    while (j >= 0 && keys[indices[j]] * dir > key) {
      indices[j + 1] = indices[j];
      j--;
    }
    indices[j + 1] = id;
  }
  return indices;
}

/**
 * Number of bytes occupied by a typed array (0 for null/undefined).
 *
 * @param {TypedArray|null} arr Array to measure.
 * @returns {number} Byte length.
 */
export function byteLengthOf(arr) {
  return arr !== null && arr !== undefined && arr.byteLength !== undefined ? arr.byteLength : 0;
}
