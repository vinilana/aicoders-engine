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
  constructor(factory, reset = null, initial = 0, maxSize = 0) {
    if (typeof factory !== 'function') {
      throw new Error('Pool: e necessario informar uma funcao "factory".');
    }
    /** @private @type {Function} */
    this._factory = factory;
    /** @private @type {Function|null} */
    this._reset = typeof reset === 'function' ? reset : null;
    /** @private @type {Array<*>} Dense free list; slots >= _count are null. */
    this._free = [];
    /** @private @type {number} Number of live entries in `_free`. */
    this._count = 0;

    /** @type {number} Total instances produced by the factory. */
    this.created = 0;
    /** @type {number} Number of instances currently checked out. */
    this.inUse = 0;
    /** @type {number} Retention limit; 0 means unbounded. */
    this.maxSize = maxSize;

    if (initial > 0) this.prealloc(initial);
  }

  /**
   * Number of instances currently sitting in the pool.
   * @returns {number} Free instance count.
   */
  get size() {
    return this._count;
  }

  /**
   * Takes an instance from the pool, creating one when the pool is empty.
   * @returns {*} A ready-to-use instance.
   */
  acquire() {
    this.inUse++;
    if (this._count > 0) {
      const index = --this._count;
      const object = this._free[index];
      this._free[index] = null;
      return object;
    }
    this.created++;
    return this._factory();
  }

  /**
   * Returns an instance to the pool, running the reset callback first.
   * @param {*} object Instance previously obtained from `acquire`.
   * @returns {boolean} True when the instance was retained.
   */
  release(object) {
    if (object === null || object === undefined) return false;
    if (this.inUse > 0) this.inUse--;
    const reset = this._reset;
    if (reset !== null) reset(object);
    if (this.maxSize > 0 && this._count >= this.maxSize) return false;
    if (this._count < this._free.length) this._free[this._count] = object;
    else this._free.push(object);
    this._count++;
    return true;
  }

  /**
   * Creates `n` instances up front so the first frames do not pay for them.
   * @param {number} n Instance count.
   * @returns {Pool} this
   */
  prealloc(n) {
    for (let i = 0; i < n; i++) {
      if (this.maxSize > 0 && this._count >= this.maxSize) break;
      const object = this._factory();
      this.created++;
      if (this._count < this._free.length) this._free[this._count] = object;
      else this._free.push(object);
      this._count++;
    }
    return this;
  }

  /**
   * Drops every retained instance. Checked out instances are unaffected.
   * @returns {Pool} this
   */
  clear() {
    const free = this._free;
    for (let i = 0, n = free.length; i < n; i++) free[i] = null;
    free.length = 0;
    this._count = 0;
    return this;
  }
}
