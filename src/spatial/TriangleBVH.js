/**
 * @file TriangleBVH.js
 * Static triangle BVH built with a binned surface-area-heuristic sweep.
 *
 * Used for precise picking (Raycaster) and for the narrow phase of the physics
 * collision world. The whole structure lives in flat TypedArrays:
 *
 *   nodeBounds[i*6 .. i*6+5]  minX,minY,minZ,maxX,maxY,maxZ
 *   nodeTriCount[i]           0 for an internal node, otherwise the leaf size
 *   nodeLeftFirst[i]          left child index (internal) or first triangle (leaf)
 *
 * Children are always stored contiguously, so the right child is `left + 1`.
 * Triangles are never moved: `triIndices` is a permutation into the original
 * index/position buffers, which keeps the build cheap even for very large meshes.
 *
 * The build uses an explicit stack, so a 500k triangle mesh will not blow the
 * JavaScript call stack.
 *
 * This module deliberately has no imports: it only reads `.x/.y/.z` style fields
 * from the math objects it receives, so it stays usable from workers and tests.
 */

/** Number of SAH bins evaluated per split. */
const BIN_COUNT = 12;
/** Relative cost of descending one level, in "triangle intersection" units. */
const TRAVERSAL_COST = 1;
/** Guard against degenerate triangles / parallel rays. */
const EPSILON = 1e-12;
/** Initial traversal stack depth (grows on demand). */
const INITIAL_STACK = 128;

/** Scratch closest-point result, module scope so the hot path never allocates. */
const _closest = new Float32Array(3);

/**
 * Surface area of an AABB, or 0 when the box is empty.
 * @param {number} minX
 * @param {number} minY
 * @param {number} minZ
 * @param {number} maxX
 * @param {number} maxY
 * @param {number} maxZ
 * @returns {number}
 */
function surfaceArea(minX, minY, minZ, maxX, maxY, maxZ) {
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  if (dx < 0 || dy < 0 || dz < 0) return 0;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

/**
 * Closest point on a triangle to `p` (Ericson, Real-Time Collision Detection).
 * The result is written into the module scratch `_closest`.
 * @param {number} px
 * @param {number} py
 * @param {number} pz
 * @param {number} ax
 * @param {number} ay
 * @param {number} az
 * @param {number} bx
 * @param {number} by
 * @param {number} bz
 * @param {number} cx
 * @param {number} cy
 * @param {number} cz
 * @returns {number} Squared distance from `p` to the closest point.
 */
function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    _closest[0] = ax; _closest[1] = ay; _closest[2] = az;
    return apx * apx + apy * apy + apz * apz;
  }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    _closest[0] = bx; _closest[1] = by; _closest[2] = bz;
    return bpx * bpx + bpy * bpy + bpz * bpz;
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + abx * v, qy = ay + aby * v, qz = az + abz * v;
    _closest[0] = qx; _closest[1] = qy; _closest[2] = qz;
    const ex = px - qx, ey = py - qy, ez = pz - qz;
    return ex * ex + ey * ey + ez * ez;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    _closest[0] = cx; _closest[1] = cy; _closest[2] = cz;
    return cpx * cpx + cpy * cpy + cpz * cpz;
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + acx * w, qy = ay + acy * w, qz = az + acz * w;
    _closest[0] = qx; _closest[1] = qy; _closest[2] = qz;
    const ex = px - qx, ey = py - qy, ez = pz - qz;
    return ex * ex + ey * ey + ez * ez;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + (cx - bx) * w, qy = by + (cy - by) * w, qz = bz + (cz - bz) * w;
    _closest[0] = qx; _closest[1] = qy; _closest[2] = qz;
    const ex = px - qx, ey = py - qy, ez = pz - qz;
    return ex * ex + ey * ey + ez * ez;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = ax + abx * v + acx * w;
  const qy = ay + aby * v + acy * w;
  const qz = az + abz * v + acz * w;
  _closest[0] = qx; _closest[1] = qy; _closest[2] = qz;
  const ex = px - qx, ey = py - qy, ez = pz - qz;
  return ex * ex + ey * ey + ez * ez;
}

/**
 * Static bounding volume hierarchy over a triangle soup.
 */
