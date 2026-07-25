/**
 * Euler angles in radians with a configurable intrinsic rotation order.
 * The engine default is 'YXZ' (yaw, then pitch, then roll), the natural
 * order for cameras and characters.
 *
 * Supported orders: 'XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'.
 */
export class Euler {
    /**
     * @param {number} [x=0]
     * @param {number} [y=0]
     * @param {number} [z=0]
     * @param {string} [order='YXZ']
     */
    constructor(x?: number, y?: number, z?: number, order?: string);
    /** @type {number} */ x: number;
    /** @type {number} */ y: number;
    /** @type {number} */ z: number;
    /** @type {string} */ order: string;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {string} [order] Keeps the current order when omitted.
     * @returns {Euler}
     */
    set(x: number, y: number, z: number, order?: string): Euler;
    /**
     * @param {Euler} e
     * @returns {Euler}
     */
    copy(e: Euler): Euler;
    /** @returns {Euler} */
    clone(): Euler;
    /**
     * Extracts Euler angles from the rotation part of a matrix.
     * The upper 3x3 of `m` must be a pure rotation (unscaled).
     * @param {Mat4} m
     * @param {string} [order] Defaults to the current order.
     * @returns {Euler}
     */
    setFromRotationMatrix(m: Mat4, order?: string): Euler;
    /**
     * Extracts Euler angles from a unit quaternion.
     * @param {import('./Quat.js').Quat} q
     * @param {string} [order] Defaults to the current order.
     * @returns {Euler}
     */
    setFromQuat(q: import('./Quat.js').Quat, order?: string): Euler;
    /**
     * Reinterprets the angles in a different order (keeps the orientation).
     * @param {string} order
     * @returns {Euler}
     */
    reorder(order: string): Euler;
    /**
     * Writes the equivalent rotation matrix into `out`.
     * @param {Mat4} out
     * @returns {Mat4}
     */
    toRotationMatrix(out: Mat4): Mat4;
    /**
     * @param {ArrayLike<number|string>} a [x, y, z, order?]
     * @param {number} [o=0]
     * @returns {Euler}
     */
    fromArray(a: ArrayLike<number | string>, o?: number): Euler;
    /**
     * @param {Array<number|string>} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number|string>}
     */
    toArray(a?: Array<number | string>, o?: number): Array<number | string>;
    /**
     * @param {Euler} e
     * @returns {boolean}
     */
    equals(e: Euler): boolean;
}
import { Mat4 } from "./Mat4.js";
