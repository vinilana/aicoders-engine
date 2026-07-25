/**
 * Four component vector. Used for homogeneous coordinates, shader uniforms,
 * tangents (w = handedness) and packed GPU data.
 * Every method mutates `this` and returns `this`, except the ones returning
 * a scalar, a boolean or a fresh clone.
 */
export class Vec4 {
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
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} w
     * @returns {Vec4}
     */
    set(x: number, y: number, z: number, w: number): Vec4;
    /**
     * @param {number} s
     * @returns {Vec4}
     */
    setScalar(s: number): Vec4;
    /**
     * @param {Vec4} v
     * @returns {Vec4}
     */
    copy(v: Vec4): Vec4;
    /** @returns {Vec4} */
    clone(): Vec4;
    /**
     * @param {Vec4} v
     * @returns {Vec4}
     */
    add(v: Vec4): Vec4;
    /**
     * @param {Vec4} a
     * @param {Vec4} b
     * @returns {Vec4}
     */
    addVectors(a: Vec4, b: Vec4): Vec4;
    /**
     * this += v * s
     * @param {Vec4} v
     * @param {number} s
     * @returns {Vec4}
     */
    addScaled(v: Vec4, s: number): Vec4;
    /**
     * @param {Vec4} v
     * @returns {Vec4}
     */
    sub(v: Vec4): Vec4;
    /**
     * @param {Vec4} a
     * @param {Vec4} b
     * @returns {Vec4}
     */
    subVectors(a: Vec4, b: Vec4): Vec4;
    /**
     * @param {Vec4} v
     * @returns {Vec4}
     */
    multiply(v: Vec4): Vec4;
    /**
     * @param {number} s
     * @returns {Vec4}
     */
    multiplyScalar(s: number): Vec4;
    /**
     * @param {Vec4} v
     * @returns {Vec4}
     */
    divide(v: Vec4): Vec4;
    /**
     * @param {number} s
     * @returns {Vec4}
     */
    divideScalar(s: number): Vec4;
    /** @returns {Vec4} */
    negate(): Vec4;
    /**
     * @param {Vec4} v
     * @returns {number}
     */
    dot(v: Vec4): number;
    /** @returns {number} */
    length(): number;
    /** @returns {number} */
    lengthSq(): number;
    /** @returns {Vec4} */
    normalize(): Vec4;
    /**
     * @param {number} l
     * @returns {Vec4}
     */
    setLength(l: number): Vec4;
    /**
     * @param {Vec4} v
     * @param {number} t
     * @returns {Vec4}
     */
    lerp(v: Vec4, t: number): Vec4;
    /**
     * @param {Vec4} a
     * @param {Vec4} b
     * @param {number} t
     * @returns {Vec4}
     */
    lerpVectors(a: Vec4, b: Vec4, t: number): Vec4;
    /**
     * @param {Vec4} v
     * @returns {Vec4}
     */
    min(v: Vec4): Vec4;
    /**
     * @param {Vec4} v
     * @returns {Vec4}
     */
    max(v: Vec4): Vec4;
    /**
     * @param {Vec4} min
     * @param {Vec4} max
     * @returns {Vec4}
     */
    clamp(min: Vec4, max: Vec4): Vec4;
    /**
     * Full 4x4 matrix multiplication (no perspective divide).
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Vec4}
     */
    applyMat4(m: import('./Mat4.js').Mat4): Vec4;
    /**
     * Divides xyz by w (perspective divide) and sets w to 1.
     * @returns {Vec4}
     */
    perspectiveDivide(): Vec4;
    /**
     * Reads a column of a 4x4 matrix (0..3).
     * @param {import('./Mat4.js').Mat4} m
     * @param {number} i
     * @returns {Vec4}
     */
    setFromMatrixColumn(m: import('./Mat4.js').Mat4, i: number): Vec4;
    /**
     * Stores an axis-angle representation of a quaternion: xyz = axis, w = angle.
     * @param {import('./Quat.js').Quat} q Unit quaternion.
     * @returns {Vec4}
     */
    setAxisAngleFromQuat(q: import('./Quat.js').Quat): Vec4;
    /**
     * @param {ArrayLike<number>} a
     * @param {number} [o=0]
     * @returns {Vec4}
     */
    fromArray(a: ArrayLike<number>, o?: number): Vec4;
    /**
     * @param {Array<number>|Float32Array} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number>|Float32Array}
     */
    toArray(a?: Array<number> | Float32Array, o?: number): Array<number> | Float32Array;
    /**
     * @param {Vec4} v
     * @returns {boolean}
     */
    equals(v: Vec4): boolean;
    /**
     * @param {Vec4} v
     * @param {number} [eps=EPSILON]
     * @returns {boolean}
     */
    nearlyEquals(v: Vec4, eps?: number): boolean;
    /** @returns {boolean} */
    isZero(): boolean;
}
export namespace Vec4 {
    const ZERO: Readonly<Vec4>;
    const ONE: Readonly<Vec4>;
    const UNIT_W: Readonly<Vec4>;
}
