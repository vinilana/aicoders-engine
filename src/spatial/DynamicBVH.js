/**
 * @file DynamicBVH.js
 * Dynamic bounding volume hierarchy (AABB tree) in the spirit of Box2D's
 * `b2DynamicTree`, rewritten for 3D and for structure-of-arrays TypedArray storage.
 *
 * Design notes:
 * - Every node lives in six parallel arrays (bounds / tight bounds / parent /
 *   child1 / child2 / height) plus one plain array for user payloads. Freed nodes
 *   are recycled through a free list threaded into `_child1`, so a steady-state
 *   scene performs zero allocations.
 * - Leaves store a *fat* AABB (used for the hierarchy, so small movements never
 *   restructure the tree) and the *tight* AABB (used to make query results exact).
 * - Insertion picks its sibling with the classic surface-area-heuristic descent and
 *   the tree is rebalanced with AVL-like rotations after every structural change.
 * - This module has no imports on purpose: it only ever reads `.min.x` style fields
 *   from the math objects it is handed, which keeps it usable from workers and tests.
 */

/** Sentinel for "no node". */
const NULL_NODE = -1;
/** Default fat-AABB margin, in world units. */
const DEFAULT_MARGIN = 0.1;
/** How far ahead of a moving proxy the fat AABB is extended. */
const DISPLACEMENT_MULTIPLIER = 2;
/** Bit mask with all six frustum plane bits set. */
const ALL_PLANES = 0x3f;
/** Symmetric neighbour window used by the bottom-up SAH rebuild. */
const REBUILD_WINDOW = 12;
/** Initial traversal stack depth (grows on demand). */
const INITIAL_STACK = 256;
/** Initial ray-heap capacity (grows on demand). */
const INITIAL_HEAP = 128;

/**
 * Spreads the low 10 bits of `v` so that two zero bits sit between each of them.
 * @param {number} v
 * @returns {number}
 */
function part1By2(v) {
  v = v & 0x3ff;
  v = (v ^ (v << 16)) & 0xff0000ff;
  v = (v ^ (v << 8)) & 0x0300f00f;
  v = (v ^ (v << 4)) & 0x030c30c3;
  v = (v ^ (v << 2)) & 0x09249249;
  return v >>> 0;
}

/**
 * Builds a 30 bit Morton code from three normalised coordinates in [0,1].
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {number}
 */
function morton3(x, y, z) {
  let ix = (x * 1024) | 0;
  let iy = (y * 1024) | 0;
  let iz = (z * 1024) | 0;
  if (ix < 0) ix = 0; else if (ix > 1023) ix = 1023;
  if (iy < 0) iy = 0; else if (iy > 1023) iy = 1023;
  if (iz < 0) iz = 0; else if (iz > 1023) iz = 1023;
  return ((part1By2(ix) << 2) | (part1By2(iy) << 1) | part1By2(iz)) >>> 0;
}

/**
 * Stable LSD radix sort of `values` by the 32 bit `keys`. Four byte-wide passes,
 * so the sorted data ends up back in the input arrays.
 * @param {Uint32Array} keys
 * @param {Int32Array} values
 * @param {Uint32Array} keysTmp
 * @param {Int32Array} valuesTmp
 * @param {number} count
 * @returns {void}
 */
function radixSortByKey(keys, values, keysTmp, valuesTmp, count) {
  const hist = new Uint32Array(1024);
  for (let i = 0; i < count; i++) {
    const k = keys[i];
    hist[k & 0xff]++;
    hist[256 + ((k >>> 8) & 0xff)]++;
    hist[512 + ((k >>> 16) & 0xff)]++;
    hist[768 + ((k >>> 24) & 0xff)]++;
  }
  let srcK = keys;
  let srcV = values;
  let dstK = keysTmp;
  let dstV = valuesTmp;
  for (let pass = 0; pass < 4; pass++) {
    const base = pass << 8;
    const shift = pass << 3;
    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = hist[base + b];
      hist[base + b] = sum;
      sum += c;
    }
    for (let i = 0; i < count; i++) {
      const k = srcK[i];
      const p = hist[base + ((k >>> shift) & 0xff)]++;
      dstK[p] = k;
      dstV[p] = srcV[i];
    }
    const tk = srcK; srcK = dstK; dstK = tk;
    const tv = srcV; srcV = dstV; dstV = tv;
  }
}

/**
 * Dynamic AABB tree used as the broadphase for rendering (frustum culling),
 * picking (raycasts) and physics (overlap queries).
 */
export class DynamicBVH {
  /**
   * @param {{margin?:number, capacity?:number, displacementMultiplier?:number}} [options]
   */
  constructor(options = {}) {
    /** @type {number} Fat AABB margin applied around every proxy. */
    this.margin = options.margin !== undefined ? options.margin : DEFAULT_MARGIN;
    /** @type {number} Motion prediction factor used by {@link DynamicBVH#update}. */
    this.displacementMultiplier = options.displacementMultiplier !== undefined
      ? options.displacementMultiplier
      : DISPLACEMENT_MULTIPLIER;

    const capacity = Math.max(8, options.capacity !== undefined ? (options.capacity | 0) : 64);

    /** @type {number} */
    this._capacity = capacity;
    /** @type {Float32Array} minX,minY,minZ,maxX,maxY,maxZ per node (fat bounds). */
    this._bounds = new Float32Array(capacity * 6);
    /** @type {Float32Array} Exact bounds, only meaningful for leaves. */
    this._tight = new Float32Array(capacity * 6);
    /** @type {Int32Array} */
    this._parent = new Int32Array(capacity);
    /** @type {Int32Array} Also doubles as the free-list "next" pointer. */
    this._child1 = new Int32Array(capacity);
    /** @type {Int32Array} */
    this._child2 = new Int32Array(capacity);
    /** @type {Int32Array} Node height; -1 marks a free slot. */
    this._height = new Int32Array(capacity);
    /** @type {Array<*>} */
    this._userData = new Array(capacity);

    this._root = NULL_NODE;
    this._nodeCount = 0;
    this._proxyCount = 0;
    this._freeList = 0;

    for (let i = 0; i < capacity; i++) {
      this._child1[i] = i + 1;
      this._height[i] = -1;
      this._userData[i] = null;
    }
    this._child1[capacity - 1] = NULL_NODE;

    /** @type {Int32Array} Traversal stack (node indices). */
    this._stack = new Int32Array(INITIAL_STACK);
    /** @type {Int32Array} Traversal stack (plane coherency masks). */
    this._maskStack = new Int32Array(INITIAL_STACK);
    /** @type {Float32Array} Flattened frustum planes: nx,ny,nz,constant. */
    this._planes = new Float32Array(24);
    /** @type {Float32Array} Ray traversal priority-queue keys. */
    this._heapKeys = new Float32Array(INITIAL_HEAP);
    /** @type {Int32Array} Ray traversal priority-queue values. */
    this._heapVals = new Int32Array(INITIAL_HEAP);
    this._heapSize = 0;
    this._heapPopKey = 0;
  }

