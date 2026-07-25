/**
 * @file Raycaster.js
 * World space ray queries against the scene graph.
 *
 * Broad phase: the scene's {@link DynamicBVH} is traversed in nearest-first
 * order. Narrow phase: the ray is transformed into each candidate's local space
 * (by the inverse of its world matrix) and tested against the geometry's
 * {@link TriangleBVH}. Transforming one ray is orders of magnitude cheaper than
 * transforming every triangle, and it lets several instances share one BVH.
 *
 * Nothing is allocated during a query: every intersection record comes from an
 * internal {@link Pool} and is handed back with
 * {@link Raycaster#releaseIntersections}. The only exception is the output array
 * itself and the records produced by user supplied `raycast()` implementations
 * on non-mesh objects.
 *
 * KNOWN LIMITATIONS
 * - One hit per object (per instance for an InstancedMesh): the triangle BVH
 *   reports the closest triangle, not every triangle the ray crosses. This is
 *   what picking needs; use several casts to walk through a shell.
 * - Geometries whose `drawMode` is not `'triangles'` are never hit.
 * - Skinned meshes are tested against their *bind pose* geometry, because the
 *   skinning happens on the GPU and no deformed copy exists on the CPU.
 * - Morph targets are ignored for the same reason.
 */

import { Vec3 } from '../math/Vec3.js';
import { Mat3 } from '../math/Mat3.js';
import { Mat4 } from '../math/Mat4.js';
import { Ray } from '../math/Ray.js';
import { Sphere } from '../math/Sphere.js';
import { Pool } from '../core/Pool.js';
import { TriangleBVH } from '../spatial/TriangleBVH.js';

/** Number of floats in a mat4. */
const MATRIX_COMPONENTS = 16;

/** Module scoped scratch - the hot path never allocates. */
const _invMatrix = new Mat4();
const _objectMatrix = new Mat4();
const _normalMatrix = new Mat3();
const _localRay = new Ray();
const _worldSphere = new Sphere();
const _point = new Vec3();
const _normal = new Vec3();
const _hit = { t: 0, u: 0, v: 0, triIndex: -1, nx: 0, ny: 0, nz: 0 };

/**
 * Number of Float32 elements between two consecutive vertices of an attribute.
 * Resolves both byte strides (the GL convention) and element strides.
 * @param {Object} attr Geometry attribute descriptor.
 * @returns {number} Stride in array elements.
 */
function attributeElementStride(attr) {
  const size = attr.size > 0 ? attr.size : 3;
  const stride = attr.stride > 0 ? attr.stride : 0;
  if (stride === 0) return size;
  if (stride >= size * 4 && (stride & 3) === 0) return stride >> 2;
  return stride;
}

/**
 * Offset, in Float32 elements, of the first component of an attribute.
 * @param {Object} attr Geometry attribute descriptor.
 * @returns {number} Offset in array elements.
 */
function attributeElementOffset(attr) {
  const offset = attr.offset > 0 ? attr.offset : 0;
  if (offset === 0) return 0;
  if ((offset & 3) === 0) return offset >> 2;
  return offset;
}

/**
 * Produces a tightly packed xyz Float32Array from a position attribute,
 * de-interleaving it when necessary. The attribute array is returned as-is when
 * it is already tightly packed, so no copy is made in the common case.
 * @param {Object} attr Position attribute descriptor.
 * @returns {Float32Array} Packed positions.
 */
function packPositions(attr) {
  const data = attr.data;
  const size = attr.size > 0 ? attr.size : 3;
  const elemStride = attributeElementStride(attr);
  const elemOffset = attributeElementOffset(attr);
  if (elemStride === 3 && elemOffset === 0 && size === 3 && data instanceof Float32Array) return data;
  const count = attr.count > 0 ? attr.count : Math.floor((data.length - elemOffset) / elemStride);
  const out = new Float32Array(count * 3);
  for (let i = 0, o = elemOffset, w = 0; i < count; i++, o += elemStride, w += 3) {
    out[w] = data[o];
    out[w + 1] = data[o + 1];
    out[w + 2] = data[o + 2];
  }
  return out;
}

