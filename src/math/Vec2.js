import { EPSILON, clamp } from './MathUtils.js';

/**
 * Two component vector.
 * Every method mutates `this` and returns `this`, except the ones returning
 * a scalar, a boolean or a fresh clone.
 */
export class Vec2 {
  /** @type {number} */ x;
  /** @type {number} */ y;

  /**
   * @param {number} [x=0]
   * @param {number} [y=0]
   */
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {Vec2}
   */
  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec2}
   */
  setScalar(s) {
    this.x = s;
    this.y = s;
    return this;
  }

  /**
   * @param {Vec2} v
   * @returns {Vec2}
   */
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  /** @returns {Vec2} */
  clone() {
    return new Vec2(this.x, this.y);
  }

  /**
   * @param {Vec2} v
   * @returns {Vec2}
   */
  add(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  /**
   * @param {Vec2} a
   * @param {Vec2} b
   * @returns {Vec2}
   */
  addVectors(a, b) {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    return this;
  }

  /**
   * this += v * s
   * @param {Vec2} v
   * @param {number} s
   * @returns {Vec2}
   */
  addScaled(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec2}
   */
  addScalar(s) {
    this.x += s;
    this.y += s;
    return this;
  }

  /**
   * @param {Vec2} v
   * @returns {Vec2}
   */
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  /**
   * @param {Vec2} a
   * @param {Vec2} b
   * @returns {Vec2}
   */
  subVectors(a, b) {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    return this;
  }

  /**
   * @param {Vec2} v
   * @returns {Vec2}
   */
  multiply(v) {
    this.x *= v.x;
    this.y *= v.y;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec2}
   */
  multiplyScalar(s) {
    this.x *= s;
    this.y *= s;
    return this;
  }

  /**
   * @param {Vec2} v
   * @returns {Vec2}
   */
  divide(v) {
    this.x /= v.x;
    this.y /= v.y;
    return this;
  }

  /**
   * @param {number} s
   * @returns {Vec2}
   */
  divideScalar(s) {
    return this.multiplyScalar(s === 0 ? 0 : 1 / s);
  }

  /** @returns {Vec2} */
  negate() {
    this.x = -this.x;
    this.y = -this.y;
    return this;
  }

  /**
   * @param {Vec2} v
   * @returns {number}
   */
  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  /**
   * 2D cross product (signed area of the parallelogram).
   * @param {Vec2} v
   * @returns {number}
   */
  cross(v) {
    return this.x * v.y - this.y * v.x;
  }

  /** @returns {number} */
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  /** @returns {number} */
  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  /**
   * @param {Vec2} v
   * @returns {number}
   */
  distanceTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * @param {Vec2} v
   * @returns {number}
   */
  distanceToSq(v) {
    const dx = this.x - v.x, dy = this.y - v.y;
    return dx * dx + dy * dy;
  }

  /** @returns {Vec2} */
  normalize() {
    const l = this.x * this.x + this.y * this.y;
    if (l > 0) {
      const inv = 1 / Math.sqrt(l);
      this.x *= inv;
      this.y *= inv;
    }
    return this;
  }

  /**
   * @param {number} l
   * @returns {Vec2}
   */
  setLength(l) {
    return this.normalize().multiplyScalar(l);
  }

  /**
   * @param {Vec2} v
   * @param {number} t
   * @returns {Vec2}
   */
  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    return this;
  }

  /**
   * @param {Vec2} a
   * @param {Vec2} b
   * @param {number} t
   * @returns {Vec2}
   */
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    return this;
  }

  /**
   * @param {Vec2} v
   * @returns {Vec2}
   */
  min(v) {
    if (v.x < this.x) this.x = v.x;
    if (v.y < this.y) this.y = v.y;
    return this;
  }

  /**
   * @param {Vec2} v
   * @returns {Vec2}
   */
  max(v) {
    if (v.x > this.x) this.x = v.x;
    if (v.y > this.y) this.y = v.y;
    return this;
  }

  /**
   * @param {Vec2} min
   * @param {Vec2} max
   * @returns {Vec2}
   */
  clamp(min, max) {
    this.x = clamp(this.x, min.x, max.x);
    this.y = clamp(this.y, min.y, max.y);
    return this;
  }

  /**
   * @param {number} min
   * @param {number} max
   * @returns {Vec2}
   */
  clampLength(min, max) {
    const l = this.length();
    if (l === 0) return this;
    const target = l < min ? min : (l > max ? max : l);
    return this.multiplyScalar(target / l);
  }

  /**
   * Applies a 3x3 matrix treating this as a point (x, y, 1).
   * @param {import('./Mat3.js').Mat3} m
   * @returns {Vec2}
   */
  applyMat3(m) {
    const e = m.elements;
    const x = this.x, y = this.y;
    this.x = e[0] * x + e[3] * y + e[6];
    this.y = e[1] * x + e[4] * y + e[7];
    return this;
  }

  /**
   * Rotates the vector around the origin.
   * @param {number} angle Radians (counter clockwise).
   * @returns {Vec2}
   */
  rotate(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const x = this.x, y = this.y;
    this.x = x * c - y * s;
    this.y = x * s + y * c;
    return this;
  }

  /**
   * Rotates the vector around a pivot point.
   * @param {Vec2} center
   * @param {number} angle
   * @returns {Vec2}
   */
  rotateAround(center, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const x = this.x - center.x, y = this.y - center.y;
    this.x = x * c - y * s + center.x;
    this.y = x * s + y * c + center.y;
    return this;
  }

  /** @returns {number} Angle of the vector in radians, in [0, 2PI). */
  angle() {
    const a = Math.atan2(this.y, this.x);
    return a < 0 ? a + Math.PI * 2 : a;
  }

  /**
   * Unsigned angle between this vector and v.
   * @param {Vec2} v
   * @returns {number}
   */
  angleTo(v) {
    const denom = Math.sqrt(
      (this.x * this.x + this.y * this.y) * (v.x * v.x + v.y * v.y)
    );
    if (denom === 0) return Math.PI / 2;
    return Math.acos(clamp((this.x * v.x + this.y * v.y) / denom, -1, 1));
  }

  /**
   * @param {ArrayLike<number>} a
   * @param {number} [o=0]
   * @returns {Vec2}
   */
  fromArray(a, o = 0) {
    this.x = a[o];
    this.y = a[o + 1];
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
    return a;
  }

  /**
   * @param {Vec2} v
   * @returns {boolean}
   */
  equals(v) {
    return this.x === v.x && this.y === v.y;
  }

  /**
   * @param {Vec2} v
   * @param {number} [eps=EPSILON]
   * @returns {boolean}
   */
  nearlyEquals(v, eps = EPSILON) {
    return Math.abs(this.x - v.x) <= eps && Math.abs(this.y - v.y) <= eps;
  }

  /** @returns {boolean} */
  isZero() {
    return (this.x * this.x + this.y * this.y) < EPSILON * EPSILON;
  }
}

/** Zero vector (frozen). @type {Vec2} */
Vec2.ZERO = Object.freeze(new Vec2(0, 0));
/** (1,1) (frozen). @type {Vec2} */
Vec2.ONE = Object.freeze(new Vec2(1, 1));
/** +Y (frozen). @type {Vec2} */
Vec2.UP = Object.freeze(new Vec2(0, 1));
/** -Y (frozen). @type {Vec2} */
Vec2.DOWN = Object.freeze(new Vec2(0, -1));
/** +X (frozen). @type {Vec2} */
Vec2.RIGHT = Object.freeze(new Vec2(1, 0));
/** -X (frozen). @type {Vec2} */
Vec2.LEFT = Object.freeze(new Vec2(-1, 0));
