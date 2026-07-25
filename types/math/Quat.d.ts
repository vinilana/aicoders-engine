/**
 * Unit quaternion (x, y, z, w) representing a rotation.
 * Right handed coordinate system, rotations follow the right hand rule.
 */
export class Quat {
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
    static slerpFlat(dst: Array<number> | Float32Array, dstOff: number, src0: ArrayLike<number>, off0: number, src1: ArrayLike<number>, off1: number, t: number): void;
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
    static multiplyQuaternionsFlat(dst: Array<number> | Float32Array, dstOff: number, src0: ArrayLike<number>, off0: number, src1: ArrayLike<number>, off1: number): void;
    /**
     * @param {number} [x=0]
     * @param {number} [y=0]
     * @param {number} [z=0]
     * @param {number} [w=1]
     */
    constructor(x?: number, y?: number, z?: number, w?: number);
    /** @type {number} */ x: number;
    /** @type {number} */ y: number;
    /** @type {number} */ z: number;
    /** @type {number} */ w: number;
    /**
     * Resets to the identity rotation.
     * @returns {Quat}
     */
    identity(): Quat;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} w
     * @returns {Quat}
     */
    set(x: number, y: number, z: number, w: number): Quat;
    /**
     * @param {Quat} q
     * @returns {Quat}
     */
    copy(q: Quat): Quat;
    /** @returns {Quat} */
    clone(): Quat;
    /**
     * @param {Vec3} axis Unit axis.
     * @param {number} angle Radians.
     * @returns {Quat}
     */
    setFromAxisAngle(axis: Vec3, angle: number): Quat;
    /**
     * Builds the quaternion from an Euler rotation (intrinsic rotations,
     * order given by `euler.order`, default 'YXZ').
     * @param {import('./Euler.js').Euler} euler
     * @returns {Quat}
     */
    setFromEuler(euler: import('./Euler.js').Euler): Quat;
    /**
     * Extracts the rotation of a matrix using Shepperd's algorithm.
     * The upper 3x3 of `m` must be a pure rotation (unscaled).
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Quat}
     */
    setFromRotationMatrix(m: import('./Mat4.js').Mat4): Quat;
    /**
     * Extracts the rotation of a 3x3 matrix.
     * @param {import('./Mat3.js').Mat3} m
     * @returns {Quat}
     */
    setFromMat3(m: import('./Mat3.js').Mat3): Quat;
    /**
     * Shortest arc rotation taking `from` to `to`. Both must be unit vectors.
     * @param {Vec3} from
     * @param {Vec3} to
     * @returns {Quat}
     */
    setFromUnitVectors(from: Vec3, to: Vec3): Quat;
    /**
     * Rotation whose local -Z axis points along `forward` and whose local +Y
     * axis is as close as possible to `up` (engine convention: objects and
     * cameras look down their local -Z).
     * @param {Vec3} forward Direction to face (does not need to be normalized).
     * @param {Vec3} [up=Vec3.UP]
     * @returns {Quat}
     */
    lookRotation(forward: Vec3, up?: Vec3): Quat;
    /**
     * this = this * q
     * @param {Quat} q
     * @returns {Quat}
     */
    multiply(q: Quat): Quat;
    /**
     * this = q * this
     * @param {Quat} q
     * @returns {Quat}
     */
    premultiply(q: Quat): Quat;
    /**
     * this = a * b (Hamilton product).
     * @param {Quat} a
     * @param {Quat} b
     * @returns {Quat}
     */
    multiplyQuaternions(a: Quat, b: Quat): Quat;
    /**
     * Full inverse (conjugate divided by squared norm).
     * @returns {Quat}
     */
    invert(): Quat;
    /**
     * Negates the vector part (inverse for unit quaternions).
     * @returns {Quat}
     */
    conjugate(): Quat;
    /**
     * Normalizes to unit length; degenerate quaternions become identity.
     * @returns {Quat}
     */
    normalize(): Quat;
    /**
     * @param {Quat} q
     * @returns {number}
     */
    dot(q: Quat): number;
    /** @returns {number} */
    lengthSq(): number;
    /** @returns {number} */
    length(): number;
    /**
     * Smallest rotation angle (radians) between the two orientations.
     * @param {Quat} q
     * @returns {number}
     */
    angleTo(q: Quat): number;
    /**
     * Spherical linear interpolation towards q (shortest path).
     * @param {Quat} q
     * @param {number} t
     * @returns {Quat}
     */
    slerp(q: Quat, t: number): Quat;
    /**
     * this = slerp(a, b, t)
     * @param {Quat} a
     * @param {Quat} b
     * @param {number} t
     * @returns {Quat}
     */
    slerpQuaternions(a: Quat, b: Quat, t: number): Quat;
    /**
     * Rotates towards q by at most `step` radians.
     * @param {Quat} q
     * @param {number} step Radians.
     * @returns {Quat}
     */
    rotateTowards(q: Quat, step: number): Quat;
    /**
     * @param {ArrayLike<number>} a
     * @param {number} [o=0]
     * @returns {Quat}
     */
    fromArray(a: ArrayLike<number>, o?: number): Quat;
    /**
     * @param {Array<number>|Float32Array} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number>|Float32Array}
     */
    toArray(a?: Array<number> | Float32Array, o?: number): Array<number> | Float32Array;
    /**
     * Exact component equality.
     * @param {Quat} q
     * @returns {boolean}
     */
    equals(q: Quat): boolean;
    /**
     * Equality within a tolerance (does not account for the double cover).
     * @param {Quat} q
     * @param {number} [eps=EPSILON]
     * @returns {boolean}
     */
    nearlyEquals(q: Quat, eps?: number): boolean;
}
export namespace Quat {
    const IDENTITY: Readonly<Quat>;
}
import { Vec3 } from "./Vec3.js";
