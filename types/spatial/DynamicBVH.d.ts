/**
 * Dynamic AABB tree used as the broadphase for rendering (frustum culling),
 * picking (raycasts) and physics (overlap queries).
 */
export class DynamicBVH {
    /**
     * @param {{margin?:number, capacity?:number, displacementMultiplier?:number}} [options]
     */
    constructor(options?: {
        margin?: number;
        capacity?: number;
        displacementMultiplier?: number;
    });
    /** @type {number} Fat AABB margin applied around every proxy. */
    margin: number;
    /** @type {number} Motion prediction factor used by {@link DynamicBVH#update}. */
    displacementMultiplier: number;
    /** @type {number} */
    _capacity: number;
    /** @type {Float32Array} minX,minY,minZ,maxX,maxY,maxZ per node (fat bounds). */
    _bounds: Float32Array;
    /** @type {Float32Array} Exact bounds, only meaningful for leaves. */
    _tight: Float32Array;
    /** @type {Int32Array} */
    _parent: Int32Array;
    /** @type {Int32Array} Also doubles as the free-list "next" pointer. */
    _child1: Int32Array;
    /** @type {Int32Array} */
    _child2: Int32Array;
    /** @type {Int32Array} Node height; -1 marks a free slot. */
    _height: Int32Array;
    /** @type {Array<*>} */
    _userData: Array<any>;
    _root: number;
    _nodeCount: number;
    _proxyCount: number;
    _freeList: number;
    /** @type {Int32Array} Traversal stack (node indices). */
    _stack: Int32Array;
    /** @type {Int32Array} Traversal stack (plane coherency masks). */
    _maskStack: Int32Array;
    /** @type {Float32Array} Flattened frustum planes: nx,ny,nz,constant. */
    _planes: Float32Array;
    /** @type {Float32Array} Ray traversal priority-queue keys. */
    _heapKeys: Float32Array;
    /** @type {Int32Array} Ray traversal priority-queue values. */
    _heapVals: Int32Array;
    _heapSize: number;
    _heapPopKey: number;
    /** @returns {number} Number of live nodes (leaves + internal). */
    get nodeCount(): number;
    /** @returns {number} Number of leaves currently stored. */
    get proxyCount(): number;
    /** @returns {number} Height of the tree, or 0 when empty. */
    get height(): number;
    /** @returns {number} Slots currently allocated in the node arrays. */
    get capacity(): number;
    /** @returns {number} Root node index, or -1 when the tree is empty. */
    get root(): number;
    /** @returns {number} Approximate CPU memory footprint, in bytes. */
    get memoryBytes(): number;
    /**
     * Grows the node arrays and re-threads the free list.
     * @param {number} newCapacity
     * @returns {void}
     */
    _grow(newCapacity: number): void;
    /**
     * Pops a node from the free list, growing the pool when necessary.
     * @returns {number} Node index.
     */
    _allocateNode(): number;
    /**
     * Returns a node to the free list.
     * @param {number} id
     * @returns {void}
     */
    _freeNode(id: number): void;
    /**
     * Surface area (SAH cost) of a node's fat AABB.
     * @param {number} node
     * @returns {number}
     */
    _area(node: number): number;
    /**
     * Surface area of the union between a node's fat AABB and an explicit box.
     * @param {number} node
     * @param {number} minX
     * @param {number} minY
     * @param {number} minZ
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} maxZ
     * @returns {number}
     */
    _unionArea(node: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number;
    /**
     * Writes the union of nodes `a` and `b` into node `dst`.
     * @param {number} dst
     * @param {number} a
     * @param {number} b
     * @returns {void}
     */
    _combine(dst: number, a: number, b: number): void;
    /**
     * Stores the tight box of a leaf and derives its fat box.
     * @param {number} node
     * @param {number} minX
     * @param {number} minY
     * @param {number} minZ
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} maxZ
     * @param {number} dx Predicted displacement on X.
     * @param {number} dy Predicted displacement on Y.
     * @param {number} dz Predicted displacement on Z.
     * @returns {void}
     */
    _setLeafBounds(node: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, dx: number, dy: number, dz: number): void;
    /**
     * Inserts a proxy.
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb World AABB.
     * @param {*} userData Payload returned by queries.
     * @returns {number} The new proxy id.
     */
    insert(aabb: {
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
    }, userData: any): number;
    /**
     * Allocation-free variant of {@link DynamicBVH#insert}.
     * @param {number} minX
     * @param {number} minY
     * @param {number} minZ
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} maxZ
     * @param {*} userData
     * @returns {number} The new proxy id.
     */
    insertMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, userData: any): number;
    /**
     * Removes a proxy previously returned by {@link DynamicBVH#insert}.
     * @param {number} proxyId
     * @returns {void}
     */
    remove(proxyId: number): void;
    /**
     * Refreshes a proxy. The tree is only restructured when the new tight AABB
     * escapes the cached fat AABB, which makes small per-frame motion nearly free.
     * @param {number} proxyId
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
     * @param {{x:number,y:number,z:number}} [displacement] Motion since the last update.
     * @returns {boolean} True when the proxy was reinserted.
     */
    update(proxyId: number, aabb: {
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
    }, displacement?: {
        x: number;
        y: number;
        z: number;
    }): boolean;
    /**
     * Allocation-free variant of {@link DynamicBVH#update}.
     * @param {number} proxyId
     * @param {number} minX
     * @param {number} minY
     * @param {number} minZ
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} maxZ
     * @param {number} [dx] Pre-multiplied displacement on X.
     * @param {number} [dy] Pre-multiplied displacement on Y.
     * @param {number} [dz] Pre-multiplied displacement on Z.
     * @returns {boolean} True when the proxy was reinserted.
     */
    updateMinMax(proxyId: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, dx?: number, dy?: number, dz?: number): boolean;
    /**
     * @param {number} proxyId
     * @returns {*} The payload stored with the proxy, or null.
     */
    getUserData(proxyId: number): any;
    /**
     * Replaces the payload of an existing proxy.
     * @param {number} proxyId
     * @param {*} userData
     * @returns {void}
     */
    setUserData(proxyId: number, userData: any): void;
    /**
     * Copies the exact (non-fattened) bounds of a proxy.
     * @param {number} proxyId
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} out
     * @returns {*} `out`.
     */
    getProxyBounds(proxyId: number, out: {
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
     * Copies the fat bounds of the root node.
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
     * Drops every proxy and resets the pool.
     * @returns {void}
     */
    clear(): void;
    /**
     * Links a fully initialised leaf into the tree, picking the sibling that
     * minimises the surface area heuristic.
     * @param {number} leaf
     * @returns {void}
     */
    _insertLeaf(leaf: number): void;
    /**
     * Unlinks a leaf without freeing it.
     * @param {number} leaf
     * @returns {void}
     */
    _removeLeaf(leaf: number): void;
    /**
     * Walks from `start` to the root refitting bounds/heights and rebalancing.
     * @param {number} start
     * @returns {void}
     */
    _refitUpwards(start: number): void;
    /**
     * AVL-like rotation around `iA`.
     * @param {number} iA
     * @returns {number} The node that now occupies `iA`'s former slot in the tree.
     */
    _balance(iA: number): number;
    /**
     * Grows the traversal stacks when the tree gets deeper than the reserve.
     * @param {number} needed
     * @returns {void}
     */
    _ensureStack(needed: number): void;
    /**
     * Frustum culling query.
     *
     * The traversal carries a bit mask of the frustum planes that are still able to
     * reject the current subtree. Once a node is fully inside a plane that plane's
     * bit is cleared for the whole subtree, and when the mask reaches zero the
     * remaining nodes are accepted without any further plane test.
     *
     * `out` is emptied before the traversal and receives the `userData` of every
     * visible proxy. Leaf acceptance uses the exact (non-fattened) bounds, so the
     * result contains no false positives from the fat AABB margin.
     *
     * @param {{planes:Array<{normal:{x:number,y:number,z:number}, constant:number}>}} frustum
     * @param {Array<*>} out
     * @returns {number} Number of visible proxies written to `out`.
     */
    query(frustum: {
        planes: Array<{
            normal: {
                x: number;
                y: number;
                z: number;
            };
            constant: number;
        }>;
    }, out: Array<any>): number;
    /**
     * Fallback frustum query for objects that only expose `intersectsAABBMinMax`.
     * @param {{intersectsAABBMinMax:Function}} frustum
     * @param {Array<*>} out
     * @returns {number}
     */
    _queryFrustumGeneric(frustum: {
        intersectsAABBMinMax: Function;
    }, out: Array<any>): number;
    /**
     * Collects every proxy whose exact bounds overlap `aabb`.
     * `out` is emptied first.
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
     * @param {Array<*>} out
     * @returns {number} Number of proxies written to `out`.
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
    }, out: Array<any>): number;
    /**
     * Allocation-free variant of {@link DynamicBVH#queryAABB}.
     * @param {number} minX
     * @param {number} minY
     * @param {number} minZ
     * @param {number} maxX
     * @param {number} maxY
     * @param {number} maxZ
     * @param {Array<*>} out
     * @returns {number}
     */
    queryAABBMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: Array<any>): number;
    /**
     * Collects every proxy whose exact bounds overlap a sphere. `out` is emptied first.
     * @param {number} cx
     * @param {number} cy
     * @param {number} cz
     * @param {number} radius
     * @param {Array<*>} out
     * @returns {number}
     */
    querySphere(cx: number, cy: number, cz: number, radius: number, out: Array<any>): number;
    /**
     * Grows the ray priority queue.
     * @returns {void}
     */
    _heapGrow(): void;
    /**
     * Pushes a node onto the min-heap.
     * @param {number} key Entry distance along the ray.
     * @param {number} value Node index.
     * @returns {void}
     */
    _heapPush(key: number, value: number): void;
    /**
     * Pops the closest node. The popped key is left in `this._heapPopKey`.
     * @returns {number} Node index.
     */
    _heapPop(): number;
    /**
     * Casts a ray through the tree, reporting proxies strictly in order of their
     * entry distance.
     *
     * The callback may narrow the search: returning a finite number replaces
     * `maxDist`, returning `false` aborts the traversal, anything else continues.
     *
     * @param {{origin:{x:number,y:number,z:number}, direction:{x:number,y:number,z:number}}} ray
     *   Direction should be normalised for `t` to be a world-space distance.
     * @param {number} maxDist
     * @param {(userData:*, proxyId:number, tEnter:number)=>(number|boolean|void)} callback
     * @returns {number} Number of proxies reported.
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
    }, maxDist: number, callback: (userData: any, proxyId: number, tEnter: number) => (number | boolean | void)): number;
    /**
     * Branch-free slab test. Returns the entry distance (clamped to 0 when the
     * origin is inside) or -1 when the ray misses within `limit`.
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
     * Rebuilds the hierarchy bottom-up with SAH driven agglomerative clustering.
     *
     * Leaves are first sorted along a 30 bit Morton curve so spatial neighbours end
     * up adjacent; rounds of mutual nearest-neighbour merging (searched inside a
     * symmetric window) then collapse the list until a single root remains. Merging
     * always picks the pair with the smallest union surface area, which is exactly
     * the SAH cost of the parent that gets created.
     *
     * This is an offline operation: call it after bulk loading a scene, never per frame.
     * @returns {void}
     */
    rebuild(): void;
    /**
     * Creates an internal node holding `a` and `b`.
     * @param {number} a
     * @param {number} b
     * @returns {number} The new parent node index.
     */
    _mergeClusters(a: number, b: number): number;
    /**
     * Total SAH cost of the tree (sum of internal node surface areas divided by the
     * root area). Useful to compare an incrementally built tree against a rebuild.
     * @returns {number}
     */
    computeCost(): number;
    /**
     * Releases every reference held by the tree.
     * @returns {void}
     */
    dispose(): void;
}