/**
 * Returns (building it once and caching it on the geometry) everything needed to
 * ray test or collide against a mesh: the triangle BVH plus the packed position
 * and index buffers it was built from.
 *
 * The cache is shared with `Mesh.getTriangleBVH()` (`geometry._triangleBVH` and
 * `geometry._triangleBVHData`), so picking and physics never build it twice.
 * Call `mesh.invalidateTriangleBVH()` after mutating the geometry.
 *
 * @param {Object} mesh Mesh-like object exposing `geometry`.
 * @returns {{positions:Float32Array, indices:Uint32Array|Uint16Array, bvh:TriangleBVH}|null}
 *   The triangle data, or null when the geometry cannot be ray tested.
 */
export function getMeshTriangleData(mesh) {
  if (mesh === null || mesh === undefined) return null;
  const geometry = mesh.geometry;
  if (geometry === null || geometry === undefined) return null;
  if (geometry.drawMode !== undefined && geometry.drawMode !== 'triangles') return null;

  let data = geometry._triangleBVHData;
  let bvh = geometry._triangleBVH;
  if (data !== undefined && data !== null && bvh !== undefined && bvh !== null) {
    if (data.bvh !== bvh) data.bvh = bvh;
    return data;
  }

  // Let the Mesh build it when it can: that keeps a single owner for the cache.
  if (typeof mesh.getTriangleBVH === 'function') {
    bvh = mesh.getTriangleBVH();
    data = geometry._triangleBVHData;
    if (bvh !== null && bvh !== undefined && data !== null && data !== undefined) {
      data.bvh = bvh;
      return data;
    }
    if (bvh === null || bvh === undefined) return null;
  }

  // Standalone fallback (plain geometry holder without the Mesh helpers).
  const posAttr = typeof geometry.getAttribute === 'function' ? geometry.getAttribute('aPosition') : null;
  if (posAttr === null || posAttr === undefined || posAttr.data === undefined) return null;

  const positions = packPositions(posAttr);
  let indices = null;
  if (geometry.index !== null && geometry.index !== undefined && geometry.index.data !== undefined) {
    indices = geometry.index.data;
  } else {
    const vertexCount = (positions.length / 3) | 0;
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }

  if (bvh === null || bvh === undefined) {
    bvh = new TriangleBVH();
    bvh.build(positions, indices, 8);
  }

  data = { positions: positions, indices: indices, bvh: bvh };
  geometry._triangleBVHData = data;
  geometry._triangleBVH = bvh;
  return data;
}

/**
 * Factory for pooled intersection records.
 * @returns {Object} A blank record.
 */
function createIntersection() {
  return {
    distance: 0,
    point: new Vec3(),
    normal: new Vec3(),
    /** @type {{x:number,y:number}|null} Barycentric UV0, or null when absent. */
    uv: null,
    /** @type {Object|null} */
    object: null,
    faceIndex: -1,
    instanceId: -1,
    /** @private Persistent storage behind `uv`. */
    _uv: { x: 0, y: 0 },
    /** @private Marks records owned by the pool. */
    _pooled: true
  };
}

/**
 * Reset callback for pooled intersection records.
 * @param {Object} r Record being released.
 * @returns {void}
 */
function resetIntersection(r) {
  r.object = null;
  r.uv = null;
  r.faceIndex = -1;
  r.instanceId = -1;
  r.distance = 0;
}

/**
 * Stable insertion sort of an intersection list by ascending distance.
 * Hit lists are short, so this beats `Array.prototype.sort` and never allocates.
 * @param {Array<Object>} list Intersections, sorted in place.
 * @returns {void}
 */
function sortByDistance(list) {
  for (let i = 1, n = list.length; i < n; i++) {
    const item = list[i];
    const d = item.distance;
    let j = i - 1;
    while (j >= 0 && list[j].distance > d) {
      list[j + 1] = list[j];
      j--;
    }
    list[j + 1] = item;
  }
}

/**
 * Casts rays through a scene and reports precise triangle intersections.
 */
