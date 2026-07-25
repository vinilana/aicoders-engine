/**
 * AnimationMixer - evaluates and blends every running {@link AnimationAction}.
 *
 * Binding: each track path (`'Hips.quaternion'`, `'.material.opacity'`,
 * `'Head.morphTargetInfluences[2]'`) is resolved exactly ONCE into a
 * {@link PropertyBinding} that holds a direct reference to the target object.
 * Bindings are cached per root, so N actions playing on the same skeleton share
 * one binding per bone.
 *
 * Blending: for every property touched this frame the mixer accumulates
 * `value * weight` into the binding's scratch buffer with a running normalized
 * weight, then writes the result to the target once. Vectors and scalars use an
 * incremental lerp; quaternions use an incremental slerp (never a component
 * sum, which would shorten and skew the rotation). When the accumulated weight
 * stays below 1 the result is blended back toward the pose captured at bind
 * time, so partially weighted actions fade against the bind pose instead of
 * snapping.
 *
 * `update(dt)` performs zero allocations after the first frame.
 *
 * @module animation/AnimationMixer
 */

import { Quat } from '../math/Quat.js';
import { Logger } from '../core/Logger.js';
import { EventBus } from '../core/EventBus.js';
import { AnimationAction } from './AnimationAction.js';

/** Kinds of property a binding can drive. */
export const BindingType = Object.freeze({
  NUMBER: 0,
  VEC2: 1,
  VEC3: 2,
  VEC4: 3,
  COLOR: 4,
  ARRAY: 5,
  ARRAY_ELEMENT: 6
});

/** glTF style property names mapped onto engine property names. */
const PROPERTY_ALIASES = {
  translation: 'position',
  rotation: 'quaternion',
  scale: 'scale',
  weights: 'morphTargetInfluences'
};

/** Weight above which no blend against the bind pose is needed. */
const FULL_WEIGHT = 1 - 1e-6;

/* Scratch used by the (cold) path parser so tokenizing allocates no objects. */
let _tokenName = '';
let _tokenIndex = -1;
let _tokenKey = '';

/**
 * Splits `name[index]` into the module scratch `_tokenName` / `_tokenIndex` /
 * `_tokenKey`. `_tokenKey` holds a non numeric index (`bones[Hips]`).
 * @private
 * @param {string} token
 * @returns {void}
 */
function parseToken(token) {
  _tokenName = token;
  _tokenIndex = -1;
  _tokenKey = '';
  const open = token.indexOf('[');
  if (open === -1 || token.charCodeAt(token.length - 1) !== 93 /* ] */) return;
  _tokenName = token.slice(0, open);
  const inner = token.slice(open + 1, token.length - 1);
  if (inner.length === 0) return;
  const numeric = Number(inner);
  if (Number.isFinite(numeric) && String(numeric) === inner) _tokenIndex = numeric | 0;
  else _tokenKey = inner;
}

/**
 * Resolves one indexing step (`array[3]`, `bones[Hips]`, `map[key]`).
 * @private
 * @param {Object} container
 * @param {number} index
 * @param {string} key
 * @returns {*}
 */
function indexInto(container, index, key) {
  if (container === null || container === undefined) return undefined;
  if (index >= 0) return container[index];
  if (key.length === 0) return container;
  if (Array.isArray(container)) {
    for (let i = 0, n = container.length; i < n; i++) {
      const item = container[i];
      if (item !== null && item !== undefined && item.name === key) return item;
    }
    return undefined;
  }
  return container[key];
}

/**
 * `Map.forEach` callback that appends keys to the array passed as `thisArg`.
 * Declared at module scope so no closure is created per call.
 * @private
 * @this {Array<*>}
 * @param {*} value
 * @param {*} key
 * @returns {void}
 */
