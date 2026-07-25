/**
 * Static bounding volume hierarchy over a triangle soup.
 */
export class TriangleBVH {
    /**
     * Rebuilds an instance from {@link TriangleBVH#serialize} output.
     * @param {object} data
     * @param {Float32Array} [positions] Overrides `data.positions` (useful when the
     *   geometry was stored separately).
     * @param {Uint32Array|Uint16Array|null} [indices] Overrides `data.indices`.
     * @returns {TriangleBVH}
     */
    static deserialize(data: object, positions?: Float32Array, indices?: Uint32Array | Uint16Array | null): TriangleBVH;
    /** @type {Float32Array|null} Vertex positions, 3 floats per vertex. */
    positions: Float32Array | null;
    /** @type {Uint32Array|Uint16Array|null} Triangle indices, or null when non-indexed. */
    indices: Uint32Array | Uint16Array | null;
    /** @type {number} */
    triCount: number;
    /** @type {number} Number of nodes actually used. */
    nodeCount: number;
    /** @type {number} */
    maxLeafTris: number;
    /** @type {Uint32Array|null} Permutation of triangle ids, grouped per leaf. */
    triIndices: Uint32Array | null;
    /** @type {Float32Array|null} 6 floats per node. */
    nodeBounds: Float32Array | null;
    /** @type {Int32Array|null} Left child (internal) or first triangle (leaf). */
    nodeLeftFirst: Int32Array | null;
    /** @type {Int32Array|null} Triangle count; 0 marks an internal node. */
    nodeTriCount: Int32Array | null;
    /** @type {Int32Array} Traversal stack. */
    _stack: Int32Array;
    /** @type {Float32Array} Parallel distance stack for ordered traversals. */
    _dstack: Float32Array;
    /** @type {number} Triangle touched by the last closestPointOnSurface call. */
    _lastClosestTri: number;
    /** @returns {number} Triangle hit by the most recent closest-point query, or -1. */
    get lastClosestTriIndex(): number;
    /** @returns {boolean} True once {@link TriangleBVH#build} produced a usable tree. */
    get isBuilt(): boolean;
    /** @returns {number} Approximate CPU memory footprint of the hierarchy, in bytes. */
    get memoryBytes(): number;
    /**
     * Grows the traversal stacks.
     * @param {number} needed
     * @returns {void}
     */
    _ensureStack(needed: number): void;
    /**
     * Builds the hierarchy. Both buffers are kept by reference and must stay alive
     * (and unmodified) for as long as the BVH is queried.
     *
     * @param {Float32Array} positions Vertex positions, 3 floats per vertex.
     * @param {Uint32Array|Uint16Array|null} [indices] Triangle indices; pass null for a
     *   non-indexed soup where every 3 consecutive vertices form a triangle.
     * @param {number} [maxLeafTris] Maximum triangles per leaf.
     * @returns {TriangleBVH} `this`.
     */
    build(positions: Float32Array, indices?: Uint32Array | Uint16Array | null, maxLeafTris?: number): TriangleBVH;
    /**
     * Recomputes a node's bounds from the triangles it owns.
     * @param {number} node
     * @param {Float32Array} triBounds
     * @returns {void}
     */
    _computeNodeBounds(node: number, triBounds: Float32Array): void;
    /**
     * Copies the three vertices of a triangle.
     * @param {number} triIndex Triangle id in the original buffer order.
     * @param {{x:number,y:number,z:number}} a
     * @param {{x:number,y:number,z:number}} b
     * @param {{x:number,y:number,z:number}} c
     * @returns {void}
     */
    getTriangle(triIndex: number, a: {
        x: number;
        y: number;
        z: number;
    }, b: {
        x: number;
        y: number;
        z: number;
    }, c: {
        x: number;
        y: number;
        z: number;
    }): void;
    /**
     * Copies the root bounds.
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} out
     * @returns {*} `out`.
     */
    getBounds(out: {
        min: {
            x: number;
            y: number;
            z: number;
        };
        max: {
            x: number;
            y: number;
            z: number;
        };
    }): any;
    /**
     * Finds the closest triangle hit by `ray`.
     *
     * Children are visited nearest first and the far child is skipped as soon as the
     * current best hit is closer than its box entry point.
     *
     * @param {{origin:{x:number,y:number,z:number}, direction:{x:number,y:number,z:number}}} ray
     *   Direction should be normalised for `t` to be a world-space distance.
     * @param {number} [maxDist]
     * @param {{t:number,u:number,v:number,triIndex:number,nx:number,ny:number,nz:number}} [out]
     *   Reused result object; a new one is created when omitted.
     * @param {boolean} [backfaceCulling] Ignore triangles seen from behind.
     * @returns {{t:number,u:number,v:number,triIndex:number,nx:number,ny:number,nz:number}|null}
     *   `out` when something was hit, otherwise null.
     */
    raycast(ray: {
        origin: {
            x: number;
            y: number;
            z: number;
        };
        direction: {
            x: number;
            y: number;
            z: number;
        };
    }, maxDist?: number, out?: {
        t: number;
        u: number;
        v: number;
        triIndex: number;
        nx: number;
        ny: number;
        nz: number;
    }, backfaceCulling?: boolean): {
        t: number;
        u: number;
        v: number;
        triIndex: number;
        nx: number;
        ny: number;
        nz: number;
    };
    /**
     * Branch-free slab test returning the entry distance, or -1 on a miss.
     * @param {Float32Array} arr
     * @param {number} o
     * @param {number} ox
     * @param {number} oy
     * @param {number} oz
     * @param {number} invX
     * @param {number} invY
     * @param {number} invZ
     * @param {number} limit
     * @returns {number}
     */
    _slabEnter(arr: Float32Array, o: number, ox: number, oy: number, oz: number, invX: number, invY: number, invZ: number, limit: number): number;
    /**
     * Collects the triangles whose bounds overlap `aabb`. `out` is emptied first.
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
     * @param {Array<number>} out
     * @returns {number} Number of triangle indices written to `out`.
     */
    queryAABB(aabb: {
        min: {
            x: number;
            y: number;
            z: number;
        };
        max: {
            x: number;
            y: number;
            z: number;
        };
    }, out: Array<number>): number;
    /**
     * Allocation-free variant of {@link TriangleBVH#queryAABB}.
     * @param {number} minX
     * @param {number} minY
     * @param {number} minZ
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} maxZ
     * @param {Array<number>} out
     * @returns {number}
     */
    queryAABBMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: Array<number>): number;
    /**
     * Collects the triangles whose bounds overlap a sphere. `out` is emptied first.
     * @param {number} cx
     * @param {number} cy
     * @param {number} cz
     * @param {number} radius
     * @param {Array<number>} out
     * @returns {number}
     */
    querySphere(cx: number, cy: number, cz: number, radius: number, out: Array<number>): number;
    /**
     * Finds the closest point on the triangle soup to `point`, pruning subtrees whose
     * box is already farther than the current best candidate.
     *
     * The triangle that produced the result is available through
     * {@link TriangleBVH#lastClosestTriIndex}.
     *
     * @param {{x:number,y:number,z:number}} point
     * @param {{x:number,y:number,z:number}} [out] Receives the surface point.
     * @returns {number} Distance to the surface, or Infinity for an empty BVH.
     */
    closestPointOnSurface(point: {
        x: number;
        y: number;
        z: number;
    }, out?: {
        x: number;
        y: number;
        z: number;
    }): number;
    /**
     * Squared distance from a point to a node's AABB (0 when inside).
     * @param {Float32Array} arr
     * @param {number} o
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     * @returns {number}
     */
    _boxDistanceSq(arr: Float32Array, o: number, px: number, py: number, pz: number): number;
    /**
     * Snapshots the hierarchy so it can be cached instead of rebuilt.
     *
     * Node arrays are trimmed copies; `triIndices`, `positions` and `indices` are
     * passed by reference, so the result is cheap to produce and its TypedArray
     * buffers can be transferred to a worker.
     *
     * @returns {{version:number, triCount:number, nodeCount:number, maxLeafTris:number,
     *   nodeBounds:Float32Array, nodeLeftFirst:Int32Array, nodeTriCount:Int32Array,
     *   triIndices:Uint32Array, positions:Float32Array|null,
     *   indices:Uint32Array|Uint16Array|null}}
     */
    serialize(): {
        version: number;
        triCount: number;
        nodeCount: number;
        maxLeafTris: number;
        nodeBounds: Float32Array;
        nodeLeftFirst: Int32Array;
        nodeTriCount: Int32Array;
        triIndices: Uint32Array;
        positions: Float32Array | null;
        indices: Uint32Array | Uint16Array | null;
    };
    /**
     * Drops every buffer reference held by the hierarchy.
     * @returns {void}
     */
    dispose(): void;
}
