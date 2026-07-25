/**
 * Returns (building it once and caching it on the geometry) everything needed to
 * ray test or collide against a mesh: the triangle BVH plus the packed position
 * and index buffers it was built from.
 *
 * The cache is shared with `Mesh.getTriangleBVH()` (`geometry._triangleBVH` and
 * `geometry._triangleBVHData`), so picking and physics never build it twice.
 * Call `mesh.invalidateTriangleBVH()` after mutating the geometry.
 *
 * @param {Object} mesh Mesh-like object exposing `geometry`.
 * @returns {{positions:Float32Array, indices:Uint32Array|Uint16Array, bvh:TriangleBVH}|null}
 *   The triangle data, or null when the geometry cannot be ray tested.
 */
export function getMeshTriangleData(mesh: any): {
    positions: Float32Array;
    indices: Uint32Array | Uint16Array;
    bvh: TriangleBVH;
};
/**
 * Casts rays through a scene and reports precise triangle intersections.
 */
export class Raycaster {
    /**
     * @param {Vec3} [origin] World space origin.
     * @param {Vec3} [direction] World space direction (normalized).
     * @param {number} [near=0] Minimum hit distance.
     * @param {number} [far=Infinity] Maximum hit distance.
     */
    constructor(origin?: Vec3, direction?: Vec3, near?: number, far?: number);
    /** @type {Ray} World space ray. */
    ray: Ray;
    /** @type {number} Hits closer than this are discarded. */
    near: number;
    /** @type {number} Hits farther than this are discarded. */
    far: number;
    /** @type {number} Layer mask; an object is tested when `object.layers & layers`. */
    layers: number;
    /** @type {boolean} Stop at the first (closest) hit - much faster for picking. */
    firstHitOnly: boolean;
    /** @type {boolean} Skip objects whose `visible` flag is false. */
    ignoreInvisible: boolean;
    /** @type {boolean} Ignore triangles seen from behind. */
    backfaceCulling: boolean;
    /** @private @type {Array<Object>} Output array of the query in flight. */
    private _out;
    /** @private @type {number} Current distance cut-off (shrinks when firstHitOnly). */
    private _limit;
    /** @private @type {Pool} */
    private _pool;
    /**
     * @private Bound broad phase callback. Created once so the query loop stays
     * closure free.
     */
    private _bvhVisit;
    /**
     * @param {Vec3} origin World space origin.
     * @param {Vec3} direction World space direction (should be normalized).
     * @returns {Raycaster} this
     */
    set(origin: Vec3, direction: Vec3): Raycaster;
    /**
     * Allocation free setter.
     * @param {number} ox Origin x.
     * @param {number} oy Origin y.
     * @param {number} oz Origin z.
     * @param {number} dx Direction x.
     * @param {number} dy Direction y.
     * @param {number} dz Direction z.
     * @returns {Raycaster} this
     */
    setValues(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): Raycaster;
    /**
     * Builds the ray from a normalized device coordinate pair.
     *
     * The origin is placed on the camera's near plane (the convention used by
     * `Camera.ndcToRay` / `Camera.screenPointToRay`), so reported distances are
     * measured from the near plane, not from the camera pivot.
     *
     * @param {number} ndcX -1 (left) .. 1 (right).
     * @param {number} ndcY -1 (bottom) .. 1 (top).
     * @param {Object} camera Camera exposing `ndcToRay` or `projectionMatrixInverse`.
     * @returns {Raycaster} this
     */
    setFromCamera(ndcX: number, ndcY: number, camera: any): Raycaster;
    /**
     * Manual NDC -> world unprojection used when the camera exposes no helper.
     * @private
     * @param {Mat4} invProj Inverse projection matrix.
     * @param {Mat4} world Camera world matrix.
     * @param {number} ndcX Normalized device x.
     * @param {number} ndcY Normalized device y.
     * @param {number} ndcZ Normalized device z.
     * @param {Vec3} out Receives the world position.
     * @returns {Vec3} out
     */
    private _unprojectManual;
    /**
     * Tests a single object (and optionally its sub tree).
     * @param {Object} object Node to test.
     * @param {boolean} [recursive=false] Also test descendants.
     * @param {Array<Object>} [out] Output array; emptied before the query.
     * @returns {Array<Object>} Hits sorted by ascending distance.
     */
    intersectObject(object: any, recursive?: boolean, out?: Array<any>): Array<any>;
    /**
     * Tests a list of objects.
     * @param {Array<Object>} objects Nodes to test.
     * @param {boolean} [recursive=false] Also test descendants.
     * @param {Array<Object>} [out] Output array; emptied before the query.
     * @returns {Array<Object>} Hits sorted by ascending distance.
     */
    intersectObjects(objects: Array<any>, recursive?: boolean, out?: Array<any>): Array<any>;
    /**
     * Tests a whole scene, using its broad phase when available.
     * @param {Object} scene Scene exposing `bvh` (or at least `meshes`).
     * @param {Array<Object>} [out] Output array; emptied before the query.
     * @returns {Array<Object>} Hits sorted by ascending distance.
     */
    intersectScene(scene: any, out?: Array<any>): Array<any>;
    /**
     * Convenience wrapper returning only the closest hit of a scene query.
     * The record stays owned by the caller until
     * {@link Raycaster#releaseIntersection} is called.
     * @param {Object} scene Scene to test.
     * @param {Array<Object>} [scratch] Reusable array, avoids allocating one.
     * @returns {Object|null} The closest hit, or null.
     */
    raycastScene(scene: any, scratch?: Array<any>): any | null;
    /**
     * Hands a list of intersection records back to the internal pool and empties
     * the array. Records produced by user `raycast()` implementations are simply
     * dropped for the garbage collector.
     * @param {Array<Object>} list Intersections previously returned by a query.
     * @returns {void}
     */
    releaseIntersections(list: Array<any>): void;
    /**
     * Hands a single intersection record back to the pool.
     * @param {Object} record Intersection record.
     * @returns {void}
     */
    releaseIntersection(record: any): void;
    /**
     * Prepares a query.
     * @private
     * @param {Array<Object>} out Output array.
     * @returns {void}
     */
    private _begin;
    /**
     * Finishes a query: sorts the hits and drops the internal reference.
     * @private
     * @returns {Array<Object>} The output array.
     */
    private _end;
    /**
     * Broad phase callback. The BVH pops proxies in nearest-first order, so the
     * traversal can stop as soon as a proxy starts beyond the best hit.
     * @private
     * @param {Object} object Proxy user data (a mesh).
     * @param {number} tEnter Entry distance of the proxy box.
     * @returns {number|boolean} New traversal limit, or false to stop.
     */
    private _visitProxy;
    /**
     * Tests an object and, when asked, its descendants.
     * @private
     * @param {Object} object Node to test.
     * @param {boolean} recursive Walk the children too.
     * @returns {void}
     */
    private _collect;
    /**
     * Dispatches one object to the right narrow phase.
     * @private
     * @param {Object} object Node to test.
     * @returns {void}
     */
    private _testObject;
    /**
     * Tests every transform a mesh contributes (one, or one per instance).
     * @private
     * @param {Object} mesh Mesh or InstancedMesh.
     * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Triangle data.
     * @returns {void}
     */
    private _testMesh;
    /**
     * Narrow phase against a single object-to-world matrix.
     * @private
     * @param {Object} mesh Owning mesh (reported as `object`).
     * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Triangle data.
     * @param {Mat4} matrix Object to world matrix.
     * @param {number} instanceId Instance index, or -1.
     * @returns {void}
     */
    private _testMatrix;
    /**
     * Appends a pooled intersection record.
     * @private
     * @param {Object} mesh Hit object.
     * @param {Object} geometry Its geometry.
     * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Triangle data.
     * @param {number} distance World distance.
     * @param {number} triIndex Triangle index.
     * @param {number} u First barycentric coordinate.
     * @param {number} v Second barycentric coordinate.
     * @param {number} instanceId Instance index, or -1.
     * @returns {void}
     */
    private _pushHit;
    /**
     * Drops every retained resource.
     * @returns {void}
     */
    dispose(): void;
}
import { TriangleBVH } from "../spatial/TriangleBVH.js";
import { Ray } from "../math/Ray.js";
import { Vec3 } from "../math/Vec3.js";