function pushKey(value, key) {
  this.push(key);
}

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
  constructor(path, node, target, kind, propertyName, elementIndex, valueSize, isQuaternion, affectsTransform) {
    /** @type {string} Track path this binding was built from. */
    this.path = path;

    /** @type {Object|null} Scene node owning the property (may be null). */
    this.node = node;

    /** @type {Object} Direct reference to the written object. */
    this.target = target;

    /** @type {number} Binding kind. @see BindingType */
    this.kind = kind;

    /** @type {string} Property name for scalar bindings. */
    this.propertyName = propertyName;

    /** @type {number} Element index for array element bindings. */
    this.elementIndex = elementIndex;

    /** @type {number} Blended component count. */
    this.valueSize = valueSize;

    /** @type {boolean} True for rotation quaternions. */
    this.isQuaternion = isQuaternion;

    /** @type {boolean} True when writing must invalidate the world matrix. */
    this.affectsTransform = affectsTransform;

    /** @type {Float32Array} Accumulation buffer. */
    this.buffer = new Float32Array(valueSize);

    /** @type {Float32Array} Pose captured when the binding was created. */
    this.original = new Float32Array(valueSize);

    /** @type {number} Sum of the weights accumulated this frame. */
    this.cumulativeWeight = 0;

    /** @type {number} Frame stamp used to reset the accumulator lazily. @private */
    this._touchFrame = -1;

    this.saveOriginalState();
  }

  /**
   * Captures the current target value as the reference pose used when the
   * accumulated weight is below 1.
   * @returns {PropertyBinding} this
   */
  saveOriginalState() {
    this.read(this.original, 0);
    return this;
  }

  /**
   * Writes the captured reference pose back onto the target.
   * @returns {PropertyBinding} this
   */
  restoreOriginalState() {
    this.write(this.original);
    return this;
  }

  /**
   * Reads the live target value.
   * @param {Float32Array|Array<number>} out Destination.
   * @param {number} [outOffset=0] Destination offset.
   * @returns {PropertyBinding} this
   */
  read(out, outOffset = 0) {
    const target = this.target;
    switch (this.kind) {
      case BindingType.NUMBER:
        out[outOffset] = target[this.propertyName];
        break;
      case BindingType.VEC2:
        out[outOffset] = target.x;
        out[outOffset + 1] = target.y;
        break;
      case BindingType.VEC3:
        out[outOffset] = target.x;
        out[outOffset + 1] = target.y;
        out[outOffset + 2] = target.z;
        break;
      case BindingType.VEC4:
        out[outOffset] = target.x;
        out[outOffset + 1] = target.y;
        out[outOffset + 2] = target.z;
        out[outOffset + 3] = target.w;
        break;
      case BindingType.COLOR:
        out[outOffset] = target.r;
        out[outOffset + 1] = target.g;
        out[outOffset + 2] = target.b;
        break;
      case BindingType.ARRAY_ELEMENT:
        out[outOffset] = target[this.elementIndex];
        break;
      default: {
        const n = this.valueSize;
        for (let k = 0; k < n; k++) out[outOffset + k] = target[k];
        break;
      }
    }
    return this;
  }

  /**
   * Writes `src` onto the target, skipping the store (and the dirty flag) when
   * nothing actually changed.
   * @param {Float32Array|Array<number>} src Source buffer, `valueSize` components.
   * @returns {PropertyBinding} this
   */
  write(src) {
    const target = this.target;
    let changed = false;

    switch (this.kind) {
      case BindingType.NUMBER: {
        const name = this.propertyName;
        const v = src[0];
        if (target[name] !== v) {
          target[name] = v;
          changed = true;
        }
        break;
      }
      case BindingType.VEC2: {
        const x = src[0];
        const y = src[1];
        if (target.x !== x || target.y !== y) {
          target.x = x;
          target.y = y;
          changed = true;
        }
        break;
      }
      case BindingType.VEC3: {
        const x = src[0];
        const y = src[1];
        const z = src[2];
        if (target.x !== x || target.y !== y || target.z !== z) {
          target.x = x;
          target.y = y;
          target.z = z;
          changed = true;
        }
        break;
      }
      case BindingType.VEC4: {
        const x = src[0];
        const y = src[1];
        const z = src[2];
        const w = src[3];
        if (target.x !== x || target.y !== y || target.z !== z || target.w !== w) {
          target.x = x;
          target.y = y;
          target.z = z;
          target.w = w;
          changed = true;
        }
        break;
      }
      case BindingType.COLOR: {
        const r = src[0];
        const g = src[1];
        const b = src[2];
        if (target.r !== r || target.g !== g || target.b !== b) {
          target.r = r;
          target.g = g;
          target.b = b;
          changed = true;
        }
        break;
      }
      case BindingType.ARRAY_ELEMENT: {
        const i = this.elementIndex;
        const v = src[0];
        if (target[i] !== v) {
          target[i] = v;
          changed = true;
        }
        break;
      }
      default: {
        const n = this.valueSize;
        for (let k = 0; k < n; k++) {
          const v = src[k];
          if (target[k] !== v) {
            target[k] = v;
            changed = true;
          }
        }
        break;
      }
    }

    if (changed && this.affectsTransform) {
      const node = this.node;
      if (node !== null) node.matrixWorldNeedsUpdate = true;
    }
    return this;
  }

  /**
   * Mixes one sampled value into the accumulator using a running normalized
   * weight. Quaternions blend by incremental slerp.
   * @param {Float32Array} src Sampled value.
   * @param {number} weight Action weight (> 0).
   * @returns {void}
   */
  accumulate(src, weight) {
    if (weight <= 0) return;
    const buffer = this.buffer;
    const n = this.valueSize;
    const previous = this.cumulativeWeight;

    if (previous <= 0) {
      for (let k = 0; k < n; k++) buffer[k] = src[k];
      this.cumulativeWeight = weight;
      return;
    }

    const total = previous + weight;
    const mix = weight / total;
    if (this.isQuaternion) {
      Quat.slerpFlat(buffer, 0, buffer, 0, src, 0, mix);
    } else {
      for (let k = 0; k < n; k++) buffer[k] += (src[k] - buffer[k]) * mix;
    }
    this.cumulativeWeight = total;
  }

  /**
   * Blends the accumulator against the reference pose when the total weight is
   * below 1, writes it to the target and arms the accumulator for next frame.
   * @returns {void}
   */
  apply() {
    const weight = this.cumulativeWeight;
    if (weight <= 0) return;

    const buffer = this.buffer;
    if (weight < FULL_WEIGHT) {
      const original = this.original;
      if (this.isQuaternion) {
        Quat.slerpFlat(buffer, 0, original, 0, buffer, 0, weight);
      } else {
        for (let k = 0, n = this.valueSize; k < n; k++) {
          buffer[k] = original[k] + (buffer[k] - original[k]) * weight;
        }
      }
    }

    this.write(buffer);
    this.cumulativeWeight = 0;
  }
}

