/**
 * EventBus - synchronous, allocation free event dispatcher.
 *
 * `emit` never allocates: listeners are stored in flat parallel arrays and the
 * dispatch loop iterates by index over a stable window whose length is captured
 * before the first call. Mutating the bus from inside a handler is safe:
 *
 *  - listeners added during a dispatch are NOT invoked by that dispatch;
 *  - listeners removed during a dispatch are NOT invoked by it either (the same
 *    semantics as DOM EventTarget), because removal only blanks the slot;
 *  - array indices never shift mid-dispatch; compaction happens once the
 *    outermost dispatch has returned.
 *
 * @module core/EventBus
 */

/**
 * Internal storage for a single event type.
 * @private
 */
class ListenerBucket {
  constructor() {
    /** @type {Array<Function|null>} Listener callbacks (null = removed). */
    this.fns = [];
    /** @type {boolean[]} Parallel "remove after first call" flags. */
    this.once = [];
    /** @type {number} Nesting level of in-flight dispatches. */
    this.depth = 0;
    /** @type {boolean} True when the bucket contains holes to compact. */
    this.dirty = false;
  }
}

export class EventBus {
  constructor() {
    /** @type {Map<string, ListenerBucket>} */
    this._buckets = new Map();
  }

  /**
   * Registers a listener for an event type.
   * @param {string} type Event name.
   * @param {Function} fn Callback invoked as `fn(a, b)`.
   * @returns {EventBus} this
   */
  on(type, fn) {
    return this._add(type, fn, false);
  }

  /**
   * Registers a listener that is removed right after its first invocation.
   * @param {string} type Event name.
   * @param {Function} fn Callback invoked as `fn(a, b)`.
   * @returns {EventBus} this
   */
  once(type, fn) {
    return this._add(type, fn, true);
  }

  /**
   * Removes the first registration matching `fn` for the given type.
   * @param {string} type Event name.
   * @param {Function} fn Callback previously registered.
   * @returns {EventBus} this
   */
  off(type, fn) {
    const bucket = this._buckets.get(type);
    if (bucket === undefined) return this;
    const fns = bucket.fns;
    for (let i = 0, n = fns.length; i < n; i++) {
      if (fns[i] === fn) {
        fns[i] = null;
        bucket.dirty = true;
        if (bucket.depth === 0) this._compact(type, bucket);
        return this;
      }
    }
    return this;
  }

  /**
   * Dispatches an event to every listener registered for `type`.
   * Performs no allocation and never throws on unknown types. Listeners added
   * during the dispatch are skipped; listeners removed during it are skipped
   * too. See the module header for the full mutation semantics.
   * @param {string} type Event name.
   * @param {*} [a] First payload argument.
   * @param {*} [b] Second payload argument.
   * @returns {boolean} True when at least one listener was invoked.
   */
  emit(type, a, b) {
    const bucket = this._buckets.get(type);
    if (bucket === undefined) return false;
    const fns = bucket.fns;
    const n = fns.length;
    if (n === 0) return false;

    bucket.depth++;
    let called = false;
    for (let i = 0; i < n; i++) {
      const fn = fns[i];
      if (fn === null) continue;
      if (bucket.once[i] === true) {
        fns[i] = null;
        bucket.dirty = true;
      }
      called = true;
      fn(a, b);
    }
    bucket.depth--;
    if (bucket.depth === 0 && bucket.dirty) this._compact(type, bucket);
    return called;
  }

  /**
   * Number of live listeners for a type, or for the whole bus when `type` is
   * omitted.
   * @param {string} [type] Event name.
   * @returns {number} Listener count.
   */
  listenerCount(type) {
    if (type === undefined) {
      let total = 0;
      this._buckets.forEach((bucket) => {
        const fns = bucket.fns;
        for (let i = 0, n = fns.length; i < n; i++) if (fns[i] !== null) total++;
      });
      return total;
    }
    const bucket = this._buckets.get(type);
    if (bucket === undefined) return 0;
    const fns = bucket.fns;
    let count = 0;
    for (let i = 0, n = fns.length; i < n; i++) if (fns[i] !== null) count++;
    return count;
  }

  /**
   * Tells whether a listener (or any listener) is registered for a type.
   * @param {string} type Event name.
   * @param {Function} [fn] Specific callback to look for.
   * @returns {boolean} True when found.
   */
  has(type, fn) {
    const bucket = this._buckets.get(type);
    if (bucket === undefined) return false;
    const fns = bucket.fns;
    if (fn === undefined) {
      for (let i = 0, n = fns.length; i < n; i++) if (fns[i] !== null) return true;
      return false;
    }
    for (let i = 0, n = fns.length; i < n; i++) if (fns[i] === fn) return true;
    return false;
  }

  /**
   * Removes every listener of a type, or all listeners when `type` is omitted.
   * @param {string} [type] Event name.
   * @returns {EventBus} this
   */
  clear(type) {
    if (type === undefined) {
      this._buckets.forEach(markBucketEmpty);
      this._buckets.clear();
      return this;
    }
    const bucket = this._buckets.get(type);
    if (bucket === undefined) return this;
    if (bucket.depth > 0) {
      // Dispatch in progress: blank the slots so the running loop skips them.
      const fns = bucket.fns;
      for (let i = 0, n = fns.length; i < n; i++) fns[i] = null;
      bucket.dirty = true;
      return this;
    }
    this._buckets.delete(type);
    return this;
  }

  /**
   * Adds a listener with the given "once" behaviour.
   * @private
   * @param {string} type Event name.
   * @param {Function} fn Callback.
   * @param {boolean} isOnce Whether it auto-removes after firing.
   * @returns {EventBus} this
   */
  _add(type, fn, isOnce) {
    if (typeof fn !== 'function') return this;
    let bucket = this._buckets.get(type);
    if (bucket === undefined) {
      bucket = new ListenerBucket();
      this._buckets.set(type, bucket);
    }
    bucket.fns.push(fn);
    bucket.once.push(isOnce);
    return this;
  }

  /**
   * Removes null slots from a bucket, dropping the bucket when it is empty.
   * @private
   * @param {string} type Event name.
   * @param {ListenerBucket} bucket Bucket to compact.
   */
  _compact(type, bucket) {
    const fns = bucket.fns;
    const once = bucket.once;
    let write = 0;
    for (let i = 0, n = fns.length; i < n; i++) {
      const fn = fns[i];
      if (fn === null) continue;
      fns[write] = fn;
      once[write] = once[i];
      write++;
    }
    fns.length = write;
    once.length = write;
    bucket.dirty = false;
    if (write === 0) this._buckets.delete(type);
  }
}

/**
 * Blanks a bucket so any in-flight dispatch stops calling its listeners.
 * @private
 * @param {ListenerBucket} bucket Bucket to blank.
 */
function markBucketEmpty(bucket) {
  const fns = bucket.fns;
  for (let i = 0, n = fns.length; i < n; i++) fns[i] = null;
  bucket.dirty = true;
}
