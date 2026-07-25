/**
 * Two component vector.
 * Every method mutates `this` and returns `this`, except the ones returning
 * a scalar, a boolean or a fresh clone.
 */
export class Vec2 {
    /**
     * @param {number} [x=0]
     * @param {number} [y=0]
     */
    constructor(x?: number, y?: number);
    /** @type {number} */ x: number;
    /** @type {number} */ y: number;
    /**
     * @param {number} x
     * @param {number} y
     * @returns {Vec2}
     */
    set(x: number, y: number): Vec2;
    /**
     * @param {number} s
     * @returns {Vec2}
     */
    setScalar(s: number): Vec2;
    /**
     * @param {Vec2} v
     * @returns {Vec2}
     */
    copy(v: Vec2): Vec2;
    /** @returns {Vec2} */
    clone(): Vec2;
    /**
     * @param {Vec2} v
     * @returns {Vec2}
     */
    add(v: Vec2): Vec2;
    /**
     * @param {Vec2} a
     * @param {Vec2} b
     * @returns {Vec2}
     */
    addVectors(a: Vec2, b: Vec2): Vec2;
    /**
     * this += v * s
     * @param {Vec2} v
     * @param {number} s
     * @returns {Vec2}
     */
    addScaled(v: Vec2, s: number): Vec2;
    /**
     * @param {number} s
     * @returns {Vec2}
     */
    addScalar(s: number): Vec2;
    /**
     * @param {Vec2} v
     * @returns {Vec2}
     */
    sub(v: Vec2): Vec2;
    /**
     * @param {Vec2} a
     * @param {Vec2} b
     * @returns {Vec2}
     */
    subVectors(a: Vec2, b: Vec2): Vec2;
    /**
     * @param {Vec2} v
     * @returns {Vec2}
     */
    multiply(v: Vec2): Vec2;
    /**
     * @param {number} s
     * @returns {Vec2}
     */
    multiplyScalar(s: number): Vec2;
    /**
     * @param {Vec2} v
     * @returns {Vec2}
     */
    divide(v: Vec2): Vec2;
    /**
     * @param {number} s
     * @returns {Vec2}
     */
    divideScalar(s: number): Vec2;
    /** @returns {Vec2} */
    negate(): Vec2;
    /**
     * @param {Vec2} v
     * @returns {number}
     */
    dot(v: Vec2): number;
    /**
     * 2D cross product (signed area of the parallelogram).
     * @param {Vec2} v
     * @returns {number}
     */
    cross(v: Vec2): number;
    /** @returns {number} */
    length(): number;
    /** @returns {number} */
    lengthSq(): number;
    /**
     * @param {Vec2} v
     * @returns {number}
     */
    distanceTo(v: Vec2): number;
    /**
     * @param {Vec2} v
     * @returns {number}
     */
    distanceToSq(v: Vec2): number;
    /** @returns {Vec2} */
    normalize(): Vec2;
    /**
     * @param {number} l
     * @returns {Vec2}
     */
    setLength(l: number): Vec2;
    /**
     * @param {Vec2} v
     * @param {number} t
     * @returns {Vec2}
     */
    lerp(v: Vec2, t: number): Vec2;
    /**
     * @param {Vec2} a
     * @param {Vec2} b
     * @param {number} t
     * @returns {Vec2}
     */
    lerpVectors(a: Vec2, b: Vec2, t: number): Vec2;
    /**
     * @param {Vec2} v
     * @returns {Vec2}
     */
    min(v: Vec2): Vec2;
    /**
     * @param {Vec2} v
     * @returns {Vec2}
     */
    max(v: Vec2): Vec2;
    /**
     * @param {Vec2} min
     * @param {Vec2} max
     * @returns {Vec2}
     */
    clamp(min: Vec2, max: Vec2): Vec2;
    /**
     * @param {number} min
     * @param {number} max
     * @returns {Vec2}
     */
    clampLength(min: number, max: number): Vec2;
    /**
     * Applies a 3x3 matrix treating this as a point (x, y, 1).
     * @param {import('./Mat3.js').Mat3} m
     * @returns {Vec2}
     */
    applyMat3(m: import('./Mat3.js').Mat3): Vec2;
    /**
     * Rotates the vector around the origin.
     * @param {number} angle Radians (counter clockwise).
     * @returns {Vec2}
     */
    rotate(angle: number): Vec2;
    /**
     * Rotates the vector around a pivot point.
     * @param {Vec2} center
     * @param {number} angle
     * @returns {Vec2}
     */
    rotateAround(center: Vec2, angle: number): Vec2;
    /** @returns {number} Angle of the vector in radians, in [0, 2PI). */
    angle(): number;
    /**
     * Unsigned angle between this vector and v.
     * @param {Vec2} v
     * @returns {number}
     */
    angleTo(v: Vec2): number;
    /**
     * @param {ArrayLike<number>} a
     * @param {number} [o=0]
     * @returns {Vec2}
     */
    fromArray(a: ArrayLike<number>, o?: number): Vec2;
    /**
     * @param {Array<number>|Float32Array} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number>|Float32Array}
     */
    toArray(a?: Array<number> | Float32Array, o?: number): Array<number> | Float32Array;
    /**
     * @param {Vec2} v
     * @returns {boolean}
     */
    equals(v: Vec2): boolean;
    /**
     * @param {Vec2} v
     * @param {number} [eps=EPSILON]
     * @returns {boolean}
     */
    nearlyEquals(v: Vec2, eps?: number): boolean;
    /** @returns {boolean} */
    isZero(): boolean;
}
export namespace Vec2 {
    const ZERO: Readonly<Vec2>;
    const ONE: Readonly<Vec2>;
    const UP: Readonly<Vec2>;
    const DOWN: Readonly<Vec2>;
    const RIGHT: Readonly<Vec2>;
    const LEFT: Readonly<Vec2>;
}
