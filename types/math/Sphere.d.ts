/**
 * Bounding sphere. A negative radius marks an "empty" sphere.
 */
export class Sphere {
    /**
     * @param {Vec3} [center] Defaults to the origin.
     * @param {number} [radius=-1] Negative means empty.
     */
    constructor(center?: Vec3, radius?: number);
    /** @type {Vec3} */ center: Vec3;
    /** @type {number} */ radius: number;
    /**
     * @param {Vec3} center
     * @param {number} radius
     * @returns {Sphere}
     */
    set(center: Vec3, radius: number): Sphere;
    /**
     * Allocation free setter.
     * @param {number} x @param {number} y @param {number} z @param {number} radius
     * @returns {Sphere}
     */
    setValues(x: number, y: number, z: number, radius: number): Sphere;
    /**
     * Marks the sphere as empty.
     * @returns {Sphere}
     */
    makeEmpty(): Sphere;
    /** @returns {boolean} */
    isEmpty(): boolean;
    /**
     * Bounding sphere of a point cloud (average center, then max radius).
     * @param {Vec3[]} points
     * @param {Vec3} [optionalCenter]
     * @returns {Sphere}
     */
    setFromPoints(points: Vec3[], optionalCenter?: Vec3): Sphere;
    /**
     * Bounding sphere of a flat position array.
     * @param {ArrayLike<number>} array
     * @param {number} [stride=3]
     * @param {number} [offset=0]
     * @returns {Sphere}
     */
    setFromArray(array: ArrayLike<number>, stride?: number, offset?: number): Sphere;
    /**
     * Sphere circumscribing an AABB.
     * @param {import('./AABB.js').AABB} b
     * @returns {Sphere}
     */
    setFromAABB(b: import('./AABB.js').AABB): Sphere;
    /**
     * Transforms the sphere (radius scaled by the largest axis scale).
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Sphere}
     */
    applyMat4(m: import('./Mat4.js').Mat4): Sphere;
    /**
     * this = source transformed by m (source is left untouched).
     * @param {Sphere} source
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Sphere}
     */
    copyTransformed(source: Sphere, m: import('./Mat4.js').Mat4): Sphere;
    /**
     * Grows the sphere so it contains p.
     * @param {Vec3} p
     * @returns {Sphere}
     */
    expandByPoint(p: Vec3): Sphere;
    /**
     * Grows the sphere so it contains another sphere.
     * @param {Sphere} s
     * @returns {Sphere}
     */
    union(s: Sphere): Sphere;
    /**
     * @param {Sphere} s
     * @returns {boolean}
     */
    intersectsSphere(s: Sphere): boolean;
    /**
     * @param {import('./AABB.js').AABB} b
     * @returns {boolean}
     */
    intersectsAABB(b: import('./AABB.js').AABB): boolean;
    /**
     * @param {import('./Plane.js').Plane} plane
     * @returns {boolean}
     */
    intersectsPlane(plane: import('./Plane.js').Plane): boolean;
    /**
     * @param {Vec3} p
     * @returns {boolean}
     */
    containsPoint(p: Vec3): boolean;
    /**
     * @param {Sphere} s
     * @returns {boolean}
     */
    containsSphere(s: Sphere): boolean;
    /**
     * Distance from the sphere surface to a point (negative when inside).
     * @param {Vec3} p
     * @returns {number}
     */
    distanceToPoint(p: Vec3): number;
    /**
     * Closest point of the sphere to p.
     * @param {Vec3} p
     * @param {Vec3} out
     * @returns {Vec3}
     */
    clampPoint(p: Vec3, out: Vec3): Vec3;
    /**
     * @param {Vec3} offset
     * @returns {Sphere}
     */
    translate(offset: Vec3): Sphere;
    /**
     * @param {Sphere} s
     * @returns {Sphere}
     */
    copy(s: Sphere): Sphere;
    /** @returns {Sphere} */
    clone(): Sphere;
    /**
     * @param {Sphere} s
     * @returns {boolean}
     */
    equals(s: Sphere): boolean;
}
import { Vec3 } from "./Vec3.js";
