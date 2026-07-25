/**
 * Ray defined by an origin and a (normally unit length) direction.
 * All intersection methods return the parametric distance `t` along the ray,
 * or -1 when there is no hit.
 */
export class Ray {
    /**
     * @param {Vec3} [origin] Defaults to the world origin.
     * @param {Vec3} [direction] Defaults to (0, 0, -1).
     */
    constructor(origin?: Vec3, direction?: Vec3);
    /** @type {Vec3} */ origin: Vec3;
    /** @type {Vec3} */ direction: Vec3;
    /**
     * @param {Vec3} origin
     * @param {Vec3} direction Should be normalized.
     * @returns {Ray}
     */
    set(origin: Vec3, direction: Vec3): Ray;
    /**
     * Allocation free setter.
     * @param {number} ox @param {number} oy @param {number} oz
     * @param {number} dx @param {number} dy @param {number} dz
     * @returns {Ray}
     */
    setValues(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): Ray;
    /**
     * Point at parametric distance t.
     * @param {number} t
     * @param {Vec3} [out] Reused when given.
     * @returns {Vec3}
     */
    at(t: number, out?: Vec3): Vec3;
    /**
     * Points the ray towards a target position.
     * @param {Vec3} target
     * @returns {Ray}
     */
    lookAt(target: Vec3): Ray;
    /**
     * Moves the origin along the direction.
     * @param {number} t
     * @returns {Ray}
     */
    advance(t: number): Ray;
    /**
     * @param {Ray} r
     * @returns {Ray}
     */
    copy(r: Ray): Ray;
    /** @returns {Ray} */
    clone(): Ray;
    /**
     * Transforms the ray by a matrix (direction is renormalized).
     * @param {import('./Mat4.js').Mat4} m
     * @returns {Ray}
     */
    applyMat4(m: import('./Mat4.js').Mat4): Ray;
    /**
     * Closest point of the ray (t >= 0) to p.
     * @param {Vec3} p
     * @param {Vec3} out
     * @returns {Vec3}
     */
    closestPointToPoint(p: Vec3, out: Vec3): Vec3;
    /**
     * Squared distance from the ray (t >= 0) to a point.
     * @param {Vec3} p
     * @returns {number}
     */
    distanceSqToPoint(p: Vec3): number;
    /**
     * Distance from the ray (t >= 0) to a point.
     * @param {Vec3} p
     * @returns {number}
     */
    distanceToPoint(p: Vec3): number;
    /**
     * Slab intersection against an axis aligned box. Divisions are computed
     * once per axis and zero direction components are handled explicitly.
     * @param {import('./AABB.js').AABB} aabb
     * @param {{x:number,y:number,z:number}} [out] Receives the hit point.
     * @returns {number} Entry distance (tmax when the origin is inside), or -1.
     */
    intersectAABB(aabb: import('./AABB.js').AABB, out?: {
        x: number;
        y: number;
        z: number;
    }): number;
    /**
     * Boolean version of {@link Ray#intersectAABB}.
     * @param {import('./AABB.js').AABB} aabb
     * @returns {boolean}
     */
    intersectsAABB(aabb: import('./AABB.js').AABB): boolean;
    /**
     * @param {import('./Sphere.js').Sphere} s
     * @param {{x:number,y:number,z:number}} [out] Receives the hit point.
     * @returns {number} Distance to the first hit, or -1.
     */
    intersectSphere(s: import('./Sphere.js').Sphere, out?: {
        x: number;
        y: number;
        z: number;
    }): number;
    /**
     * @param {import('./Sphere.js').Sphere} s
     * @returns {boolean}
     */
    intersectsSphere(s: import('./Sphere.js').Sphere): boolean;
    /**
     * @param {import('./Plane.js').Plane} p
     * @returns {number} Distance to the plane, or -1 when parallel / behind.
     */
    intersectPlane(p: import('./Plane.js').Plane): number;
    /**
     * @param {import('./Plane.js').Plane} p
     * @returns {boolean}
     */
    intersectsPlane(p: import('./Plane.js').Plane): boolean;
    /**
     * Moller-Trumbore triangle intersection.
     * @param {Vec3} a
     * @param {Vec3} b
     * @param {Vec3} c
     * @param {boolean} [backfaceCulling=false] Ignores triangles facing away.
     * @param {{t?:number,u?:number,v?:number,x?:number,y?:number,z?:number}} [out]
     *   When given, receives `t`, the barycentrics `u`/`v` and the hit point `x`/`y`/`z`.
     * @returns {number} Distance to the hit, or -1.
     */
    intersectTriangle(a: Vec3, b: Vec3, c: Vec3, backfaceCulling?: boolean, out?: {
        t?: number;
        u?: number;
        v?: number;
        x?: number;
        y?: number;
        z?: number;
    }): number;
    /**
     * @param {Ray} r
     * @returns {boolean}
     */
    equals(r: Ray): boolean;
}
import { Vec3 } from "./Vec3.js";
