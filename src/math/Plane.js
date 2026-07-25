import { Vec3 } from './Vec3.js';

// Module scoped scratch - never allocate on the hot path.
const _v1 = new Vec3();
const _v2 = new Vec3();

/**
 * Infinite plane defined by `dot(normal, p) + constant = 0`.
 * Points with a positive distance are on the side the normal points to.
 */
export class Plane {
  /** @type {Vec3} */ normal;
  /** @type {number} */ constant;

  /**
   * @param {Vec3} [normal] Defaults to (1, 0, 0).
   * @param {number} [constant=0]
   */
  constructor(normal, constant = 0) {
    this.normal = normal !== undefined ? normal.clone() : new Vec3(1, 0, 0);
    this.constant = constant;
  }

  /**
   * @param {Vec3} normal
   * @param {number} constant
   * @returns {Plane}
   */
  set(normal, constant) {
    this.normal.copy(normal);
    this.constant = constant;
    return this;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} w
   * @returns {Plane}
   */
  setComponents(x, y, z, w) {
    this.normal.x = x;
    this.normal.y = y;
    this.normal.z = z;
    this.constant = w;
    return this;
  }

  /**
   * @param {Vec3} normal Unit normal.
   * @param {Vec3} point A point on the plane.
   * @returns {Plane}
   */
  setFromNormalAndCoplanarPoint(normal, point) {
    this.normal.copy(normal);
    this.constant = -(point.x * normal.x + point.y * normal.y + point.z * normal.z);
    return this;
  }

  /**
   * Builds the plane through three points (counter clockwise winding).
   * @param {Vec3} a
   * @param {Vec3} b
   * @param {Vec3} c
   * @returns {Plane}
   */
  setFromCoplanarPoints(a, b, c) {
    _v1.subVectors(c, b);
    _v2.subVectors(a, b);
    _v1.cross(_v2).normalize();
    return this.setFromNormalAndCoplanarPoint(_v1, a);
  }

  /**
   * Scales normal and constant so the normal becomes unit length.
   * @returns {Plane}
   */
  normalize() {
    const n = this.normal;
    const lsq = n.x * n.x + n.y * n.y + n.z * n.z;
    if (lsq > 0) {
      const inv = 1 / Math.sqrt(lsq);
      n.x *= inv;
      n.y *= inv;
      n.z *= inv;
      this.constant *= inv;
    }
    return this;
  }

  /**
   * Flips the plane orientation.
   * @returns {Plane}
   */
  negate() {
    this.normal.negate();
    this.constant = -this.constant;
    return this;
  }

  /**
   * Signed distance from the plane to a point.
   * @param {Vec3} p
   * @returns {number}
   */
  distanceToPoint(p) {
    return this.normal.x * p.x + this.normal.y * p.y + this.normal.z * p.z + this.constant;
  }

  /**
   * Signed distance from the plane to the closest point of a sphere.
   * @param {import('./Sphere.js').Sphere} s
   * @returns {number}
   */
  distanceToSphere(s) {
    return this.distanceToPoint(s.center) - s.radius;
  }

  /**
   * Projects a point onto the plane.
   * @param {Vec3} p
   * @param {Vec3} out
   * @returns {Vec3}
   */
  projectPoint(p, out) {
    const d = this.distanceToPoint(p);
    out.x = p.x - this.normal.x * d;
    out.y = p.y - this.normal.y * d;
    out.z = p.z - this.normal.z * d;
    return out;
  }

  /**
   * Ray/plane parameter along `direction` starting at `origin`.
   * @param {Vec3} origin
   * @param {Vec3} direction
   * @returns {number} t, or -1 when parallel.
   */
  intersectRayParam(origin, direction) {
    const denom = this.normal.dot(direction);
    if (denom === 0) return -1;
    return -(this.normal.dot(origin) + this.constant) / denom;
  }

  /**
   * Transforms the plane by a matrix.
   * @param {import('./Mat4.js').Mat4} m
   * @param {import('./Mat3.js').Mat3} [normalMatrix] Precomputed normal matrix (optional).
   * @returns {Plane}
   */
  applyMat4(m, normalMatrix) {
    // A point on the plane, moved to the new space.
    _v1.copy(this.normal).multiplyScalar(-this.constant).applyMat4(m);
    if (normalMatrix !== undefined) this.normal.applyMat3(normalMatrix).normalize();
    else this.normal.transformDirection(m);
    this.constant = -_v1.dot(this.normal);
    return this;
  }

  /**
   * Moves the plane along its normal.
   * @param {Vec3} offset
   * @returns {Plane}
   */
  translate(offset) {
    this.constant -= this.normal.dot(offset);
    return this;
  }

  /**
   * @param {Plane} p
   * @returns {Plane}
   */
  copy(p) {
    this.normal.copy(p.normal);
    this.constant = p.constant;
    return this;
  }

  /** @returns {Plane} */
  clone() {
    return new Plane(this.normal, this.constant);
  }

  /**
   * @param {Plane} p
   * @returns {boolean}
   */
  equals(p) {
    return this.normal.equals(p.normal) && this.constant === p.constant;
  }
}