export class AnimationMixer {
  /**
   * @param {Object} root Root of the node hierarchy the clips are bound against.
   */
  constructor(root) {
    /** @type {Object} Binding root. */
    this.root = root;

    /** @type {number} Accumulated scaled time, seconds. */
    this.time = 0;

    /** @type {number} Global speed multiplier applied to every action. */
    this.timeScale = 1;

    /** @type {?function(AnimationAction):void} Called when any action finishes. */
    this.onFinished = null;

    /** @type {?function(AnimationAction, number):void} Called when any action loops. */
    this.onLoop = null;

    /** @type {Array<AnimationAction>} Every action created by this mixer. @private */
    this._actions = [];

    /** @type {Array<AnimationAction>} Actions currently being updated. @private */
    this._active = [];

    /** @type {Map<Object, Map<import('./AnimationClip.js').AnimationClip, AnimationAction>>} @private */
    this._actionsByRoot = new Map();

    /** @type {Map<Object, Map<string, PropertyBinding|null>>} Binding cache per root. @private */
    this._bindingsByRoot = new Map();

    /** @type {Array<PropertyBinding|null>} Bindings touched during the current frame. @private */
    this._touched = [];

    /** @type {number} Frame stamp used to reset accumulators lazily. @private */
    this._frame = 0;

    /** @type {Float32Array} Sample scratch, grown to the largest track value size. @private */
    this._scratch = new Float32Array(16);

    /** @type {EventBus|null} Created on first listener registration. @private */
    this._events = null;
  }

