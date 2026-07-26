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
    /** @private @type {import('../render/Geometry.js').Geometry|null} */
    private _geometry;
    /**
     * @type {number} Bumped every time the geometry object is replaced.
     *
     * A mesh that never moves but whose geometry is rebuilt — a voxel chunk being
     * remeshed, a procedural surface, a streamed LOD — changes its bounds without
     * changing its matrix. Everything downstream keyed off `worldMatrixVersion`
     * alone would conclude that nothing happened and keep the bounds of the very
     * first geometry, forever. Versioning the geometry separately is what lets
     * both `updateWorldBounds()` and the broad phase notice.
     */
    _geometryVersion: number;
    /** @type {Object|Object[]|null} */
    material: any | any[] | null;
    /** World space bounding volumes, refreshed by `updateWorldBounds()`. */
    boundingSphereWorld: Sphere;
    boundingBoxWorld: AABB;
    /** @type {number} Proxy id inside `Scene.bvh`, -1 when not registered. */
    _bvhProxy: number;
    /**
     * @type {number} World matrix version the broad phase proxy was built from.
     *
     * Compared by `Scene.updateMatrices` so that a world matrix updated outside
     * the scene walk — by anyone calling `updateWorldMatrix(true)` directly —
     * still refreshes the proxy. Without it such a mesh keeps the bounds it had
     * when it was added and disappears as soon as it moves.
     */
    _bvhVersion: number;
    /** @type {number} Geometry version the broad phase proxy was built from. */
    _bvhGeometryVersion: number;
    /** @private worldMatrixVersion used the last time bounds were rebuilt. */
    private _boundsVersion;
    /** @private geometry version used the last time bounds were rebuilt. */
    private _boundsGeometryVersion;
    /** @private Center of the last broadphase proxy, used to derive displacement. */
    private _prevCenterX;
    /** @private */
    private _prevCenterY;
    /** @private */
    private _prevCenterZ;
    /**
     * Replacing the geometry invalidates the world bounds and the broad phase
     * proxy. Going through an accessor rather than a plain field is deliberate:
     * swapping geometry in place is the natural way to rebuild a static mesh, and
     * it used to leave the mesh culled against the bounds of whatever it held
     * first — visible from one angle and gone from another.
     *
     * @param {import('../render/Geometry.js').Geometry|null} value
     */
    set geometry(arg: import("../render/Geometry.js").Geometry);
    /** @returns {import('../render/Geometry.js').Geometry|null} */
    get geometry(): import("../render/Geometry.js").Geometry;
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
