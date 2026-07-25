/**
 * Root container of a renderable world.
 *
 * The scene keeps flat lists of meshes / lights / skinned meshes updated
 * incrementally on add and remove (whole sub trees included) and owns the
 * dynamic broadphase used for frustum culling and ray queries.
 */
export class Scene extends Node3D {
    /** @type {Color|Object|null} Solid color or cube texture used as background. */
    background: Color | any | null;
    /** @type {Object|null} IBL environment. */
    environment: any | null;
    /** @type {{color: Color, density: number, near: number, far: number, mode: string}|null} */
    fog: {
        color: Color;
        density: number;
        near: number;
        far: number;
        mode: string;
    } | null;
    ambientLight: Color;
    ambientIntensity: number;
    /** @type {DynamicBVH} */
    bvh: DynamicBVH;
    /** @type {import('./Mesh.js').Mesh[]} */
    meshes: import('./Mesh.js').Mesh[];
    /** @type {import('./Light.js').Light[]} */
    lights: import('./Light.js').Light[];
    /** @type {import('./SkinnedMesh.js').SkinnedMesh[]} */
    skinnedMeshes: import('./SkinnedMesh.js').SkinnedMesh[];
    /** @private Meshes whose world matrix changed during the last updateMatrices. */
    private _dirtyMeshes;
    /** @private */
    private _dirtyCount;
    /** @private Proxy AABB used for nodes with frustumCulled === false. */
    private _unboundedAABB;
    /**
     * Registers a sub tree into the flat lists. Called by `Node3D.add`.
     * @param {Node3D} root
     * @internal
     */
    _onNodeAdded(root: Node3D): void;
    /**
     * Unregisters a sub tree from the flat lists and the broadphase.
     * Called by `Node3D.remove`.
     * @param {Node3D} root
     * @internal
     */
    _onNodeRemoved(root: Node3D): void;
    /**
     * Swap-remove helper keeping `_listIndex` coherent.
     * @private
     * @param {Node3D[]} list
     * @param {Node3D} node
     */
    private _removeFromList;
    /**
     * Single iterative pass over the whole graph: recomposes local matrices that
     * changed, multiplies them by the parent world matrix and records the meshes
     * whose world matrix was rebuilt so `updateBVH()` only touches those.
     * Skinned meshes are refreshed at the end, once every bone is up to date.
     * @returns {Scene} this
     */
    updateMatrices(): Scene;
    /**
     * Inserts / refreshes the broadphase proxies of the meshes whose world
     * matrix changed during the last `updateMatrices()` call.
     * @returns {Scene} this
     */
    updateBVH(): Scene;
    /**
     * Forces a mesh to be re-evaluated by the next `updateBVH()` call. Use it
     * after changing `frustumCulled` or the geometry of a static mesh.
     * @param {import('./Mesh.js').Mesh} mesh
     * @returns {Scene} this
     */
    markMeshDirty(mesh: import('./Mesh.js').Mesh): Scene;
    /**
     * Rebuilds the broadphase from scratch. Useful after loading a large amount
     * of static geometry.
     * @returns {Scene} this
     */
    rebuildBVH(): Scene;
    /**
     * Enables linear fog.
     * @param {Color} color
     * @param {number} near
     * @param {number} far
     * @returns {Scene} this
     */
    setFogLinear(color: Color, near: number, far: number): Scene;
    /**
     * Enables exponential squared fog.
     * @param {Color} color
     * @param {number} density
     * @returns {Scene} this
     */
    setFogExp2(color: Color, density: number): Scene;
    /**
     * Disables fog.
     * @returns {Scene} this
     */
    clearFog(): Scene;
    /**
     * Sets the ambient term.
     * @param {Color} color
     * @param {number} [intensity=1]
     * @returns {Scene} this
     */
    setAmbient(color: Color, intensity?: number): Scene;
}
import { Node3D } from "./Node3D.js";
import { Color } from "../math/Color.js";
import { DynamicBVH } from "../spatial/DynamicBVH.js";
