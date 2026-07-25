/**
 * Computes the opaque state sort key.
 * Layout: `(programId & 0xfff) << 20 | (materialId & 0xfff) << 8 | (geometryId & 0xff)`.
 *
 * @param {number} programId
 * @param {number} materialId
 * @param {number} geometryId
 * @returns {number} uint32
 */
export function makeSortKey(programId: number, materialId: number, geometryId: number): number;
/**
 * One submitted draw call. Instances are pooled and reused across frames, so the
 * shape must stay monomorphic: never add fields to an individual item.
 */
export class RenderItem {
    /** @type {Object|null} Node3D that owns the draw. */
    mesh: any | null;
    /** @type {Object|null} Geometry to bind. */
    geometry: any | null;
    /** @type {Object|null} Material to apply. */
    material: any | null;
    /** @type {Object|null} `{start, count, materialIndex}` or null for the whole geometry. */
    group: any | null;
    /** @type {number} Index of `group` inside `geometry.groups`, -1 when unused. */
    groupIndex: number;
    /** @type {number} Distance to the camera plane, in world units. */
    depth: number;
    /** @type {number} uint32 state sort key. */
    sortKey: number;
    /** @type {Object|null} Program resolved while the list was built. */
    program: any | null;
    /** Drops every reference so a disposed scene is not kept alive by the pool. */
    clear(): void;
}
export class RenderList {
    /** @type {RenderItem[]} Opaque draws, sorted by state then front to back. */
    opaque: RenderItem[];
    /** @type {RenderItem[]} Blended draws, sorted strictly back to front. */
    transparent: RenderItem[];
    /** @type {RenderItem[]} Everything that writes into a shadow map. */
    shadowCasters: RenderItem[];
    /** @private @type {RenderItem[]} */
    private _pool;
    /** @private @type {number} */
    private _poolUsed;
    /** @private @type {Uint32Array} state key per element id */
    private _stateKeys;
    /** @private @type {Uint32Array} quantised depth per element id */
    private _depthKeys;
    /** @private @type {Uint32Array} permutation being sorted */
    private _indices;
    /** @private @type {Uint32Array} radix scratch */
    private _tmp;
    /** @private @type {Float64Array} exact depth per element id */
    private _depths;
    /** @private @type {RenderItem[]} destination of a permutation apply */
    private _reordered;
    /** Per frame counters, useful for the renderer statistics block. */
    stats: {
        opaque: number;
        transparent: number;
        shadowCasters: number;
        pooled: number;
    };
    /** @type {number} Total draws queued this frame. */
    get count(): number;
    /** @type {number} Items currently held by the pool. */
    get poolSize(): number;
    /**
     * Grows the sorting scratch buffers. Only ever runs when a frame is bigger than
     * every previous frame, so it is not part of the steady state cost.
     * @param {number} n
     * @private
     */
    private _ensureCapacity;
    /**
     * Takes an item from the pool, growing it when the frame is bigger than any
     * frame before it.
     * @returns {RenderItem}
     * @private
     */
    private _acquire;
    /**
     * Empties the three lists and returns every item to the pool.
     * @returns {RenderList} this
     */
    reset(): RenderList;
    /**
     * Queues one draw call.
     *
     * The item lands in `transparent` when the material blends, in `opaque`
     * otherwise, and additionally in `shadowCasters` when both the node and the
     * material agree to cast shadows.
     *
     * @param {Object} mesh Node3D being drawn.
     * @param {Object} geometry Geometry to bind.
     * @param {Object} material Material to apply.
     * @param {number} [groupIndex=-1] Index into `geometry.groups`, -1 for the whole geometry.
     * @param {number} [depth=0] Distance to the camera plane.
     * @param {Object|null} [program=null] Program already resolved by the renderer.
     * @returns {RenderItem} the queued item
     */
    push(mesh: any, geometry: any, material: any, groupIndex?: number, depth?: number, program?: any | null): RenderItem;
    /**
     * Applies a permutation to one of the lists without allocating.
     * @param {RenderItem[]} list
     * @param {Uint32Array} indices
     * @param {number} n
     * @private
     */
    private _applyPermutation;
    /**
     * Sorts the opaque list: by program, then material, then geometry, breaking
     * ties front to back.
     * @returns {RenderList} this
     */
    sortOpaque(): RenderList;
    /**
     * Sorts the transparent list strictly back to front.
     * @returns {RenderList} this
     */
    sortTransparent(): RenderList;
    /**
     * Sorts the shadow caster list by state only (depth is irrelevant for a pure
     * depth pass, but batching by program and geometry still pays off).
     * @returns {RenderList} this
     */
    sortShadowCasters(): RenderList;
    /**
     * Drops the pooled items. Only needed when the renderer is disposed.
     * @returns {RenderList} this
     */
    dispose(): RenderList;
}
