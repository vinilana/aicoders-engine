/**
 * 3x3 matrix stored COLUMN MAJOR in a Float32Array(9), matching the GLSL
 * `mat3` memory layout. The element at row r, column c lives at
 * `elements[c * 3 + r]`.
 *
 * Used for normal matrices and for 2D affine transforms (UV transforms).
 */
export class Mat3 {
  /** @type {Float32Array} */ elements;

  constructor() {
    const e = new Float32Array(9);
    e[0] = 1;
    e[4] = 1;
    e[8] = 1;
    this.elements = e;
  }

  /**
   * @returns {Mat3}
   */
  identity() {
    const e = this.elements;
    e[0] = 1; e[3] = 0; e[6] = 0;
    e[1] = 0; e[4] = 1; e[7] = 0;
    e[2] = 0; e[5] = 0; e[8] = 1;
    return this;
  }

  /**
   * Sets all 9 values. Arguments are given in ROW MAJOR reading order and
   * stored column major.
   * @param {number} n11 @param {number} n12 @param {number} n13
   * @param {number} n21 @param {number} n22 @param {number} n23
   * @param {number} n31 @param {number} n32 @param {number} n33
   * @returns {Mat3}
   */
  set(n11, n12, n13, n21, n22, n23, n31, n32, n33) {
    const e = this.elements;
    e[0] = n11; e[3] = n12; e[6] = n13;
    e[1] = n21; e[4] = n22; e[7] = n23;
    e[2] = n31; e[5] = n32; e[8] = n33;
    return this;
  }

  /**
   * @param {Mat3} m
   * @returns {Mat3}
   */
  copy(m) {
    this.elements.set(m.elements);
    return this;
  }

  /** @returns {Mat3} */
  clone() {
    return new Mat3().copy(this);
  }

  /**
   * Copies the upper left 3x3 block of a 4x4 matrix.
   * @param {import('./Mat4.js').Mat4} m
   * @returns {Mat3}
   */
  setFromMat4(m) {
    const me = m.elements;
    const e = this.elements;
    e[0] = me[0]; e[3] = me[4]; e[6] = me[8];
    e[1] = me[1]; e[4] = me[5]; e[7] = me[9];
    e[2] = me[2]; e[5] = me[6]; e[8] = me[10];
    return this;
  }

  /**
   * this = this * m
   * @param {Mat3} m
   * @returns {Mat3}
   */
  multiply(m) {
    return this.multiplyMatrices(this, m);
  }

  /**
   * this = m * this
   * @param {Mat3} m
   * @returns {Mat3}
   */
  premultiply(m) {
    return this.multiplyMatrices(m, this);
  }

  /**
   * this = a * b
   * @param {Mat3} a
   * @param {Mat3} b
   * @returns {Mat3}
   */
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;

    const a11 = ae[0], a12 = ae[3], a13 = ae[6];
    const a21 = ae[1], a22 = ae[4], a23 = ae[7];
    const a31 = ae[2], a32 = ae[5], a33 = ae[8];

    const b11 = be[0], b12 = be[3], b13 = be[6];
    const b21 = be[1], b22 = be[4], b23 = be[7];
    const b31 = be[2], b32 = be[5], b33 = be[8];

    te[0] = a11 * b11 + a12 * b21 + a13 * b31;
    te[3] = a11 * b12 + a12 * b22 + a13 * b32;
    te[6] = a11 * b13 + a12 * b23 + a13 * b33;

    te[1] = a21 * b11 + a22 * b21 + a23 * b31;
    te[4] = a21 * b12 + a22 * b22 + a23 * b32;
    te[7] = a21 * b13 + a22 * b23 + a23 * b33;

    te[2] = a31 * b11 + a32 * b21 + a33 * b31;
    te[5] = a31 * b12 + a32 * b22 + a33 * b32;
    te[8] = a31 * b13 + a32 * b23 + a33 * b33;

