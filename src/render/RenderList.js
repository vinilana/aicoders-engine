/**
 * RenderList - the per frame draw call queue.
 *
 * Every entry is a POOLED `RenderItem`: the pool grows to the high water mark of
 * the scene and is then reused forever, so a steady state frame allocates
 * nothing at all. The same is true of the sorting scratch buffers.
 *
 * Sorting
 *  - Opaque: a uint32 state key `(programId << 20) | (materialId << 8) | geometryId`
 *    groups draws that share a program, then a material, then a geometry, which is
 *    exactly the order in which state changes get more expensive. Ties are broken
 *    front to back by a quantised depth key. Both passes use the stable radix sort
 *    from `util/TypedArrayUtils.js`: sorting by depth FIRST and by the state key
 *    SECOND leaves the depth order intact inside every equal state bucket, which
 *    is the cheapest way to get a composite ordering out of 32 bit keys.
 *  - Transparent: strict back to front by distance to the camera plane, using a
 *    Float64Array of depths and an index permutation (an introsort for large
 *    lists, an insertion sort for the small ones a real frame usually has).
 *
 * The depth quantisation reinterprets the float32 bit pattern as a uint32. For
 * non negative floats that mapping is strictly monotonic, so the radix sort over
 * the bit patterns produces the exact same order as sorting the floats - with no
 * precision loss and no division.
 */

import { radixSortUint32, insertionSortByKey } from '../util/TypedArrayUtils.js';

/** Reinterpretation buffer used to quantise a float32 depth into a uint32 key. */
const _floatBits = new Float32Array(1);
const _uintBits = new Uint32Array(_floatBits.buffer);

/** Explicit stack for the introsort, sized for any realistic list. */
const _sortStack = new Int32Array(128);

/**
 * Quantises a depth into a monotonically increasing uint32 sort key.
 * @param {number} depth View space depth (negative values clamp to 0).
 * @returns {number} uint32 key, ascending = front to back
 */
function depthToKey(depth) {
  _floatBits[0] = depth > 0 ? depth : 0;
  return _uintBits[0] >>> 0;
}

/**
 * Descending (back to front) introsort of an index permutation driven by a
 * parallel Float64Array of keys. Allocation free and closure free.
 *
 * @param {Uint32Array} indices Permutation to sort in place.
 * @param {Float64Array} keys Keys indexed by element id.
 * @param {number} count Entries to sort.
 */
function sortIndicesDescending(indices, keys, count) {
  if (count < 2) return;
  if (count <= 24) {
    insertionSortByKey(indices, keys, count, true);
    return;
  }

  let sp = 0;
  _sortStack[sp++] = 0;
  _sortStack[sp++] = count - 1;

  while (sp > 0) {
    const hi = _sortStack[--sp];
    const lo = _sortStack[--sp];
    if (hi - lo < 16) {
      // Insertion sort of the [lo, hi] slice.
      for (let i = lo + 1; i <= hi; i++) {
        const id = indices[i];
        const key = keys[id];
        let j = i - 1;
        while (j >= lo && keys[indices[j]] < key) {
          indices[j + 1] = indices[j];
          j--;
        }
        indices[j + 1] = id;
      }
      continue;
    }

    // Median of three pivot, moved to hi - 1.
    const mid = (lo + ((hi - lo) >> 1)) | 0;
    if (keys[indices[mid]] > keys[indices[lo]]) {
      const t = indices[lo]; indices[lo] = indices[mid]; indices[mid] = t;
    }
    if (keys[indices[hi]] > keys[indices[lo]]) {
      const t = indices[lo]; indices[lo] = indices[hi]; indices[hi] = t;
    }
    if (keys[indices[hi]] > keys[indices[mid]]) {
      const t = indices[mid]; indices[mid] = indices[hi]; indices[hi] = t;
    }
    const pivot = keys[indices[mid]];

    let i = lo;
    let j = hi;
    while (i <= j) {
      while (keys[indices[i]] > pivot) i++;
      while (keys[indices[j]] < pivot) j--;
      if (i <= j) {
        const t = indices[i]; indices[i] = indices[j]; indices[j] = t;
        i++;
        j--;
      }
    }

    // Push the larger half first so the stack depth stays O(log n).
    if (j - lo > hi - i) {
      if (lo < j && sp + 4 <= _sortStack.length) { _sortStack[sp++] = lo; _sortStack[sp++] = j; }
      if (i < hi && sp + 2 <= _sortStack.length) { _sortStack[sp++] = i; _sortStack[sp++] = hi; }
    } else {
      if (i < hi && sp + 4 <= _sortStack.length) { _sortStack[sp++] = i; _sortStack[sp++] = hi; }
      if (lo < j && sp + 2 <= _sortStack.length) { _sortStack[sp++] = lo; _sortStack[sp++] = j; }
    }
  }
}

