import { Node3D } from './Node3D.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';
import { Frustum } from '../math/Frustum.js';
import { Ray } from '../math/Ray.js';

const _v1 = new Vec3();
const _v2 = new Vec3();

/**
 * Base camera. Subclasses only have to implement `updateProjection()` and the
 * change detection used by `updateProjectionIfNeeded()`.
 *
 * Convention: right handed, the camera looks down its local -Z axis, +Y is up.
 * `viewMatrix` is the inverse of `worldMatrix` computed with a fast affine
 * inverse that also supports (orthogonal) non uniform scale.
 */
export class Camera extends Node3D {
  isCamera = true;

  viewMatrix = new Mat4();
  projectionMatrix = new Mat4();
  projectionMatrixInverse = new Mat4();
  viewProjectionMatrix = new Mat4();
  frustum = new Frustum();

  near = 0.1;
  far = 1000;

  /** @private Set by subclasses when a projection parameter changed. */
  _projectionDirty = true;
  /** @private worldMatrixVersion used the last time the view matrix was built. */
  _viewVersion = -1;

  /**
   * @param {string} [name='Camera']
   */
  constructor(name = 'Camera') {
    super(name);
  }

  /**
   * Rebuilds the projection matrix and its inverse. The base implementation
   * only refreshes the inverse, which is what a camera driven by a hand
   * authored projection matrix needs.
   * @returns {Camera} this
   */
  updateProjection() {
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    this._projectionDirty = false;
    return this;
  }

  /**
   * Rebuilds the projection matrix only when one of its parameters changed.
   * @returns {Camera} this
   */
  updateProjectionIfNeeded() {
    if (this._projectionDirty === true) this.updateProjection();
    return this;
  }

  /**
   * Rebuilds `viewMatrix` from `worldMatrix` using a fast affine inverse.
   * @param {boolean} [force=false] Rebuild even when the world matrix did not change.
   * @returns {Camera} this
   */
  updateViewMatrix(force = false) {
    this.updateProjectionIfNeeded();
    if (force === false && this._viewVersion === this.worldMatrixVersion) return this;
    this._viewVersion = this.worldMatrixVersion;

    const e = this.worldMatrix.elements;
    const v = this.viewMatrix.elements;

    let sx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    let sy = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
    let sz = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    sx = sx > 0 ? 1 / sx : 0;
    sy = sy > 0 ? 1 / sy : 0;
    sz = sz > 0 ? 1 / sz : 0;

    // Inverse of an orthogonal-basis affine matrix: rows of the inverse are the
    // columns of the original divided by the squared axis length.
    v[0] = e[0] * sx; v[4] = e[1] * sx; v[8] = e[2] * sx;
    v[1] = e[4] * sy; v[5] = e[5] * sy; v[9] = e[6] * sy;
    v[2] = e[8] * sz; v[6] = e[9] * sz; v[10] = e[10] * sz;
    v[3] = 0; v[7] = 0; v[11] = 0; v[15] = 1;

    const tx = e[12];
    const ty = e[13];
    const tz = e[14];
    v[12] = -(v[0] * tx + v[4] * ty + v[8] * tz);
    v[13] = -(v[1] * tx + v[5] * ty + v[9] * tz);
    v[14] = -(v[2] * tx + v[6] * ty + v[10] * tz);
    return this;
  }

  /**
   * Recomposes `viewProjectionMatrix` and extracts the frustum planes.
   * @returns {Camera} this
   */
  updateFrustum() {
    this.viewProjectionMatrix.multiplyMatrices(this.projectionMatrix, this.viewMatrix);
    this.frustum.setFromProjectionMatrix(this.viewProjectionMatrix);
    return this;
  }

  /**
   * Convenience: view matrix, view projection matrix and frustum in one call.
   * @returns {Camera} this
   */
  updateCamera() {
    this.updateViewMatrix();
    this.updateFrustum();
    return this;
  }

  /**
   * Projects a world space point to viewport pixels.
   * @param {Vec3} v World space point.
   * @param {number} viewportW
   * @param {number} viewportH
   * @param {Vec3} out Receives (pixelX, pixelY, ndcZ).
   * @returns {Vec3} out
   */
  worldToScreen(v, viewportW, viewportH, out) {
    const m = this.viewProjectionMatrix.elements;
    const x = v.x;
    const y = v.y;
    const z = v.z;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    const inv = cw !== 0 ? 1 / cw : 0;
    const ndcX = cx * inv;
    const ndcY = cy * inv;
    const ndcZ = cz * inv;
    out.x = (ndcX * 0.5 + 0.5) * viewportW;
    out.y = (0.5 - ndcY * 0.5) * viewportH;
    out.z = ndcZ;
    return out;
  }

  /**
   * Unprojects a normalized device coordinate triple into world space.
   * @param {number} ndcX -1..1
   * @param {number} ndcY -1..1
   * @param {number} ndcZ -1 (near) .. 1 (far)
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  unproject(ndcX, ndcY, ndcZ, out) {
    const ip = this.projectionMatrixInverse.elements;
    const vx = ip[0] * ndcX + ip[4] * ndcY + ip[8] * ndcZ + ip[12];
    const vy = ip[1] * ndcX + ip[5] * ndcY + ip[9] * ndcZ + ip[13];
    const vz = ip[2] * ndcX + ip[6] * ndcY + ip[10] * ndcZ + ip[14];
    const vw = ip[3] * ndcX + ip[7] * ndcY + ip[11] * ndcZ + ip[15];
    const inv = vw !== 0 ? 1 / vw : 1;
    out.set(vx * inv, vy * inv, vz * inv);
    return out.applyMat4(this.worldMatrix);
  }

  /**
   * Builds a world space ray from a viewport pixel position.
   * @param {number} x Pixel x (0 = left).
   * @param {number} y Pixel y (0 = top).
   * @param {number} viewportW
   * @param {number} viewportH
   * @param {Ray} [outRay] Reused when provided.
   * @returns {Ray}
   */
  screenPointToRay(x, y, viewportW, viewportH, outRay) {
    const ray = outRay !== undefined && outRay !== null ? outRay : new Ray();
    const ndcX = (x / viewportW) * 2 - 1;
    const ndcY = 1 - (y / viewportH) * 2;
    this.unproject(ndcX, ndcY, -1, _v1);
    this.unproject(ndcX, ndcY, 1, _v2);
    ray.origin.copy(_v1);
    ray.direction.copy(_v2).sub(_v1).normalize();
    return ray;
  }

  /**
   * Builds a world space ray from normalized device coordinates.
   * @param {number} ndcX -1..1
   * @param {number} ndcY -1..1
   * @param {Ray} [outRay]
   * @returns {Ray}
   */
  ndcToRay(ndcX, ndcY, outRay) {
    const ray = outRay !== undefined && outRay !== null ? outRay : new Ray();
    this.unproject(ndcX, ndcY, -1, _v1);
    this.unproject(ndcX, ndcY, 1, _v2);
    ray.origin.copy(_v1);
    ray.direction.copy(_v2).sub(_v1).normalize();
    return ray;
  }
}