    return this;
  }

  /**
   * Inverts the matrix; singular matrices become the identity.
   * @returns {Mat3}
   */
  invert() {
    const e = this.elements;
    const n11 = e[0], n21 = e[1], n31 = e[2];
    const n12 = e[3], n22 = e[4], n32 = e[5];
    const n13 = e[6], n23 = e[7], n33 = e[8];

    const t11 = n33 * n22 - n32 * n23;
    const t12 = n32 * n13 - n33 * n12;
    const t13 = n23 * n12 - n22 * n13;

    const det = n11 * t11 + n21 * t12 + n31 * t13;
    if (det === 0) return this.identity();

    const d = 1 / det;

    e[0] = t11 * d;
    e[1] = (n31 * n23 - n33 * n21) * d;
    e[2] = (n32 * n21 - n31 * n22) * d;
    e[3] = t12 * d;
    e[4] = (n33 * n11 - n31 * n13) * d;
    e[5] = (n31 * n12 - n32 * n11) * d;
    e[6] = t13 * d;
    e[7] = (n21 * n13 - n23 * n11) * d;
    e[8] = (n22 * n11 - n21 * n12) * d;

    return this;
  }

  /** @returns {Mat3} */
  transpose() {
    const e = this.elements;
    let t;
    t = e[1]; e[1] = e[3]; e[3] = t;
    t = e[2]; e[2] = e[6]; e[6] = t;
    t = e[5]; e[5] = e[7]; e[7] = t;
    return this;
  }

  /** @returns {number} */
  determinant() {
    const e = this.elements;
    const a = e[0], b = e[1], c = e[2];
    const d = e[3], f = e[4], g = e[5];
    const h = e[6], i = e[7], j = e[8];
    return a * f * j - a * g * i - b * d * j + b * g * h + c * d * i - c * f * h;
  }

  /**
   * Normal matrix of a model matrix: inverse transpose of its upper 3x3.
   * @param {import('./Mat4.js').Mat4} m4
   * @returns {Mat3}
   */
  getNormalMatrix(m4) {
    return this.setFromMat4(m4).invert().transpose();
  }

  /**
   * 2D scale applied to this matrix (this = this * scale).
   * @param {number} sx
   * @param {number} sy
   * @returns {Mat3}
   */
  scale(sx, sy) {
    const e = this.elements;
    e[0] *= sx; e[3] *= sy;
    e[1] *= sx; e[4] *= sy;
    e[2] *= sx; e[5] *= sy;
    return this;
  }

  /**
   * 2D rotation applied to this matrix (this = this * rotation).
   * @param {number} theta Radians.
   * @returns {Mat3}
   */
  rotate(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    const e = this.elements;
    const a11 = e[0], a12 = e[3], a13 = e[6];
    const a21 = e[1], a22 = e[4], a23 = e[7];

    e[0] = c * a11 + s * a12;
    e[3] = -s * a11 + c * a12;
    e[6] = a13;

    e[1] = c * a21 + s * a22;
    e[4] = -s * a21 + c * a22;
    e[7] = a23;

    return this;
  }

  /**
   * 2D translation applied to this matrix (this = this * translation).
   * @param {number} tx
   * @param {number} ty
   * @returns {Mat3}
   */
  translate(tx, ty) {
    const e = this.elements;
    e[6] += tx * e[0] + ty * e[3];
    e[7] += tx * e[1] + ty * e[4];
    e[8] += tx * e[2] + ty * e[5];
    return this;
  }

  /**
   * Pure 2D rotation matrix.
   * @param {number} theta Radians.
   * @returns {Mat3}
   */
  makeRotation(theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return this.set(
      c, -s, 0,
      s, c, 0,
      0, 0, 1
    );
  }

  /**
   * Pure 2D translation matrix.
   * @param {number} tx
   * @param {number} ty
   * @returns {Mat3}
   */
  makeTranslation(tx, ty) {
    return this.set(
      1, 0, tx,
      0, 1, ty,
      0, 0, 1
    );
  }

  /**
   * Pure 2D scale matrix.
   * @param {number} sx
   * @param {number} sy
   * @returns {Mat3}
   */
  makeScale(sx, sy) {
    return this.set(
      sx, 0, 0,
      0, sy, 0,
      0, 0, 1
    );
  }

  /**
   * Builds a UV transform (offset / repeat / rotation around a center),
   * matching the KHR_texture_transform semantics.
   * @param {number} tx Offset X.
   * @param {number} ty Offset Y.
   * @param {number} sx Repeat X.
   * @param {number} sy Repeat Y.
   * @param {number} rotation Radians.
   * @param {number} cx Rotation center X.
   * @param {number} cy Rotation center Y.
   * @returns {Mat3}
   */
  setUvTransform(tx, ty, sx, sy, rotation, cx, cy) {
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    return this.set(
      sx * c, sx * s, -sx * (c * cx + s * cy) + cx + tx,
      -sy * s, sy * c, -sy * (-s * cx + c * cy) + cy + ty,
      0, 0, 1
    );
  }

  /**
   * @param {ArrayLike<number>} a Column major values.
   * @param {number} [o=0]
   * @returns {Mat3}
   */
  fromArray(a, o = 0) {
    const e = this.elements;
    for (let i = 0; i < 9; i++) e[i] = a[o + i];
    return this;
  }

  /**
   * @param {Array<number>|Float32Array} [a=[]]
   * @param {number} [o=0]
   * @returns {Array<number>|Float32Array}
   */
  toArray(a = [], o = 0) {
    const e = this.elements;
    for (let i = 0; i < 9; i++) a[o + i] = e[i];
    return a;
  }

  /**
   * Exact element equality.
   * @param {Mat3} m
   * @returns {boolean}
   */
  equals(m) {
    const a = this.elements, b = m.elements;
    for (let i = 0; i < 9; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Element equality within a tolerance.
   * @param {Mat3} m
   * @param {number} [eps=1e-6]
   * @returns {boolean}
   */
  nearlyEquals(m, eps = 1e-6) {
    const a = this.elements, b = m.elements;
    for (let i = 0; i < 9; i++) {
      if (Math.abs(a[i] - b[i]) > eps) return false;
    }
    return true;
  }
}

/** Identity matrix (frozen, do not mutate). @type {Mat3} */
Mat3.IDENTITY = Object.freeze(new Mat3());
