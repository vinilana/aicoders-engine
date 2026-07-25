import { EPSILON, clamp } from './MathUtils.js';
import { Vec3 } from './Vec3.js';

// Module scoped scratch objects - never allocate on the hot path.
const _vx = new Vec3();
const _vy = new Vec3();
const _vz = new Vec3();
const _tmp = new Vec3();

/**
 * Builds a quaternion from an orthonormal basis using Shepperd's method
 * (picks the largest component to avoid catastrophic cancellation).
 * The basis is given as three column vectors of the rotation matrix.
 * @param {Quat} q Destination.
 * @param {number} m11 @param {number} m12 @param {number} m13
 * @param {number} m21 @param {number} m22 @param {number} m23
 * @param {number} m31 @param {number} m32 @param {number} m33
 * @returns {Quat}
 */
function setFromBasis(q, m11, m12, m13, m21, m22, m23, m31, m32, m33) {
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    q.w = 0.25 / s;
    q.x = (m32 - m23) * s;
    q.y = (m13 - m31) * s;
    q.z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    q.w = (m32 - m23) / s;
    q.x = 0.25 * s;
    q.y = (m12 + m21) / s;
    q.z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    q.w = (m13 - m31) / s;
    q.x = (m12 + m21) / s;
    q.y = 0.25 * s;
    q.z = (m23 + m32) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    q.w = (m21 - m12) / s;
    q.x = (m13 + m31) / s;
    q.y = (m23 + m32) / s;
    q.z = 0.25 * s;
  }
  return q;
}

/**
 * Unit quaternion (x, y, z, w) representing a rotation.
 * Right handed coordinate system, rotations follow the right hand rule.
 */