  /** @returns {number} Number of live nodes (leaves + internal). */
  get nodeCount() {
    return this._nodeCount;
  }

  /** @returns {number} Number of leaves currently stored. */
  get proxyCount() {
    return this._proxyCount;
  }

  /** @returns {number} Height of the tree, or 0 when empty. */
  get height() {
    return this._root === NULL_NODE ? 0 : this._height[this._root];
  }

  /** @returns {number} Slots currently allocated in the node arrays. */
  get capacity() {
    return this._capacity;
  }

  /** @returns {number} Root node index, or -1 when the tree is empty. */
  get root() {
    return this._root;
  }

  /** @returns {number} Approximate CPU memory footprint, in bytes. */
  get memoryBytes() {
    return this._bounds.byteLength + this._tight.byteLength + this._parent.byteLength +
      this._child1.byteLength + this._child2.byteLength + this._height.byteLength;
  }

  // ---------------------------------------------------------------------------
  // Node pool
  // ---------------------------------------------------------------------------

  /**
   * Grows the node arrays and re-threads the free list.
   * @param {number} newCapacity
   * @returns {void}
   */
  _grow(newCapacity) {
    const oldCapacity = this._capacity;
    if (newCapacity <= oldCapacity) return;

    const bounds = new Float32Array(newCapacity * 6);
    bounds.set(this._bounds);
    const tight = new Float32Array(newCapacity * 6);
    tight.set(this._tight);
    const parent = new Int32Array(newCapacity);
    parent.set(this._parent);
    const child1 = new Int32Array(newCapacity);
    child1.set(this._child1);
    const child2 = new Int32Array(newCapacity);
    child2.set(this._child2);
    const height = new Int32Array(newCapacity);
    height.set(this._height);

    this._bounds = bounds;
    this._tight = tight;
    this._parent = parent;
    this._child1 = child1;
    this._child2 = child2;
    this._height = height;
    this._userData.length = newCapacity;
    this._capacity = newCapacity;

    for (let i = oldCapacity; i < newCapacity; i++) {
      child1[i] = i + 1;
      height[i] = -1;
      this._userData[i] = null;
    }
    child1[newCapacity - 1] = this._freeList;
    this._freeList = oldCapacity;
  }

  /**
   * Pops a node from the free list, growing the pool when necessary.
   * @returns {number} Node index.
   */
  _allocateNode() {
    if (this._freeList === NULL_NODE) this._grow(this._capacity * 2);
    const id = this._freeList;
    this._freeList = this._child1[id];
    this._parent[id] = NULL_NODE;
    this._child1[id] = NULL_NODE;
    this._child2[id] = NULL_NODE;
    this._height[id] = 0;
    this._userData[id] = null;
    this._nodeCount++;
    return id;
  }

  /**
   * Returns a node to the free list.
   * @param {number} id
   * @returns {void}
   */
  _freeNode(id) {
    this._child1[id] = this._freeList;
    this._height[id] = -1;
    this._userData[id] = null;
    this._freeList = id;
    this._nodeCount--;
  }

  // ---------------------------------------------------------------------------
  // Bounds helpers
  // ---------------------------------------------------------------------------

  /**
   * Surface area (SAH cost) of a node's fat AABB.
   * @param {number} node
   * @returns {number}
   */
  _area(node) {
    const b = this._bounds;
    const o = node * 6;
    const dx = b[o + 3] - b[o];
    const dy = b[o + 4] - b[o + 1];
    const dz = b[o + 5] - b[o + 2];
    return 2 * (dx * dy + dy * dz + dz * dx);
  }

  /**
   * Surface area of the union between a node's fat AABB and an explicit box.
   * @param {number} node
   * @param {number} minX
   * @param {number} minY
   * @param {number} minZ
   * @param {number} maxX
   * @param {number} maxY
   * @param {number} maxZ
   * @returns {number}
   */
  _unionArea(node, minX, minY, minZ, maxX, maxY, maxZ) {
    const b = this._bounds;
    const o = node * 6;
    const nx = b[o] < minX ? b[o] : minX;
    const ny = b[o + 1] < minY ? b[o + 1] : minY;
    const nz = b[o + 2] < minZ ? b[o + 2] : minZ;
    const xx = b[o + 3] > maxX ? b[o + 3] : maxX;
    const xy = b[o + 4] > maxY ? b[o + 4] : maxY;
    const xz = b[o + 5] > maxZ ? b[o + 5] : maxZ;
    const dx = xx - nx;
    const dy = xy - ny;
    const dz = xz - nz;
    return 2 * (dx * dy + dy * dz + dz * dx);
  }

  /**
   * Writes the union of nodes `a` and `b` into node `dst`.
   * @param {number} dst
   * @param {number} a
   * @param {number} b
   * @returns {void}
   */
  _combine(dst, a, b) {
    const arr = this._bounds;
    const d = dst * 6;
    const oa = a * 6;
    const ob = b * 6;
    arr[d] = arr[oa] < arr[ob] ? arr[oa] : arr[ob];
    arr[d + 1] = arr[oa + 1] < arr[ob + 1] ? arr[oa + 1] : arr[ob + 1];
    arr[d + 2] = arr[oa + 2] < arr[ob + 2] ? arr[oa + 2] : arr[ob + 2];
    arr[d + 3] = arr[oa + 3] > arr[ob + 3] ? arr[oa + 3] : arr[ob + 3];
    arr[d + 4] = arr[oa + 4] > arr[ob + 4] ? arr[oa + 4] : arr[ob + 4];
    arr[d + 5] = arr[oa + 5] > arr[ob + 5] ? arr[oa + 5] : arr[ob + 5];
  }

