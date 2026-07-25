/**
 * View frustum stored as 6 planes whose normals point INWARDS, so a point is
 * inside when every `distanceToPoint` is >= 0.
 *
 * Plane order: 0 left, 1 right, 2 bottom, 3 top, 4 near, 5 far.
 */
export class Frustum {
    /** @type {Plane[]} */ planes: Plane[];
    /**
     * Extracts the 6 planes from a COLUMN MAJOR view-projection matrix using
     * the Gribb-Hartmann method, then normalizes them (so distances are real
     * world units, which the BVH and shadow code rely on).
     * @param {import('./Mat4.js').Mat4} m viewProjection matrix.
     * @returns {Frustum}
     */
    setFromProjectionMatrix(m: import('./Mat4.js').Mat4): Frustum;
    /**
     * @param {Frustum} f
     * @returns {Frustum}
     */
    copy(f: Frustum): Frustum;
    /** @returns {Frustum} */
    clone(): Frustum;
    /**
     * @param {import('./Sphere.js').Sphere} sphere
     * @returns {boolean} False only when the sphere is fully outside.
     */
    intersectsSphere(sphere: import('./Sphere.js').Sphere): boolean;
    /**
     * @param {import('./AABB.js').AABB} aabb
     * @returns {boolean} False only when the box is fully outside.
     */
    intersectsAABB(aabb: import('./AABB.js').AABB): boolean;
    /**
     * Allocation free "positive vertex" test used by the BVH traversal.
     * For every plane only the box corner farthest along the plane normal is
     * evaluated; when it lies behind the plane the whole box is outside.
     * @param {number} minX @param {number} minY @param {number} minZ
     * @param {number} maxX @param {number} maxY @param {number} maxZ
     * @returns {boolean} False only when the box is fully outside.
     */
    intersectsAABBMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean;
    /**
     * Conservative "fully inside" test: true when the box needs no further
     * per-child culling (the BVH accepts whole subtrees with it).
     * @param {number} minX @param {number} minY @param {number} minZ
     * @param {number} maxX @param {number} maxY @param {number} maxZ
     * @returns {boolean}
     */
    containsAABBMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean;
    /**
     * @param {import('./Vec3.js').Vec3} p
     * @returns {boolean}
     */
    containsPoint(p: import('./Vec3.js').Vec3): boolean;
    /**
     * Sphere test that also reports full containment.
     * @param {import('./Sphere.js').Sphere} sphere
     * @returns {number} -1 outside, 0 intersecting, 1 fully inside.
     */
    classifySphere(sphere: import('./Sphere.js').Sphere): number;
}
import { Plane } from "./Plane.js";