export class TriangleBVH {
  constructor() {
    /** @type {Float32Array|null} Vertex positions, 3 floats per vertex. */
    this.positions = null;
    /** @type {Uint32Array|Uint16Array|null} Triangle indices, or null when non-indexed. */
    this.indices = null;
    /** @type {number} */
    this.triCount = 0;
    /** @type {number} Number of nodes actually used. */
    this.nodeCount = 0;
    /** @type {number} */
    this.maxLeafTris = 8;

    /** @type {Uint32Array|null} Permutation of triangle ids, grouped per leaf. */
    this.triIndices = null;
    /** @type {Float32Array|null} 6 floats per node. */
    this.nodeBounds = null;
    /** @type {Int32Array|null} Left child (internal) or first triangle (leaf). */
    this.nodeLeftFirst = null;
    /** @type {Int32Array|null} Triangle count; 0 marks an internal node. */
    this.nodeTriCount = null;

    /** @type {Int32Array} Traversal stack. */
    this._stack = new Int32Array(INITIAL_STACK);
    /** @type {Float32Array} Parallel distance stack for ordered traversals. */
    this._dstack = new Float32Array(INITIAL_STACK);
    /** @type {number} Triangle touched by the last closestPointOnSurface call. */
    this._lastClosestTri = -1;
  }

  /** @returns {number} Triangle hit by the most recent closest-point query, or -1. */
  get lastClosestTriIndex() {
    return this._lastClosestTri;
  }

  /** @returns {boolean} True once {@link TriangleBVH#build} produced a usable tree. */
  get isBuilt() {
    return this.nodeCount > 0;
  }

  /** @returns {number} Approximate CPU memory footprint of the hierarchy, in bytes. */
  get memoryBytes() {
    if (this.nodeBounds === null) return 0;
    return this.nodeBounds.byteLength + this.nodeLeftFirst.byteLength +
      this.nodeTriCount.byteLength + this.triIndices.byteLength;
  }

  /**
   * Grows the traversal stacks.
   * @param {number} needed
   * @returns {void}
   */
  _ensureStack(needed) {
    if (needed <= this._stack.length) return;
    let n = this._stack.length;
    while (n < needed) n *= 2;
    const s = new Int32Array(n);
    s.set(this._stack);
    const d = new Float32Array(n);
    d.set(this._dstack);
    this._stack = s;
    this._dstack = d;
  }

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------

  /**
   * Builds the hierarchy. Both buffers are kept by reference and must stay alive
   * (and unmodified) for as long as the BVH is queried.
   *
   * @param {Float32Array} positions Vertex positions, 3 floats per vertex.
   * @param {Uint32Array|Uint16Array|null} [indices] Triangle indices; pass null for a
   *   non-indexed soup where every 3 consecutive vertices form a triangle.
   * @param {number} [maxLeafTris] Maximum triangles per leaf.
   * @returns {TriangleBVH} `this`.
   */
  build(positions, indices = null, maxLeafTris = 8) {
    this.positions = positions;
    this.indices = indices;
    this.maxLeafTris = Math.max(1, maxLeafTris | 0);

    const triCount = indices !== null && indices !== undefined
      ? (indices.length / 3) | 0
      : (positions.length / 9) | 0;
    this.triCount = triCount;

    if (triCount === 0) {
      this.nodeCount = 0;
      this.triIndices = new Uint32Array(0);
      this.nodeBounds = new Float32Array(0);
      this.nodeLeftFirst = new Int32Array(0);
      this.nodeTriCount = new Int32Array(0);
      return this;
    }

    const triIndices = new Uint32Array(triCount);
    // Per triangle bounds and centroids. Both are build-time only and released at
    // the end so a large mesh does not keep 36 extra bytes per triangle resident.
    const triBounds = new Float32Array(triCount * 6);
    const centroids = new Float32Array(triCount * 3);

    for (let t = 0; t < triCount; t++) {
      triIndices[t] = t;

      let ia, ib, ic;
      if (indices !== null && indices !== undefined) {
        ia = indices[t * 3] * 3;
        ib = indices[t * 3 + 1] * 3;
        ic = indices[t * 3 + 2] * 3;
      } else {
        ia = t * 9;
        ib = t * 9 + 3;
        ic = t * 9 + 6;
      }

      const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
      const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
      const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

      const minX = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
      const minY = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
      const minZ = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz);
      const maxX = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
      const maxY = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
      const maxZ = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz);

      const o = t * 6;
      triBounds[o] = minX; triBounds[o + 1] = minY; triBounds[o + 2] = minZ;
      triBounds[o + 3] = maxX; triBounds[o + 4] = maxY; triBounds[o + 5] = maxZ;