  /**
   * Stores the tight box of a leaf and derives its fat box.
   * @param {number} node
   * @param {number} minX
   * @param {number} minY
   * @param {number} minZ
   * @param {number} maxX
   * @param {number} maxY
   * @param {number} maxZ
   * @param {number} dx Predicted displacement on X.
   * @param {number} dy Predicted displacement on Y.
   * @param {number} dz Predicted displacement on Z.
   * @returns {void}
   */
  _setLeafBounds(node, minX, minY, minZ, maxX, maxY, maxZ, dx, dy, dz) {
    const o = node * 6;
    const t = this._tight;
    t[o] = minX; t[o + 1] = minY; t[o + 2] = minZ;
    t[o + 3] = maxX; t[o + 4] = maxY; t[o + 5] = maxZ;

    const m = this.margin;
    const b = this._bounds;
    let bminX = minX - m;
    let bminY = minY - m;
    let bminZ = minZ - m;
    let bmaxX = maxX + m;
    let bmaxY = maxY + m;
    let bmaxZ = maxZ + m;

    if (dx !== 0) { if (dx < 0) bminX += dx; else bmaxX += dx; }
    if (dy !== 0) { if (dy < 0) bminY += dy; else bmaxY += dy; }
    if (dz !== 0) { if (dz < 0) bminZ += dz; else bmaxZ += dz; }

    b[o] = bminX; b[o + 1] = bminY; b[o + 2] = bminZ;
    b[o + 3] = bmaxX; b[o + 4] = bmaxY; b[o + 5] = bmaxZ;
  }

  // ---------------------------------------------------------------------------
  // Public proxy API
  // ---------------------------------------------------------------------------

  /**
   * Inserts a proxy.
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb World AABB.
   * @param {*} userData Payload returned by queries.
   * @returns {number} The new proxy id.
   */
  insert(aabb, userData) {
    const mn = aabb.min;
    const mx = aabb.max;
    return this.insertMinMax(mn.x, mn.y, mn.z, mx.x, mx.y, mx.z, userData);
  }

  /**
   * Allocation-free variant of {@link DynamicBVH#insert}.
   * @param {number} minX
   * @param {number} minY
   * @param {number} minZ
   * @param {number} maxX
   * @param {number} maxY
   * @param {number} maxZ
   * @param {*} userData
   * @returns {number} The new proxy id.
   */
  insertMinMax(minX, minY, minZ, maxX, maxY, maxZ, userData) {
    const leaf = this._allocateNode();
    this._setLeafBounds(leaf, minX, minY, minZ, maxX, maxY, maxZ, 0, 0, 0);
    this._userData[leaf] = userData === undefined ? null : userData;
    this._height[leaf] = 0;
    this._insertLeaf(leaf);
    this._proxyCount++;
    return leaf;
  }

  /**
   * Removes a proxy previously returned by {@link DynamicBVH#insert}.
   * @param {number} proxyId
   * @returns {void}
   */
  remove(proxyId) {
    if (proxyId < 0 || proxyId >= this._capacity || this._height[proxyId] !== 0) return;
    this._removeLeaf(proxyId);
    this._freeNode(proxyId);
    this._proxyCount--;
  }

  /**
   * Refreshes a proxy. The tree is only restructured when the new tight AABB
   * escapes the cached fat AABB, which makes small per-frame motion nearly free.
   * @param {number} proxyId
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
   * @param {{x:number,y:number,z:number}} [displacement] Motion since the last update.
   * @returns {boolean} True when the proxy was reinserted.
   */
  update(proxyId, aabb, displacement) {
    const mn = aabb.min;
    const mx = aabb.max;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    if (displacement !== undefined && displacement !== null) {
      const k = this.displacementMultiplier;
      dx = displacement.x * k;
      dy = displacement.y * k;
      dz = displacement.z * k;
    }
    return this.updateMinMax(proxyId, mn.x, mn.y, mn.z, mx.x, mx.y, mx.z, dx, dy, dz);
  }

  /**
   * Allocation-free variant of {@link DynamicBVH#update}.
   * @param {number} proxyId
   * @param {number} minX
   * @param {number} minY
   * @param {number} minZ
   * @param {number} maxX
   * @param {number} maxY
   * @param {number} maxZ
   * @param {number} [dx] Pre-multiplied displacement on X.
   * @param {number} [dy] Pre-multiplied displacement on Y.
   * @param {number} [dz] Pre-multiplied displacement on Z.
   * @returns {boolean} True when the proxy was reinserted.
   */
  updateMinMax(proxyId, minX, minY, minZ, maxX, maxY, maxZ, dx = 0, dy = 0, dz = 0) {
    if (proxyId < 0 || proxyId >= this._capacity || this._height[proxyId] !== 0) return false;

    const o = proxyId * 6;
    const b = this._bounds;
    if (minX >= b[o] && minY >= b[o + 1] && minZ >= b[o + 2] &&
        maxX <= b[o + 3] && maxY <= b[o + 4] && maxZ <= b[o + 5]) {
      const t = this._tight;
      t[o] = minX; t[o + 1] = minY; t[o + 2] = minZ;
      t[o + 3] = maxX; t[o + 4] = maxY; t[o + 5] = maxZ;
      return false;
    }

    this._removeLeaf(proxyId);
    this._setLeafBounds(proxyId, minX, minY, minZ, maxX, maxY, maxZ, dx, dy, dz);
    this._insertLeaf(proxyId);
    return true;
  }

  /**
   * @param {number} proxyId
   * @returns {*} The payload stored with the proxy, or null.
   */
  getUserData(proxyId) {
    if (proxyId < 0 || proxyId >= this._capacity) return null;
    return this._userData[proxyId];
  }

