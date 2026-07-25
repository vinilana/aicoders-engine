import { Vec3 } from './Vec3.js';

// Module scoped scratch objects - never allocate on the hot path.
const _x = new Vec3();
const _y = new Vec3();
const _z = new Vec3();

/**
 * 4x4 matrix stored COLUMN MAJOR in a Float32Array(16), exactly like WebGL
 * expects it. The element at row r, column c lives at `elements[c * 4 + r]`.
 *
 * Conventions: right handed coordinate system, camera looks down -Z,
 * +Y is up, clip space depth in [-1, 1].
 */
export class Mat4 {
  /** @type {Float32Array} */ elements;

  constructor() {
    const e = new Float32Array(16);
    e[0] = 1;
    e[5] = 1;
    e[10] = 1;
    e[15] = 1;
    this.elements = e;
  }

  /**
   * Sets the identity matrix.
   * @returns {Mat4}
   */
  identity() {
    const e = this.elements;
    e[0] = 1; e[4] = 0; e[8] = 0; e[12] = 0;
    e[1] = 0; e[5] = 1; e[9] = 0; e[13] = 0;
    e[2] = 0; e[6] = 0; e[10] = 1; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }

  /**
   * Sets all 16 values. Arguments are given in ROW MAJOR reading order for
   * readability and stored column major.
   * @param {number} n11 @param {number} n12 @param {number} n13 @param {number} n14
   * @param {number} n21 @param {number} n22 @param {number} n23 @param {number} n24
   * @param {number} n31 @param {number} n32 @param {number} n33 @param {number} n34
   * @param {number} n41 @param {number} n42 @param {number} n43 @param {number} n44
   * @returns {Mat4}
   */
  set(n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, n41, n42, n43, n44) {
    const e = this.elements;
    e[0] = n11; e[4] = n12; e[8] = n13; e[12] = n14;
    e[1] = n21; e[5] = n22; e[9] = n23; e[13] = n24;
    e[2] = n31; e[6] = n32; e[10] = n33; e[14] = n34;
    e[3] = n41; e[7] = n42; e[11] = n43; e[15] = n44;
    return this;
  }

  /**
   * @param {Mat4} m
   * @returns {Mat4}
   */
  copy(m) {
    this.elements.set(m.elements);
    return this;
  }

  /** @returns {Mat4} */
  clone() {
    return new Mat4().copy(this);
  }

  /**
   * Reads 16 column major values from an array.
   * @param {ArrayLike<number>} a
   * @param {number} [o=0]
   * @returns {Mat4}
   */
  fromArray(a, o = 0) {
    const e = this.elements;
    for (let i = 0; i < 16; i++) e[i] = a[o + i];
    return this;
  }

  /**
   * Writes 16 column major values into an array.
   * @param {Array<number>|Float32Array} [a=[]]
   * @param {number} [o=0]
   * @returns {Array<number>|Float32Array}
   */
  toArray(a = [], o = 0) {
    const e = this.elements;
    for (let i = 0; i < 16; i++) a[o + i] = e[i];
    return a;
  }

  /**
   * this = this * m
   * @param {Mat4} m
   * @returns {Mat4}
   */
  multiply(m) {
    return this.multiplyMatrices(this, m);
  }

  /**
   * this = m * this
   * @param {Mat4} m
   * @returns {Mat4}
   */
  premultiply(m) {
    return this.multiplyMatrices(m, this);
  }