export class Quat {
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
   * Resets to the identity rotation.
   * @returns {Quat}
   */
  identity() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.w = 1;
    return this;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} w
   * @returns {Quat}
   */
  set(x, y, z, w) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  /**
   * @param {Quat} q
   * @returns {Quat}
   */
  copy(q) {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  /** @returns {Quat} */
  clone() {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  /**
   * @param {Vec3} axis Unit axis.
   * @param {number} angle Radians.
   * @returns {Quat}
   */
  setFromAxisAngle(axis, angle) {
    const half = angle * 0.5;
    const s = Math.sin(half);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }

  /**
   * Builds the quaternion from an Euler rotation (intrinsic rotations,
   * order given by `euler.order`, default 'YXZ').
   * @param {import('./Euler.js').Euler} euler
   * @returns {Quat}
   */
  setFromEuler(euler) {
    const x = euler.x, y = euler.y, z = euler.z;
    const order = euler.order || 'YXZ';
    const c1 = Math.cos(x * 0.5), c2 = Math.cos(y * 0.5), c3 = Math.cos(z * 0.5);
    const s1 = Math.sin(x * 0.5), s2 = Math.sin(y * 0.5), s3 = Math.sin(z * 0.5);

    switch (order) {
      case 'XYZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'YXZ':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'ZXY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'ZYX':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      case 'YZX':
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 + s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 - s1 * s2 * s3;
        break;
      case 'XZY':
        this.x = s1 * c2 * c3 - c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 + s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
      default:
        this.x = s1 * c2 * c3 + c1 * s2 * s3;
        this.y = c1 * s2 * c3 - s1 * c2 * s3;
        this.z = c1 * c2 * s3 - s1 * s2 * c3;
        this.w = c1 * c2 * c3 + s1 * s2 * s3;
        break;
    }
    return this;
  }

  /**
   * Extracts the rotation of a matrix using Shepperd's algorithm.
   * The upper 3x3 of `m` must be a pure rotation (unscaled).
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Quat}
   */
  setFromRotationMatrix(m) {
    const e = m.elements;
    return setFromBasis(
      this,
      e[0], e[4], e[8],
      e[1], e[5], e[9],
      e[2], e[6], e[10]
    );
  }

  /**
   * Extracts the rotation of a 3x3 matrix.
   * @param {import('./Mat3.js').Mat3} m
   * @returns {Quat}
   */
  setFromMat3(m) {
    const e = m.elements;
    return setFromBasis(
      this,
      e[0], e[3], e[6],
      e[1], e[4], e[7],
      e[2], e[5], e[8]
    );
  }

  /**
   * Shortest arc rotation taking `from` to `to`. Both must be unit vectors.
   * @param {Vec3} from
   * @param {Vec3} to
   * @returns {Quat}
   */
  setFromUnitVectors(from, to) {
    let r = from.x * to.x + from.y * to.y + from.z * to.z + 1;
    if (r < EPSILON) {
      // 180 degree rotation: pick any axis orthogonal to `from`.
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) {
        this.x = -from.y;
        this.y = from.x;
        this.z = 0;
        this.w = r;
      } else {
        this.x = 0;
        this.y = -from.z;
        this.z = from.y;
        this.w = r;
      }
    } else {
      this.x = from.y * to.z - from.z * to.y;
      this.y = from.z * to.x - from.x * to.z;
      this.z = from.x * to.y - from.y * to.x;
      this.w = r;
    }
    return this.normalize();
  }

  /**
   * Rotation whose local -Z axis points along `forward` and whose local +Y
   * axis is as close as possible to `up` (engine convention: objects and
   * cameras look down their local -Z).
   * @param {Vec3} forward Direction to face (does not need to be normalized).
   * @param {Vec3} [up=Vec3.UP]
   * @returns {Quat}
   */
  lookRotation(forward, up = Vec3.UP) {
    _vz.copy(forward);
    if (_vz.lengthSq() < EPSILON * EPSILON) _vz.set(0, 0, 1);
    else _vz.normalize().negate();

    _tmp.copy(up);
    if (_tmp.lengthSq() < EPSILON * EPSILON) _tmp.set(0, 1, 0);
    _vx.crossVectors(_tmp, _vz);
    if (_vx.lengthSq() < EPSILON * EPSILON) {
      // up is parallel to forward: nudge it.
      if (Math.abs(_tmp.z) < 0.9) _tmp.set(0, 0, 1);
      else _tmp.set(1, 0, 0);
      _vx.crossVectors(_tmp, _vz);
    }
    _vx.normalize();
    _vy.crossVectors(_vz, _vx);

    return setFromBasis(
      this,
      _vx.x, _vy.x, _vz.x,
      _vx.y, _vy.y, _vz.y,
      _vx.z, _vy.z, _vz.z
    );
  }

  /**
   * this = this * q
   * @param {Quat} q
   * @returns {Quat}
   */
  multiply(q) {
    return this.multiplyQuaternions(this, q);
  }

  /**
   * this = q * this
   * @param {Quat} q
   * @returns {Quat}
   */
  premultiply(q) {
    return this.multiplyQuaternions(q, this);
  }

  /**
   * this = a * b (Hamilton product).
   * @param {Quat} a
   * @param {Quat} b
   * @returns {Quat}
   */
  multiplyQuaternions(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w;
    const bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  /**
   * Full inverse (conjugate divided by squared norm).
   * @returns {Quat}
   */
  invert() {
    const lsq = this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
    if (lsq === 0) return this.identity();
    const inv = 1 / lsq;
    this.x = -this.x * inv;
    this.y = -this.y * inv;
    this.z = -this.z * inv;
    this.w = this.w * inv;
    return this;
  }

  /**
   * Negates the vector part (inverse for unit quaternions).
   * @returns {Quat}
   */
  conjugate() {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  /**
   * Normalizes to unit length; degenerate quaternions become identity.
   * @returns {Quat}
   */
  normalize() {
    let l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (l === 0) {
      this.x = 0;
      this.y = 0;
      this.z = 0;
      this.w = 1;
      return this;
    }
    l = 1 / l;
    this.x *= l;
    this.y *= l;
    this.z *= l;
    this.w *= l;
    return this;
  }

  /**
   * @param {Quat} q
   * @returns {number}
   */
  dot(q) {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  /** @returns {number} */
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  /** @returns {number} */
  length() {
    return Math.sqrt(this.lengthSq());
  }

  /**
   * Smallest rotation angle (radians) between the two orientations.
   * @param {Quat} q
   * @returns {number}
   */
  angleTo(q) {
    const d = Math.abs(clamp(this.dot(q), -1, 1));
    return 2 * Math.acos(d);
  }

  /**
   * Spherical linear interpolation towards q (shortest path).
   * @param {Quat} q
   * @param {number} t
   * @returns {Quat}
   */
  slerp(q, t) {
    if (t === 0) return this;
    if (t === 1) return this.copy(q);

    const x = this.x, y = this.y, z = this.z, w = this.w;
    let cosHalfTheta = w * q.w + x * q.x + y * q.y + z * q.z;

    let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    if (cosHalfTheta < 0) {
      cosHalfTheta = -cosHalfTheta;
      qx = -qx;
      qy = -qy;
      qz = -qz;
      qw = -qw;
    }

    if (cosHalfTheta >= 1.0) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.w = w;
      return this;
    }

    const sqrSinHalfTheta = 1.0 - cosHalfTheta * cosHalfTheta;
    if (sqrSinHalfTheta <= Number.EPSILON) {
      // Nearly identical: fall back to normalized lerp.
      const s = 1 - t;
      this.x = s * x + t * qx;
      this.y = s * y + t * qy;
      this.z = s * z + t * qz;
      this.w = s * w + t * qw;
      return this.normalize();
    }

    const sinHalfTheta = Math.sqrt(sqrSinHalfTheta);
    const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

    this.x = x * ratioA + qx * ratioB;
    this.y = y * ratioA + qy * ratioB;
    this.z = z * ratioA + qz * ratioB;
    this.w = w * ratioA + qw * ratioB;
    return this;
  }

  /**
   * this = slerp(a, b, t)
   * @param {Quat} a
   * @param {Quat} b
   * @param {number} t
   * @returns {Quat}
   */
  slerpQuaternions(a, b, t) {
    return this.copy(a).slerp(b, t);
  }

  /**
   * Rotates towards q by at most `step` radians.
   * @param {Quat} q
   * @param {number} step Radians.
   * @returns {Quat}
   */
  rotateTowards(q, step) {
    const angle = this.angleTo(q);
    if (angle === 0) return this;
    const t = Math.min(1, step / angle);
    return this.slerp(q, t);
  }

  /**
   * @param {ArrayLike<number>} a
   * @param {number} [o=0]
   * @returns {Quat}
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
   * Exact component equality.
   * @param {Quat} q
   * @returns {boolean}
   */
  equals(q) {
    return this.x === q.x && this.y === q.y && this.z === q.z && this.w === q.w;
  }

  /**
   * Equality within a tolerance (does not account for the double cover).
   * @param {Quat} q
   * @param {number} [eps=EPSILON]
   * @returns {boolean}
   */
  nearlyEquals(q, eps = EPSILON) {
    return Math.abs(this.x - q.x) <= eps &&
      Math.abs(this.y - q.y) <= eps &&
      Math.abs(this.z - q.z) <= eps &&
      Math.abs(this.w - q.w) <= eps;
  }

  /**
   * Flat-array slerp used by the animation system (no object allocation).
   * @param {Array<number>|Float32Array} dst
   * @param {number} dstOff
   * @param {ArrayLike<number>} src0
   * @param {number} off0
   * @param {ArrayLike<number>} src1
   * @param {number} off1
   * @param {number} t
   * @returns {void}
   */
  static slerpFlat(dst, dstOff, src0, off0, src1, off1, t) {
    let x0 = src0[off0];
    let y0 = src0[off0 + 1];
    let z0 = src0[off0 + 2];
    let w0 = src0[off0 + 3];

    const x1 = src1[off1];
    const y1 = src1[off1 + 1];
    const z1 = src1[off1 + 2];
    const w1 = src1[off1 + 3];

    if (t === 0) {
      dst[dstOff] = x0;
      dst[dstOff + 1] = y0;
      dst[dstOff + 2] = z0;
      dst[dstOff + 3] = w0;
      return;
    }

    if (t === 1) {
      dst[dstOff] = x1;
      dst[dstOff + 1] = y1;
      dst[dstOff + 2] = z1;
      dst[dstOff + 3] = w1;
      return;
    }

    if (w0 !== w1 || x0 !== x1 || y0 !== y1 || z0 !== z1) {
      let s = 1 - t;
      const cos = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
      const dir = cos >= 0 ? 1 : -1;
      const sqrSin = 1 - cos * cos;

      if (sqrSin > Number.EPSILON) {
        const sin = Math.sqrt(sqrSin);
        const len = Math.atan2(sin, cos * dir);
        s = Math.sin(s * len) / sin;
        t = Math.sin(t * len) / sin;
      }

      const tDir = t * dir;
      x0 = x0 * s + x1 * tDir;
      y0 = y0 * s + y1 * tDir;
      z0 = z0 * s + z1 * tDir;
      w0 = w0 * s + w1 * tDir;

      if (s === 1 - t) {
        const f = 1 / Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
        x0 *= f;
        y0 *= f;
        z0 *= f;
        w0 *= f;
      }
    }

    dst[dstOff] = x0;
    dst[dstOff + 1] = y0;
    dst[dstOff + 2] = z0;
    dst[dstOff + 3] = w0;
  }

  /**
   * Flat-array quaternion product, used by the animation system.
   * @param {Array<number>|Float32Array} dst
   * @param {number} dstOff
   * @param {ArrayLike<number>} src0
   * @param {number} off0
   * @param {ArrayLike<number>} src1
   * @param {number} off1
   * @returns {void}
   */
  static multiplyQuaternionsFlat(dst, dstOff, src0, off0, src1, off1) {
    const x0 = src0[off0], y0 = src0[off0 + 1], z0 = src0[off0 + 2], w0 = src0[off0 + 3];
    const x1 = src1[off1], y1 = src1[off1 + 1], z1 = src1[off1 + 2], w1 = src1[off1 + 3];
    dst[dstOff] = x0 * w1 + w0 * x1 + y0 * z1 - z0 * y1;
    dst[dstOff + 1] = y0 * w1 + w0 * y1 + z0 * x1 - x0 * z1;
    dst[dstOff + 2] = z0 * w1 + w0 * z1 + x0 * y1 - y0 * x1;
    dst[dstOff + 3] = w0 * w1 - x0 * x1 - y0 * y1 - z0 * z1;
  }
}

/** Identity rotation (frozen). @type {Quat} */
Quat.IDENTITY = Object.freeze(new Quat(0, 0, 0, 1));
