/**
 * Infinite plane defined by `dot(normal, p) + constant = 0`.
 * Points with a positive distance are on the side the normal points to.
 */
export class Plane {
    /**
     * @param {Vec3} [normal] Defaults to (1, 0, 0).
     * @param {number} [constant=0]
     */
    constructor(normal?: Vec3, constant?: number);
    /** @type {Vec3} */ normal: Vec3;
    /** @type {number} */ constant: number;
    /**
     * @param {Vec3} normal
     * @param {number} constant
     * @returns {Plane}
     */
    set(normal: Vec3, constant: number): Plane;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} w
     * @returns {Plane}
     */
    setComponents(x: number, y: number, z: number, w: number): Plane;
    /**
     * @param {Vec3} normal Unit normal.
     * @param {Vec3} point A point on the plane.
     * @returns {Plane}
     */
    setFromNormalAndCoplanarPoint(normal: Vec3, point: Vec3): Plane;
    /**
     * Builds the plane through three points (counter clockwise winding).
     * @param {Vec3} a
     * @param {Vec3} b
     * @param {Vec3} c
     * @returns {Plane}
     */
    setFromCoplanarPoints(a: Vec3, b: Vec3, c: Vec3): Plane;
    /**
     * Scales normal and constant so the normal becomes unit length.
     * @returns {Plane}
     */
    normalize(): Plane;
    /**
     * Flips the plane orientation.
     * @returns {Plane}
     */
    negate(): Plane;
    /**
     * Signed distance from the plane to a point.
     * @param {Vec3} p
     * @returns {number}
     */
    distanceToPoint(p: Vec3): number;
    /**
     * Signed distance from the plane to the closest point of a sphere.
     * @param {import('./Sphere.js').Sphere} s
     * @returns {number}
     */
    distanceToSphere(s: import('./Sphere.js').Sphere): number;
    /**
     * Projects a point onto the plane.
     * @param {Vec3} p
     * @param {Vec3} out
     * @returns {Vec3}
     */
    projectPoint(p: Vec3, out: Vec3): Vec3;
    /**
     * Ray/plane parameter along `direction` starting at `origin`.
     * @param {Vec3} origin
     * @param {Vec3} direction
     * @returns {number} t, or -1 when parallel.
     */
    intersectRayParam(origin: Vec3, direction: Vec3): number;
    /**
     * Transforms the plane by a matrix.
     * @param {import('./Mat4.js').Mat4} m
     * @param {import('./Mat3.js').Mat3} [normalMatrix] Precomputed normal matrix (optional).
     * @returns {Plane}
     */
    applyMat4(m: import('./Mat4.js').Mat4, normalMatrix?: import('./Mat3.js').Mat3): Plane;
    /**
     * Moves the plane along its normal.
     * @param {Vec3} offset
     * @returns {Plane}
     */
    translate(offset: Vec3): Plane;
    /**
     * @param {Plane} p
     * @returns {Plane}
     */
    copy(p: Plane): Plane;
    /** @returns {Plane} */
    clone(): Plane;
    /**
     * @param {Plane} p
     * @returns {boolean}
     */
    equals(p: Plane): boolean;
}
import { Vec3 } from "./Vec3.js";