  /**
   * this = a * b
   * @param {Mat4} a
   * @param {Mat4} b
   * @returns {Mat4}
   */
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;

    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];

    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];

    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;

    return this;
  }

  /**
   * Multiplies every element by a scalar.
   * @param {number} s
   * @returns {Mat4}
   */
  multiplyScalar(s) {
    const e = this.elements;
    for (let i = 0; i < 16; i++) e[i] *= s;
    return this;
  }

  /**
   * Builds a matrix from translation, rotation and scale.
   * @param {Vec3} position
   * @param {import('./Quat.js').Quat} quaternion
   * @param {Vec3} scale
   * @returns {Mat4}
   */
  compose(position, quaternion, scale) {
    const te = this.elements;
    const x = quaternion.x, y = quaternion.y, z = quaternion.z, w = quaternion.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scale.x, sy = scale.y, sz = scale.z;

    te[0] = (1 - (yy + zz)) * sx;
    te[1] = (xy + wz) * sx;
    te[2] = (xz - wy) * sx;
    te[3] = 0;

    te[4] = (xy - wz) * sy;
    te[5] = (1 - (xx + zz)) * sy;
    te[6] = (yz + wx) * sy;
    te[7] = 0;

    te[8] = (xz + wy) * sz;
    te[9] = (yz - wx) * sz;
    te[10] = (1 - (xx + yy)) * sz;
    te[11] = 0;

    te[12] = position.x;
    te[13] = position.y;
    te[14] = position.z;
    te[15] = 1;

    return this;
  }

  /**
   * Splits the matrix into translation, rotation and scale.
   * A negative determinant (mirrored matrix) is folded into a negative X scale.
   * @param {Vec3} position
   * @param {import('./Quat.js').Quat} quaternion
   * @param {Vec3} scale
   * @returns {Mat4}
   */
  decompose(position, quaternion, scale) {
    const te = this.elements;

    let sx = Math.sqrt(te[0] * te[0] + te[1] * te[1] + te[2] * te[2]);
    const sy = Math.sqrt(te[4] * te[4] + te[5] * te[5] + te[6] * te[6]);
    const sz = Math.sqrt(te[8] * te[8] + te[9] * te[9] + te[10] * te[10]);

    // Mirrored matrices cannot be represented by a rotation: flip X.
    if (this.determinant() < 0) sx = -sx;

    position.x = te[12];
    position.y = te[13];
    position.z = te[14];

    const me = _m1.elements;
    me.set(te);

    const invSX = sx !== 0 ? 1 / sx : 0;
    const invSY = sy !== 0 ? 1 / sy : 0;
    const invSZ = sz !== 0 ? 1 / sz : 0;

    me[0] *= invSX; me[1] *= invSX; me[2] *= invSX; me[3] = 0;
    me[4] *= invSY; me[5] *= invSY; me[6] *= invSY; me[7] = 0;
    me[8] *= invSZ; me[9] *= invSZ; me[10] *= invSZ; me[11] = 0;
    me[12] = 0; me[13] = 0; me[14] = 0; me[15] = 1;

    quaternion.setFromRotationMatrix(_m1);

    scale.x = sx;
    scale.y = sy;
    scale.z = sz;

    return this;
  }

  /**
   * Full general inverse via cofactor expansion (works for projection
   * matrices too, not only affine ones). Sets the identity when the matrix
   * is singular.
   * @returns {Mat4}
   */
  invert() {
    const te = this.elements;
    const n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3];
    const n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7];
    const n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11];
    const n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15];

    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 -
      n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 +
      n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 -
      n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 +
      n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;

    if (det === 0) return this.identity();

    const d = 1 / det;

    te[0] = t11 * d;
    te[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 +
      n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d;
    te[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 -
      n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d;
    te[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 +
      n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d;

    te[4] = t12 * d;
    te[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 -
      n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d;
    te[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 +
      n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d;
    te[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 -
      n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d;

    te[8] = t13 * d;
    te[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 +
      n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d;
    te[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 -
      n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d;
    te[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 +
      n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d;

    te[12] = t14 * d;
    te[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 -
      n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d;
    te[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 +
      n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d;
    te[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 -
      n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d;

    return this;
  }

  /**
   * this = inverse(m)
   * @param {Mat4} m
   * @returns {Mat4}
   */
  invertMatrix(m) {
    return this.copy(m).invert();
  }

  /** @returns {Mat4} */
  transpose() {
    const e = this.elements;
    let t;
    t = e[1]; e[1] = e[4]; e[4] = t;
    t = e[2]; e[2] = e[8]; e[8] = t;
    t = e[6]; e[6] = e[9]; e[9] = t;
    t = e[3]; e[3] = e[12]; e[12] = t;
    t = e[7]; e[7] = e[13]; e[13] = t;
    t = e[11]; e[11] = e[14]; e[14] = t;
    return this;
  }

  /** @returns {number} */
  determinant() {
    const te = this.elements;
    const n11 = te[0], n12 = te[4], n13 = te[8], n14 = te[12];
    const n21 = te[1], n22 = te[5], n23 = te[9], n24 = te[13];
    const n31 = te[2], n32 = te[6], n33 = te[10], n34 = te[14];
    const n41 = te[3], n42 = te[7], n43 = te[11], n44 = te[15];

    return (
      n41 * (
        +n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 +
        n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34
      ) +
      n42 * (
        +n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 -
        n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31
      ) +
      n43 * (
        +n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 +
        n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31
      ) +
      n44 * (
        -n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 +
        n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31
      )
    );
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @returns {Mat4}
   */
  makeTranslation(x, y, z) {
    return this.set(
      1, 0, 0, x,
      0, 1, 0, y,
      0, 0, 1, z,
      0, 0, 0, 1
    );
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @returns {Mat4}
   */
  makeScale(x, y, z) {
    return this.set(
      x, 0, 0, 0,
      0, y, 0, 0,
      0, 0, z, 0,
      0, 0, 0, 1
    );
  }

  /**
   * @param {number} theta Radians.
   * @returns {Mat4}
   */
  makeRotationX(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return this.set(
      1, 0, 0, 0,
      0, c, -s, 0,
      0, s, c, 0,
      0, 0, 0, 1
    );
  }

  /**
   * @param {number} theta Radians.
   * @returns {Mat4}
   */
  makeRotationY(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return this.set(
      c, 0, s, 0,
      0, 1, 0, 0,
      -s, 0, c, 0,
      0, 0, 0, 1
    );
  }

  /**
   * @param {number} theta Radians.
   * @returns {Mat4}
   */
  makeRotationZ(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return this.set(
      c, -s, 0, 0,
      s, c, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    );
  }

  /**
   * @param {import('./Quat.js').Quat} q
   * @returns {Mat4}
   */
  makeRotationFromQuat(q) {
    return this.compose(_ZERO_V, q, _ONE_V);
  }

  /**
   * Rotation around an arbitrary unit axis (Rodrigues formula).
   * @param {Vec3} axis Unit axis.
   * @param {number} angle Radians.
   * @returns {Mat4}
   */
  makeRotationAxis(axis, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const x = axis.x, y = axis.y, z = axis.z;
    const tx = t * x, ty = t * y;

    return this.set(
      tx * x + c, tx * y - s * z, tx * z + s * y, 0,
      tx * y + s * z, ty * y + c, ty * z - s * x, 0,
      tx * z - s * y, ty * z + s * x, t * z * z + c, 0,
      0, 0, 0, 1
    );
  }

  /**
   * Builds a matrix whose columns are the given basis vectors.
   * @param {Vec3} xAxis
   * @param {Vec3} yAxis
   * @param {Vec3} zAxis
   * @returns {Mat4}
   */
  makeBasis(xAxis, yAxis, zAxis) {
    return this.set(
      xAxis.x, yAxis.x, zAxis.x, 0,
      xAxis.y, yAxis.y, zAxis.y, 0,
      xAxis.z, yAxis.z, zAxis.z, 0,
      0, 0, 0, 1
    );
  }

  /**
   * Copies the rotation part of m into this, removing scale and translation.
   * @param {Mat4} m
   * @returns {Mat4}
   */
  extractRotation(m) {
    const te = this.elements;
    const me = m.elements;

    let sx = Math.sqrt(me[0] * me[0] + me[1] * me[1] + me[2] * me[2]);
    let sy = Math.sqrt(me[4] * me[4] + me[5] * me[5] + me[6] * me[6]);
    let sz = Math.sqrt(me[8] * me[8] + me[9] * me[9] + me[10] * me[10]);
    sx = sx !== 0 ? 1 / sx : 0;
    sy = sy !== 0 ? 1 / sy : 0;
    sz = sz !== 0 ? 1 / sz : 0;

    te[0] = me[0] * sx; te[1] = me[1] * sx; te[2] = me[2] * sx; te[3] = 0;
    te[4] = me[4] * sy; te[5] = me[5] * sy; te[6] = me[6] * sy; te[7] = 0;
    te[8] = me[8] * sz; te[9] = me[9] * sz; te[10] = me[10] * sz; te[11] = 0;
    te[12] = 0; te[13] = 0; te[14] = 0; te[15] = 1;
    return this;
  }

  /**
   * Writes the three basis columns into the given vectors.
   * @param {Vec3} xAxis
   * @param {Vec3} yAxis
   * @param {Vec3} zAxis
   * @returns {Mat4}
   */
  extractBasis(xAxis, yAxis, zAxis) {
    const e = this.elements;
    xAxis.set(e[0], e[1], e[2]);
    yAxis.set(e[4], e[5], e[6]);
    zAxis.set(e[8], e[9], e[10]);
    return this;
  }

  /**
   * Overwrites the translation column. Accepts (x, y, z) or (vec3).
   * @param {number|Vec3} x
   * @param {number} [y]
   * @param {number} [z]
   * @returns {Mat4}
   */
  setPosition(x, y, z) {
    const e = this.elements;
    if (typeof x === 'object' && x !== null) {
      e[12] = x.x;
      e[13] = x.y;
      e[14] = x.z;
    } else {
      e[12] = x;
      e[13] = y;
      e[14] = z;
    }
    return this;
  }

  /**
   * Scales the basis columns by a vector (this = this * scale).
   * @param {Vec3} v
   * @returns {Mat4}
   */
  scale(v) {
    const e = this.elements;
    const x = v.x, y = v.y, z = v.z;
    e[0] *= x; e[4] *= y; e[8] *= z;
    e[1] *= x; e[5] *= y; e[9] *= z;
    e[2] *= x; e[6] *= y; e[10] *= z;
    e[3] *= x; e[7] *= y; e[11] *= z;
    return this;
  }

  /**
   * Camera WORLD matrix looking from `eye` towards `target`
   * (right handed, the camera looks down its local -Z).
   * @param {Vec3} eye
   * @param {Vec3} target
   * @param {Vec3} up
   * @returns {Mat4}
   */
  lookAt(eye, target, up) {
    _z.subVectors(eye, target);
    if (_z.lengthSq() === 0) _z.z = 1;
    _z.normalize();

    _x.crossVectors(up, _z);
    if (_x.lengthSq() === 0) {
      // up and forward are parallel: perturb one axis.
      if (Math.abs(up.z) === 1) _z.x += 0.0001;
      else _z.z += 0.0001;
      _z.normalize();
      _x.crossVectors(up, _z);
    }
    _x.normalize();
    _y.crossVectors(_z, _x);

    const e = this.elements;
    e[0] = _x.x; e[4] = _y.x; e[8] = _z.x; e[12] = eye.x;
    e[1] = _x.y; e[5] = _y.y; e[9] = _z.y; e[13] = eye.y;
    e[2] = _x.z; e[6] = _y.z; e[10] = _z.z; e[14] = eye.z;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }

  /**
   * VIEW matrix (inverse of {@link lookAt}), built directly for precision.
   * @param {Vec3} eye
   * @param {Vec3} target
   * @param {Vec3} up
   * @returns {Mat4}
   */
  makeView(eye, target, up) {
    _z.subVectors(eye, target);
    if (_z.lengthSq() === 0) _z.z = 1;
    _z.normalize();

    _x.crossVectors(up, _z);
    if (_x.lengthSq() === 0) {
      if (Math.abs(up.z) === 1) _z.x += 0.0001;
      else _z.z += 0.0001;
      _z.normalize();
      _x.crossVectors(up, _z);
    }
    _x.normalize();
    _y.crossVectors(_z, _x);

    const e = this.elements;
    e[0] = _x.x; e[4] = _x.y; e[8] = _x.z; e[12] = -(_x.x * eye.x + _x.y * eye.y + _x.z * eye.z);
    e[1] = _y.x; e[5] = _y.y; e[9] = _y.z; e[13] = -(_y.x * eye.x + _y.y * eye.y + _y.z * eye.z);
    e[2] = _z.x; e[6] = _z.y; e[10] = _z.z; e[14] = -(_z.x * eye.x + _z.y * eye.y + _z.z * eye.z);
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }

  /**
   * Right handed perspective projection mapping depth to [-1, 1].
   * `far` may be Infinity (infinite far plane).
   * @param {number} fovY Vertical field of view in RADIANS.
   * @param {number} aspect Width / height.
   * @param {number} near
   * @param {number} far
   * @returns {Mat4}
   */
  perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY * 0.5);
    const e = this.elements;

    e[0] = f / aspect; e[4] = 0; e[8] = 0; e[12] = 0;
    e[1] = 0; e[5] = f; e[9] = 0; e[13] = 0;
    e[2] = 0; e[6] = 0; e[14] = 0; e[10] = 0;
    e[3] = 0; e[7] = 0; e[11] = -1; e[15] = 0;

    if (far === Infinity || !Number.isFinite(far)) {
      e[10] = -1;
      e[14] = -2 * near;
    } else {
      const nf = 1 / (near - far);
      e[10] = (far + near) * nf;
      e[14] = 2 * far * near * nf;
    }
    return this;
  }

  /**
   * Right handed orthographic projection mapping depth to [-1, 1].
   * @param {number} left @param {number} right
   * @param {number} bottom @param {number} top
   * @param {number} near @param {number} far
   * @returns {Mat4}
   */
  orthographic(left, right, bottom, top, near, far) {
    const e = this.elements;
    const w = 1 / (right - left);
    const h = 1 / (top - bottom);
    const p = 1 / (far - near);

    e[0] = 2 * w; e[4] = 0; e[8] = 0; e[12] = -(right + left) * w;
    e[1] = 0; e[5] = 2 * h; e[9] = 0; e[13] = -(top + bottom) * h;
    e[2] = 0; e[6] = 0; e[10] = -2 * p; e[14] = -(far + near) * p;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }

  /**
   * Off-center perspective frustum (used by shadow/portal cameras).
   * @param {number} left @param {number} right
   * @param {number} bottom @param {number} top
   * @param {number} near @param {number} far
   * @returns {Mat4}
   */
  frustum(left, right, bottom, top, near, far) {
    const e = this.elements;
    const x = 2 * near / (right - left);
    const y = 2 * near / (top - bottom);
    const a = (right + left) / (right - left);
    const b = (top + bottom) / (top - bottom);
    const c = -(far + near) / (far - near);
    const d = -2 * far * near / (far - near);

    e[0] = x; e[4] = 0; e[8] = a; e[12] = 0;
    e[1] = 0; e[5] = y; e[9] = b; e[13] = 0;
    e[2] = 0; e[6] = 0; e[10] = c; e[14] = d;
    e[3] = 0; e[7] = 0; e[11] = -1; e[15] = 0;
    return this;
  }

  /**
   * Largest scale factor among the three basis columns.
   * Used for conservative bounding sphere transforms.
   * @returns {number}
   */
  getMaxScaleOnAxis() {
    const e = this.elements;
    const sx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    const sy = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
    const sz = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    return Math.sqrt(Math.max(sx, sy, sz));
  }

  /**
   * Writes the translation column into `out`.
   * @param {Vec3} out
   * @returns {Vec3}
   */
  getPosition(out) {
    const e = this.elements;
    return out.set(e[12], e[13], e[14]);
  }

  /**
   * Exact element equality.
   * @param {Mat4} m
   * @returns {boolean}
   */
  equals(m) {
    const a = this.elements, b = m.elements;
    for (let i = 0; i < 16; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Element equality within a tolerance.
   * @param {Mat4} m
   * @param {number} [eps=1e-6]
   * @returns {boolean}
   */
  nearlyEquals(m, eps = 1e-6) {
    const a = this.elements, b = m.elements;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(a[i] - b[i]) > eps) return false;
    }
    return true;
  }
}

// Scratch matrix used by decompose(); declared after the class so the
// constructor is available.
const _m1 = new Mat4();
const _ZERO_V = Object.freeze(new Vec3(0, 0, 0));
const _ONE_V = Object.freeze(new Vec3(1, 1, 1));

/** Identity matrix (frozen, do not mutate). @type {Mat4} */
Mat4.IDENTITY = Object.freeze(new Mat4());
