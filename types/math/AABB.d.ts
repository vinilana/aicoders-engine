/**
 * Axis aligned bounding box defined by its min and max corners.
 * An "empty" box has min > max on at least one axis (see {@link AABB#makeEmpty}).
 */
export class AABB {
    /**
     * @param {Vec3} [min] Defaults to +Infinity (empty box).
     * @param {Vec3} [max] Defaults to -Infinity (empty box).
     */
    constructor(min?: Vec3, max?: Vec3);
    /** @type {Vec3} */ min: Vec3;
    /** @type {Vec3} */ max: Vec3;
    /**
     * Resets to the "empty" state so points can be accumulated.
     * @returns {AABB}
     */
    makeEmpty(): AABB;
    /** @returns {boolean} */
    isEmpty(): boolean;
    /**
     * @param {Vec3} min
     * @param {Vec3} max
     * @returns {AABB}
     */
    set(min: Vec3, max: Vec3): AABB;
    /**
     * Allocation free setter used by the spatial structures.
     * @param {number} minX @param {number} minY @param {number} minZ
     * @param {number} maxX @param {number} maxY @param {number} maxZ
     * @returns {AABB}
     */
    setMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB;
    /**
     * @param {Vec3[]} points
     * @returns {AABB}
     */
    setFromPoints(points: Vec3[]): AABB;
    /**
     * Builds the box from a flat position array.
     * @param {ArrayLike<number>} array
     * @param {number} [stride=3] Components between consecutive positions.
     * @param {number} [offset=0] Index of the first X component.
     * @returns {AABB}
     */
    setFromArray(array: ArrayLike<number>, stride?: number, offset?: number): AABB;
    /**
     * @param {Vec3} center
     * @param {Vec3} size Full size (not half extents).
     * @returns {AABB}
     */
    setFromCenterAndSize(center: Vec3, size: Vec3): AABB;
    /**
     * @param {Vec3} p
     * @returns {AABB}
     */
    expandByPoint(p: Vec3): AABB;
    /**
     * @param {number} x @param {number} y @param {number} z
     * @returns {AABB}
     */
    expandByXYZ(x: number, y: number, z: number): AABB;
    /**
     * @param {AABB} b
     * @returns {AABB}
     */
    expandByAABB(b: AABB): AABB;
    /**
     * Grows (or shrinks, for negative values) the box on every axis.
     * @param {number} s
     * @returns {AABB}
     */
    expandByScalar(s: number): AABB;
    /**
     * Alias of {@link AABB#expandByAABB}.
     * @param {AABB} b
     * @returns {AABB}
     */
    union(b: AABB): AABB;
    /**
     * this = union(a, b)
     * @param {AABB} a
     * @param {AABB} b
     * @returns {AABB}
     */
    unionOf(a: AABB, b: AABB): AABB;
    /**
     * Intersection of two boxes (may become empty).
     * @param {AABB} b
     * @returns {AABB}
     */
    intersection(b: AABB): AABB;
    /**
     * Moves the box.
     * @param {Vec3} offset
     * @returns {AABB}
     */
    translate(offset: Vec3): AABB;
    /**
     * @param {Vec3} out
     * @returns {Vec3}
     */
    getCenter(out: Vec3): Vec3;
    /**
     * @param {Vec3} out
     * @returns {Vec3} Full size on each axis.
     */
    getSize(out: Vec3): Vec3;
    /**
     * Writes one of the 8 corners (bit 0 = X, bit 1 = Y, bit 2 = Z).
     * @param {number} i 0..7
     * @param {Vec3} out
     * @returns {Vec3}
     */
    getCorner(i: number, out: Vec3): Vec3;
    /**
     * Smallest sphere containing the box.
     * @param {import('./Sphere.js').Sphere} out
     * @returns {import('./Sphere.js').Sphere}
     */
    getBoundingSphere(out: import('./Sphere.js').Sphere): import('./Sphere.js').Sphere;
    /**
     * Transforms the box by a matrix using Arvo's method: the center and the
     * extents are transformed independently (3 dot products + 3 abs dot
     * products) instead of the 8 corners.
     * @param {import('./Mat4.js').Mat4} m
     * @returns {AABB}
     */
    applyMat4(m: import('./Mat4.js').Mat4): AABB;
    /**
     * this = source transformed by m (source is left untouched).
     * @param {AABB} source
     * @param {import('./Mat4.js').Mat4} m
     * @returns {AABB}
     */
    copyTransformed(source: AABB, m: import('./Mat4.js').Mat4): AABB;
    /**
     * @param {AABB} b
     * @returns {boolean}
     */
    intersectsAABB(b: AABB): boolean;
    /**
     * Allocation free overlap test.
     * @param {number} minX @param {number} minY @param {number} minZ
     * @param {number} maxX @param {number} maxY @param {number} maxZ
     * @returns {boolean}
     */
    intersectsMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean;
    /**
     * @param {import('./Sphere.js').Sphere} s
     * @returns {boolean}
     */
    intersectsSphere(s: import('./Sphere.js').Sphere): boolean;
    /**
     * Slab test against a ray (no allocation, no division per slab).
     * @param {import('./Ray.js').Ray} ray
     * @param {number} [maxDist=Infinity]
     * @returns {boolean}
     */
    intersectsRay(ray: import('./Ray.js').Ray, maxDist?: number): boolean;
    /**
     * @param {Vec3} p
     * @returns {boolean}
     */
    containsPoint(p: Vec3): boolean;
    /**
     * @param {AABB} b
     * @returns {boolean}
     */
    containsAABB(b: AABB): boolean;
    /**
     * Closest point of the box to p.
     * @param {Vec3} p
     * @param {Vec3} out
     * @returns {Vec3}
     */
    clampPoint(p: Vec3, out: Vec3): Vec3;
    /**
     * @param {Vec3} p
     * @returns {number} 0 when the point is inside.
     */
    distanceToPoint(p: Vec3): number;
    /**
     * @param {Vec3} p
     * @returns {number} Squared distance, 0 when inside.
     */
    distanceToPointSq(p: Vec3): number;
    /**
     * Surface area (SAH cost metric used by the BVH builders).
     * @returns {number}
     */
    surfaceArea(): number;
    /** @returns {number} */
    volume(): number;
    /**
     * @param {AABB} b
     * @returns {AABB}
     */
    copy(b: AABB): AABB;
    /** @returns {AABB} */
    clone(): AABB;
    /**
     * @param {AABB} b
     * @returns {boolean}
     */
    equals(b: AABB): boolean;
    /**
     * Builds the box that contains a sphere.
     * @param {import('./Sphere.js').Sphere} s
     * @returns {AABB}
     */
    setFromSphere(s: import('./Sphere.js').Sphere): AABB;
}
import { Vec3 } from "./Vec3.js";
