/**
 * Three component vector.
 * Every method mutates `this` and returns `this`, except the ones returning
 * a scalar, a boolean or a fresh clone.
 */
export class Vec3 {
    /**
     * @param {number} [x=0]
     * @param {number} [y=0]
     * @param {number} [z=0]
     */
    constructor(x?: number, y?: number, z?: number);
    /** @type {number} */ x: number;
    /** @type {number} */ y: number;
    /** @type {number} */ z: number;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Vec3}
     */
    set(x: number, y: number, z: number): Vec3;
    /**
     * Sets all components to the same scalar.
     * @param {number} s
     * @returns {Vec3}
     */
    setScalar(s: number): Vec3;
    /**
     * @param {Vec3} v
     * @returns {Vec3}
     */
    copy(v: Vec3): Vec3;
    /** @returns {Vec3} A new vector with the same components. */
    clone(): Vec3;
    /**
     * @param {Vec3} v
     * @returns {Vec3}
     */
    add(v: Vec3): Vec3;
    /**
     * @param {Vec3} a
     * @param {Vec3} b
     * @returns {Vec3}
     */
    addVectors(a: Vec3, b: Vec3): Vec3;
    /**
     * this += v * s
     * @param {Vec3} v
     * @param {number} s
     * @returns {Vec3}
     */
    addScaled(v: Vec3, s: number): Vec3;
    /**
     * Adds a scalar to every component.
     * @param {number} s
     * @returns {Vec3}
     */
    addScalar(s: number): Vec3;
    /**
     * @param {Vec3} v
     * @returns {Vec3}
     */
    sub(v: Vec3): Vec3;
    /**
     * @param {Vec3} a
     * @param {Vec3} b
     * @returns {Vec3}
     */
    subVectors(a: Vec3, b: Vec3): Vec3;
    /**
     * Component wise multiplication.
     * @param {Vec3} v
     * @returns {Vec3}
     */
    multiply(v: Vec3): Vec3;
    /**
     * @param {Vec3} a
     * @param {Vec3} b
     * @returns {Vec3}
     */
    multiplyVectors(a: Vec3, b: Vec3): Vec3;
    /**
     * @param {number} s
     * @returns {Vec3}
     */
    multiplyScalar(s: number): Vec3;
    /**
     * Component wise division.
     * @param {Vec3} v
     * @returns {Vec3}
     */
    divide(v: Vec3): Vec3;
    /**
     * @param {number} s
     * @returns {Vec3}
     */
    divideScalar(s: number): Vec3;
    /** @returns {Vec3} */
    negate(): Vec3;
    /**
     * @param {Vec3} v
     * @returns {number}
     */
    dot(v: Vec3): number;
    /**
     * this = this x v
     * @param {Vec3} v
     * @returns {Vec3}
     */
    cross(v: Vec3): Vec3;
    /**
     * this = a x b
     * @param {Vec3} a
     * @param {Vec3} b
     * @returns {Vec3}
     */
    crossVectors(a: Vec3, b: Vec3): Vec3;
    /** @returns {number} */
    length(): number;
    /** @returns {number} */
    lengthSq(): number;
    /** @returns {number} Manhattan length. */
    manhattanLength(): number;
    /**
     * @param {Vec3} v
     * @returns {number}
     */
    distanceTo(v: Vec3): number;
    /**
     * @param {Vec3} v
     * @returns {number}
     */
    distanceToSq(v: Vec3): number;
    /**
     * Normalizes in place. Zero length vectors are left untouched.
     * @returns {Vec3}
     */
    normalize(): Vec3;
    /**
     * @param {number} l
     * @returns {Vec3}
     */
    setLength(l: number): Vec3;
    /**
     * @param {Vec3} v
     * @param {number} t
     * @returns {Vec3}
     */
    lerp(v: Vec3, t: number): Vec3;
    /**
     * @param {Vec3} a
     * @param {Vec3} b
     * @param {number} t
     * @returns {Vec3}
     */
    lerpVectors(a: Vec3, b: Vec3, t: number): Vec3;
    /**
     * Component wise minimum.
     * @param {Vec3} v
     * @returns {Vec3}
     */
    min(v: Vec3): Vec3;
    /**
     * Component wise maximum.
     * @param {Vec3} v
     * @returns {Vec3}
     */
    max(v: Vec3): Vec3;
    /**
     * Clamps each component between the matching components of min and max.
     * @param {Vec3} min
     * @param {Vec3} max
     * @returns {Vec3}
     */
    clamp(min: Vec3, max: Vec3): Vec3;
    /**
     * Clamps the vector magnitude between min and max.
     * @param {number} min
     * @param {number} max
     * @returns {Vec3}
     */
    clampLength(min: number, max: number): Vec3;
    /**
     * Multiplies by a 3x3 matrix (column major elements).
     * @param {import('./Mat3.js').Mat3} m
     * @returns {Vec3}
     */
    applyMat3(m: import('./Mat3.js').Mat3): Vec3;
    /**
     * Multiplies by a 4x4 matrix as a point (w = 1) with perspective divide.
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Vec3}
     */
    applyMat4(m: import('./Mat4.js').Mat4): Vec3;
    /**
     * Rotates this vector by a quaternion.
     * @param {import('./Quat.js').Quat} q
     * @returns {Vec3}
     */
    applyQuat(q: import('./Quat.js').Quat): Vec3;
    /**
     * Multiplies by the upper 3x3 of a 4x4 matrix and renormalizes.
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Vec3}
     */
    transformDirection(m: import('./Mat4.js').Mat4): Vec3;
    /**
     * Reflects this vector around a (normalized) plane normal.
     * @param {Vec3} n Unit normal.
     * @returns {Vec3}
     */
    reflect(n: Vec3): Vec3;
    /**
     * Projects this vector onto v.
     * @param {Vec3} v
     * @returns {Vec3}
     */
    project(v: Vec3): Vec3;
    /**
     * Removes the component of this vector parallel to v.
     * @param {Vec3} v
     * @returns {Vec3}
     */
    projectOnPlane(v: Vec3): Vec3;
    /**
     * Extracts the translation of a 4x4 matrix.
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Vec3}
     */
    setFromMatrixPosition(m: import('./Mat4.js').Mat4): Vec3;
    /**
     * Reads a column of a 4x4 matrix (0..3).
     * @param {import('./Mat4.js').Mat4} m
     * @param {number} i
     * @returns {Vec3}
     */
    setFromMatrixColumn(m: import('./Mat4.js').Mat4, i: number): Vec3;
    /**
     * Scale of a matrix column (length of the basis vector).
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Vec3}
     */
    setFromMatrixScale(m: import('./Mat4.js').Mat4): Vec3;
    /**
     * Spherical coordinates to cartesian.
     * phi is the polar angle measured from +Y, theta the azimuth around +Y.
     * @param {number} radius
     * @param {number} phi
     * @param {number} theta
     * @returns {Vec3}
     */
    setFromSpherical(radius: number, phi: number, theta: number): Vec3;
    /**
     * Cylindrical coordinates to cartesian.
     * @param {number} radius
     * @param {number} theta
     * @param {number} y
     * @returns {Vec3}
     */
    setFromCylindrical(radius: number, theta: number, y: number): Vec3;
    /**
     * @param {ArrayLike<number>} a
     * @param {number} [o=0]
     * @returns {Vec3}
     */
    fromArray(a: ArrayLike<number>, o?: number): Vec3;
    /**
     * @param {Array<number>|Float32Array} [a=[]]
     * @param {number} [o=0]
     * @returns {Array<number>|Float32Array}
     */
    toArray(a?: Array<number> | Float32Array, o?: number): Array<number> | Float32Array;
    /**
     * Exact component equality.
     * @param {Vec3} v
     * @returns {boolean}
     */
    equals(v: Vec3): boolean;
    /**
     * Equality within a tolerance.
     * @param {Vec3} v
     * @param {number} [eps=EPSILON]
     * @returns {boolean}
     */
    nearlyEquals(v: Vec3, eps?: number): boolean;
    /** @returns {boolean} True when the squared length is below EPSILON^2. */
    isZero(): boolean;
    /** @returns {boolean} True when no component is NaN or Infinity. */
    isFinite(): boolean;
    /**
     * Unsigned angle (radians) between this vector and v.
     * @param {Vec3} v
     * @returns {number}
     */
    angleTo(v: Vec3): number;
}
export namespace Vec3 {
    const ZERO: Readonly<Vec3>;
    const ONE: Readonly<Vec3>;
    const UP: Readonly<Vec3>;
    const DOWN: Readonly<Vec3>;
    const RIGHT: Readonly<Vec3>;
    const LEFT: Readonly<Vec3>;
    const FORWARD: Readonly<Vec3>;
    const BACK: Readonly<Vec3>;
}
