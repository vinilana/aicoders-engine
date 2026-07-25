import { EPSILON, clamp } from './MathUtils.js';

/**
 * Three component vector.
 * Every method mutates `this` and returns `this`, except the ones returning
 * a scalar, a boolean or a fresh clone.
 */
export class Vec3 {
  /** @type {number} */ x;
  /** @type {number} */ y;
  /** @type {number} */ z;

  /**
   * @param {number} [x=0]
   * @param {number} [y=0]
   * @param {number} [z=0]
   */
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {Vec3}
   */
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  /**
   * Sets all components to the same scalar.
   * @param {number} s
   * @returns {Vec3}
   */
  setScalar(s) {
    this.x = s;
    this.y = s;
    this.z = s;
    return this;
  }

  /**
   * @param {Vec3} v
   * @returns {Vec3}
   */
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  /** @returns {Vec3} A new vector with the same components. */
  clone() {
    return new Vec3(this.x, this.y, this.z);
  }

  /**
   * @param {Vec3} v
   * @returns {Vec3}
   */
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  /**
   * @param {Vec3} a
   * @param {Vec3} b
   * @returns {Vec3}
   */
  addVectors(a, b) {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  /**
   * this += v * s
   * @param {Vec3} v
   * @param {number} s
   * @returns {Vec3}
   */
  addScaled(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  /**
   * Adds a scalar to every component.
   * @param {number} s
   * @returns {Vec3}
   */
  addScalar(s) {
    this.x += s;
    this.y += s;
    this.z += s;
    return this;
  }

  /**
   * @param {Vec3} v
   * @returns {Vec3}
   */
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  /**
   * @param {Vec3} a
   * @param {Vec3} b
   * @returns {Vec3}
   */
  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  /**
   * Component wise multiplication.
   * @param {Vec3} v
   * @returns {Vec3}
   */
  multiply(v) {
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    return this;
  }

  /**
   * @param {Vec3} a
   * @param {Vec3} b
   * @returns {Vec3}
   */
  multiplyVectors(a, b) {
    this.x = a.x * b.x;
    this.y = a.y * b.y;
    this.z = a.z * b.z;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec3}
   */
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  /**
   * Component wise division.
   * @param {Vec3} v
   * @returns {Vec3}
   */
  divide(v) {
    this.x /= v.x;
    this.y /= v.y;
    this.z /= v.z;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec3}
   */
  divideScalar(s) {
    return this.multiplyScalar(s === 0 ? 0 : 1 / s);
  }

  /** @returns {Vec3} */
  negate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  /**
   * @param {Vec3} v
   * @returns {number}
   */
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  /**
   * this = this x v
   * @param {Vec3} v
   * @returns {Vec3}
   */
  cross(v) {
    const ax = this.x, ay = this.y, az = this.z;
    this.x = ay * v.z - az * v.y;
    this.y = az * v.x - ax * v.z;
    this.z = ax * v.y - ay * v.x;
    return this;
  }

  /**
   * this = a x b
   * @param {Vec3} a
   * @param {Vec3} b
   * @returns {Vec3}
   */
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  /** @returns {number} */
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  /** @returns {number} */
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  /** @returns {number} Manhattan length. */
  manhattanLength() {
    return Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z);
  }

  /**
   * @param {Vec3} v
   * @returns {number}
   */
  distanceTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * @param {Vec3} v
   * @returns {number}
   */
  distanceToSq(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Normalizes in place. Zero length vectors are left untouched.
   * @returns {Vec3}
   */
  normalize() {
    const l = this.x * this.x + this.y * this.y + this.z * this.z;
    if (l > 0) {
      const inv = 1 / Math.sqrt(l);
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
    }
    return this;
  }

  /**
   * @param {number} l
   * @returns {Vec3}
   */
  setLength(l) {
    return this.normalize().multiplyScalar(l);
  }

  /**
   * @param {Vec3} v
   * @param {number} t
   * @returns {Vec3}
   */
  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  /**
   * @param {Vec3} a
   * @param {Vec3} b
   * @param {number} t
   * @returns {Vec3}
   */
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }

  /**
   * Component wise minimum.
   * @param {Vec3} v
   * @returns {Vec3}
   */
  min(v) {
    if (v.x < this.x) this.x = v.x;
    if (v.y < this.y) this.y = v.y;
    if (v.z < this.z) this.z = v.z;
    return this;
  }

  /**
   * Component wise maximum.
   * @param {Vec3} v
   * @returns {Vec3}
   */
  max(v) {
    if (v.x > this.x) this.x = v.x;
    if (v.y > this.y) this.y = v.y;
    if (v.z > this.z) this.z = v.z;
    return this;
  }

  /**
   * Clamps each component between the matching components of min and max.
   * @param {Vec3} min
   * @param {Vec3} max
   * @returns {Vec3}
   */
  clamp(min, max) {
    this.x = clamp(this.x, min.x, max.x);
    this.y = clamp(this.y, min.y, max.y);
    this.z = clamp(this.z, min.z, max.z);
    return this;
  }

  /**
   * Clamps the vector magnitude between min and max.
   * @param {number} min
   * @param {number} max
   * @returns {Vec3}
   */
  clampLength(min, max) {
    const l = this.length();
    if (l === 0) return this;
    const target = l < min ? min : (l > max ? max : l);
    return this.multiplyScalar(target / l);
  }

  /**
   * Multiplies by a 3x3 matrix (column major elements).
   * @param {import('./Mat3.js').Mat3} m
   * @returns {Vec3}
   */
  applyMat3(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[3] * y + e[6] * z;
    this.y = e[1] * x + e[4] * y + e[7] * z;
    this.z = e[2] * x + e[5] * y + e[8] * z;
    return this;
  }

  /**
   * Multiplies by a 4x4 matrix as a point (w = 1) with perspective divide.
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Vec3}
   */
  applyMat4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    let w = e[3] * x + e[7] * y + e[11] * z + e[15];
    w = w === 0 ? 1 : 1 / w;
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }

