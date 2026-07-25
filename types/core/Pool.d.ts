/**
 * Pool - generic free list for reusable objects.
 *
 * The pool keeps recycled instances in a dense array plus a live counter, so
 * `acquire`/`release` are O(1) and never resize the backing array once warmed
 * up. Nothing is allocated on the hot path apart from the objects the factory
 * has to create when the free list runs dry.
 *
 * @module core/Pool
 */
export class Pool {
    /**
     * @param {Function} factory Creates a brand new instance: `() => object`.
     * @param {Function|null} [reset=null] Called on release: `(object) => void`.
     * @param {number} [initial=0] Instances pre-allocated at construction.
     * @param {number} [maxSize=0] Maximum retained instances; 0 = unbounded.
     *   Objects released beyond the limit are simply dropped for the GC.
     */
    constructor(factory: Function, reset?: Function | null, initial?: number, maxSize?: number);
    /** @private @type {Function} */
    private _factory;
    /** @private @type {Function|null} */
    private _reset;
    /** @private @type {Array<*>} Dense free list; slots >= _count are null. */
    private _free;
    /** @private @type {number} Number of live entries in `_free`. */
    private _count;
    /** @type {number} Total instances produced by the factory. */
    created: number;
    /** @type {number} Number of instances currently checked out. */
    inUse: number;
    /** @type {number} Retention limit; 0 means unbounded. */
    maxSize: number;
    /**
     * Number of instances currently sitting in the pool.
     * @returns {number} Free instance count.
     */
    get size(): number;
    /**
     * Takes an instance from the pool, creating one when the pool is empty.
     * @returns {*} A ready-to-use instance.
     */
    acquire(): any;
    /**
     * Returns an instance to the pool, running the reset callback first.
     * @param {*} object Instance previously obtained from `acquire`.
     * @returns {boolean} True when the instance was retained.
     */
    release(object: any): boolean;
    /**
     * Creates `n` instances up front so the first frames do not pay for them.
     * @param {number} n Instance count.
     * @returns {Pool} this
     */
    prealloc(n: number): Pool;
    /**
     * Drops every retained instance. Checked out instances are unaffected.
     * @returns {Pool} this
     */
    clear(): Pool;
}
