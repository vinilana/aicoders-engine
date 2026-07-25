import { EPSILON, clamp } from './MathUtils.js';

/**
 * Four component vector. Used for homogeneous coordinates, shader uniforms,
 * tangents (w = handedness) and packed GPU data.
 * Every method mutates `this` and returns `this`, except the ones returning
 * a scalar, a boolean or a fresh clone.
 */
export class Vec4 {
  /** @type {number} */ x;
  /** @type {number} */ y;
  /** @type {number} */ z;
  /** @type {number} */ w;

  /**
   * @param {number} [x=0]
   * @param {number} [y=0]
   * @param {number} [z=0]
   * @param {number} [w=1]
   */
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} w
   * @returns {Vec4}
   */
  set(x, y, z, w) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec4}
   */
  setScalar(s) {
    this.x = s;
    this.y = s;
    this.z = s;
    this.w = s;
    return this;
  }

  /**
   * @param {Vec4} v
   * @returns {Vec4}
   */
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    this.w = v.w !== undefined ? v.w : 1;
    return this;
  }

  /** @returns {Vec4} */
  clone() {
    return new Vec4(this.x, this.y, this.z, this.w);
  }

  /**
   * @param {Vec4} v
   * @returns {Vec4}
   */
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    this.w += v.w;
    return this;
  }

  /**
   * @param {Vec4} a
   * @param {Vec4} b
   * @returns {Vec4}
   */
  addVectors(a, b) {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    this.w = a.w + b.w;
    return this;
  }

  /**
   * this += v * s
   * @param {Vec4} v
   * @param {number} s
   * @returns {Vec4}
   */
  addScaled(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    this.w += v.w * s;
    return this;
  }

  /**
   * @param {Vec4} v
   * @returns {Vec4}
   */
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    this.w -= v.w;
    return this;
  }

  /**
   * @param {Vec4} a
   * @param {Vec4} b
   * @returns {Vec4}
   */
  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    this.w = a.w - b.w;
    return this;
  }

  /**
   * @param {Vec4} v
   * @returns {Vec4}
   */
  multiply(v) {
    this.x *= v.x;
    this.y *= v.y;
    this.z *= v.z;
    this.w *= v.w;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec4}
   */
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    this.w *= s;
    return this;
  }

  /**
   * @param {Vec4} v
   * @returns {Vec4}
   */
  divide(v) {
    this.x /= v.x;
    this.y /= v.y;
    this.z /= v.z;
    this.w /= v.w;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec4}
   */
  divideScalar(s) {
    return this.multiplyScalar(s === 0 ? 0 : 1 / s);
  }

  /** @returns {Vec4} */
  negate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    this.w = -this.w;
    return this;
  }

  /**
   * @param {Vec4} v
   * @returns {number}
   */
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z + this.w * v.w;
  }

  /** @returns {number} */
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
  }

  /** @returns {number} */
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  /** @returns {Vec4} */
  normalize() {
    const l = this.lengthSq();
    if (l > 0) {
      const inv = 1 / Math.sqrt(l);
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      this.w *= inv;
    }
    return this;
  }

  /**
   * @param {number} l
   * @returns {Vec4}
   */
  setLength(l) {
    return this.normalize().multiplyScalar(l);
  }

  /**
   * @param {Vec4} v
   * @param {number} t
   * @returns {Vec4}
   */
  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    this.w += (v.w - this.w) * t;
    return this;
  }

  /**
   * @param {Vec4} a
   * @param {Vec4} b
   * @param {number} t
   * @returns {Vec4}
   */
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    this.w = a.w + (b.w - a.w) * t;
    return this;
  }

  /**
   * @param {Vec4} v
   * @returns {Vec4}
   */
  min(v) {
    if (v.x < this.x) this.x = v.x;
    if (v.y < this.y) this.y = v.y;
    if (v.z < this.z) this.z = v.z;
    if (v.w < this.w) this.w = v.w;
    return this;
  }

  /**
   * @param {Vec4} v
   * @returns {Vec4}
   */
  max(v) {
    if (v.x > this.x) this.x = v.x;
    if (v.y > this.y) this.y = v.y;
    if (v.z > this.z) this.z = v.z;
    if (v.w > this.w) this.w = v.w;
    return this;
  }

  /**
   * @param {Vec4} min
   * @param {Vec4} max
   * @returns {Vec4}
   */
  clamp(min, max) {
    this.x = clamp(this.x, min.x, max.x);
    this.y = clamp(this.y, min.y, max.y);
    this.z = clamp(this.z, min.z, max.z);
    this.w = clamp(this.w, min.w, max.w);
    return this;
  }

  /**
   * Full 4x4 matrix multiplication (no perspective divide).
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Vec4}
   */
  applyMat4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z, w = this.w;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12] * w;
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13] * w;
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14] * w;
    this.w = e[3] * x + e[7] * y + e[11] * z + e[15] * w;
    return this;
  }

  /**
   * Divides xyz by w (perspective divide) and sets w to 1.
   * @returns {Vec4}
   */
  perspectiveDivide() {
    if (this.w !== 0) {
      const inv = 1 / this.w;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      this.w = 1;
    }
    return this;
  }

  /**
   * Reads a column of a 4x4 matrix (0..3).
   * @param {import('./Mat4.js').Mat4} m
   * @param {number} i
   * @returns {Vec4}
   */
  setFromMatrixColumn(m, i) {
    const e = m.elements;
    const o = i * 4;
    this.x = e[o];
    this.y = e[o + 1];
    this.z = e[o + 2];
    this.w = e[o + 3];
    return this;
  }

  /**
   * Stores an axis-angle representation of a quaternion: xyz = axis, w = angle.
   * @param {import('./Quat.js').Quat} q Unit quaternion.
   * @returns {Vec4}
   */
  setAxisAngleFromQuat(q) {
    const w = clamp(q.w, -1, 1);
    this.w = 2 * Math.acos(w);
    const s = Math.sqrt(1 - w * w);
    if (s < 0.0001) {
      this.x = 1;
      this.y = 0;
      this.z = 0;
    } else {
      this.x = q.x / s;
      this.y = q.y / s;
      this.z = q.z / s;
    }
    return this;
  }

  /**
   * @param {ArrayLike<number>} a
   * @param {number} [o=0]
   * @returns {Vec4}
   */
  fromArray(a, o = 0) {
    this.x = a[o];
    this.y = a[o + 1];
    this.z = a[o + 2];
    this.w = a[o + 3];
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
    a[o + 3] = this.w;
    return a;
  }

  /**
   * @param {Vec4} v
   * @returns {boolean}
   */
  equals(v) {
    return this.x === v.x && this.y === v.y && this.z === v.z && this.w === v.w;
  }

  /**
   * @param {Vec4} v
   * @param {number} [eps=EPSILON]
   * @returns {boolean}
   */
  nearlyEquals(v, eps = EPSILON) {
    return Math.abs(this.x - v.x) <= eps &&
      Math.abs(this.y - v.y) <= eps &&
      Math.abs(this.z - v.z) <= eps &&
      Math.abs(this.w - v.w) <= eps;
  }

  /** @returns {boolean} */
  isZero() {
    return this.lengthSq() < EPSILON * EPSILON;
  }
}

/** (0,0,0,0) (frozen). @type {Vec4} */
Vec4.ZERO = Object.freeze(new Vec4(0, 0, 0, 0));
/** (1,1,1,1) (frozen). @type {Vec4} */
Vec4.ONE = Object.freeze(new Vec4(1, 1, 1, 1));
/** (0,0,0,1) (frozen). @type {Vec4} */
Vec4.UNIT_W = Object.freeze(new Vec4(0, 0, 0, 1));
