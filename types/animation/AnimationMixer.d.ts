/** Kinds of property a binding can drive. */
export const BindingType: Readonly<{
    NUMBER: 0;
    VEC2: 1;
    VEC3: 2;
    VEC4: 3;
    COLOR: 4;
    ARRAY: 5;
    ARRAY_ELEMENT: 6;
}>;
/**
 * A resolved animation target: a direct reference to the object holding the
 * animated property plus everything needed to blend and write it.
 */
export class PropertyBinding {
    /**
     * @param {string} path Original track path (diagnostics only).
     * @param {Object|null} node Owning scene node, when the target belongs to one.
     * @param {Object} target Object actually written to (a Vec3, Color, array, or property owner).
     * @param {number} kind One of {@link BindingType}.
     * @param {string} propertyName Property name on `target` (NUMBER kind only).
     * @param {number} elementIndex Element index inside `target` (ARRAY_ELEMENT kind only).
     * @param {number} valueSize Components blended and written.
     * @param {boolean} isQuaternion Blend with slerp instead of lerp.
     * @param {boolean} affectsTransform Mark the node's world matrix dirty on write.
     */
    constructor(path: string, node: any | null, target: any, kind: number, propertyName: string, elementIndex: number, valueSize: number, isQuaternion: boolean, affectsTransform: boolean);
    /** @type {string} Track path this binding was built from. */
    path: string;
    /** @type {Object|null} Scene node owning the property (may be null). */
    node: any | null;
    /** @type {Object} Direct reference to the written object. */
    target: any;
    /** @type {number} Binding kind. @see BindingType */
    kind: number;
    /** @type {string} Property name for scalar bindings. */
    propertyName: string;
    /** @type {number} Element index for array element bindings. */
    elementIndex: number;
    /** @type {number} Blended component count. */
    valueSize: number;
    /** @type {boolean} True for rotation quaternions. */
    isQuaternion: boolean;
    /** @type {boolean} True when writing must invalidate the world matrix. */
    affectsTransform: boolean;
    /** @type {Float32Array} Accumulation buffer. */
    buffer: Float32Array;
    /** @type {Float32Array} Pose captured when the binding was created. */
    original: Float32Array;
    /** @type {number} Sum of the weights accumulated this frame. */
    cumulativeWeight: number;
    /** @type {number} Frame stamp used to reset the accumulator lazily. @private */
    private _touchFrame;
    /**
     * Captures the current target value as the reference pose used when the
     * accumulated weight is below 1.
     * @returns {PropertyBinding} this
     */
    saveOriginalState(): PropertyBinding;
    /**
     * Writes the captured reference pose back onto the target.
     * @returns {PropertyBinding} this
     */
    restoreOriginalState(): PropertyBinding;
    /**
     * Reads the live target value.
     * @param {Float32Array|Array<number>} out Destination.
     * @param {number} [outOffset=0] Destination offset.
     * @returns {PropertyBinding} this
     */
    read(out: Float32Array | Array<number>, outOffset?: number): PropertyBinding;
    /**
     * Writes `src` onto the target, skipping the store (and the dirty flag) when
     * nothing actually changed.
     * @param {Float32Array|Array<number>} src Source buffer, `valueSize` components.
     * @returns {PropertyBinding} this
     */
    write(src: Float32Array | Array<number>): PropertyBinding;
    /**
     * Mixes one sampled value into the accumulator using a running normalized
     * weight. Quaternions blend by incremental slerp.
     * @param {Float32Array} src Sampled value.
     * @param {number} weight Action weight (> 0).
     * @returns {void}
     */
    accumulate(src: Float32Array, weight: number): void;
    /**
     * Blends the accumulator against the reference pose when the total weight is
     * below 1, writes it to the target and arms the accumulator for next frame.
     * @returns {void}
     */
    apply(): void;
}
export class AnimationMixer {
    /**
     * @param {Object} root Root of the node hierarchy the clips are bound against.
     */
    constructor(root: any);
    /** @type {Object} Binding root. */
    root: any;
    /** @type {number} Accumulated scaled time, seconds. */
    time: number;
    /** @type {number} Global speed multiplier applied to every action. */
    timeScale: number;
    /** @type {?function(AnimationAction):void} Called when any action finishes. */
    onFinished: (arg0: AnimationAction) => void;
    /** @type {?function(AnimationAction, number):void} Called when any action loops. */
    onLoop: (arg0: AnimationAction, arg1: number) => void;
    /** @type {Array<AnimationAction>} Every action created by this mixer. @private */
    private _actions;
    /** @type {Array<AnimationAction>} Actions currently being updated. @private */
    private _active;
    /** @type {Map<Object, Map<import('./AnimationClip.js').AnimationClip, AnimationAction>>} @private */
    private _actionsByRoot;
    /** @type {Map<Object, Map<string, PropertyBinding|null>>} Binding cache per root. @private */
    private _bindingsByRoot;
    /** @type {Array<PropertyBinding|null>} Bindings touched during the current frame. @private */
    private _touched;
    /** @type {number} Frame stamp used to reset accumulators lazily. @private */
    private _frame;
    /** @type {Float32Array} Sample scratch, grown to the largest track value size. @private */
    private _scratch;
    /** @type {EventBus|null} Created on first listener registration. @private */
    private _events;
    /** @returns {Object} The binding root. */
    getRoot(): any;
    /** @returns {Array<AnimationAction>} Every action created by this mixer. */
    getActions(): Array<AnimationAction>;
    /** @returns {number} Number of actions currently being updated. */
    get activeCount(): number;
    /**
     * Returns the action for `clip` on `root`, creating and binding it on first
     * use. The same (clip, root) pair always yields the same action.
     *
     * @param {import('./AnimationClip.js').AnimationClip} clip
     * @param {Object} [root] Binding root (defaults to the mixer root).
     * @returns {AnimationAction|null}
     */
    clipAction(clip: import('./AnimationClip.js').AnimationClip, root?: any): AnimationAction | null;
    /**
     * Returns an already created action without creating one.
     * @param {import('./AnimationClip.js').AnimationClip} clip
     * @param {Object} [root] Binding root (defaults to the mixer root).
     * @returns {AnimationAction|null}
     */
    existingAction(clip: import('./AnimationClip.js').AnimationClip, root?: any): AnimationAction | null;
    /**
     * Stops and rewinds every action.
     * @returns {AnimationMixer} this
     */
    stopAllAction(): AnimationMixer;
    /**
     * Drops the cached action (and its bindings usage) for one clip.
     * @param {import('./AnimationClip.js').AnimationClip} clip
     * @param {Object} [root] Binding root (defaults to the mixer root).
     * @returns {AnimationMixer} this
     */
    uncacheAction(clip: import('./AnimationClip.js').AnimationClip, root?: any): AnimationMixer;
    /**
     * Drops every action playing `clip`, on every root.
     * @param {import('./AnimationClip.js').AnimationClip} clip
     * @returns {AnimationMixer} this
     */
    uncacheClip(clip: import('./AnimationClip.js').AnimationClip): AnimationMixer;
    /**
     * Drops every action and binding attached to `root`.
     * @param {Object} [root] Binding root (defaults to the mixer root).
     * @returns {AnimationMixer} this
     */
    uncacheRoot(root?: any): AnimationMixer;
    /**
     * Re-captures the reference pose of every binding. Call it after moving nodes
     * by hand while actions with a weight below 1 are running.
     * @returns {AnimationMixer} this
     */
    refreshOriginalState(): AnimationMixer;
    /**
     * Copies map keys into a plain array (cold path helper - Map iteration would
     * allocate an iterator, which is fine here but never during `update`).
     * @private
     * @param {Map} map
     * @returns {Array<*>}
     */
    private _collectMapKeys;
    /**
     * Advances every running action and writes the blended pose.
     * Allocation free.
     *
     * @param {number} dt Frame delta in seconds.
     * @returns {AnimationMixer} this
     */
    update(dt: number): AnimationMixer;
    /**
     * Sets the mixer clock and moves every action to the matching time.
     * @param {number} time Seconds.
     * @returns {AnimationMixer} this
     */
    setTime(time: number): AnimationMixer;
    /**
     * Registers a mixer level listener. Types: `'finished'`, `'loop'`.
     * @param {string} type
     * @param {function(AnimationAction, number):void} fn
     * @returns {AnimationMixer} this
     */
    on(type: string, fn: (arg0: AnimationAction, arg1: number) => void): AnimationMixer;
    /**
     * Removes a mixer level listener.
     * @param {string} type
     * @param {function(AnimationAction, number):void} fn
     * @returns {AnimationMixer} this
     */
    off(type: string, fn: (arg0: AnimationAction, arg1: number) => void): AnimationMixer;
    /**
     * Releases every action, binding and listener.
     * @returns {void}
     */
    dispose(): void;
    /**
     * Adds an action to the update list.
     * @private
     * @param {AnimationAction} action
     * @returns {void}
     */
    private _activateAction;
    /**
     * Removes an action from the update list (O(1) swap remove).
     * @private
     * @param {AnimationAction} action
     * @returns {void}
     */
    private _deactivateAction;
    /**
     * Forwards an action `finished` event.
     * @private
     * @param {AnimationAction} action
     * @returns {void}
     */
    private _onActionFinished;
    /**
     * Forwards an action `loop` event.
     * @private
     * @param {AnimationAction} action
     * @param {number} loops
     * @returns {void}
     */
    private _onActionLoop;
    /**
     * Resolves every track of an action into a binding, once.
     * @private
     * @param {AnimationAction} action
     * @returns {void}
     */
    private _bindAction;
    /**
     * Returns the cached binding for a track path, resolving it on first use.
     * Unresolvable paths are cached as `null` so the lookup is never retried.
     * @private
     * @param {Object} root
     * @param {import('./KeyframeTrack.js').KeyframeTrack} track
     * @returns {PropertyBinding|null}
     */
    private _getBinding;
    /**
     * Parses a track path and builds the binding.
     * @private
     * @param {Object} root
     * @param {import('./KeyframeTrack.js').KeyframeTrack} track
     * @returns {PropertyBinding|null}
     */
    private _createBinding;
    /**
     * Finds a node by name below `root` (the root itself matches too).
     * @private
     * @param {Object} root
     * @param {string} name
     * @returns {Object|null}
     */
    private _findNode;
}
import { AnimationAction } from "./AnimationAction.js";