  /** @returns {Object} The binding root. */
  getRoot() {
    return this.root;
  }

  /** @returns {Array<AnimationAction>} Every action created by this mixer. */
  getActions() {
    return this._actions;
  }

  /** @returns {number} Number of actions currently being updated. */
  get activeCount() {
    return this._active.length;
  }

  /* -------------------------------------------------------------------- */
  /* Actions                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Returns the action for `clip` on `root`, creating and binding it on first
   * use. The same (clip, root) pair always yields the same action.
   *
   * @param {import('./AnimationClip.js').AnimationClip} clip
   * @param {Object} [root] Binding root (defaults to the mixer root).
   * @returns {AnimationAction|null}
   */
  clipAction(clip, root) {
    if (clip === null || clip === undefined) return null;
    const bindRoot = root !== undefined && root !== null ? root : this.root;

    let byClip = this._actionsByRoot.get(bindRoot);
    if (byClip === undefined) {
      byClip = new Map();
      this._actionsByRoot.set(bindRoot, byClip);
    }

    let action = byClip.get(clip);
    if (action !== undefined) return action;

    action = new AnimationAction(this, clip, bindRoot);
    this._bindAction(action);
    byClip.set(clip, action);
    this._actions.push(action);
    return action;
  }

  /**
   * Returns an already created action without creating one.
   * @param {import('./AnimationClip.js').AnimationClip} clip
   * @param {Object} [root] Binding root (defaults to the mixer root).
   * @returns {AnimationAction|null}
   */
  existingAction(clip, root) {
    const bindRoot = root !== undefined && root !== null ? root : this.root;
    const byClip = this._actionsByRoot.get(bindRoot);
    if (byClip === undefined) return null;
    const action = byClip.get(clip);
    return action === undefined ? null : action;
  }

  /**
   * Stops and rewinds every action.
   * @returns {AnimationMixer} this
   */
  stopAllAction() {
    const active = this._active;
    for (let i = active.length - 1; i >= 0; i--) active[i].stop();
    active.length = 0;
    return this;
  }

  /**
   * Drops the cached action (and its bindings usage) for one clip.
   * @param {import('./AnimationClip.js').AnimationClip} clip
   * @param {Object} [root] Binding root (defaults to the mixer root).
   * @returns {AnimationMixer} this
   */
  uncacheAction(clip, root) {
    const bindRoot = root !== undefined && root !== null ? root : this.root;
    const byClip = this._actionsByRoot.get(bindRoot);
    if (byClip === undefined) return this;
    const action = byClip.get(clip);
    if (action === undefined) return this;
    this._deactivateAction(action);
    byClip.delete(clip);
    const index = this._actions.indexOf(action);
    if (index !== -1) this._actions.splice(index, 1);
    action._bindings = null;
    action._trackCache = null;
    return this;
  }

  /**
   * Drops every action playing `clip`, on every root.
   * @param {import('./AnimationClip.js').AnimationClip} clip
   * @returns {AnimationMixer} this
   */
  uncacheClip(clip) {
    const roots = this._actionsByRoot;
    const rootList = this._collectMapKeys(roots);
    for (let i = 0, n = rootList.length; i < n; i++) this.uncacheAction(clip, rootList[i]);
    return this;
  }

