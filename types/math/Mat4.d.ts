/**
 * 4x4 matrix stored COLUMN MAJOR in a Float32Array(16), exactly like WebGL
 * expects it. The element at row r, column c lives at `elements[c * 4 + r]`.
 *
 * Conventions: right handed coordinate system, camera looks down -Z,
 * +Y is up, clip space depth in [-1, 1].
 */
export class Mat4 {
    /** @type {Float32Array} */ elements: Float32Array;
    /**
     * Sets the identity matrix.
     * @returns {Mat4}
     */
    identity(): Mat4;
    /**
     * Sets all 16 values. Arguments are given in ROW MAJOR reading order for
     * readability and stored column major.
     * @param {number} n11 @param {number} n12 @param {number} n13 @param {number} n14
     * @param {number} n21 @param {number} n22 @param {number} n23 @param {number} n24
     * @param {number} n31 @param {number} n32 @param {number} n33 @param {number} n34
     * @param {number} n41 @param {number} n42 @param {number} n43 @param {number} n44
     * @returns {Mat4}
     */
    set(n11: number, n12: number, n13: number, n14: number, n21: number, n22: number, n23: number, n24: number, n31: number, n32: number, n33: number, n34: number, n41: number, n42: number, n43: number, n44: number): Mat4;
    /**
     * @param {Mat4} m
     * @returns {Mat4}
     */
    copy(m: Mat4): Mat4;
    /** @returns {Mat4} */
    clone(): Mat4;
    /**
     * Reads 16 column major values from an array.
     * @param {ArrayLike<number>} a
     * @param {number} [o=0]
     * @returns {Mat4}
     */
    fromArray(a: ArrayLike<number>, o?: number): Mat4;
    /**
     * Writes 16 column major values into an array.
     * @param {Array<number>|Float32Array} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number>|Float32Array}
     */
    toArray(a?: Array<number> | Float32Array, o?: number): Array<number> | Float32Array;
    /**
     * this = this * m
     * @param {Mat4} m
     * @returns {Mat4}
     */
    multiply(m: Mat4): Mat4;
    /**
     * this = m * this
     * @param {Mat4} m
     * @returns {Mat4}
     */
    premultiply(m: Mat4): Mat4;
    /**
     * this = a * b
     * @param {Mat4} a
     * @param {Mat4} b
     * @returns {Mat4}
     */
    multiplyMatrices(a: Mat4, b: Mat4): Mat4;
    /**
     * Multiplies every element by a scalar.
     * @param {number} s
     * @returns {Mat4}
     */
    multiplyScalar(s: number): Mat4;
    /**
     * Builds a matrix from translation, rotation and scale.
     * @param {Vec3} position
     * @param {import('./Quat.js').Quat} quaternion
     * @param {Vec3} scale
     * @returns {Mat4}
     */
    compose(position: Vec3, quaternion: import('./Quat.js').Quat, scale: Vec3): Mat4;
    /**
     * Splits the matrix into translation, rotation and scale.
     * A negative determinant (mirrored matrix) is folded into a negative X scale.
     * @param {Vec3} position
     * @param {import('./Quat.js').Quat} quaternion
     * @param {Vec3} scale
     * @returns {Mat4}
     */
    decompose(position: Vec3, quaternion: import('./Quat.js').Quat, scale: Vec3): Mat4;
    /**
     * Full general inverse via cofactor expansion (works for projection
     * matrices too, not only affine ones). Sets the identity when the matrix
     * is singular.
     * @returns {Mat4}
     */
    invert(): Mat4;
    /**
     * this = inverse(m)
     * @param {Mat4} m
     * @returns {Mat4}
     */
    invertMatrix(m: Mat4): Mat4;
    /** @returns {Mat4} */
    transpose(): Mat4;
    /** @returns {number} */
    determinant(): number;
    /**
     * @param {number} x @param {number} y @param {number} z
     * @returns {Mat4}
     */
    makeTranslation(x: number, y: number, z: number): Mat4;
    /**
     * @param {number} x @param {number} y @param {number} z
     * @returns {Mat4}
     */
    makeScale(x: number, y: number, z: number): Mat4;
    /**
     * @param {number} theta Radians.
     * @returns {Mat4}
     */
    makeRotationX(theta: number): Mat4;
    /**
     * @param {number} theta Radians.
     * @returns {Mat4}
     */
    makeRotationY(theta: number): Mat4;
    /**
     * @param {number} theta Radians.
     * @returns {Mat4}
     */
    makeRotationZ(theta: number): Mat4;
    /**
     * @param {import('./Quat.js').Quat} q
     * @returns {Mat4}
     */
    makeRotationFromQuat(q: import('./Quat.js').Quat): Mat4;
    /**
     * Rotation around an arbitrary unit axis (Rodrigues formula).
     * @param {Vec3} axis Unit axis.
     * @param {number} angle Radians.
     * @returns {Mat4}
     */
    makeRotationAxis(axis: Vec3, angle: number): Mat4;
    /**
     * Builds a matrix whose columns are the given basis vectors.
     * @param {Vec3} xAxis
     * @param {Vec3} yAxis
     * @param {Vec3} zAxis
     * @returns {Mat4}
     */
    makeBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Mat4;
    /**
     * Copies the rotation part of m into this, removing scale and translation.
     * @param {Mat4} m
     * @returns {Mat4}
     */
    extractRotation(m: Mat4): Mat4;
    /**
     * Writes the three basis columns into the given vectors.
     * @param {Vec3} xAxis
     * @param {Vec3} yAxis
     * @param {Vec3} zAxis
     * @returns {Mat4}
     */
    extractBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Mat4;
    /**
     * Overwrites the translation column. Accepts (x, y, z) or (vec3).
     * @param {number|Vec3} x
     * @param {number} [y]
     * @param {number} [z]
     * @returns {Mat4}
     */
    setPosition(x: number | Vec3, y?: number, z?: number): Mat4;
    /**
     * Scales the basis columns by a vector (this = this * scale).
     * @param {Vec3} v
     * @returns {Mat4}
     */
    scale(v: Vec3): Mat4;
    /**
     * Camera WORLD matrix looking from `eye` towards `target`
     * (right handed, the camera looks down its local -Z).
     * @param {Vec3} eye
     * @param {Vec3} target
     * @param {Vec3} up
     * @returns {Mat4}
     */
    lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4;
    /**
     * VIEW matrix (inverse of {@link lookAt}), built directly for precision.
     * @param {Vec3} eye
     * @param {Vec3} target
     * @param {Vec3} up
     * @returns {Mat4}
     */
    makeView(eye: Vec3, target: Vec3, up: Vec3): Mat4;
    /**
     * Right handed perspective projection mapping depth to [-1, 1].
     * `far` may be Infinity (infinite far plane).
     * @param {number} fovY Vertical field of view in RADIANS.
     * @param {number} aspect Width / height.
     * @param {number} near
     * @param {number} far
     * @returns {Mat4}
     */
    perspective(fovY: number, aspect: number, near: number, far: number): Mat4;
    /**
     * Right handed orthographic projection mapping depth to [-1, 1].
     * @param {number} left @param {number} right
     * @param {number} bottom @param {number} top
     * @param {number} near @param {number} far
     * @returns {Mat4}
     */
    orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4;
    /**
     * Off-center perspective frustum (used by shadow/portal cameras).
     * @param {number} left @param {number} right
     * @param {number} bottom @param {number} top
     * @param {number} near @param {number} far
     * @returns {Mat4}
     */
    frustum(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4;
    /**
     * Largest scale factor among the three basis columns.
     * Used for conservative bounding sphere transforms.
     * @returns {number}
     */
    getMaxScaleOnAxis(): number;
    /**
     * Writes the translation column into `out`.
     * @param {Vec3} out
     * @returns {Vec3}
     */
    getPosition(out: Vec3): Vec3;
    /**
     * Exact element equality.
     * @param {Mat4} m
     * @returns {boolean}
     */
    equals(m: Mat4): boolean;
    /**
     * Element equality within a tolerance.
     * @param {Mat4} m
     * @param {number} [eps=1e-6]
     * @returns {boolean}
     */
    nearlyEquals(m: Mat4, eps?: number): boolean;
}
export namespace Mat4 {
    const IDENTITY: Readonly<Mat4>;
}
import { Vec3 } from "./Vec3.js";