  /**
   * Replaces the payload of an existing proxy.
   * @param {number} proxyId
   * @param {*} userData
   * @returns {void}
   */
  setUserData(proxyId, userData) {
    if (proxyId < 0 || proxyId >= this._capacity) return;
    this._userData[proxyId] = userData;
  }

  /**
   * Copies the exact (non-fattened) bounds of a proxy.
   * @param {number} proxyId
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} out
   * @returns {*} `out`.
   */
  getProxyBounds(proxyId, out) {
    const o = proxyId * 6;
    const t = this._tight;
    out.min.x = t[o]; out.min.y = t[o + 1]; out.min.z = t[o + 2];
    out.max.x = t[o + 3]; out.max.y = t[o + 4]; out.max.z = t[o + 5];
    return out;
  }

  /**
   * Copies the fat bounds of the root node.
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} out
   * @returns {*} `out`.
   */
  getBounds(out) {
    if (this._root === NULL_NODE) {
      out.min.x = Infinity; out.min.y = Infinity; out.min.z = Infinity;
      out.max.x = -Infinity; out.max.y = -Infinity; out.max.z = -Infinity;
      return out;
    }
    const o = this._root * 6;
    const b = this._bounds;
    out.min.x = b[o]; out.min.y = b[o + 1]; out.min.z = b[o + 2];
    out.max.x = b[o + 3]; out.max.y = b[o + 4]; out.max.z = b[o + 5];
    return out;
  }