  /**
   * Drops every action and binding attached to `root`.
   * @param {Object} [root] Binding root (defaults to the mixer root).
   * @returns {AnimationMixer} this
   */
  uncacheRoot(root) {
    const bindRoot = root !== undefined && root !== null ? root : this.root;
    const byClip = this._actionsByRoot.get(bindRoot);
    if (byClip !== undefined) {
      const clips = this._collectMapKeys(byClip);
      for (let i = 0, n = clips.length; i < n; i++) this.uncacheAction(clips[i], bindRoot);
      this._actionsByRoot.delete(bindRoot);
    }
    this._bindingsByRoot.delete(bindRoot);
    return this;
  }

  /**
   * Re-captures the reference pose of every binding. Call it after moving nodes
   * by hand while actions with a weight below 1 are running.
   * @returns {AnimationMixer} this
   */
  refreshOriginalState() {
    const roots = this._bindingsByRoot;
    const rootList = this._collectMapKeys(roots);
    for (let i = 0, n = rootList.length; i < n; i++) {
      const map = roots.get(rootList[i]);
      const keys = this._collectMapKeys(map);
      for (let j = 0, m = keys.length; j < m; j++) {
        const binding = map.get(keys[j]);
        if (binding !== null && binding !== undefined) binding.saveOriginalState();
      }
    }
    return this;
  }

  /**
   * Copies map keys into a plain array (cold path helper - Map iteration would
   * allocate an iterator, which is fine here but never during `update`).
   * @private
   * @param {Map} map
   * @returns {Array<*>}
   */
  _collectMapKeys(map) {
    const keys = [];
    map.forEach(pushKey, keys);
    return keys;
  }

  /* -------------------------------------------------------------------- */
  /* Per frame update                                                      */
  /* -------------------------------------------------------------------- */

  /**
   * Advances every running action and writes the blended pose.
   * Allocation free.
   *
   * @param {number} dt Frame delta in seconds.
   * @returns {AnimationMixer} this
   */
  update(dt) {
    const delta = dt * this.timeScale;
    this.time += delta;

    const active = this._active;

    // Phase 1 - advance time and weights. Iterating backwards keeps the swap
    // remove performed by actions that finish or fade out safe.
    for (let i = active.length - 1; i >= 0; i--) active[i]._update(delta);

    // Phase 2 - sample every track and accumulate into its binding.
    const frame = ++this._frame;
    const touched = this._touched;
    const scratch = this._scratch;
    let count = 0;

    for (let i = 0, n = active.length; i < n; i++) {
      const action = active[i];
      const weight = action._effectiveWeight;
      if (weight <= 0) continue;
      const clip = action.clip;
      // The clip was edited after this action was bound: rebind it (cold path).
      if (action._bindings === null || action._clipVersion !== clip.version) this._bindAction(action);

      const bindings = action._bindings;
      const tracks = clip.tracks;
      const cache = action._trackCache;
      const time = action.time;

      for (let j = 0, m = bindings.length; j < m; j++) {
        const binding = bindings[j];
        if (binding === null) continue;
        tracks[j].evaluate(time, scratch, 0, cache, j);
        if (binding._touchFrame !== frame) {
          binding._touchFrame = frame;
          binding.cumulativeWeight = 0;
          touched[count++] = binding;
        }
        binding.accumulate(scratch, weight);
      }
    }

    // Phase 3 - one write per property.
    for (let i = 0; i < count; i++) {
      const binding = touched[i];
      binding.apply();
      touched[i] = null;
    }

    // Phase 4 - retire the actions that finished during this frame. They stay
    // in the list until here so the frame that reached the end still writes the
    // final pose.
    for (let i = active.length - 1; i >= 0; i--) {
      const action = active[i];
      if (action._pendingStop) {
        action._pendingStop = false;
        action._effectiveWeight = 0;
        this._deactivateAction(action);
      }
    }

    return this;
  }

