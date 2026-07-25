/**
 * Returns a typed array of the same kind as `arr` with at least `newLength`
 * elements, copying the existing contents. If the array is already large
 * enough the very same instance is returned (no copy, no allocation).
 *
 * @param {TypedArray} arr Source array.
 * @param {number} newLength Desired element count.
 * @returns {TypedArray} `arr` or a larger copy.
 */
export function growTypedArray(arr: TypedArray, newLength: number): TypedArray;
/**
 * Geometric growth helper: returns an array able to hold `required` elements,
 * doubling the current capacity to amortize repeated growth.
 *
 * @param {TypedArray|null} arr Existing array (may be null).
 * @param {number} required Required element count.
 * @param {Function} [Ctor] Constructor used when `arr` is null.
 * @returns {TypedArray} An array with `length >= required`.
 */
export function ensureCapacity(arr: TypedArray | null, required: number, Ctor?: Function): TypedArray;
/**
 * Concatenates a list of typed arrays into a single new array.
 *
 * @param {TypedArray[]} list Arrays to join (may be empty).
 * @param {Function} [Ctor] Constructor for the result; defaults to the
 *   constructor of the first entry.
 * @returns {TypedArray|null} The joined array, or null when nothing to join.
 */
export function concatTypedArrays(list: TypedArray[], Ctor?: Function): TypedArray | null;
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
export function copyRange(src: TypedArray, srcOffset: number, dst: TypedArray, dstOffset: number, count: number): void;
/**
 * Fills a range of a typed array with a constant value (no view allocation).
 *
 * @param {TypedArray} arr Target array.
 * @param {number} value Value to write.
 * @param {number} [start=0] First index.
 * @param {number} [end=arr.length] End index (exclusive).
 */
export function fillRange(arr: TypedArray, value: number, start?: number, end?: number): void;
/**
 * Packs a normalized float in [0,1] into an unsigned 8 bit integer.
 *
 * @param {number} value Value in [0,1] (clamped).
 * @returns {number} Integer in [0,255].
 */
export function packUnorm8(value: number): number;
/**
 * Unpacks an unsigned 8 bit integer back into a normalized float.
 *
 * @param {number} value Integer in [0,255].
 * @returns {number} Float in [0,1].
 */
export function unpackUnorm8(value: number): number;
/**
 * Packs a normalized float in [-1,1] into a signed 8 bit integer stored in the
 * low byte of the result.
 *
 * @param {number} value Value in [-1,1] (clamped).
 * @returns {number} Integer in [0,255] representing an int8 two's complement.
 */
export function packSnorm8(value: number): number;
/**
 * Unpacks a signed 8 bit integer into a normalized float in [-1,1].
 *
 * @param {number} value Integer in [0,255] (int8 two's complement).
 * @returns {number} Float in [-1,1].
 */
export function unpackSnorm8(value: number): number;
/**
 * Packs a normalized float in [0,1] into an unsigned 16 bit integer.
 *
 * @param {number} value Value in [0,1] (clamped).
 * @returns {number} Integer in [0,65535].
 */
export function packUnorm16(value: number): number;
/**
 * Unpacks an unsigned 16 bit integer into a normalized float in [0,1].
 *
 * @param {number} value Integer in [0,65535].
 * @returns {number} Float in [0,1].
 */
export function unpackUnorm16(value: number): number;
/**
 * Packs a normalized float in [-1,1] into a signed 16 bit integer stored in
 * the low 16 bits of the result.
 *
 * @param {number} value Value in [-1,1] (clamped).
 * @returns {number} Integer in [0,65535] representing an int16 two's complement.
 */
export function packSnorm16(value: number): number;
/**
 * Unpacks a signed 16 bit integer into a normalized float in [-1,1].
 *
 * @param {number} value Integer in [0,65535] (int16 two's complement).
 * @returns {number} Float in [-1,1].
 */
export function unpackSnorm16(value: number): number;
/**
 * Converts a 32 bit float into an IEEE 754 binary16 bit pattern.
 * Handles subnormals, infinities and NaN, and rounds to nearest even.
 *
 * @param {number} value Float value.
 * @returns {number} Unsigned 16 bit integer with the half float bits.
 */
export function packHalfFloat(value: number): number;
/**
 * Converts an IEEE 754 binary16 bit pattern back into a JavaScript number.
 *
 * @param {number} half Unsigned 16 bit integer.
 * @returns {number} The decoded float value.
 */
export function unpackHalfFloat(half: number): number;
/**
 * Fills a Uint16Array with the half float encoding of a Float32Array.
 *
 * @param {Float32Array|number[]} src Source values.
 * @param {Uint16Array} dst Destination (must hold `count` entries).
 * @param {number} [count=src.length] Number of values to convert.
 * @returns {Uint16Array} `dst`.
 */
export function packHalfFloatArray(src: Float32Array | number[], dst: Uint16Array, count?: number): Uint16Array;
/**
 * Fills a Float32Array from a Uint16Array of half floats.
 *
 * @param {Uint16Array} src Source half floats.
 * @param {Float32Array} dst Destination.
 * @param {number} [count=src.length] Number of values to convert.
 * @returns {Float32Array} `dst`.
 */
export function unpackHalfFloatArray(src: Uint16Array, dst: Float32Array, count?: number): Float32Array;
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
export function radixSortUint32(keys: Uint32Array, indices: Uint32Array, tmp?: Uint32Array, count?: number): Uint32Array;
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
export function radixSortUint32Pairs(keys: Uint32Array, values: Uint32Array, count?: number): Uint32Array;
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
export function compareAndSwapSort(array: any[] | TypedArray, compare: Function, start?: number, end?: number): any[] | TypedArray;
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
export function insertionSortByKey(indices: Uint32Array | any[], keys: Float32Array | Float64Array, count?: number, descending?: boolean): Uint32Array | any[];
/**
 * Number of bytes occupied by a typed array (0 for null/undefined).
 *
 * @param {TypedArray|null} arr Array to measure.
 * @returns {number} Byte length.
 */
export function byteLengthOf(arr: TypedArray | null): number;