      const c = t * 3;
      centroids[c] = (ax + bx + cx) * (1 / 3);
      centroids[c + 1] = (ay + by + cy) * (1 / 3);
      centroids[c + 2] = (az + bz + cz) * (1 / 3);
    }

    // A binary tree with at most `triCount` leaves needs at most 2*triCount-1 nodes.
    const maxNodes = triCount * 2;
    const nodeBounds = new Float32Array(maxNodes * 6);
    const nodeLeftFirst = new Int32Array(maxNodes);
    const nodeTriCount = new Int32Array(maxNodes);

    this.triIndices = triIndices;
    this.nodeBounds = nodeBounds;
    this.nodeLeftFirst = nodeLeftFirst;
    this.nodeTriCount = nodeTriCount;

    nodeLeftFirst[0] = 0;
    nodeTriCount[0] = triCount;
    this.nodeCount = 1;
    this._computeNodeBounds(0, triBounds);

    // Binning scratch.
    const binCount = new Int32Array(BIN_COUNT);
    const binBounds = new Float32Array(BIN_COUNT * 6);
    const leftArea = new Float32Array(BIN_COUNT);
    const leftCount = new Int32Array(BIN_COUNT);

    let stack = new Int32Array(256);
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp];
      const start = nodeLeftFirst[node];
      const count = nodeTriCount[node];
      if (count <= 1) continue;

      // Centroid bounds decide the split axis.
      let cminX = Infinity, cminY = Infinity, cminZ = Infinity;
      let cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
      for (let i = start, e = start + count; i < e; i++) {
        const c = triIndices[i] * 3;
        const x = centroids[c], y = centroids[c + 1], z = centroids[c + 2];
        if (x < cminX) cminX = x;
        if (y < cminY) cminY = y;
        if (z < cminZ) cminZ = z;
        if (x > cmaxX) cmaxX = x;
        if (y > cmaxY) cmaxY = y;
        if (z > cmaxZ) cmaxZ = z;
      }

      const ex = cmaxX - cminX;
      const ey = cmaxY - cminY;
      const ez = cmaxZ - cminZ;
      let axis = 0;
      let extent = ex;
      if (ey > extent) { axis = 1; extent = ey; }
      if (ez > extent) { axis = 2; extent = ez; }

      let leftSize = -1;

      if (extent > 1e-9) {
        const cmin = axis === 0 ? cminX : (axis === 1 ? cminY : cminZ);
        const scale = BIN_COUNT / extent;

        binCount.fill(0);
        for (let b = 0; b < BIN_COUNT; b++) {
          const o = b * 6;
          binBounds[o] = Infinity; binBounds[o + 1] = Infinity; binBounds[o + 2] = Infinity;
          binBounds[o + 3] = -Infinity; binBounds[o + 4] = -Infinity; binBounds[o + 5] = -Infinity;
        }

        for (let i = start, e = start + count; i < e; i++) {
          const t = triIndices[i];
          let b = ((centroids[t * 3 + axis] - cmin) * scale) | 0;
          if (b < 0) b = 0; else if (b >= BIN_COUNT) b = BIN_COUNT - 1;
          binCount[b]++;
          const bo = b * 6;
          const to = t * 6;
          if (triBounds[to] < binBounds[bo]) binBounds[bo] = triBounds[to];
          if (triBounds[to + 1] < binBounds[bo + 1]) binBounds[bo + 1] = triBounds[to + 1];
          if (triBounds[to + 2] < binBounds[bo + 2]) binBounds[bo + 2] = triBounds[to + 2];
          if (triBounds[to + 3] > binBounds[bo + 3]) binBounds[bo + 3] = triBounds[to + 3];
          if (triBounds[to + 4] > binBounds[bo + 4]) binBounds[bo + 4] = triBounds[to + 4];
          if (triBounds[to + 5] > binBounds[bo + 5]) binBounds[bo + 5] = triBounds[to + 5];
        }

        // Forward sweep: everything left of (and including) bin i.
        let lminX = Infinity, lminY = Infinity, lminZ = Infinity;
        let lmaxX = -Infinity, lmaxY = -Infinity, lmaxZ = -Infinity;
        let lcount = 0;
        for (let i = 0; i < BIN_COUNT - 1; i++) {
          const o = i * 6;
          if (binCount[i] > 0) {
            if (binBounds[o] < lminX) lminX = binBounds[o];
            if (binBounds[o + 1] < lminY) lminY = binBounds[o + 1];
            if (binBounds[o + 2] < lminZ) lminZ = binBounds[o + 2];
            if (binBounds[o + 3] > lmaxX) lmaxX = binBounds[o + 3];
            if (binBounds[o + 4] > lmaxY) lmaxY = binBounds[o + 4];
            if (binBounds[o + 5] > lmaxZ) lmaxZ = binBounds[o + 5];
            lcount += binCount[i];
          }
          leftCount[i] = lcount;
          leftArea[i] = lcount > 0 ? surfaceArea(lminX, lminY, lminZ, lmaxX, lmaxY, lmaxZ) : 0;
        }

        // Backward sweep: everything right of bin i.
        let rminX = Infinity, rminY = Infinity, rminZ = Infinity;
        let rmaxX = -Infinity, rmaxY = -Infinity, rmaxZ = -Infinity;
        let rcount = 0;
        let bestCost = Infinity;
        let bestSplit = -1;
        for (let i = BIN_COUNT - 2; i >= 0; i--) {
          const o = (i + 1) * 6;
          if (binCount[i + 1] > 0) {
            if (binBounds[o] < rminX) rminX = binBounds[o];
            if (binBounds[o + 1] < rminY) rminY = binBounds[o + 1];
            if (binBounds[o + 2] < rminZ) rminZ = binBounds[o + 2];
            if (binBounds[o + 3] > rmaxX) rmaxX = binBounds[o + 3];
            if (binBounds[o + 4] > rmaxY) rmaxY = binBounds[o + 4];
            if (binBounds[o + 5] > rmaxZ) rmaxZ = binBounds[o + 5];
            rcount += binCount[i + 1];
          }
          if (leftCount[i] === 0 || rcount === 0) continue;
          const rArea = surfaceArea(rminX, rminY, rminZ, rmaxX, rmaxY, rmaxZ);
          const cost = leftArea[i] * leftCount[i] + rArea * rcount;
          if (cost < bestCost) {
            bestCost = cost;
            bestSplit = i;
          }
        }

        if (bestSplit >= 0) {
          const no = node * 6;
          const parentArea = surfaceArea(
            nodeBounds[no], nodeBounds[no + 1], nodeBounds[no + 2],
            nodeBounds[no + 3], nodeBounds[no + 4], nodeBounds[no + 5]);
          const leafCost = count * parentArea;
          const splitCost = TRAVERSAL_COST * parentArea + bestCost;

          if (count > this.maxLeafTris || splitCost < leafCost) {
            // In-place partition against the chosen bin boundary.
            let i = start;
            let j = start + count - 1;
            while (i <= j) {
              const t = triIndices[i];
              let b = ((centroids[t * 3 + axis] - cmin) * scale) | 0;
              if (b < 0) b = 0; else if (b >= BIN_COUNT) b = BIN_COUNT - 1;
              if (b <= bestSplit) {
                i++;
              } else {
                triIndices[i] = triIndices[j];
                triIndices[j] = t;
                j--;
              }
            }
            leftSize = i - start;
          }
        }
      }

      // Fall back to a median split when SAH refused but the leaf is still too big.
      if (leftSize <= 0 || leftSize >= count) {
        if (count <= this.maxLeafTris) continue;
        leftSize = count >> 1;
      }

      const left = this.nodeCount++;
      const right = this.nodeCount++;
      nodeLeftFirst[left] = start;
      nodeTriCount[left] = leftSize;
      nodeLeftFirst[right] = start + leftSize;
      nodeTriCount[right] = count - leftSize;
      this._computeNodeBounds(left, triBounds);
      this._computeNodeBounds(right, triBounds);

      nodeLeftFirst[node] = left;
      nodeTriCount[node] = 0;

      if (sp + 2 > stack.length) {
        const bigger = new Int32Array(stack.length * 2);
        bigger.set(stack);
        stack = bigger;
      }
      stack[sp++] = left;
      stack[sp++] = right;
    }

    this._ensureStack(64);
    return this;
  }

  /**
   * Recomputes a node's bounds from the triangles it owns.
   * @param {number} node
   * @param {Float32Array} triBounds
   * @returns {void}
   */
  _computeNodeBounds(node, triBounds) {
    const triIndices = this.triIndices;
    const start = this.nodeLeftFirst[node];
    const count = this.nodeTriCount[node];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = start, e = start + count; i < e; i++) {
      const o = triIndices[i] * 6;
      if (triBounds[o] < minX) minX = triBounds[o];
      if (triBounds[o + 1] < minY) minY = triBounds[o + 1];
      if (triBounds[o + 2] < minZ) minZ = triBounds[o + 2];
      if (triBounds[o + 3] > maxX) maxX = triBounds[o + 3];
      if (triBounds[o + 4] > maxY) maxY = triBounds[o + 4];
      if (triBounds[o + 5] > maxZ) maxZ = triBounds[o + 5];
    }
    const no = node * 6;
    const nb = this.nodeBounds;
    nb[no] = minX; nb[no + 1] = minY; nb[no + 2] = minZ;
    nb[no + 3] = maxX; nb[no + 4] = maxY; nb[no + 5] = maxZ;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Copies the three vertices of a triangle.
   * @param {number} triIndex Triangle id in the original buffer order.
   * @param {{x:number,y:number,z:number}} a
   * @param {{x:number,y:number,z:number}} b
   * @param {{x:number,y:number,z:number}} c
   * @returns {void}
   */
  getTriangle(triIndex, a, b, c) {
    const positions = this.positions;
    const indices = this.indices;
    let ia, ib, ic;
    if (indices !== null && indices !== undefined) {
      ia = indices[triIndex * 3] * 3;
      ib = indices[triIndex * 3 + 1] * 3;
      ic = indices[triIndex * 3 + 2] * 3;
    } else {
      ia = triIndex * 9;
      ib = triIndex * 9 + 3;
      ic = triIndex * 9 + 6;
    }
    a.x = positions[ia]; a.y = positions[ia + 1]; a.z = positions[ia + 2];
    b.x = positions[ib]; b.y = positions[ib + 1]; b.z = positions[ib + 2];
    c.x = positions[ic]; c.y = positions[ic + 1]; c.z = positions[ic + 2];
  }

  /**
   * Copies the root bounds.
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} out
   * @returns {*} `out`.
   */
  getBounds(out) {
    if (this.nodeCount === 0) {
      out.min.x = Infinity; out.min.y = Infinity; out.min.z = Infinity;
      out.max.x = -Infinity; out.max.y = -Infinity; out.max.z = -Infinity;
      return out;
    }
    const nb = this.nodeBounds;
    out.min.x = nb[0]; out.min.y = nb[1]; out.min.z = nb[2];
    out.max.x = nb[3]; out.max.y = nb[4]; out.max.z = nb[5];
    return out;
  }

  // ---------------------------------------------------------------------------
  // Ray casting
  // ---------------------------------------------------------------------------

  /**
   * Finds the closest triangle hit by `ray`.
   *
   * Children are visited nearest first and the far child is skipped as soon as the
   * current best hit is closer than its box entry point.
   *
   * @param {{origin:{x:number,y:number,z:number}, direction:{x:number,y:number,z:number}}} ray
   *   Direction should be normalised for `t` to be a world-space distance.
   * @param {number} [maxDist]
   * @param {{t:number,u:number,v:number,triIndex:number,nx:number,ny:number,nz:number}} [out]
   *   Reused result object; a new one is created when omitted.
   * @param {boolean} [backfaceCulling] Ignore triangles seen from behind.
   * @returns {{t:number,u:number,v:number,triIndex:number,nx:number,ny:number,nz:number}|null}
   *   `out` when something was hit, otherwise null.
   */
  raycast(ray, maxDist = Infinity, out = null, backfaceCulling = false) {
    if (this.nodeCount === 0) return null;

    const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
    const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
    const invX = 1 / dx, invY = 1 / dy, invZ = 1 / dz;

    const nb = this.nodeBounds;
    const nodeLeftFirst = this.nodeLeftFirst;
    const nodeTriCount = this.nodeTriCount;
    const triIndices = this.triIndices;
    const positions = this.positions;
    const indices = this.indices;
    const hasIndices = indices !== null && indices !== undefined;

    let best = maxDist;
    let bestTri = -1;
    let bestU = 0;
    let bestV = 0;

    this._ensureStack(64);
    let sp = 0;

    let rootT = this._slabEnter(nb, 0, ox, oy, oz, invX, invY, invZ, best);
    if (rootT < 0) return null;
    this._stack[sp] = 0;
    this._dstack[sp] = rootT;
    sp++;

    while (sp > 0) {
      sp--;
      const node = this._stack[sp];
      if (this._dstack[sp] >= best) continue;

      const count = nodeTriCount[node];

      if (count > 0) {
        const start = nodeLeftFirst[node];
        for (let i = start, e = start + count; i < e; i++) {
          const tri = triIndices[i];
          let ia, ib, ic;
          if (hasIndices) {
            ia = indices[tri * 3] * 3;
            ib = indices[tri * 3 + 1] * 3;
            ic = indices[tri * 3 + 2] * 3;
          } else {
            ia = tri * 9;
            ib = tri * 9 + 3;
            ic = tri * 9 + 6;
          }

          const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
          const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az;
          const e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;

          // Moller-Trumbore.
          const pvx = dy * e2z - dz * e2y;
          const pvy = dz * e2x - dx * e2z;
          const pvz = dx * e2y - dy * e2x;
          const det = e1x * pvx + e1y * pvy + e1z * pvz;

          if (backfaceCulling) {
            if (det < EPSILON) continue;
          } else if (det > -EPSILON && det < EPSILON) {
            continue;
          }

          const invDet = 1 / det;
          const tvx = ox - ax, tvy = oy - ay, tvz = oz - az;
          const u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
          if (u < 0 || u > 1) continue;

          const qvx = tvy * e1z - tvz * e1y;
          const qvy = tvz * e1x - tvx * e1z;
          const qvz = tvx * e1y - tvy * e1x;
          const v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
          if (v < 0 || u + v > 1) continue;

          const t = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
          if (t < 0 || t >= best) continue;

          best = t;
          bestTri = tri;
          bestU = u;
          bestV = v;
        }
        continue;
      }

      const left = nodeLeftFirst[node];
      const right = left + 1;
      const tl = this._slabEnter(nb, left * 6, ox, oy, oz, invX, invY, invZ, best);
      const tr = this._slabEnter(nb, right * 6, ox, oy, oz, invX, invY, invZ, best);

      this._ensureStack(sp + 2);
      if (tl >= 0 && tr >= 0) {
        // Push the far child first so the near one is popped next.
        if (tl <= tr) {
          this._stack[sp] = right; this._dstack[sp] = tr; sp++;
          this._stack[sp] = left; this._dstack[sp] = tl; sp++;
        } else {
          this._stack[sp] = left; this._dstack[sp] = tl; sp++;
          this._stack[sp] = right; this._dstack[sp] = tr; sp++;
        }
      } else if (tl >= 0) {
        this._stack[sp] = left; this._dstack[sp] = tl; sp++;
      } else if (tr >= 0) {
        this._stack[sp] = right; this._dstack[sp] = tr; sp++;
      }
    }

    if (bestTri < 0) return null;

    const result = out !== null && out !== undefined
      ? out
      : { t: 0, u: 0, v: 0, triIndex: -1, nx: 0, ny: 0, nz: 0 };
    result.t = best;
    result.u = bestU;
    result.v = bestV;
    result.triIndex = bestTri;

    // Geometric normal of the winning triangle.
    let ia, ib, ic;
    if (hasIndices) {
      ia = indices[bestTri * 3] * 3;
      ib = indices[bestTri * 3 + 1] * 3;
      ic = indices[bestTri * 3 + 2] * 3;
    } else {
      ia = bestTri * 9;
      ib = bestTri * 9 + 3;
      ic = bestTri * 9 + 6;
    }
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az;
    const e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      const inv = 1 / len;
      nx *= inv; ny *= inv; nz *= inv;
    }
    result.nx = nx;
    result.ny = ny;
    result.nz = nz;
    return result;
  }

  /**
   * Branch-free slab test returning the entry distance, or -1 on a miss.
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

    if (tmax < 0 || tmin > tmax || tmin >= limit) return -1;
    return tmin < 0 ? 0 : tmin;
  }

  // ---------------------------------------------------------------------------
  // Overlap queries
  // ---------------------------------------------------------------------------

  /**
   * Collects the triangles whose bounds overlap `aabb`. `out` is emptied first.
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
   * @param {Array<number>} out
   * @returns {number} Number of triangle indices written to `out`.
   */
  queryAABB(aabb, out) {
    const mn = aabb.min;
    const mx = aabb.max;
    return this.queryAABBMinMax(mn.x, mn.y, mn.z, mx.x, mx.y, mx.z, out);
  }

  /**
   * Allocation-free variant of {@link TriangleBVH#queryAABB}.
   * @param {number} minX
   * @param {number} minY
   * @param {number} minZ
   * @param {number} maxX
   * @param {number} maxY
   * @param {number} maxZ
   * @param {Array<number>} out
   * @returns {number}
   */
  queryAABBMinMax(minX, minY, minZ, maxX, maxY, maxZ, out) {
    out.length = 0;
    if (this.nodeCount === 0) return 0;

    const nb = this.nodeBounds;
    const nodeLeftFirst = this.nodeLeftFirst;
    const nodeTriCount = this.nodeTriCount;
    const triIndices = this.triIndices;
    const positions = this.positions;
    const indices = this.indices;
    const hasIndices = indices !== null && indices !== undefined;

    this._ensureStack(64);
    let sp = 0;
    this._stack[sp++] = 0;
    let count = 0;

    while (sp > 0) {
      const node = this._stack[--sp];
      const o = node * 6;
      if (nb[o] > maxX || nb[o + 3] < minX ||
          nb[o + 1] > maxY || nb[o + 4] < minY ||
          nb[o + 2] > maxZ || nb[o + 5] < minZ) {
        continue;
      }

      const triCount = nodeTriCount[node];
      if (triCount > 0) {
        const start = nodeLeftFirst[node];
        for (let i = start, e = start + triCount; i < e; i++) {
          const tri = triIndices[i];
          let ia, ib, ic;
          if (hasIndices) {
            ia = indices[tri * 3] * 3;
            ib = indices[tri * 3 + 1] * 3;
            ic = indices[tri * 3 + 2] * 3;
          } else {
            ia = tri * 9;
            ib = tri * 9 + 3;
            ic = tri * 9 + 6;
          }
          const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
          const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
          const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

          if ((ax < minX && bx < minX && cx < minX) || (ax > maxX && bx > maxX && cx > maxX)) continue;
          if ((ay < minY && by < minY && cy < minY) || (ay > maxY && by > maxY && cy > maxY)) continue;
          if ((az < minZ && bz < minZ && cz < minZ) || (az > maxZ && bz > maxZ && cz > maxZ)) continue;

          out[count++] = tri;
        }
        continue;
      }

      const left = nodeLeftFirst[node];
      this._ensureStack(sp + 2);
      this._stack[sp++] = left;
      this._stack[sp++] = left + 1;
    }

    out.length = count;
    return count;
  }

  /**
   * Collects the triangles whose bounds overlap a sphere. `out` is emptied first.
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @param {number} radius
   * @param {Array<number>} out
   * @returns {number}
   */
  querySphere(cx, cy, cz, radius, out) {
    return this.queryAABBMinMax(
      cx - radius, cy - radius, cz - radius,
      cx + radius, cy + radius, cz + radius, out);
  }

  // ---------------------------------------------------------------------------
  // Closest point
  // ---------------------------------------------------------------------------

  /**
   * Finds the closest point on the triangle soup to `point`, pruning subtrees whose
   * box is already farther than the current best candidate.
   *
   * The triangle that produced the result is available through
   * {@link TriangleBVH#lastClosestTriIndex}.
   *
   * @param {{x:number,y:number,z:number}} point
   * @param {{x:number,y:number,z:number}} [out] Receives the surface point.
   * @returns {number} Distance to the surface, or Infinity for an empty BVH.
   */
  closestPointOnSurface(point, out) {
    this._lastClosestTri = -1;
    if (this.nodeCount === 0) return Infinity;

    const px = point.x, py = point.y, pz = point.z;
    const nb = this.nodeBounds;
    const nodeLeftFirst = this.nodeLeftFirst;
    const nodeTriCount = this.nodeTriCount;
    const triIndices = this.triIndices;
    const positions = this.positions;
    const indices = this.indices;
    const hasIndices = indices !== null && indices !== undefined;

    let best = Infinity;
    let bestX = 0, bestY = 0, bestZ = 0;
    let bestTri = -1;

    this._ensureStack(64);
    let sp = 0;
    this._stack[sp] = 0;
    this._dstack[sp] = 0;
    sp++;

    while (sp > 0) {
      sp--;
      const node = this._stack[sp];
      if (this._dstack[sp] >= best) continue;

      const count = nodeTriCount[node];
      if (count > 0) {
        const start = nodeLeftFirst[node];
        for (let i = start, e = start + count; i < e; i++) {
          const tri = triIndices[i];
          let ia, ib, ic;
          if (hasIndices) {
            ia = indices[tri * 3] * 3;
            ib = indices[tri * 3 + 1] * 3;
            ic = indices[tri * 3 + 2] * 3;
          } else {
            ia = tri * 9;
            ib = tri * 9 + 3;
            ic = tri * 9 + 6;
          }
          const d2 = closestPointOnTriangle(
            px, py, pz,
            positions[ia], positions[ia + 1], positions[ia + 2],
            positions[ib], positions[ib + 1], positions[ib + 2],
            positions[ic], positions[ic + 1], positions[ic + 2]);
          if (d2 < best) {
            best = d2;
            bestX = _closest[0];
            bestY = _closest[1];
            bestZ = _closest[2];
            bestTri = tri;
          }
        }
        continue;
      }

      const left = nodeLeftFirst[node];
      const right = left + 1;
      const dl = this._boxDistanceSq(nb, left * 6, px, py, pz);
      const dr = this._boxDistanceSq(nb, right * 6, px, py, pz);

      this._ensureStack(sp + 2);
      if (dl <= dr) {
        if (dr < best) { this._stack[sp] = right; this._dstack[sp] = dr; sp++; }
        if (dl < best) { this._stack[sp] = left; this._dstack[sp] = dl; sp++; }
      } else {
        if (dl < best) { this._stack[sp] = left; this._dstack[sp] = dl; sp++; }
        if (dr < best) { this._stack[sp] = right; this._dstack[sp] = dr; sp++; }
      }
    }

    if (bestTri < 0) return Infinity;
    this._lastClosestTri = bestTri;
    if (out !== undefined && out !== null) {
      out.x = bestX;
      out.y = bestY;
      out.z = bestZ;
    }
    return Math.sqrt(best);
  }

  /**
   * Squared distance from a point to a node's AABB (0 when inside).
   * @param {Float32Array} arr
   * @param {number} o
   * @param {number} px
   * @param {number} py
   * @param {number} pz
   * @returns {number}
   */
  _boxDistanceSq(arr, o, px, py, pz) {
    const dx = px < arr[o] ? arr[o] - px : (px > arr[o + 3] ? px - arr[o + 3] : 0);
    const dy = py < arr[o + 1] ? arr[o + 1] - py : (py > arr[o + 4] ? py - arr[o + 4] : 0);
    const dz = pz < arr[o + 2] ? arr[o + 2] - pz : (pz > arr[o + 5] ? pz - arr[o + 5] : 0);
    return dx * dx + dy * dy + dz * dz;
  }

  // ---------------------------------------------------------------------------
  // Serialisation
  // ---------------------------------------------------------------------------

  /**
   * Snapshots the hierarchy so it can be cached instead of rebuilt.
   *
   * Node arrays are trimmed copies; `triIndices`, `positions` and `indices` are
   * passed by reference, so the result is cheap to produce and its TypedArray
   * buffers can be transferred to a worker.
   *
   * @returns {{version:number, triCount:number, nodeCount:number, maxLeafTris:number,
   *   nodeBounds:Float32Array, nodeLeftFirst:Int32Array, nodeTriCount:Int32Array,
   *   triIndices:Uint32Array, positions:Float32Array|null,
   *   indices:Uint32Array|Uint16Array|null}}
   */
  serialize() {
    return {
      version: 1,
      triCount: this.triCount,
      nodeCount: this.nodeCount,
      maxLeafTris: this.maxLeafTris,
      nodeBounds: this.nodeBounds.slice(0, this.nodeCount * 6),
      nodeLeftFirst: this.nodeLeftFirst.slice(0, this.nodeCount),
      nodeTriCount: this.nodeTriCount.slice(0, this.nodeCount),
      triIndices: this.triIndices,
      positions: this.positions,
      indices: this.indices
    };
  }

  /**
   * Rebuilds an instance from {@link TriangleBVH#serialize} output.
   * @param {object} data
   * @param {Float32Array} [positions] Overrides `data.positions` (useful when the
   *   geometry was stored separately).
   * @param {Uint32Array|Uint16Array|null} [indices] Overrides `data.indices`.
   * @returns {TriangleBVH}
   */
  static deserialize(data, positions, indices) {
    if (data === null || data === undefined) {
      throw new Error('TriangleBVH.deserialize: dados ausentes.');
    }
    if (data.version !== 1) {
      throw new Error('TriangleBVH.deserialize: versao ' + data.version + ' nao suportada.');
    }

    const bvh = new TriangleBVH();
    bvh.positions = positions !== undefined && positions !== null ? positions : data.positions;
    bvh.indices = indices !== undefined ? indices : data.indices;
    bvh.triCount = data.triCount;
    bvh.nodeCount = data.nodeCount;
    bvh.maxLeafTris = data.maxLeafTris;
    bvh.nodeBounds = data.nodeBounds instanceof Float32Array
      ? data.nodeBounds
      : new Float32Array(data.nodeBounds);
    bvh.nodeLeftFirst = data.nodeLeftFirst instanceof Int32Array
      ? data.nodeLeftFirst
      : new Int32Array(data.nodeLeftFirst);
    bvh.nodeTriCount = data.nodeTriCount instanceof Int32Array
      ? data.nodeTriCount
      : new Int32Array(data.nodeTriCount);
    bvh.triIndices = data.triIndices instanceof Uint32Array
      ? data.triIndices
      : new Uint32Array(data.triIndices);

    if (bvh.positions === null || bvh.positions === undefined) {
      throw new Error('TriangleBVH.deserialize: posicoes ausentes.');
    }
    bvh._ensureStack(64);
    return bvh;
  }

  /**
   * Drops every buffer reference held by the hierarchy.
   * @returns {void}
   */
  dispose() {
    this.positions = null;
    this.indices = null;
    this.triIndices = null;
    this.nodeBounds = null;
    this.nodeLeftFirst = null;
    this.nodeTriCount = null;
    this.triCount = 0;
    this.nodeCount = 0;
    this._lastClosestTri = -1;
  }
}
