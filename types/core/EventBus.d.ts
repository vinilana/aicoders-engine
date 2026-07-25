export class EventBus {
    /** @type {Map<string, ListenerBucket>} */
    _buckets: Map<string, ListenerBucket>;
    /**
     * Registers a listener for an event type.
     * @param {string} type Event name.
     * @param {Function} fn Callback invoked as `fn(a, b)`.
     * @returns {EventBus} this
     */
    on(type: string, fn: Function): EventBus;
    /**
     * Registers a listener that is removed right after its first invocation.
     * @param {string} type Event name.
     * @param {Function} fn Callback invoked as `fn(a, b)`.
     * @returns {EventBus} this
     */
    once(type: string, fn: Function): EventBus;
    /**
     * Removes the first registration matching `fn` for the given type.
     * @param {string} type Event name.
     * @param {Function} fn Callback previously registered.
     * @returns {EventBus} this
     */
    off(type: string, fn: Function): EventBus;
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
    emit(type: string, a?: any, b?: any): boolean;
    /**
     * Number of live listeners for a type, or for the whole bus when `type` is
     * omitted.
     * @param {string} [type] Event name.
     * @returns {number} Listener count.
     */
    listenerCount(type?: string): number;
    /**
     * Tells whether a listener (or any listener) is registered for a type.
     * @param {string} type Event name.
     * @param {Function} [fn] Specific callback to look for.
     * @returns {boolean} True when found.
     */
    has(type: string, fn?: Function): boolean;
    /**
     * Removes every listener of a type, or all listeners when `type` is omitted.
     * @param {string} [type] Event name.
     * @returns {EventBus} this
     */
    clear(type?: string): EventBus;
    /**
     * Adds a listener with the given "once" behaviour.
     * @private
     * @param {string} type Event name.
     * @param {Function} fn Callback.
     * @param {boolean} isOnce Whether it auto-removes after firing.
     * @returns {EventBus} this
     */
    private _add;
    /**
     * Removes null slots from a bucket, dropping the bucket when it is empty.
     * @private
     * @param {string} type Event name.
     * @param {ListenerBucket} bucket Bucket to compact.
     */
    private _compact;
}
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
declare class ListenerBucket {
    /** @type {Array<Function|null>} Listener callbacks (null = removed). */
    fns: Array<Function | null>;
    /** @type {boolean[]} Parallel "remove after first call" flags. */
    once: boolean[];
    /** @type {number} Nesting level of in-flight dispatches. */
    depth: number;
    /** @type {boolean} True when the bucket contains holes to compact. */
    dirty: boolean;
}
export {};