  /**
   * Drops every proxy and resets the pool.
   * @returns {void}
   */
  clear() {
    const capacity = this._capacity;
    for (let i = 0; i < capacity; i++) {
      this._child1[i] = i + 1;
      this._child2[i] = NULL_NODE;
      this._parent[i] = NULL_NODE;
      this._height[i] = -1;
      this._userData[i] = null;
    }
    this._child1[capacity - 1] = NULL_NODE;
    this._freeList = 0;
    this._root = NULL_NODE;
    this._nodeCount = 0;
    this._proxyCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Tree surgery
  // ---------------------------------------------------------------------------

  /**
   * Links a fully initialised leaf into the tree, picking the sibling that
   * minimises the surface area heuristic.
   * @param {number} leaf
   * @returns {void}
   */
  _insertLeaf(leaf) {
    if (this._root === NULL_NODE) {
      this._root = leaf;
      this._parent[leaf] = NULL_NODE;
      return;
    }

    const b = this._bounds;
    const lo = leaf * 6;
    const lminX = b[lo];
    const lminY = b[lo + 1];
    const lminZ = b[lo + 2];
    const lmaxX = b[lo + 3];
    const lmaxY = b[lo + 4];
    const lmaxZ = b[lo + 5];

    // Descend to the best sibling.
    let index = this._root;
    while (this._child1[index] !== NULL_NODE) {
      const c1 = this._child1[index];
      const c2 = this._child2[index];

      const area = this._area(index);
      const combinedArea = this._unionArea(index, lminX, lminY, lminZ, lmaxX, lmaxY, lmaxZ);

      // Cost of creating a new parent right here.
      const cost = 2 * combinedArea;
      // Minimum cost of pushing the leaf further down.
      const inheritanceCost = 2 * (combinedArea - area);

      const union1 = this._unionArea(c1, lminX, lminY, lminZ, lmaxX, lmaxY, lmaxZ);
      const cost1 = this._child1[c1] === NULL_NODE
        ? union1 + inheritanceCost
        : union1 - this._area(c1) + inheritanceCost;

      const union2 = this._unionArea(c2, lminX, lminY, lminZ, lmaxX, lmaxY, lmaxZ);
      const cost2 = this._child1[c2] === NULL_NODE
        ? union2 + inheritanceCost
        : union2 - this._area(c2) + inheritanceCost;

      if (cost < cost1 && cost < cost2) break;
      index = cost1 < cost2 ? c1 : c2;
    }

    const sibling = index;
    const oldParent = this._parent[sibling];
    const newParent = this._allocateNode();

    this._parent[newParent] = oldParent;
    this._userData[newParent] = null;
    this._child1[newParent] = sibling;
    this._child2[newParent] = leaf;
    this._combine(newParent, sibling, leaf);
    this._height[newParent] = this._height[sibling] + 1;
    this._parent[sibling] = newParent;
    this._parent[leaf] = newParent;

    if (oldParent !== NULL_NODE) {
      if (this._child1[oldParent] === sibling) this._child1[oldParent] = newParent;
      else this._child2[oldParent] = newParent;
    } else {
      this._root = newParent;
    }

    this._refitUpwards(this._parent[leaf]);
  }

  /**
   * Unlinks a leaf without freeing it.
   * @param {number} leaf
   * @returns {void}
   */
  _removeLeaf(leaf) {
    if (leaf === this._root) {
      this._root = NULL_NODE;
      this._parent[leaf] = NULL_NODE;
      return;
    }

    const parent = this._parent[leaf];
    const grandParent = this._parent[parent];
    const sibling = this._child1[parent] === leaf ? this._child2[parent] : this._child1[parent];

    if (grandParent !== NULL_NODE) {
      if (this._child1[grandParent] === parent) this._child1[grandParent] = sibling;
      else this._child2[grandParent] = sibling;
      this._parent[sibling] = grandParent;
      this._freeNode(parent);
      this._refitUpwards(grandParent);
    } else {
      this._root = sibling;
      this._parent[sibling] = NULL_NODE;
      this._freeNode(parent);
    }

    this._parent[leaf] = NULL_NODE;
  }

  /**
   * Walks from `start` to the root refitting bounds/heights and rebalancing.
   * @param {number} start
   * @returns {void}
   */
  _refitUpwards(start) {
    let i = start;
    while (i !== NULL_NODE) {
      i = this._balance(i);
      const c1 = this._child1[i];
      const c2 = this._child2[i];
      const h1 = this._height[c1];
      const h2 = this._height[c2];
      this._height[i] = 1 + (h1 > h2 ? h1 : h2);
      this._combine(i, c1, c2);
      i = this._parent[i];
    }
  }

  /**
   * AVL-like rotation around `iA`.
   * @param {number} iA
   * @returns {number} The node that now occupies `iA`'s former slot in the tree.
   */
  _balance(iA) {
    const child1 = this._child1;
    const child2 = this._child2;
    const parent = this._parent;
    const height = this._height;

    if (child1[iA] === NULL_NODE || height[iA] < 2) return iA;

    const iB = child1[iA];
    const iC = child2[iA];
    const balance = height[iC] - height[iB];

    if (balance > 1) {
      // Rotate C up.
      const iF = child1[iC];
      const iG = child2[iC];

      child1[iC] = iA;
      parent[iC] = parent[iA];
      parent[iA] = iC;

      if (parent[iC] !== NULL_NODE) {
        if (child1[parent[iC]] === iA) child1[parent[iC]] = iC;
        else child2[parent[iC]] = iC;
      } else {
        this._root = iC;
      }

      if (height[iF] > height[iG]) {
        child2[iC] = iF;
        child2[iA] = iG;
        parent[iG] = iA;
        this._combine(iA, iB, iG);
        this._combine(iC, iA, iF);
        height[iA] = 1 + (height[iB] > height[iG] ? height[iB] : height[iG]);
        height[iC] = 1 + (height[iA] > height[iF] ? height[iA] : height[iF]);
      } else {
        child2[iC] = iG;
        child2[iA] = iF;
        parent[iF] = iA;
        this._combine(iA, iB, iF);
        this._combine(iC, iA, iG);
        height[iA] = 1 + (height[iB] > height[iF] ? height[iB] : height[iF]);
        height[iC] = 1 + (height[iA] > height[iG] ? height[iA] : height[iG]);
      }
      return iC;
    }

    if (balance < -1) {
      // Rotate B up.
      const iD = child1[iB];
      const iE = child2[iB];

      child1[iB] = iA;
      parent[iB] = parent[iA];
      parent[iA] = iB;

      if (parent[iB] !== NULL_NODE) {
        if (child1[parent[iB]] === iA) child1[parent[iB]] = iB;
        else child2[parent[iB]] = iB;
      } else {
        this._root = iB;
      }

      if (height[iD] > height[iE]) {
        child2[iB] = iD;
        child1[iA] = iE;
        parent[iE] = iA;
        this._combine(iA, iE, iC);
        this._combine(iB, iA, iD);
        height[iA] = 1 + (height[iE] > height[iC] ? height[iE] : height[iC]);
        height[iB] = 1 + (height[iA] > height[iD] ? height[iA] : height[iD]);
      } else {
        child2[iB] = iE;
        child1[iA] = iD;
        parent[iD] = iA;
        this._combine(iA, iD, iC);
        this._combine(iB, iA, iE);
        height[iA] = 1 + (height[iD] > height[iC] ? height[iD] : height[iC]);
        height[iB] = 1 + (height[iA] > height[iE] ? height[iA] : height[iE]);
      }
      return iB;
    }

    return iA;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Grows the traversal stacks when the tree gets deeper than the reserve.
   * @param {number} needed
   * @returns {void}
   */
  _ensureStack(needed) {
    if (needed <= this._stack.length) return;
    let n = this._stack.length;
    while (n < needed) n *= 2;
    const s = new Int32Array(n);
    s.set(this._stack);
    const m = new Int32Array(n);
    m.set(this._maskStack);
    this._stack = s;
    this._maskStack = m;
  }

  /**
   * Frustum culling query.
   *
   * The traversal carries a bit mask of the frustum planes that are still able to
   * reject the current subtree. Once a node is fully inside a plane that plane's
   * bit is cleared for the whole subtree, and when the mask reaches zero the
   * remaining nodes are accepted without any further plane test.
   *
   * `out` is emptied before the traversal and receives the `userData` of every
   * visible proxy. Leaf acceptance uses the exact (non-fattened) bounds, so the
   * result contains no false positives from the fat AABB margin.
   *
   * @param {{planes:Array<{normal:{x:number,y:number,z:number}, constant:number}>}} frustum
   * @param {Array<*>} out
   * @returns {number} Number of visible proxies written to `out`.
   */
  query(frustum, out) {
    out.length = 0;
    if (this._root === NULL_NODE) return 0;

    const planeList = frustum.planes;
    if (planeList === undefined || planeList === null || planeList.length < 6) {
      return this._queryFrustumGeneric(frustum, out);
    }

    const p = this._planes;
    for (let i = 0; i < 6; i++) {
      const pl = planeList[i];
      const n = pl.normal;
      const o = i * 4;
      p[o] = n.x;
      p[o + 1] = n.y;
      p[o + 2] = n.z;
      p[o + 3] = pl.constant;
    }

    // A DFS that pops one node and pushes two children grows the stack by at most
    // one entry per level, so `height + 4` slots are always enough.
    this._ensureStack(this.height + 4);
    const bounds = this._bounds;
    const tight = this._tight;
    const child1 = this._child1;
    const child2 = this._child2;
    const userData = this._userData;

    let sp = 0;
    this._stack[sp] = this._root;
    this._maskStack[sp] = ALL_PLANES;
    sp++;

    let count = 0;

    while (sp > 0) {
      sp--;
      const node = this._stack[sp];
      let mask = this._maskStack[sp];
      const isLeaf = child1[node] === NULL_NODE;
      const o = node * 6;
      const src = isLeaf ? tight : bounds;

      if (mask !== 0) {
        const minX = src[o];
        const minY = src[o + 1];
        const minZ = src[o + 2];
        const maxX = src[o + 3];
        const maxY = src[o + 4];
        const maxZ = src[o + 5];

        let rejected = false;
        for (let i = 0; i < 6; i++) {
          const bit = 1 << i;
          if ((mask & bit) === 0) continue;
          const po = i * 4;
          const nx = p[po];
          const ny = p[po + 1];
          const nz = p[po + 2];
          const c = p[po + 3];

          // Farthest corner along the (inward pointing) plane normal.
          const px = nx > 0 ? maxX : minX;
          const py = ny > 0 ? maxY : minY;
          const pz = nz > 0 ? maxZ : minZ;
          if (nx * px + ny * py + nz * pz + c < 0) { rejected = true; break; }

          // Nearest corner: when it is inside too the whole box clears this plane.
          const qx = nx > 0 ? minX : maxX;
          const qy = ny > 0 ? minY : maxY;
          const qz = nz > 0 ? minZ : maxZ;
          if (nx * qx + ny * qy + nz * qz + c >= 0) mask &= ~bit;
        }
        if (rejected) continue;
      }

      if (isLeaf) {
        out[count++] = userData[node];
        continue;
      }

      this._ensureStack(sp + 2);
      this._stack[sp] = child1[node];
      this._maskStack[sp] = mask;
      sp++;
      this._stack[sp] = child2[node];
      this._maskStack[sp] = mask;
      sp++;
    }

    out.length = count;
    return count;
  }

  /**
   * Fallback frustum query for objects that only expose `intersectsAABBMinMax`.
   * @param {{intersectsAABBMinMax:Function}} frustum
   * @param {Array<*>} out
   * @returns {number}
   */
  _queryFrustumGeneric(frustum, out) {
    this._ensureStack(this.height + 4);
    const bounds = this._bounds;
    const tight = this._tight;
    const child1 = this._child1;
    const child2 = this._child2;
    const userData = this._userData;

    let sp = 0;
    this._stack[sp++] = this._root;
    let count = 0;

    while (sp > 0) {
      const node = this._stack[--sp];
      const isLeaf = child1[node] === NULL_NODE;
      const src = isLeaf ? tight : bounds;
      const o = node * 6;
      if (!frustum.intersectsAABBMinMax(src[o], src[o + 1], src[o + 2], src[o + 3], src[o + 4], src[o + 5])) {
        continue;
      }
      if (isLeaf) {
        out[count++] = userData[node];
        continue;
      }
      this._ensureStack(sp + 2);
      this._stack[sp++] = child1[node];
      this._stack[sp++] = child2[node];
    }

    out.length = count;
    return count;
  }

  /**
   * Collects every proxy whose exact bounds overlap `aabb`.
   * `out` is emptied first.
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
   * @param {Array<*>} out
   * @returns {number} Number of proxies written to `out`.
   */
  queryAABB(aabb, out) {
    const mn = aabb.min;
    const mx = aabb.max;
    return this.queryAABBMinMax(mn.x, mn.y, mn.z, mx.x, mx.y, mx.z, out);
  }

  /**
   * Allocation-free variant of {@link DynamicBVH#queryAABB}.
   * @param {number} minX
   * @param {number} minY
   * @param {number} minZ
   * @param {number} maxX
   * @param {number} maxY
   * @param {number} maxZ
   * @param {Array<*>} out
   * @returns {number}
   */
  queryAABBMinMax(minX, minY, minZ, maxX, maxY, maxZ, out) {
    out.length = 0;
    if (this._root === NULL_NODE) return 0;

    this._ensureStack(this.height + 4);
    const bounds = this._bounds;
    const tight = this._tight;
    const child1 = this._child1;
    const child2 = this._child2;
    const userData = this._userData;

    let sp = 0;
    this._stack[sp++] = this._root;
    let count = 0;

    while (sp > 0) {
      const node = this._stack[--sp];
      const isLeaf = child1[node] === NULL_NODE;
      const src = isLeaf ? tight : bounds;
      const o = node * 6;
      if (src[o] > maxX || src[o + 3] < minX ||
          src[o + 1] > maxY || src[o + 4] < minY ||
          src[o + 2] > maxZ || src[o + 5] < minZ) {
        continue;
      }
      if (isLeaf) {
        out[count++] = userData[node];
        continue;
      }
      this._ensureStack(sp + 2);
      this._stack[sp++] = child1[node];
      this._stack[sp++] = child2[node];
    }

    out.length = count;
    return count;
  }

  /**
   * Collects every proxy whose exact bounds overlap a sphere. `out` is emptied first.
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @param {number} radius
   * @param {Array<*>} out
   * @returns {number}
   */
  querySphere(cx, cy, cz, radius, out) {
    out.length = 0;
    if (this._root === NULL_NODE) return 0;

    const r2 = radius * radius;
    this._ensureStack(this.height + 4);
    const bounds = this._bounds;
    const tight = this._tight;
    const child1 = this._child1;
    const child2 = this._child2;
    const userData = this._userData;

    let sp = 0;
    this._stack[sp++] = this._root;
    let count = 0;

    while (sp > 0) {
      const node = this._stack[--sp];
      const isLeaf = child1[node] === NULL_NODE;
      const src = isLeaf ? tight : bounds;
      const o = node * 6;

      let dx = cx < src[o] ? src[o] - cx : (cx > src[o + 3] ? cx - src[o + 3] : 0);
      let dy = cy < src[o + 1] ? src[o + 1] - cy : (cy > src[o + 4] ? cy - src[o + 4] : 0);
      let dz = cz < src[o + 2] ? src[o + 2] - cz : (cz > src[o + 5] ? cz - src[o + 5] : 0);
      if (dx * dx + dy * dy + dz * dz > r2) continue;

      if (isLeaf) {
        out[count++] = userData[node];
        continue;
      }
      this._ensureStack(sp + 2);
      this._stack[sp++] = child1[node];
      this._stack[sp++] = child2[node];
    }

    out.length = count;
    return count;
  }

  // ---------------------------------------------------------------------------
  // Ray traversal (priority queue ordered by entry distance)
  // ---------------------------------------------------------------------------

  /**
   * Grows the ray priority queue.
   * @returns {void}
   */
  _heapGrow() {
    const n = this._heapKeys.length * 2;
    const k = new Float32Array(n);
    k.set(this._heapKeys);
    const v = new Int32Array(n);
    v.set(this._heapVals);
    this._heapKeys = k;
    this._heapVals = v;
  }

  /**
   * Pushes a node onto the min-heap.
   * @param {number} key Entry distance along the ray.
   * @param {number} value Node index.
   * @returns {void}
   */
  _heapPush(key, value) {
    if (this._heapSize === this._heapKeys.length) this._heapGrow();
    const keys = this._heapKeys;
    const vals = this._heapVals;
    let i = this._heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = value;
  }

  /**
   * Pops the closest node. The popped key is left in `this._heapPopKey`.
   * @returns {number} Node index.
   */
  _heapPop() {
    const keys = this._heapKeys;
    const vals = this._heapVals;
    const topValue = vals[0];
    this._heapPopKey = keys[0];

    const n = --this._heapSize;
    if (n > 0) {
      const key = keys[n];
      const value = vals[n];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        vals[i] = vals[child];
        i = child;
      }
      keys[i] = key;
      vals[i] = value;
    }
    return topValue;
  }

  /**
   * Casts a ray through the tree, reporting proxies strictly in order of their
   * entry distance.
   *
   * The callback may narrow the search: returning a finite number replaces
   * `maxDist`, returning `false` aborts the traversal, anything else continues.
   *
   * @param {{origin:{x:number,y:number,z:number}, direction:{x:number,y:number,z:number}}} ray
   *   Direction should be normalised for `t` to be a world-space distance.
   * @param {number} maxDist
   * @param {(userData:*, proxyId:number, tEnter:number)=>(number|boolean|void)} callback
   * @returns {number} Number of proxies reported.
   */
  raycast(ray, maxDist, callback) {
    if (this._root === NULL_NODE) return 0;

    const ox = ray.origin.x;
    const oy = ray.origin.y;
    const oz = ray.origin.z;
    const invX = 1 / ray.direction.x;
    const invY = 1 / ray.direction.y;
    const invZ = 1 / ray.direction.z;

    const bounds = this._bounds;
    const tight = this._tight;
    const child1 = this._child1;
    const child2 = this._child2;
    const userData = this._userData;

    let limit = maxDist;
    this._heapSize = 0;

    const rootIsLeaf = child1[this._root] === NULL_NODE;
    let t = this._slabEnter(rootIsLeaf ? tight : bounds, this._root * 6, ox, oy, oz, invX, invY, invZ, limit);
    if (t < 0) return 0;
    this._heapPush(t, this._root);

    let reported = 0;

    while (this._heapSize > 0) {
      const node = this._heapPop();
      const tEnter = this._heapPopKey;
      if (tEnter > limit) break;

      if (child1[node] === NULL_NODE) {
        reported++;
        const r = callback(userData[node], node, tEnter);
        if (r === false) break;
        if (typeof r === 'number' && r >= 0 && r < limit) limit = r;
        continue;
      }

      const c1 = child1[node];
      const c2 = child2[node];

      const t1 = this._slabEnter(
        child1[c1] === NULL_NODE ? tight : bounds, c1 * 6, ox, oy, oz, invX, invY, invZ, limit);
      if (t1 >= 0) this._heapPush(t1, c1);

      const t2 = this._slabEnter(
        child1[c2] === NULL_NODE ? tight : bounds, c2 * 6, ox, oy, oz, invX, invY, invZ, limit);
      if (t2 >= 0) this._heapPush(t2, c2);
    }

    this._heapSize = 0;
    return reported;
  }

  /**
   * Branch-free slab test. Returns the entry distance (clamped to 0 when the
   * origin is inside) or -1 when the ray misses within `limit`.
   * @param {Float32Array} arr
   * @param {number} o
   * @param {number} ox
   * @param {number} oy
   * @param {number} oz
   * @param {number} invX
   * @param {number} invY
   * @param {number} invZ
   * @param {number} limit
   * @returns {number}
   */
  _slabEnter(arr, o, ox, oy, oz, invX, invY, invZ, limit) {
    const ax = (arr[o] - ox) * invX;
    const bx = (arr[o + 3] - ox) * invX;
    let tmin = ax < bx ? ax : bx;
    let tmax = ax > bx ? ax : bx;

    const ay = (arr[o + 1] - oy) * invY;
    const by = (arr[o + 4] - oy) * invY;
    const lo1 = ay < by ? ay : by;
    const hi1 = ay > by ? ay : by;
    if (lo1 > tmin) tmin = lo1;
    if (hi1 < tmax) tmax = hi1;

    const az = (arr[o + 2] - oz) * invZ;
    const bz = (arr[o + 5] - oz) * invZ;
    const lo2 = az < bz ? az : bz;
    const hi2 = az > bz ? az : bz;
    if (lo2 > tmin) tmin = lo2;
    if (hi2 < tmax) tmax = hi2;

    if (tmax < 0 || tmin > tmax || tmin > limit) return -1;
    return tmin < 0 ? 0 : tmin;
  }

  // ---------------------------------------------------------------------------
  // Rebuild
  // ---------------------------------------------------------------------------

  /**
   * Rebuilds the hierarchy bottom-up with SAH driven agglomerative clustering.
   *
   * Leaves are first sorted along a 30 bit Morton curve so spatial neighbours end
   * up adjacent; rounds of mutual nearest-neighbour merging (searched inside a
   * symmetric window) then collapse the list until a single root remains. Merging
   * always picks the pair with the smallest union surface area, which is exactly
   * the SAH cost of the parent that gets created.
   *
   * This is an offline operation: call it after bulk loading a scene, never per frame.
   * @returns {void}
   */
  rebuild() {
    const leafCount = this._proxyCount;
    if (leafCount === 0) {
      this._root = NULL_NODE;
      return;
    }

    // 1. Gather leaves, then release every internal node back to the pool.
    const leaves = new Int32Array(leafCount);
    let found = 0;
    if (this._root !== NULL_NODE) {
      this._ensureStack(this.height + 8);
      let sp = 0;
      this._stack[sp++] = this._root;
      while (sp > 0) {
        const node = this._stack[--sp];
        if (this._child1[node] === NULL_NODE) {
          if (found < leafCount) leaves[found++] = node;
          continue;
        }
        this._ensureStack(sp + 2);
        this._stack[sp++] = this._child1[node];
        this._stack[sp++] = this._child2[node];
      }
    }
    if (found === 0) {
      this._root = NULL_NODE;
      return;
    }

    // Free the old internal nodes; leaves keep their slots, bounds and payloads.
    // Height identifies the three states unambiguously: -1 free, 0 leaf, >0 internal.
    for (let i = 0; i < found; i++) {
      const leaf = leaves[i];
      this._parent[leaf] = NULL_NODE;
      this._child1[leaf] = NULL_NODE;
      this._child2[leaf] = NULL_NODE;
      this._height[leaf] = 0;
    }
    for (let i = 0, n = this._capacity; i < n; i++) {
      if (this._height[i] > 0) this._freeNode(i);
    }
    this._root = NULL_NODE;

    if (found === 1) {
      this._root = leaves[0];
      this._parent[leaves[0]] = NULL_NODE;
      return;
    }

    // 2. Morton order the leaves by fat-AABB centroid.
    const bounds = this._bounds;
    let gminX = Infinity, gminY = Infinity, gminZ = Infinity;
    let gmaxX = -Infinity, gmaxY = -Infinity, gmaxZ = -Infinity;
    for (let i = 0; i < found; i++) {
      const o = leaves[i] * 6;
      const cx = (bounds[o] + bounds[o + 3]) * 0.5;
      const cy = (bounds[o + 1] + bounds[o + 4]) * 0.5;
      const cz = (bounds[o + 2] + bounds[o + 5]) * 0.5;
      if (cx < gminX) gminX = cx;
      if (cy < gminY) gminY = cy;
      if (cz < gminZ) gminZ = cz;
      if (cx > gmaxX) gmaxX = cx;
      if (cy > gmaxY) gmaxY = cy;
      if (cz > gmaxZ) gmaxZ = cz;
    }
    const sx = gmaxX > gminX ? 1 / (gmaxX - gminX) : 0;
    const sy = gmaxY > gminY ? 1 / (gmaxY - gminY) : 0;
    const sz = gmaxZ > gminZ ? 1 / (gmaxZ - gminZ) : 0;

    const codes = new Uint32Array(found);
    for (let i = 0; i < found; i++) {
      const o = leaves[i] * 6;
      const cx = ((bounds[o] + bounds[o + 3]) * 0.5 - gminX) * sx;
      const cy = ((bounds[o + 1] + bounds[o + 4]) * 0.5 - gminY) * sy;
      const cz = ((bounds[o + 2] + bounds[o + 5]) * 0.5 - gminZ) * sz;
      codes[i] = morton3(cx, cy, cz);
    }
    radixSortByKey(codes, leaves, new Uint32Array(found), new Int32Array(found), found);

    // 3. Agglomerative clustering.
    const nn = new Int32Array(found);
    const consumed = new Uint8Array(found);
    let count = found;

    while (count > 1) {
      const searchWindow = REBUILD_WINDOW < count - 1 ? REBUILD_WINDOW : count - 1;
      // Re-read every round: _mergeClusters allocates, which may reallocate the
      // node arrays and invalidate any cached reference.
      const nodeBounds = this._bounds;

      for (let i = 0; i < count; i++) {
        const a = leaves[i];
        const ao = a * 6;
        const aminX = nodeBounds[ao], aminY = nodeBounds[ao + 1], aminZ = nodeBounds[ao + 2];
        const amaxX = nodeBounds[ao + 3], amaxY = nodeBounds[ao + 4], amaxZ = nodeBounds[ao + 5];

        let lo = i - searchWindow;
        if (lo < 0) lo = 0;
        let hi = i + searchWindow;
        if (hi > count - 1) hi = count - 1;

        let best = -1;
        let bestCost = Infinity;
        for (let j = lo; j <= hi; j++) {
          if (j === i) continue;
          const cost = this._unionArea(leaves[j], aminX, aminY, aminZ, amaxX, amaxY, amaxZ);
          if (cost < bestCost) {
            bestCost = cost;
            best = j;
          }
        }
        nn[i] = best;
        consumed[i] = 0;
      }

      let merges = 0;
      for (let i = 0; i < count; i++) {
        if (consumed[i] !== 0) continue;
        const j = nn[i];
        if (j <= i || consumed[j] !== 0 || nn[j] !== i) continue;
        leaves[i] = this._mergeClusters(leaves[i], leaves[j]);
        consumed[j] = 1;
        merges++;
      }

      if (merges === 0) {
        // Degenerate tie situation: force progress with sequential pairing.
        for (let i = 0; i + 1 < count; i += 2) {
          leaves[i] = this._mergeClusters(leaves[i], leaves[i + 1]);
          consumed[i + 1] = 1;
        }
      }

      let w = 0;
      for (let i = 0; i < count; i++) {
        if (consumed[i] !== 0) continue;
        leaves[w++] = leaves[i];
      }
      count = w;
    }

    this._root = leaves[0];
    this._parent[this._root] = NULL_NODE;
  }

  /**
   * Creates an internal node holding `a` and `b`.
   * @param {number} a
   * @param {number} b
   * @returns {number} The new parent node index.
   */
  _mergeClusters(a, b) {
    const parentNode = this._allocateNode();
    this._child1[parentNode] = a;
    this._child2[parentNode] = b;
    this._parent[a] = parentNode;
    this._parent[b] = parentNode;
    this._parent[parentNode] = NULL_NODE;
    this._userData[parentNode] = null;
    this._combine(parentNode, a, b);
    const ha = this._height[a];
    const hb = this._height[b];
    this._height[parentNode] = 1 + (ha > hb ? ha : hb);
    return parentNode;
  }

  /**
   * Total SAH cost of the tree (sum of internal node surface areas divided by the
   * root area). Useful to compare an incrementally built tree against a rebuild.
   * @returns {number}
   */
  computeCost() {
    if (this._root === NULL_NODE) return 0;
    const rootArea = this._area(this._root);
    if (rootArea <= 0) return 0;
    let cost = 0;
    for (let i = 0; i < this._capacity; i++) {
      if (this._height[i] > 0) cost += this._area(i);
    }
    return cost / rootArea;
  }

  /**
   * Releases every reference held by the tree.
   * @returns {void}
   */
  dispose() {
    this.clear();
    this._userData.length = 0;
  }
}
