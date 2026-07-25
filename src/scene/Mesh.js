import { Node3D } from './Node3D.js';
import { Vec3 } from '../math/Vec3.js';
import { Mat3 } from '../math/Mat3.js';
import { Mat4 } from '../math/Mat4.js';
import { Sphere } from '../math/Sphere.js';
import { AABB } from '../math/AABB.js';
import { Ray } from '../math/Ray.js';
import { TriangleBVH } from '../spatial/TriangleBVH.js';

const _invMatrix = new Mat4();
const _normalMatrix = new Mat3();
const _localRay = new Ray();
const _va = new Vec3();
const _vb = new Vec3();
const _vc = new Vec3();
const _edge1 = new Vec3();
const _edge2 = new Vec3();
const _point = new Vec3();
const _normal = new Vec3();
const _sphere = new Sphere();
const _hit = { t: 0, triIndex: 0, u: 0, v: 0 };

/**
 * Returns the number of Float32 elements between two consecutive vertices of an
 * attribute, resolving both byte strides (GL convention) and element strides.
 * @param {Object} attr
 * @returns {number}
 */
function attributeElementStride(attr) {
  const size = attr.size > 0 ? attr.size : 3;
  const stride = attr.stride > 0 ? attr.stride : 0;
  if (stride === 0) return size;
  // A byte stride is always a multiple of 4 and at least size * 4.
  if (stride >= size * 4 && (stride & 3) === 0) return stride >> 2;
  return stride;
}

/**
 * Returns the offset in Float32 elements of the first component of an attribute.
 * @param {Object} attr
 * @returns {number}
 */
function attributeElementOffset(attr) {
  const offset = attr.offset > 0 ? attr.offset : 0;
  if (offset === 0) return 0;
  if ((offset & 3) === 0) return offset >> 2;
  return offset;
}

/**
 * Produces a tightly packed xyz Float32Array from a position attribute,
 * de-interleaving it when necessary.
 * @param {Object} attr
 * @returns {Float32Array}
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
 * Renderable node: a geometry drawn with one material (or one material per
 * geometry group).
 */
export class Mesh extends Node3D {
  isMesh = true;

  /** @type {import('../render/Geometry.js').Geometry|null} */
  geometry = null;
  /** @type {Object|Object[]|null} */
  material = null;

  /** World space bounding volumes, refreshed by `updateWorldBounds()`. */
  boundingSphereWorld = new Sphere();
  boundingBoxWorld = new AABB();

  /** @type {number} Proxy id inside `Scene.bvh`, -1 when not registered. */
  _bvhProxy = -1;

  /**
   * @type {number} World matrix version the broad phase proxy was built from.
   *
   * Compared by `Scene.updateMatrices` so that a world matrix updated outside
   * the scene walk — by anyone calling `updateWorldMatrix(true)` directly —
   * still refreshes the proxy. Without it such a mesh keeps the bounds it had
   * when it was added and disappears as soon as it moves.
   */
  _bvhVersion = -1;

  /** @private worldMatrixVersion used the last time bounds were rebuilt. */
  _boundsVersion = -1;
  /** @private Center of the last broadphase proxy, used to derive displacement. */
  _prevCenterX = 0;
  /** @private */
  _prevCenterY = 0;
  /** @private */
  _prevCenterZ = 0;

  /**
   * @param {import('../render/Geometry.js').Geometry|null} [geometry=null]
   * @param {Object|Object[]|null} [material=null]
   */
  constructor(geometry = null, material = null) {
    super('Mesh');
    this.geometry = geometry;
    this.material = material;
    this.castShadow = true;
    this.receiveShadow = true;
  }

  /**
   * Transforms the geometry bounds into world space. The work is skipped while
   * the world matrix does not change.
   * @param {boolean} [force=false]
   * @returns {Mesh} this
   */
  updateWorldBounds(force = false) {
    const geometry = this.geometry;
    if (geometry === null) return this;
    if (force === false && this._boundsVersion === this.worldMatrixVersion) return this;
    this._boundsVersion = this.worldMatrixVersion;

    if (geometry.boundingBox === null || geometry.boundingBox === undefined) geometry.computeBoundingBox();
    if (geometry.boundingSphere === null || geometry.boundingSphere === undefined) geometry.computeBoundingSphere();

    const box = geometry.boundingBox;
    const sphere = geometry.boundingSphere;
    if (box !== null && box !== undefined) {
      this.boundingBoxWorld.copy(box).applyMat4(this.worldMatrix);
    }
    if (sphere !== null && sphere !== undefined) {
      this.boundingSphereWorld.center.copy(sphere.center).applyMat4(this.worldMatrix);
      this.boundingSphereWorld.radius = sphere.radius * this.worldMatrix.getMaxScaleOnAxis();
    }
    return this;
  }

  /**
   * Lazily builds (and caches on the geometry) the triangle BVH used for
   * precise ray queries.
   * @returns {TriangleBVH|null}
   */
  getTriangleBVH() {
    const geometry = this.geometry;
    if (geometry === null) return null;
    if (geometry.drawMode !== undefined && geometry.drawMode !== 'triangles') return null;

    const cached = geometry._triangleBVH;
    const hasCache = cached !== undefined && cached !== null;
    if (hasCache === true && geometry._triangleBVHData !== undefined && geometry._triangleBVHData !== null) {
      return cached;
    }

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
    geometry._triangleBVHData = { positions: positions, indices: indices };

    // Another subsystem (collision) may have built the acceleration structure
    // already: reuse it and only rebuild the vertex lookup table.
    if (hasCache === true) return cached;

    const bvh = new TriangleBVH();
    bvh.build(positions, indices, 8);
    geometry._triangleBVH = bvh;
    return bvh;
  }