export class Raycaster {
  /** @type {Ray} World space ray. */
  ray;
  /** @type {number} Hits closer than this are discarded. */
  near = 0;
  /** @type {number} Hits farther than this are discarded. */
  far = Infinity;
  /** @type {number} Layer mask; an object is tested when `object.layers & layers`. */
  layers = 0xffffffff;
  /** @type {boolean} Stop at the first (closest) hit - much faster for picking. */
  firstHitOnly = false;
  /** @type {boolean} Skip objects whose `visible` flag is false. */
  ignoreInvisible = true;
  /** @type {boolean} Ignore triangles seen from behind. */
  backfaceCulling = false;

  /**
   * @param {Vec3} [origin] World space origin.
   * @param {Vec3} [direction] World space direction (normalized).
   * @param {number} [near=0] Minimum hit distance.
   * @param {number} [far=Infinity] Maximum hit distance.
   */
  constructor(origin, direction, near = 0, far = Infinity) {
    this.ray = new Ray(origin, direction);
    this.near = near;
    this.far = far;

    /** @private @type {Array<Object>} Output array of the query in flight. */
    this._out = null;
    /** @private @type {number} Current distance cut-off (shrinks when firstHitOnly). */
    this._limit = far;
    /** @private @type {Pool} */
    this._pool = new Pool(createIntersection, resetIntersection, 16);

    const self = this;
    /**
     * @private Bound broad phase callback. Created once so the query loop stays
     * closure free.
     */
    this._bvhVisit = function (userData, proxyId, tEnter) {
      return self._visitProxy(userData, tEnter);
    };
  }