/**
 * One submitted draw call. Instances are pooled and reused across frames, so the
 * shape must stay monomorphic: never add fields to an individual item.
 */
export class RenderItem {
  constructor() {
    /** @type {Object|null} Node3D that owns the draw. */
    this.mesh = null;
    /** @type {Object|null} Geometry to bind. */
    this.geometry = null;
    /** @type {Object|null} Material to apply. */
    this.material = null;
    /** @type {Object|null} `{start, count, materialIndex}` or null for the whole geometry. */
    this.group = null;
    /** @type {number} Index of `group` inside `geometry.groups`, -1 when unused. */
    this.groupIndex = -1;
    /** @type {number} Distance to the camera plane, in world units. */
    this.depth = 0;
    /** @type {number} uint32 state sort key. */
    this.sortKey = 0;
    /** @type {Object|null} Program resolved while the list was built. */
    this.program = null;
  }

  /** Drops every reference so a disposed scene is not kept alive by the pool. */
  clear() {
    this.mesh = null;
    this.geometry = null;
    this.material = null;
    this.group = null;
    this.groupIndex = -1;
    this.depth = 0;
    this.sortKey = 0;
    this.program = null;
  }
}

/**
 * Computes the opaque state sort key.
 * Layout: `(programId & 0xfff) << 20 | (materialId & 0xfff) << 8 | (geometryId & 0xff)`.
 *
 * @param {number} programId
 * @param {number} materialId
 * @param {number} geometryId
 * @returns {number} uint32
 */
export function makeSortKey(programId, materialId, geometryId) {
  return ((((programId & 0xfff) << 20) | ((materialId & 0xfff) << 8) | (geometryId & 0xff)) >>> 0);
}

export class RenderList {
  constructor() {
    /** @type {RenderItem[]} Opaque draws, sorted by state then front to back. */
    this.opaque = [];
    /** @type {RenderItem[]} Blended draws, sorted strictly back to front. */
    this.transparent = [];
    /** @type {RenderItem[]} Everything that writes into a shadow map. */
    this.shadowCasters = [];

    /** @private @type {RenderItem[]} */
    this._pool = [];
    /** @private @type {number} */
    this._poolUsed = 0;

    /** @private @type {Uint32Array} state key per element id */
    this._stateKeys = new Uint32Array(256);
    /** @private @type {Uint32Array} quantised depth per element id */
    this._depthKeys = new Uint32Array(256);
    /** @private @type {Uint32Array} permutation being sorted */
    this._indices = new Uint32Array(256);
    /** @private @type {Uint32Array} radix scratch */
    this._tmp = new Uint32Array(256);
    /** @private @type {Float64Array} exact depth per element id */
    this._depths = new Float64Array(256);
    /** @private @type {RenderItem[]} destination of a permutation apply */
    this._reordered = [];

    /** Per frame counters, useful for the renderer statistics block. */
    this.stats = { opaque: 0, transparent: 0, shadowCasters: 0, pooled: 0 };
  }

  /** @type {number} Total draws queued this frame. */
  get count() {
    return this.opaque.length + this.transparent.length;
  }

  /** @type {number} Items currently held by the pool. */
  get poolSize() {
    return this._pool.length;
  }

  /**
   * Grows the sorting scratch buffers. Only ever runs when a frame is bigger than
   * every previous frame, so it is not part of the steady state cost.
   * @param {number} n
   * @private
   */
  _ensureCapacity(n) {
    if (this._stateKeys.length >= n) return;
    let size = this._stateKeys.length;
    while (size < n) size *= 2;
    this._stateKeys = new Uint32Array(size);
    this._depthKeys = new Uint32Array(size);
    this._indices = new Uint32Array(size);
    this._tmp = new Uint32Array(size);
    this._depths = new Float64Array(size);
  }

  /**
   * Takes an item from the pool, growing it when the frame is bigger than any
   * frame before it.
   * @returns {RenderItem}
   * @private
   */
  _acquire() {
    const pool = this._pool;
    if (this._poolUsed < pool.length) return pool[this._poolUsed++];
    const item = new RenderItem();
    pool.push(item);
    this._poolUsed++;
    return item;
  }

  /**
   * Empties the three lists and returns every item to the pool.
   * @returns {RenderList} this
   */
  reset() {
    const pool = this._pool;
    for (let i = 0, n = this._poolUsed; i < n; i++) pool[i].clear();
    this._poolUsed = 0;
    this.opaque.length = 0;
    this.transparent.length = 0;
    this.shadowCasters.length = 0;
    this.stats.opaque = 0;
    this.stats.transparent = 0;
    this.stats.shadowCasters = 0;
    this.stats.pooled = pool.length;
    return this;
  }