  /**
   * Sets the mixer clock and moves every action to the matching time.
   * @param {number} time Seconds.
   * @returns {AnimationMixer} this
   */
  setTime(time) {
    this.time = 0;
    const actions = this._actions;
    for (let i = 0, n = actions.length; i < n; i++) actions[i].setTime(0);
    this.update(time);
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Events                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Registers a mixer level listener. Types: `'finished'`, `'loop'`.
   * @param {string} type
   * @param {function(AnimationAction, number):void} fn
   * @returns {AnimationMixer} this
   */
  on(type, fn) {
    if (this._events === null) this._events = new EventBus();
    this._events.on(type, fn);
    return this;
  }

  /**
   * Removes a mixer level listener.
   * @param {string} type
   * @param {function(AnimationAction, number):void} fn
   * @returns {AnimationMixer} this
   */
  off(type, fn) {
    if (this._events !== null) this._events.off(type, fn);
    return this;
  }

  /**
   * Releases every action, binding and listener.
   * @returns {void}
   */
  dispose() {
    this.stopAllAction();
    const actions = this._actions;
    for (let i = 0, n = actions.length; i < n; i++) {
      actions[i]._bindings = null;
      actions[i]._trackCache = null;
      actions[i].mixer = null;
    }
    actions.length = 0;
    this._active.length = 0;
    this._touched.length = 0;
    this._actionsByRoot.clear();
    this._bindingsByRoot.clear();
    if (this._events !== null) {
      this._events.clear();
      this._events = null;
    }
  }

  /* -------------------------------------------------------------------- */
  /* Internals used by AnimationAction                                     */
  /* -------------------------------------------------------------------- */

  /**
   * Adds an action to the update list.
   * @private
   * @param {AnimationAction} action
   * @returns {void}
   */
  _activateAction(action) {
    if (action._active) return;
    if (action._bindings === null) this._bindAction(action);
    action._activeIndex = this._active.length;
    action._active = true;
    this._active.push(action);
  }

  /**
   * Removes an action from the update list (O(1) swap remove).
   * @private
   * @param {AnimationAction} action
   * @returns {void}
   */
  _deactivateAction(action) {
    if (!action._active) return;
    const active = this._active;
    const index = action._activeIndex;
    const last = active.length - 1;
    if (index >= 0 && index <= last && active[index] === action) {
      if (index !== last) {
        const moved = active[last];
        active[index] = moved;
        moved._activeIndex = index;
      }
      active.length = last;
    } else {
      const fallback = active.indexOf(action);
      if (fallback !== -1) active.splice(fallback, 1);
    }
    action._active = false;
    action._activeIndex = -1;
  }

  /**
   * Forwards an action `finished` event.
   * @private
   * @param {AnimationAction} action
   * @returns {void}
   */
  _onActionFinished(action) {
    if (this.onFinished !== null) this.onFinished(action);
    if (this._events !== null) this._events.emit('finished', action, 0);
  }

  /**
   * Forwards an action `loop` event.
   * @private
   * @param {AnimationAction} action
   * @param {number} loops
   * @returns {void}
   */
  _onActionLoop(action, loops) {
    if (this.onLoop !== null) this.onLoop(action, loops);
    if (this._events !== null) this._events.emit('loop', action, loops);
  }

  /* -------------------------------------------------------------------- */
  /* Binding                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Resolves every track of an action into a binding, once.
   * @private
   * @param {AnimationAction} action
   * @returns {void}
   */
  _bindAction(action) {
    const clip = action.clip;
    const tracks = clip !== null ? clip.tracks : null;
    const n = tracks !== null ? tracks.length : 0;
    const bindings = new Array(n);
    let maxValueSize = 0;

    for (let i = 0; i < n; i++) {
      const track = tracks[i];
      bindings[i] = this._getBinding(action.root, track);
      if (track.valueSize > maxValueSize) maxValueSize = track.valueSize;
    }

    action._bindings = bindings;
    action._trackCache = new Int32Array(n);
    action._clipVersion = clip !== null ? clip.version : 0;
    if (maxValueSize > this._scratch.length) this._scratch = new Float32Array(maxValueSize);
  }

  /**
   * Returns the cached binding for a track path, resolving it on first use.
   * Unresolvable paths are cached as `null` so the lookup is never retried.
   * @private
   * @param {Object} root
   * @param {import('./KeyframeTrack.js').KeyframeTrack} track
   * @returns {PropertyBinding|null}
   */
  _getBinding(root, track) {
    if (root === null || root === undefined) return null;

    let map = this._bindingsByRoot.get(root);
    if (map === undefined) {
      map = new Map();
      this._bindingsByRoot.set(root, map);
    }

    const path = track.targetPath;
    if (map.has(path)) {
      const cached = map.get(path);
      if (cached !== null && cached !== undefined && track.valueSize < cached.valueSize) {
        // A narrower track shares this property: never write past its data.
        cached.valueSize = track.valueSize;
      }
      return cached;
    }

    const binding = this._createBinding(root, track);
    map.set(path, binding);
    return binding;
  }

  /**
   * Parses a track path and builds the binding.
   * @private
   * @param {Object} root
   * @param {import('./KeyframeTrack.js').KeyframeTrack} track
   * @returns {PropertyBinding|null}
   */
  _createBinding(root, track) {
    const path = track.targetPath;
    if (typeof path !== 'string' || path.length === 0) return null;

    const parts = path.split('.');

    // Node names may themselves contain dots: grow the name until a node
    // matches, always leaving at least one part for the property.
    let nodeName = parts[0];
    let cursor = 1;
    let node = this._findNode(root, nodeName);
    while (node === null && cursor < parts.length - 1) {
      nodeName += '.' + parts[cursor];
      cursor++;
      node = this._findNode(root, nodeName);
    }

    if (node === null) {
      Logger.warnOnce('anim-node-' + path, 'AnimationMixer: no node named "' + parts[0] + '" for track "' + path + '".');
      return null;
    }
    if (cursor >= parts.length) {
      Logger.warnOnce('anim-prop-' + path, 'AnimationMixer: track "' + path + '" has no property.');
      return null;
    }

    // Walk the intermediate objects (".material.opacity", "material[1].opacity").
    let owner = node;
    for (let i = cursor; i < parts.length - 1; i++) {
      parseToken(parts[i]);
      let next = owner[_tokenName];
      if (_tokenIndex >= 0 || _tokenKey.length > 0) next = indexInto(next, _tokenIndex, _tokenKey);
      if (next === null || next === undefined || typeof next !== 'object') {
        Logger.warnOnce('anim-path-' + path, 'AnimationMixer: cannot resolve "' + parts[i] + '" in track "' + path + '".');
        return null;
      }
      owner = next;
    }

    parseToken(parts[parts.length - 1]);
    const elementIndex = _tokenIndex;
    const elementKey = _tokenKey;
    let property = _tokenName;

    if (owner === node) {
      const alias = PROPERTY_ALIASES[property];
      if (alias !== undefined && alias !== property) {
        const current = owner[property];
        if (current === undefined || current === null) {
          property = alias;
        } else if (track.isQuaternion) {
          // glTF calls the rotation channel "rotation"; never let a quaternion
          // track bind to an Euler-like property when a quaternion exists.
          const aliased = owner[alias];
          if (aliased !== undefined && aliased !== null && aliased.w !== undefined) property = alias;
        }
      }
    }

    let value = owner[property];

    // Morph weights have no dedicated storage yet: create the array so glTF
    // morph tracks bind and keep their weights available to user code.
    if ((value === null || value === undefined) && property === 'morphTargetInfluences') {
      value = new Float32Array(track.valueSize > 0 ? track.valueSize : 1);
      owner[property] = value;
    }

    if (value === null || value === undefined) {
      Logger.warnOnce('anim-miss-' + path, 'AnimationMixer: property "' + property + '" not found for track "' + path + '".');
      return null;
    }

    const affectsTransform = owner === node &&
      (property === 'position' || property === 'quaternion' || property === 'scale');

    let kind = -1;
    let target = owner;
    let valueSize = track.valueSize;
    let index = -1;
    let isQuaternion = false;

    if (typeof value === 'number') {
      if (elementIndex >= 0 || elementKey.length > 0) {
        Logger.warnOnce('anim-index-' + path, 'AnimationMixer: track "' + path + '" indexes a scalar property.');
        return null;
      }
      kind = BindingType.NUMBER;
      valueSize = 1;
    } else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      target = value;
      if (elementIndex >= 0) {
        if (elementIndex >= value.length) {
          Logger.warnOnce('anim-range-' + path, 'AnimationMixer: index out of range in track "' + path + '".');
          return null;
        }
        kind = BindingType.ARRAY_ELEMENT;
        index = elementIndex;
        valueSize = 1;
      } else {
        kind = BindingType.ARRAY;
        if (valueSize > value.length) valueSize = value.length;
      }
    } else if (typeof value === 'object') {
      if (elementIndex >= 0 || elementKey.length > 0) {
        const element = indexInto(value, elementIndex, elementKey);
        if (element === null || element === undefined || typeof element !== 'object') {
          Logger.warnOnce('anim-index-' + path, 'AnimationMixer: cannot index "' + property + '" in track "' + path + '".');
          return null;
        }
        value = element;
      }
      target = value;
      if (value.w !== undefined && value.x !== undefined) {
        kind = BindingType.VEC4;
        valueSize = 4;
        isQuaternion = track.isQuaternion || property === 'quaternion' || property === 'rotation';
      } else if (value.z !== undefined && value.x !== undefined) {
        kind = BindingType.VEC3;
        valueSize = 3;
      } else if (value.b !== undefined && value.r !== undefined) {
        kind = BindingType.COLOR;
        valueSize = 3;
      } else if (value.y !== undefined && value.x !== undefined) {
        kind = BindingType.VEC2;
        valueSize = 2;
      } else {
        Logger.warnOnce('anim-kind-' + path, 'AnimationMixer: unsupported property type for track "' + path + '".');
        return null;
      }
    } else {
      Logger.warnOnce('anim-kind-' + path, 'AnimationMixer: unsupported property type for track "' + path + '".');
      return null;
    }

    if (track.valueSize < valueSize) valueSize = track.valueSize;
    if (valueSize <= 0) return null;

    // A rotation track stored in a plain 4 element array still needs slerp.
    if (track.isQuaternion && kind === BindingType.ARRAY && valueSize === 4) isQuaternion = true;

    // Refuse to blend a rotation into anything that is not 4 components: the
    // component wise lerp would produce a non rotation.
    if (track.isQuaternion && !isQuaternion) {
      Logger.warnOnce(
        'anim-quat-' + path,
        'AnimationMixer: rotation track "' + path + '" resolved to a non quaternion property; ignored.'
      );
      return null;
    }

    return new PropertyBinding(
      path,
      node,
      target,
      kind,
      property,
      index,
      valueSize,
      isQuaternion,
      affectsTransform
    );
  }

  /**
   * Finds a node by name below `root` (the root itself matches too).
   * @private
   * @param {Object} root
   * @param {string} name
   * @returns {Object|null}
   */
  _findNode(root, name) {
    if (name === '') return root;
    if (root.name === name) return root;
    if (typeof root.getObjectByName === 'function') {
      const node = root.getObjectByName(name);
      if (node !== null && node !== undefined) return node;
    }
    const skeleton = root.skeleton;
    if (skeleton !== null && skeleton !== undefined) {
      const bones = skeleton.bones;
      if (bones !== null && bones !== undefined) {
        for (let i = 0, n = bones.length; i < n; i++) {
          const bone = bones[i];
          if (bone !== null && bone !== undefined && bone.name === name) return bone;
        }
      }
    }
    return null;
  }
}