  /**
   * @param {Vec3} origin World space origin.
   * @param {Vec3} direction World space direction (should be normalized).
   * @returns {Raycaster} this
   */
  set(origin, direction) {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction).normalize();
    return this;
  }

  /**
   * Allocation free setter.
   * @param {number} ox Origin x.
   * @param {number} oy Origin y.
   * @param {number} oz Origin z.
   * @param {number} dx Direction x.
   * @param {number} dy Direction y.
   * @param {number} dz Direction z.
   * @returns {Raycaster} this
   */
  setValues(ox, oy, oz, dx, dy, dz) {
    this.ray.origin.set(ox, oy, oz);
    this.ray.direction.set(dx, dy, dz).normalize();
    return this;
  }

  /**
   * Builds the ray from a normalized device coordinate pair.
   *
   * The origin is placed on the camera's near plane (the convention used by
   * `Camera.ndcToRay` / `Camera.screenPointToRay`), so reported distances are
   * measured from the near plane, not from the camera pivot.
   *
   * @param {number} ndcX -1 (left) .. 1 (right).
   * @param {number} ndcY -1 (bottom) .. 1 (top).
   * @param {Object} camera Camera exposing `ndcToRay` or `projectionMatrixInverse`.
   * @returns {Raycaster} this
   */
  setFromCamera(ndcX, ndcY, camera) {
    if (typeof camera.ndcToRay === 'function') {
      camera.ndcToRay(ndcX, ndcY, this.ray);
      return this;
    }
    if (typeof camera.unproject === 'function') {
      camera.unproject(ndcX, ndcY, -1, this.ray.origin);
      camera.unproject(ndcX, ndcY, 1, _point);
      this.ray.direction.copy(_point).sub(this.ray.origin).normalize();
      return this;
    }
    // Last resort: rebuild the unprojection by hand.
    const ip = camera.projectionMatrixInverse;
    const world = camera.worldMatrix;
    if (ip === undefined || world === undefined) {
      throw new Error('Raycaster.setFromCamera: camera invalida (sem ndcToRay/unproject/projectionMatrixInverse).');
    }
    this._unprojectManual(ip, world, ndcX, ndcY, -1, this.ray.origin);
    this._unprojectManual(ip, world, ndcX, ndcY, 1, _point);
    this.ray.direction.copy(_point).sub(this.ray.origin).normalize();
    return this;
  }

  /**
   * Manual NDC -> world unprojection used when the camera exposes no helper.
   * @private
   * @param {Mat4} invProj Inverse projection matrix.
   * @param {Mat4} world Camera world matrix.
   * @param {number} ndcX Normalized device x.
   * @param {number} ndcY Normalized device y.
   * @param {number} ndcZ Normalized device z.
   * @param {Vec3} out Receives the world position.
   * @returns {Vec3} out
   */
  _unprojectManual(invProj, world, ndcX, ndcY, ndcZ, out) {
    const e = invProj.elements;
    const vx = e[0] * ndcX + e[4] * ndcY + e[8] * ndcZ + e[12];
    const vy = e[1] * ndcX + e[5] * ndcY + e[9] * ndcZ + e[13];
    const vz = e[2] * ndcX + e[6] * ndcY + e[10] * ndcZ + e[14];
    const vw = e[3] * ndcX + e[7] * ndcY + e[11] * ndcZ + e[15];
    const inv = vw !== 0 ? 1 / vw : 1;
    out.set(vx * inv, vy * inv, vz * inv);
    return out.applyMat4(world);
  }

  /* ------------------------------------------------------------------ */
  /* Public queries                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Tests a single object (and optionally its sub tree).
   * @param {Object} object Node to test.
   * @param {boolean} [recursive=false] Also test descendants.
   * @param {Array<Object>} [out] Output array; emptied before the query.
   * @returns {Array<Object>} Hits sorted by ascending distance.
   */
  intersectObject(object, recursive = false, out = []) {
    this._begin(out);
    this._collect(object, recursive);
    return this._end();
  }

  /**
   * Tests a list of objects.
   * @param {Array<Object>} objects Nodes to test.
   * @param {boolean} [recursive=false] Also test descendants.
   * @param {Array<Object>} [out] Output array; emptied before the query.
   * @returns {Array<Object>} Hits sorted by ascending distance.
   */
  intersectObjects(objects, recursive = false, out = []) {
    this._begin(out);
    for (let i = 0, n = objects.length; i < n; i++) this._collect(objects[i], recursive);
    return this._end();
  }

  /**
   * Tests a whole scene, using its broad phase when available.
   * @param {Object} scene Scene exposing `bvh` (or at least `meshes`).
   * @param {Array<Object>} [out] Output array; emptied before the query.
   * @returns {Array<Object>} Hits sorted by ascending distance.
   */
  intersectScene(scene, out = []) {
    this._begin(out);

    const bvh = scene.bvh;
    if (bvh !== undefined && bvh !== null && typeof bvh.raycast === 'function' && bvh.proxyCount > 0) {
      const limit = this.far === Infinity ? Number.MAX_VALUE : this.far;
      bvh.raycast(this.ray, limit, this._bvhVisit);
    } else if (Array.isArray(scene.meshes) === true && scene.meshes.length > 0) {
      const meshes = scene.meshes;
      for (let i = 0, n = meshes.length; i < n; i++) this._testObject(meshes[i]);
    } else {
      this._collect(scene, true);
    }

    return this._end();
  }

  /**
   * Convenience wrapper returning only the closest hit of a scene query.
   * The record stays owned by the caller until
   * {@link Raycaster#releaseIntersection} is called.
   * @param {Object} scene Scene to test.
   * @param {Array<Object>} [scratch] Reusable array, avoids allocating one.
   * @returns {Object|null} The closest hit, or null.
   */
  raycastScene(scene, scratch) {
    const list = scratch !== undefined && scratch !== null ? scratch : [];
    const previous = this.firstHitOnly;
    this.firstHitOnly = true;
    this.intersectScene(scene, list);
    this.firstHitOnly = previous;
    if (list.length === 0) return null;
    // Release everything but the winner.
    for (let i = 1, n = list.length; i < n; i++) this.releaseIntersection(list[i]);
    const first = list[0];
    list.length = 0;
    return first;
  }

  /**
   * Hands a list of intersection records back to the internal pool and empties
   * the array. Records produced by user `raycast()` implementations are simply
   * dropped for the garbage collector.
   * @param {Array<Object>} list Intersections previously returned by a query.
   * @returns {void}
   */
  releaseIntersections(list) {
    if (list === null || list === undefined) return;
    for (let i = 0, n = list.length; i < n; i++) this.releaseIntersection(list[i]);
    list.length = 0;
  }

  /**
   * Hands a single intersection record back to the pool.
   * @param {Object} record Intersection record.
   * @returns {void}
   */
  releaseIntersection(record) {
    if (record !== null && record !== undefined && record._pooled === true) this._pool.release(record);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Prepares a query.
   * @private
   * @param {Array<Object>} out Output array.
   * @returns {void}
   */
  _begin(out) {
    out.length = 0;
    this._out = out;
    this._limit = this.far;
  }

  /**
   * Finishes a query: sorts the hits and drops the internal reference.
   * @private
   * @returns {Array<Object>} The output array.
   */
  _end() {
    const out = this._out;
    this._out = null;
    sortByDistance(out);
    return out;
  }

  /**
   * Broad phase callback. The BVH pops proxies in nearest-first order, so the
   * traversal can stop as soon as a proxy starts beyond the best hit.
   * @private
   * @param {Object} object Proxy user data (a mesh).
   * @param {number} tEnter Entry distance of the proxy box.
   * @returns {number|boolean} New traversal limit, or false to stop.
   */
  _visitProxy(object, tEnter) {
    if (tEnter > this._limit) return false;
    this._testObject(object);
    return this.firstHitOnly === true ? this._limit : -1;
  }

  /**
   * Tests an object and, when asked, its descendants.
   * @private
   * @param {Object} object Node to test.
   * @param {boolean} recursive Walk the children too.
   * @returns {void}
   */
  _collect(object, recursive) {
    if (object === null || object === undefined) return;
    if (this.ignoreInvisible === true && object.visible === false) return;

    this._testObject(object);

    if (recursive !== true) return;
    const children = object.children;
    if (children === undefined || children === null) return;
    for (let i = 0, n = children.length; i < n; i++) this._collect(children[i], true);
  }

  /**
   * Dispatches one object to the right narrow phase.
   * @private
   * @param {Object} object Node to test.
   * @returns {void}
   */
  _testObject(object) {
    if (object === null || object === undefined) return;
    if (this.ignoreInvisible === true && object.visible === false) return;
    const layers = object.layers;
    if (typeof layers === 'number' && (layers & this.layers) === 0) return;

    if (object.isMesh === true) {
      const data = getMeshTriangleData(object);
      if (data !== null) {
        this._testMesh(object, data);
        return;
      }
    }
    // Custom pickable (sprites, helpers, user classes).
    if (typeof object.raycast === 'function') object.raycast(this, this._out);
  }

  /**
   * Tests every transform a mesh contributes (one, or one per instance).
   * @private
   * @param {Object} mesh Mesh or InstancedMesh.
   * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Triangle data.
   * @returns {void}
   */
  _testMesh(mesh, data) {
    if (mesh.isInstancedMesh === true) {
      const matrices = mesh.instanceMatrix;
      if (matrices === null || matrices === undefined) return;
      for (let i = 0, n = mesh.count; i < n; i++) {
        _objectMatrix.fromArray(matrices, i * MATRIX_COMPONENTS);
        _objectMatrix.premultiply(mesh.worldMatrix);
        this._testMatrix(mesh, data, _objectMatrix, i);
      }
      return;
    }
    this._testMatrix(mesh, data, mesh.worldMatrix, -1);
  }

  /**
   * Narrow phase against a single object-to-world matrix.
   * @private
   * @param {Object} mesh Owning mesh (reported as `object`).
   * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Triangle data.
   * @param {Mat4} matrix Object to world matrix.
   * @param {number} instanceId Instance index, or -1.
   * @returns {void}
   */
  _testMatrix(mesh, data, matrix, instanceId) {
    const bvh = data.bvh;
    if (bvh === null || bvh === undefined || bvh.nodeCount === 0) return;

    const geometry = mesh.geometry;
    const worldRay = this.ray;
    const far = this._limit;

    const e = matrix.elements;
    const sx = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    const sy = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    const sz = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
    let minScale = sx < sy ? sx : sy;
    if (sz < minScale) minScale = sz;
    let maxScale = sx > sy ? sx : sy;
    if (sz > maxScale) maxScale = sz;
    if (minScale <= 0) minScale = 1;
    if (maxScale <= 0) maxScale = 1;

    // Cheap world space sphere rejection before paying for the inverse.
    if ((geometry.boundingSphere === null || geometry.boundingSphere === undefined) &&
        typeof geometry.computeBoundingSphere === 'function') {
      geometry.computeBoundingSphere();
    }
    const localSphere = geometry.boundingSphere;
    if (localSphere !== null && localSphere !== undefined && localSphere.radius > 0) {
      _worldSphere.center.copy(localSphere.center).applyMat4(matrix);
      _worldSphere.radius = localSphere.radius * maxScale;
      if (_worldSphere.containsPoint(worldRay.origin) === false) {
        const tSphere = worldRay.intersectSphere(_worldSphere, null);
        if (tSphere === -1 || tSphere > far) return;
      }
    }

    _invMatrix.copy(matrix).invert();
    _localRay.origin.copy(worldRay.origin).applyMat4(_invMatrix);
    _localRay.direction.copy(worldRay.direction).transformDirection(_invMatrix);

    const localFar = far === Infinity ? Infinity : far / minScale;
    const result = bvh.raycast(_localRay, localFar, _hit, this.backfaceCulling);
    if (result === null || result === undefined) return;

    // Exact world distance: the local `t` is only a distance in local units.
    _localRay.at(result.t, _point);
    _point.applyMat4(matrix);
    const distance = worldRay.origin.distanceTo(_point);
    if (distance < this.near || distance > this._limit) return;

    _normal.set(result.nx, result.ny, result.nz);
    _normalMatrix.getNormalMatrix(matrix);
    _normal.applyMat3(_normalMatrix).normalize();

    this._pushHit(mesh, geometry, data, distance, result.triIndex, result.u, result.v, instanceId);
  }

  /**
   * Appends a pooled intersection record.
   * @private
   * @param {Object} mesh Hit object.
   * @param {Object} geometry Its geometry.
   * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Triangle data.
   * @param {number} distance World distance.
   * @param {number} triIndex Triangle index.
   * @param {number} u First barycentric coordinate.
   * @param {number} v Second barycentric coordinate.
   * @param {number} instanceId Instance index, or -1.
   * @returns {void}
   */
  _pushHit(mesh, geometry, data, distance, triIndex, u, v, instanceId) {
    const record = this._pool.acquire();
    record.distance = distance;
    record.point.copy(_point);
    record.normal.copy(_normal);
    record.object = mesh;
    record.faceIndex = triIndex;
    record.instanceId = instanceId;
    record.uv = null;

    const uvAttr = typeof geometry.getAttribute === 'function' ? geometry.getAttribute('aUV0') : null;
    if (uvAttr !== null && uvAttr !== undefined && uvAttr.data !== undefined) {
      const indices = data.indices;
      const stride = attributeElementStride(uvAttr);
      const offset = attributeElementOffset(uvAttr);
      const uvData = uvAttr.data;
      const a = indices[triIndex * 3];
      const b = indices[triIndex * 3 + 1];
      const c = indices[triIndex * 3 + 2];
      const w = 1 - u - v;
      const ao = offset + a * stride;
      const bo = offset + b * stride;
      const co = offset + c * stride;
      record._uv.x = uvData[ao] * w + uvData[bo] * u + uvData[co] * v;
      record._uv.y = uvData[ao + 1] * w + uvData[bo + 1] * u + uvData[co + 1] * v;
      record.uv = record._uv;
    }

    this._out.push(record);
    if (this.firstHitOnly === true && distance < this._limit) this._limit = distance;
  }

  /**
   * Drops every retained resource.
   * @returns {void}
   */
  dispose() {
    this._pool.clear();
    this._out = null;
  }
}