  /**
   * Drops the cached triangle BVH. Call it after mutating the geometry.
   * @returns {Mesh} this
   */
  invalidateTriangleBVH() {
    const geometry = this.geometry;
    if (geometry !== null) {
      geometry._triangleBVH = null;
      geometry._triangleBVHData = null;
    }
    return this;
  }

  /**
   * Ray / mesh intersection. The ray is transformed into local space and tested
   * against the triangle BVH; the resulting hit is reported in world space.
   * @param {Object} raycaster Provides `ray`, `near`, `far` and optionally `layers`.
   * @param {Array} intersects Output array, appended in place.
   * @returns {Array} intersects
   */
  raycast(raycaster, intersects) {
    if (this.geometry === null || this.visible === false) return intersects;
    const layers = raycaster.layers;
    if (typeof layers === 'number' && (layers & this.layers) === 0) return intersects;
    return this._raycastMatrix(raycaster, intersects, this.worldMatrix, -1);
  }

  /**
   * Core ray test against an arbitrary object-to-world matrix. Shared with
   * `InstancedMesh`, which calls it once per instance.
   * @protected
   * @param {Object} raycaster
   * @param {Array} intersects
   * @param {Mat4} matrix Object to world matrix.
   * @param {number} instanceId Instance index, -1 for a regular mesh.
   * @returns {Array} intersects
   */
  _raycastMatrix(raycaster, intersects, matrix, instanceId) {
    const geometry = this.geometry;
    if (geometry === null) return intersects;

    const worldRay = raycaster.ray;
    const near = typeof raycaster.near === 'number' ? raycaster.near : 0;
    const far = typeof raycaster.far === 'number' ? raycaster.far : Infinity;

    if (geometry.boundingSphere === null || geometry.boundingSphere === undefined) geometry.computeBoundingSphere();
    const localSphere = geometry.boundingSphere;
    if (localSphere !== null && localSphere !== undefined && localSphere.radius > 0) {
      _sphere.center.copy(localSphere.center).applyMat4(matrix);
      _sphere.radius = localSphere.radius * matrix.getMaxScaleOnAxis();
      if (_sphere.containsPoint(worldRay.origin) === false) {
        const tSphere = worldRay.intersectSphere(_sphere, _point);
        if (tSphere === -1 || tSphere > far) return intersects;
      }
    }

    const bvh = this.getTriangleBVH();
    if (bvh === null) return intersects;

    const e = matrix.elements;
    const s0 = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    const s1 = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    const s2 = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
    let minScale = s0 < s1 ? s0 : s1;
    if (s2 < minScale) minScale = s2;
    if (minScale <= 0) minScale = 1;

    _invMatrix.copy(matrix).invert();
    _localRay.origin.copy(worldRay.origin).applyMat4(_invMatrix);
    _localRay.direction.copy(worldRay.direction).transformDirection(_invMatrix);

    const localFar = far === Infinity ? Infinity : far / minScale;
    const result = bvh.raycast(_localRay, localFar, _hit);
    if (result === null || result === undefined) return intersects;

    const t = result.t;
    const u = result.u;
    const v = result.v;
    const triIndex = result.triIndex;

    _localRay.at(t, _point);
    _point.applyMat4(matrix);
    const distance = worldRay.origin.distanceTo(_point);
    if (distance < near || distance > far) return intersects;

    const data = geometry._triangleBVHData;
    const positions = data.positions;
    const indices = data.indices;
    const i0 = indices[triIndex * 3] * 3;
    const i1 = indices[triIndex * 3 + 1] * 3;
    const i2 = indices[triIndex * 3 + 2] * 3;
    _va.set(positions[i0], positions[i0 + 1], positions[i0 + 2]);
    _vb.set(positions[i1], positions[i1 + 1], positions[i1 + 2]);
    _vc.set(positions[i2], positions[i2 + 1], positions[i2 + 2]);
    _edge1.subVectors(_vb, _va);
    _edge2.subVectors(_vc, _va);
    _normal.crossVectors(_edge1, _edge2).normalize();
    _normalMatrix.getNormalMatrix(matrix);
    _normal.applyMat3(_normalMatrix).normalize();

    const intersection = {
      distance: distance,
      point: new Vec3().copy(_point),
      normal: new Vec3().copy(_normal),
      object: this,
      faceIndex: triIndex,
      instanceId: instanceId,
      uv: null
    };

    const uvAttr = typeof geometry.getAttribute === 'function' ? geometry.getAttribute('aUV0') : null;
    if (uvAttr !== null && uvAttr !== undefined && uvAttr.data !== undefined) {
      const stride = attributeElementStride(uvAttr);
      const offset = attributeElementOffset(uvAttr);
      const uvData = uvAttr.data;
      const a = indices[triIndex * 3];
      const b = indices[triIndex * 3 + 1];
      const c = indices[triIndex * 3 + 2];
      const w = 1 - u - v;
      const ax = offset + a * stride;
      const bx = offset + b * stride;
      const cx = offset + c * stride;
      intersection.uv = {
        x: uvData[ax] * w + uvData[bx] * u + uvData[cx] * v,
        y: uvData[ax + 1] * w + uvData[bx + 1] * u + uvData[cx + 1] * v
      };
    }

    intersects.push(intersection);
    return intersects;
  }

  /**
   * @param {number} index Group / material index.
   * @returns {Object|null} The material used by that group.
   */
  getMaterial(index) {
    const material = this.material;
    if (material === null) return null;
    if (Array.isArray(material)) return material[index] !== undefined ? material[index] : material[0];
    return material;
  }

  /** @protected */
  _disposeSelf() {
    super._disposeSelf();
    this._bvhProxy = -1;
    this.geometry = null;
    this.material = null;
  }
}