  /**
   * Rotates this vector by a quaternion.
   * @param {import('./Quat.js').Quat} q
   * @returns {Vec3}
   */
  applyQuat(q) {
    const vx = this.x, vy = this.y, vz = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // v + qw * t + cross(q.xyz, t)
    this.x = vx + qw * tx + qy * tz - qz * ty;
    this.y = vy + qw * ty + qz * tx - qx * tz;
    this.z = vz + qw * tz + qx * ty - qy * tx;
    return this;
  }

  /**
   * Multiplies by the upper 3x3 of a 4x4 matrix and renormalizes.
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Vec3}
   */
  transformDirection(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8] * z;
    this.y = e[1] * x + e[5] * y + e[9] * z;
    this.z = e[2] * x + e[6] * y + e[10] * z;
    return this.normalize();
  }

  /**
   * Reflects this vector around a (normalized) plane normal.
   * @param {Vec3} n Unit normal.
   * @returns {Vec3}
   */
  reflect(n) {
    const d = 2 * (this.x * n.x + this.y * n.y + this.z * n.z);
    this.x -= n.x * d;
    this.y -= n.y * d;
    this.z -= n.z * d;
    return this;
  }

  /**
   * Projects this vector onto v.
   * @param {Vec3} v
   * @returns {Vec3}
   */
  project(v) {
    const lsq = v.x * v.x + v.y * v.y + v.z * v.z;
    if (lsq === 0) return this.set(0, 0, 0);
    const s = (this.x * v.x + this.y * v.y + this.z * v.z) / lsq;
    this.x = v.x * s;
    this.y = v.y * s;
    this.z = v.z * s;
    return this;
  }

  /**
   * Removes the component of this vector parallel to v.
   * @param {Vec3} v
   * @returns {Vec3}
   */
  projectOnPlane(v) {
    const lsq = v.x * v.x + v.y * v.y + v.z * v.z;
    if (lsq === 0) return this;
    const s = (this.x * v.x + this.y * v.y + this.z * v.z) / lsq;
    this.x -= v.x * s;
    this.y -= v.y * s;
    this.z -= v.z * s;
    return this;
  }

  /**
   * Extracts the translation of a 4x4 matrix.
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Vec3}
   */
  setFromMatrixPosition(m) {
    const e = m.elements;
    this.x = e[12];
    this.y = e[13];
    this.z = e[14];
    return this;
  }

  /**
   * Reads a column of a 4x4 matrix (0..3).
   * @param {import('./Mat4.js').Mat4} m
   * @param {number} i
   * @returns {Vec3}
   */
  setFromMatrixColumn(m, i) {
    const e = m.elements;
    const o = i * 4;
    this.x = e[o];
    this.y = e[o + 1];
    this.z = e[o + 2];
    return this;
  }

  /**
   * Scale of a matrix column (length of the basis vector).
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Vec3}
   */
  setFromMatrixScale(m) {
    const e = m.elements;
    this.x = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    this.y = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    this.z = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
    return this;
  }

  /**
   * Spherical coordinates to cartesian.
   * phi is the polar angle measured from +Y, theta the azimuth around +Y.
   * @param {number} radius
   * @param {number} phi
   * @param {number} theta
   * @returns {Vec3}
   */
  setFromSpherical(radius, phi, theta) {
    const sinPhi = Math.sin(phi) * radius;
    this.x = sinPhi * Math.sin(theta);
    this.y = Math.cos(phi) * radius;
    this.z = sinPhi * Math.cos(theta);
    return this;
  }

  /**
   * Cylindrical coordinates to cartesian.
   * @param {number} radius
   * @param {number} theta
   * @param {number} y
   * @returns {Vec3}
   */
  setFromCylindrical(radius, theta, y) {
    this.x = radius * Math.sin(theta);
    this.y = y;
    this.z = radius * Math.cos(theta);
    return this;
  }

  /**
   * @param {ArrayLike<number>} a
   * @param {number} [o=0]
   * @returns {Vec3}
   */
  fromArray(a, o = 0) {
    this.x = a[o];
    this.y = a[o + 1];
    this.z = a[o + 2];
    return this;
  }

  /**
   * @param {Array<number>|Float32Array} [a=[]]
   * @param {number} [o=0]
   * @returns {Array<number>|Float32Array}
   */
  toArray(a = [], o = 0) {
    a[o] = this.x;
    a[o + 1] = this.y;
    a[o + 2] = this.z;
    return a;
  }

  /**
   * Exact component equality.
   * @param {Vec3} v
   * @returns {boolean}
   */
  equals(v) {
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  /**
   * Equality within a tolerance.
   * @param {Vec3} v
   * @param {number} [eps=EPSILON]
   * @returns {boolean}
   */
  nearlyEquals(v, eps = EPSILON) {
    return Math.abs(this.x - v.x) <= eps &&
      Math.abs(this.y - v.y) <= eps &&
      Math.abs(this.z - v.z) <= eps;
  }

  /** @returns {boolean} True when the squared length is below EPSILON^2. */
  isZero() {
    return (this.x * this.x + this.y * this.y + this.z * this.z) < EPSILON * EPSILON;
  }

  /** @returns {boolean} True when no component is NaN or Infinity. */
  isFinite() {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  /**
   * Unsigned angle (radians) between this vector and v.
   * @param {Vec3} v
   * @returns {number}
   */
  angleTo(v) {
    const denom = Math.sqrt(
      (this.x * this.x + this.y * this.y + this.z * this.z) *
      (v.x * v.x + v.y * v.y + v.z * v.z)
    );
    if (denom === 0) return Math.PI / 2;
    const c = (this.x * v.x + this.y * v.y + this.z * v.z) / denom;
    return Math.acos(clamp(c, -1, 1));
  }
}

/** Zero vector (frozen). @type {Vec3} */
Vec3.ZERO = Object.freeze(new Vec3(0, 0, 0));
/** (1,1,1) (frozen). @type {Vec3} */
Vec3.ONE = Object.freeze(new Vec3(1, 1, 1));
/** +Y (frozen). @type {Vec3} */
Vec3.UP = Object.freeze(new Vec3(0, 1, 0));
/** -Y (frozen). @type {Vec3} */
Vec3.DOWN = Object.freeze(new Vec3(0, -1, 0));
/** +X (frozen). @type {Vec3} */
Vec3.RIGHT = Object.freeze(new Vec3(1, 0, 0));
/** -X (frozen). @type {Vec3} */
Vec3.LEFT = Object.freeze(new Vec3(-1, 0, 0));
/** -Z, the camera forward axis (frozen). @type {Vec3} */
Vec3.FORWARD = Object.freeze(new Vec3(0, 0, -1));
/** +Z (frozen). @type {Vec3} */
Vec3.BACK = Object.freeze(new Vec3(0, 0, 1));
