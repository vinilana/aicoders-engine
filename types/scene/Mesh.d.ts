/**
 * Renderable node: a geometry drawn with one material (or one material per
 * geometry group).
 */
export class Mesh extends Node3D {
    /**
     * @param {import('../render/Geometry.js').Geometry|null} [geometry=null]
     * @param {Object|Object[]|null} [material=null]
     */
    constructor(geometry?: import('../render/Geometry.js').Geometry | null, material?: any | any[] | null);
    /** @type {import('../render/Geometry.js').Geometry|null} */
    geometry: import('../render/Geometry.js').Geometry | null;
    /** @type {Object|Object[]|null} */
    material: any | any[] | null;
    /** World space bounding volumes, refreshed by `updateWorldBounds()`. */
    boundingSphereWorld: Sphere;
    boundingBoxWorld: AABB;
    /** @type {number} Proxy id inside `Scene.bvh`, -1 when not registered. */
    _bvhProxy: number;
    /** @private worldMatrixVersion used the last time bounds were rebuilt. */
    private _boundsVersion;
    /** @private Center of the last broadphase proxy, used to derive displacement. */
    private _prevCenterX;
    /** @private */
    private _prevCenterY;
    /** @private */
    private _prevCenterZ;
    /**
     * Transforms the geometry bounds into world space. The work is skipped while
     * the world matrix does not change.
     * @param {boolean} [force=false]
     * @returns {Mesh} this
     */
    updateWorldBounds(force?: boolean): Mesh;
    /**
     * Lazily builds (and caches on the geometry) the triangle BVH used for
     * precise ray queries.
     * @returns {TriangleBVH|null}
     */
    getTriangleBVH(): TriangleBVH | null;
    /**
     * Drops the cached triangle BVH. Call it after mutating the geometry.
     * @returns {Mesh} this
     */
    invalidateTriangleBVH(): Mesh;
    /**
     * Ray / mesh intersection. The ray is transformed into local space and tested
     * against the triangle BVH; the resulting hit is reported in world space.
     * @param {Object} raycaster Provides `ray`, `near`, `far` and optionally `layers`.
     * @param {Array} intersects Output array, appended in place.
     * @returns {Array} intersects
     */
    raycast(raycaster: any, intersects: any[]): any[];
    /**
     * Core ray test against an arbitrary object-to-world matrix. Shared with
     * `InstancedMesh`, which calls it once per instance.
     * @protected
     * @param {Object} raycaster
     * @param {Array} intersects
     * @param {Mat4} matrix Object to world matrix.
     * @param {number} instanceId Instance index, -1 for a regular mesh.
     * @returns {Array} intersects
     */
    protected _raycastMatrix(raycaster: any, intersects: any[], matrix: Mat4, instanceId: number): any[];
    /**
     * @param {number} index Group / material index.
     * @returns {Object|null} The material used by that group.
     */
    getMaterial(index: number): any | null;
}
import { Node3D } from "./Node3D.js";
import { Sphere } from "../math/Sphere.js";
import { AABB } from "../math/AABB.js";
import { TriangleBVH } from "../spatial/TriangleBVH.js";
import { Mat4 } from "../math/Mat4.js";
