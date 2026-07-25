import { clamp } from './MathUtils.js';
import { Mat4 } from './Mat4.js';

// Module scoped scratch - never allocate on the hot path.
const _m = new Mat4();

/**
 * Euler angles in radians with a configurable intrinsic rotation order.
 * The engine default is 'YXZ' (yaw, then pitch, then roll), the natural
 * order for cameras and characters.
 *
 * Supported orders: 'XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'.
 */
export class Euler {
  /** @type {number} */ x;
  /** @type {number} */ y;
  /** @type {number} */ z;
  /** @type {string} */ order;

  /**
   * @param {number} [x=0]
   * @param {number} [y=0]
   * @param {number} [z=0]
   * @param {string} [order='YXZ']
   */
  constructor(x = 0, y = 0, z = 0, order = 'YXZ') {
    this.x = x;
    this.y = y;
    this.z = z;
    this.order = order;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {string} [order] Keeps the current order when omitted.
   * @returns {Euler}
   */
  set(x, y, z, order) {
    this.x = x;
    this.y = y;
    this.z = z;
    if (order !== undefined) this.order = order;
    return this;
  }

  /**
   * @param {Euler} e
   * @returns {Euler}
   */
  copy(e) {
    this.x = e.x;
    this.y = e.y;
    this.z = e.z;
    this.order = e.order;
    return this;
  }

  /** @returns {Euler} */
  clone() {
    return new Euler(this.x, this.y, this.z, this.order);
  }

  /**
   * Extracts Euler angles from the rotation part of a matrix.
   * The upper 3x3 of `m` must be a pure rotation (unscaled).
   * @param {Mat4} m
   * @param {string} [order] Defaults to the current order.
   * @returns {Euler}
   */
  setFromRotationMatrix(m, order = this.order) {
    const te = m.elements;
    const m11 = te[0], m12 = te[4], m13 = te[8];
    const m21 = te[1], m22 = te[5], m23 = te[9];
    const m31 = te[2], m32 = te[6], m33 = te[10];

    switch (order) {
      case 'XYZ':
        this.y = Math.asin(clamp(m13, -1, 1));
        if (Math.abs(m13) < 0.9999999) {
          this.x = Math.atan2(-m23, m33);
          this.z = Math.atan2(-m12, m11);
        } else {
          this.x = Math.atan2(m32, m22);
          this.z = 0;
        }
        break;
      case 'YXZ':
        this.x = Math.asin(-clamp(m23, -1, 1));
        if (Math.abs(m23) < 0.9999999) {
          this.y = Math.atan2(m13, m33);
          this.z = Math.atan2(m21, m22);
        } else {
          this.y = Math.atan2(-m31, m11);
          this.z = 0;
        }
        break;
      case 'ZXY':
        this.x = Math.asin(clamp(m32, -1, 1));
        if (Math.abs(m32) < 0.9999999) {
          this.y = Math.atan2(-m31, m33);
          this.z = Math.atan2(-m12, m22);
        } else {
          this.y = 0;
          this.z = Math.atan2(m21, m11);
        }
        break;
      case 'ZYX':
        this.y = Math.asin(-clamp(m31, -1, 1));
        if (Math.abs(m31) < 0.9999999) {
          this.x = Math.atan2(m32, m33);
          this.z = Math.atan2(m21, m11);
        } else {
          this.x = 0;
          this.z = Math.atan2(-m12, m22);
        }
        break;
      case 'YZX':
        this.z = Math.asin(clamp(m21, -1, 1));
        if (Math.abs(m21) < 0.9999999) {
          this.x = Math.atan2(-m23, m22);
          this.y = Math.atan2(-m31, m11);
        } else {
          this.x = 0;
          this.y = Math.atan2(m13, m33);
        }
        break;
      case 'XZY':
        this.z = Math.asin(-clamp(m12, -1, 1));
        if (Math.abs(m12) < 0.9999999) {
          this.x = Math.atan2(m32, m22);
          this.y = Math.atan2(m13, m11);
        } else {
          this.x = Math.atan2(-m23, m33);
          this.y = 0;
        }
        break;
      default:
        // Unknown order: fall back to the engine default.
        return this.setFromRotationMatrix(m, 'YXZ');
    }

    this.order = order;
    return this;
  }

  /**
   * Extracts Euler angles from a unit quaternion.
   * @param {import('./Quat.js').Quat} q
   * @param {string} [order] Defaults to the current order.
   * @returns {Euler}
   */
  setFromQuat(q, order = this.order) {
    _m.makeRotationFromQuat(q);
    return this.setFromRotationMatrix(_m, order);
  }

  /**
   * Reinterprets the angles in a different order (keeps the orientation).
   * @param {string} order
   * @returns {Euler}
   */
  reorder(order) {
    this.toRotationMatrix(_m);
    return this.setFromRotationMatrix(_m, order);
  }

  /**
   * Writes the equivalent rotation matrix into `out`.
   * @param {Mat4} out
   * @returns {Mat4}
   */
  toRotationMatrix(out) {
    const cx = Math.cos(this.x), sx = Math.sin(this.x);
    const cy = Math.cos(this.y), sy = Math.sin(this.y);
    const cz = Math.cos(this.z), sz = Math.sin(this.z);
    const e = out.elements;

    // R composed following the configured intrinsic order.
    let m11, m12, m13, m21, m22, m23, m31, m32, m33;

    switch (this.order) {
      case 'XYZ': {
        const ae = cx * cz, af = cx * sz, be = sx * cz, bf = sx * sz;
        m11 = cy * cz; m12 = -cy * sz; m13 = sy;
        m21 = af + be * sy; m22 = ae - bf * sy; m23 = -sx * cy;
        m31 = bf - ae * sy; m32 = be + af * sy; m33 = cx * cy;
        break;
      }
      case 'ZXY': {
        const ce = cy * cz, cf = cy * sz, de = sy * cz, df = sy * sz;
        m11 = ce - df * sx; m12 = -cx * sz; m13 = de + cf * sx;
        m21 = cf + de * sx; m22 = cx * cz; m23 = df - ce * sx;
        m31 = -cx * sy; m32 = sx; m33 = cx * cy;
        break;
      }
      case 'ZYX': {
        const ae = cx * cz, af = cx * sz, be = sx * cz, bf = sx * sz;
        m11 = cy * cz; m12 = be * sy - af; m13 = ae * sy + bf;
        m21 = cy * sz; m22 = bf * sy + ae; m23 = af * sy - be;
        m31 = -sy; m32 = sx * cy; m33 = cx * cy;
        break;
      }
      case 'YZX': {
        const ac = cx * cy, ad = cx * sy, bc = sx * cy, bd = sx * sy;
        m11 = cy * cz; m12 = bd - ac * sz; m13 = bc * sz + ad;
        m21 = sz; m22 = cx * cz; m23 = -sx * cz;
        m31 = -sy * cz; m32 = ad * sz + bc; m33 = ac - bd * sz;
        break;
      }
      case 'XZY': {
        const ac = cx * cy, ad = cx * sy, bc = sx * cy, bd = sx * sy;
        m11 = cy * cz; m12 = -sz; m13 = sy * cz;
        m21 = ac * sz + bd; m22 = cx * cz; m23 = ad * sz - bc;
        m31 = bc * sz - ad; m32 = sx * cz; m33 = bd * sz + ac;
        break;
      }
      default: { // 'YXZ'
        const ce = cy * cz, cf = cy * sz, de = sy * cz, df = sy * sz;
        m11 = ce + df * sx; m12 = de * sx - cf; m13 = cx * sy;
        m21 = cx * sz; m22 = cx * cz; m23 = -sx;
        m31 = cf * sx - de; m32 = df + ce * sx; m33 = cx * cy;
        break;
      }
    }

    e[0] = m11; e[4] = m12; e[8] = m13; e[12] = 0;
    e[1] = m21; e[5] = m22; e[9] = m23; e[13] = 0;
    e[2] = m31; e[6] = m32; e[10] = m33; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return out;
  }

  /**
   * @param {ArrayLike<number|string>} a [x, y, z, order?]
   * @param {number} [o=0]
   * @returns {Euler}
   */
  fromArray(a, o = 0) {
    this.x = /** @type {number} */ (a[o]);
    this.y = /** @type {number} */ (a[o + 1]);
    this.z = /** @type {number} */ (a[o + 2]);
    if (a[o + 3] !== undefined) this.order = /** @type {string} */ (a[o + 3]);
    return this;
  }

  /**
   * @param {Array<number|string>} [a=[]]
   * @param {number} [o=0]
   * @returns {Array<number|string>}
   */
  toArray(a = [], o = 0) {
    a[o] = this.x;
    a[o + 1] = this.y;
    a[o + 2] = this.z;
    a[o + 3] = this.order;
    return a;
  }

  /**
   * @param {Euler} e
   * @returns {boolean}
   */
  equals(e) {
    return this.x === e.x && this.y === e.y && this.z === e.z && this.order === e.order;
  }
}
