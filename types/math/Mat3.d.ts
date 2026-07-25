/**
 * 3x3 matrix stored COLUMN MAJOR in a Float32Array(9), matching the GLSL
 * `mat3` memory layout. The element at row r, column c lives at
 * `elements[c * 3 + r]`.
 *
 * Used for normal matrices and for 2D affine transforms (UV transforms).
 */
export class Mat3 {
    /** @type {Float32Array} */ elements: Float32Array;
    /**
     * @returns {Mat3}
     */
    identity(): Mat3;
    /**
     * Sets all 9 values. Arguments are given in ROW MAJOR reading order and
     * stored column major.
     * @param {number} n11 @param {number} n12 @param {number} n13
     * @param {number} n21 @param {number} n22 @param {number} n23
     * @param {number} n31 @param {number} n32 @param {number} n33
     * @returns {Mat3}
     */
    set(n11: number, n12: number, n13: number, n21: number, n22: number, n23: number, n31: number, n32: number, n33: number): Mat3;
    /**
     * @param {Mat3} m
     * @returns {Mat3}
     */
    copy(m: Mat3): Mat3;
    /** @returns {Mat3} */
    clone(): Mat3;
    /**
     * Copies the upper left 3x3 block of a 4x4 matrix.
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Mat3}
     */
    setFromMat4(m: import('./Mat4.js').Mat4): Mat3;
    /**
     * this = this * m
     * @param {Mat3} m
     * @returns {Mat3}
     */
    multiply(m: Mat3): Mat3;
    /**
     * this = m * this
     * @param {Mat3} m
     * @returns {Mat3}
     */
    premultiply(m: Mat3): Mat3;
    /**
     * this = a * b
     * @param {Mat3} a
     * @param {Mat3} b
     * @returns {Mat3}
     */
    multiplyMatrices(a: Mat3, b: Mat3): Mat3;
    /**
     * Inverts the matrix; singular matrices become the identity.
     * @returns {Mat3}
     */
    invert(): Mat3;
    /** @returns {Mat3} */
    transpose(): Mat3;
    /** @returns {number} */
    determinant(): number;
    /**
     * Normal matrix of a model matrix: inverse transpose of its upper 3x3.
     * @param {import('./Mat4.js').Mat4} m4
     * @returns {Mat3}
     */
    getNormalMatrix(m4: import('./Mat4.js').Mat4): Mat3;
    /**
     * 2D scale applied to this matrix (this = this * scale).
     * @param {number} sx
     * @param {number} sy
     * @returns {Mat3}
     */
    scale(sx: number, sy: number): Mat3;
    /**
     * 2D rotation applied to this matrix (this = this * rotation).
     * @param {number} theta Radians.
     * @returns {Mat3}
     */
    rotate(theta: number): Mat3;
    /**
     * 2D translation applied to this matrix (this = this * translation).
     * @param {number} tx
     * @param {number} ty
     * @returns {Mat3}
     */
    translate(tx: number, ty: number): Mat3;
    /**
     * Pure 2D rotation matrix.
     * @param {number} theta Radians.
     * @returns {Mat3}
     */
    makeRotation(theta: number): Mat3;
    /**
     * Pure 2D translation matrix.
     * @param {number} tx
     * @param {number} ty
     * @returns {Mat3}
     */
    makeTranslation(tx: number, ty: number): Mat3;
    /**
     * Pure 2D scale matrix.
     * @param {number} sx
     * @param {number} sy
     * @returns {Mat3}
     */
    makeScale(sx: number, sy: number): Mat3;
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
    setUvTransform(tx: number, ty: number, sx: number, sy: number, rotation: number, cx: number, cy: number): Mat3;
    /**
     * @param {ArrayLike<number>} a Column major values.
     * @param {number} [o=0]
     * @returns {Mat3}
     */
    fromArray(a: ArrayLike<number>, o?: number): Mat3;
    /**
     * @param {Array<number>|Float32Array} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number>|Float32Array}
     */
    toArray(a?: Array<number> | Float32Array, o?: number): Array<number> | Float32Array;
    /**
     * Exact element equality.
     * @param {Mat3} m
     * @returns {boolean}
     */
    equals(m: Mat3): boolean;
    /**
     * Element equality within a tolerance.
     * @param {Mat3} m
     * @param {number} [eps=1e-6]
     * @returns {boolean}
     */
    nearlyEquals(m: Mat3, eps?: number): boolean;
}
export namespace Mat3 {
    const IDENTITY: Readonly<Mat3>;
}