  /**
   * Queues one draw call.
   *
   * The item lands in `transparent` when the material blends, in `opaque`
   * otherwise, and additionally in `shadowCasters` when both the node and the
   * material agree to cast shadows.
   *
   * @param {Object} mesh Node3D being drawn.
   * @param {Object} geometry Geometry to bind.
   * @param {Object} material Material to apply.
   * @param {number} [groupIndex=-1] Index into `geometry.groups`, -1 for the whole geometry.
   * @param {number} [depth=0] Distance to the camera plane.
   * @param {Object|null} [program=null] Program already resolved by the renderer.
   * @returns {RenderItem} the queued item
   */
  push(mesh, geometry, material, groupIndex = -1, depth = 0, program = null) {
    const item = this._acquire();
    item.mesh = mesh;
    item.geometry = geometry;
    item.material = material;
    item.groupIndex = groupIndex;
    item.group = (groupIndex >= 0 && geometry.groups && groupIndex < geometry.groups.length)
      ? geometry.groups[groupIndex]
      : null;
    item.depth = depth;
    item.program = program;

    const resolved = program || material.program || null;
    item.sortKey = makeSortKey(
      resolved !== null && typeof resolved.id === 'number' ? resolved.id : (material.sortKey >>> 8),
      material.id,
      geometry.id
    );

    const blended = material.transparent === true || material.alphaMode === 'blend';
    if (blended) {
      this.transparent.push(item);
      this.stats.transparent++;
    } else {
      this.opaque.push(item);
      this.stats.opaque++;
    }

    if (mesh.castShadow === true && material.castShadow !== false) {
      this.shadowCasters.push(item);
      this.stats.shadowCasters++;
    }

    return item;
  }

  /**
   * Applies a permutation to one of the lists without allocating.
   * @param {RenderItem[]} list
   * @param {Uint32Array} indices
   * @param {number} n
   * @private
   */
  _applyPermutation(list, indices, n) {
    const dst = this._reordered;
    for (let i = 0; i < n; i++) dst[i] = list[indices[i]];
    for (let i = 0; i < n; i++) list[i] = dst[i];
    // Keep the scratch from retaining the items until the next sort.
    for (let i = 0; i < n; i++) dst[i] = null;
  }

  /**
   * Sorts the opaque list: by program, then material, then geometry, breaking
   * ties front to back.
   * @returns {RenderList} this
   */
  sortOpaque() {
    const list = this.opaque;
    const n = list.length;
    if (n < 2) return this;
    this._ensureCapacity(n);

    const stateKeys = this._stateKeys;
    const depthKeys = this._depthKeys;
    const indices = this._indices;
    for (let i = 0; i < n; i++) {
      const item = list[i];
      stateKeys[i] = item.sortKey;
      depthKeys[i] = depthToKey(item.depth);
      indices[i] = i;
    }

    // Stable radix twice: the depth pass sets the tie break order, the state pass
    // groups by program/material/geometry while preserving it.
    radixSortUint32(depthKeys, indices, this._tmp, n);
    radixSortUint32(stateKeys, indices, this._tmp, n);

    this._applyPermutation(list, indices, n);
    return this;
  }

  /**
   * Sorts the transparent list strictly back to front.
   * @returns {RenderList} this
   */
  sortTransparent() {
    const list = this.transparent;
    const n = list.length;
    if (n < 2) return this;
    this._ensureCapacity(n);

    const depths = this._depths;
    const indices = this._indices;
    for (let i = 0; i < n; i++) {
      depths[i] = list[i].depth;
      indices[i] = i;
    }

    sortIndicesDescending(indices, depths, n);
    this._applyPermutation(list, indices, n);
    return this;
  }

  /**
   * Sorts the shadow caster list by state only (depth is irrelevant for a pure
   * depth pass, but batching by program and geometry still pays off).
   * @returns {RenderList} this
   */
  sortShadowCasters() {
    const list = this.shadowCasters;
    const n = list.length;
    if (n < 2) return this;
    this._ensureCapacity(n);

    const stateKeys = this._stateKeys;
    const indices = this._indices;
    for (let i = 0; i < n; i++) {
      stateKeys[i] = list[i].sortKey;
      indices[i] = i;
    }
    radixSortUint32(stateKeys, indices, this._tmp, n);
    this._applyPermutation(list, indices, n);
    return this;
  }

  /**
   * Drops the pooled items. Only needed when the renderer is disposed.
   * @returns {RenderList} this
   */
  dispose() {
    this.reset();
    this._pool.length = 0;
    this._reordered.length = 0;
    this.stats.pooled = 0;
    return this;
  }
}
