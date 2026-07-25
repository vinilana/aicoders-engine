import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { Mat4 } from '../math/Mat4.js';

/**
 * Shared traversal stacks. They live at module scope and are reused by every
 * traversal so that walking the graph never allocates. Nested traversals are
 * supported through a shared stack pointer that each call saves and restores.
 */
const _stack = [];
const _flagStack = [];
let _sp = 0;

const _m1 = new Mat4();
const _v1 = new Vec3();
const _v2 = new Vec3();
const _q1 = new Quat();
const _lookTarget = new Vec3();
const _axis = new Vec3();

/**
 * Base node of the scene graph.
 *
 * Transform model: `position`, `quaternion` and `scale` are the source of truth
 * and may be mutated freely. `Scene.updateMatrices()` (or `updateWorldMatrix()`)
 * recomposes `localMatrix` when the transform actually changed and multiplies it
 * by the parent world matrix, iteratively, once per frame. Nodes flagged with
 * `matrixAutoUpdate = false` are treated as static and are skipped until
 * `updateMatrix()` is called manually.
 */
export class Node3D {
  /** @type {number} Monotonic id source. */
  static _nextId = 1;

  id = 0;
  name = '';
  /** @type {Node3D|null} */
  parent = null;
  /** @type {Node3D[]} */
  children = [];

  position = new Vec3(0, 0, 0);
  quaternion = new Quat();
  scale = new Vec3(1, 1, 1);

  localMatrix = new Mat4();
  worldMatrix = new Mat4();

  visible = true;
  /** @type {number} 32 bit layer mask. */
  layers = 1;
  castShadow = false;
  receiveShadow = true;
  frustumCulled = true;
  renderOrder = 0;
  matrixAutoUpdate = true;
  matrixWorldNeedsUpdate = true;

  /**
   * Incremented every time `worldMatrix` is recomputed. Consumers (bounds,
   * broadphase proxies, skinning) compare it against their own cached value to
   * know whether they must refresh.
   * @type {number}
   */
  worldMatrixVersion = 0;

  isMesh = false;
  isLight = false;
  isCamera = false;
  isSkinnedMesh = false;
  isInstancedMesh = false;
  isScene = false;
  isLOD = false;

  /** @type {Object} Free-form user storage. */
  userData = {};

  /** @type {Function|null} Called by the renderer right before drawing. */
  onBeforeRender = null;
  /** @type {Function|null} Called by the renderer right after drawing. */
  onAfterRender = null;

  /** @private Index inside the owning Scene flat list (meshes or lights). */
  _listIndex = -1;

  /** @private Cached local transform used for change detection. */
  _lpx = NaN;
  _lpy = NaN;
  _lpz = NaN;
  _lqx = NaN;
  _lqy = NaN;
  _lqz = NaN;
  _lqw = NaN;
  _lsx = NaN;
  _lsy = NaN;
  _lsz = NaN;

  /**
   * @param {string} [name] Optional node name.
   */
  constructor(name = '') {
    this.id = Node3D._nextId++;
    this.name = name;
  }

  /* ------------------------------------------------------------------ */
  /* Hierarchy                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Adds one or more children, detaching them from their previous parent.
   * @param {...Node3D} children
   * @returns {Node3D} this
   */
  add(...children) {
    for (let i = 0, n = children.length; i < n; i++) {
      const child = children[i];
      if (child === null || child === undefined || child === this) continue;
      if (child.parent !== null) child.parent.remove(child);
      child.parent = this;
      child.matrixWorldNeedsUpdate = true;
      this.children.push(child);
      const scene = this._findScene();
      if (scene !== null) scene._onNodeAdded(child);
    }
    return this;
  }

  /**
   * Removes a direct child.
   * @param {Node3D} child
   * @returns {Node3D} this
   */
  remove(child) {
    if (child === null || child === undefined) return this;
    const children = this.children;
    const index = children.indexOf(child);
    if (index === -1) return this;
    const scene = this._findScene();
    if (scene !== null) scene._onNodeRemoved(child);
    children.splice(index, 1);
    child.parent = null;
    child.matrixWorldNeedsUpdate = true;
    return this;
  }

  /**
   * Detaches this node from its parent, if any.
   * @returns {Node3D} this
   */
  removeFromParent() {
    if (this.parent !== null) this.parent.remove(this);
    return this;
  }

  /**
   * Removes every direct child.
   * @returns {Node3D} this
   */
  clear() {
    const children = this.children;
    for (let i = children.length - 1; i >= 0; i--) this.remove(children[i]);
    return this;
  }

  /**
   * Walks up the parent chain looking for the owning Scene.
   * @private
   * @returns {Node3D|null}
   */
  _findScene() {
    let node = this;
    while (node !== null) {
      if (node.isScene === true) return node;
      node = node.parent;
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Traversal                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Iterative depth first traversal (this node included).
   * @param {(node: Node3D) => void} cb
   * @returns {Node3D} this
   */
  traverse(cb) {
    const base = _sp;
    _stack[_sp++] = this;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      cb(node);
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) _stack[_sp++] = children[i];
    }
    return this;
  }

  /**
   * Iterative traversal that prunes invisible sub trees.
   * @param {(node: Node3D) => void} cb
   * @returns {Node3D} this
   */
  traverseVisible(cb) {
    if (this.visible === false) return this;
    const base = _sp;
    _stack[_sp++] = this;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      cb(node);
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) {
        const child = children[i];
        if (child.visible === true) _stack[_sp++] = child;
      }
    }
    return this;
  }

  /**
   * Iterative traversal of every ancestor, closest first.
   * @param {(node: Node3D) => void} cb
   * @returns {Node3D} this
   */
  traverseAncestors(cb) {
    let node = this.parent;
    while (node !== null) {
      cb(node);
      node = node.parent;
    }
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Matrices                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Recomposes `localMatrix` from position/quaternion/scale and flags the
   * world matrix (and the whole sub tree) as dirty. Call it manually after
   * moving a node whose `matrixAutoUpdate` is false.
   * @returns {Node3D} this
   */
  updateMatrix() {
    const p = this.position;
    const q = this.quaternion;
    const s = this.scale;
    this.localMatrix.compose(p, q, s);
    this._lpx = p.x; this._lpy = p.y; this._lpz = p.z;
    this._lqx = q.x; this._lqy = q.y; this._lqz = q.z; this._lqw = q.w;
    this._lsx = s.x; this._lsy = s.y; this._lsz = s.z;
    this.matrixWorldNeedsUpdate = true;
    return this;
  }

  /**
   * Recomposes `localMatrix` only when the transform actually changed.
   * @private
   * @returns {boolean} True when the local matrix was rebuilt.
   */
  _syncLocalMatrix() {
    const p = this.position;
    const q = this.quaternion;
    const s = this.scale;
    if (this._lpx === p.x && this._lpy === p.y && this._lpz === p.z &&
      this._lqx === q.x && this._lqy === q.y && this._lqz === q.z && this._lqw === q.w &&
      this._lsx === s.x && this._lsy === s.y && this._lsz === s.z) {
      return false;
    }
    this.localMatrix.compose(p, q, s);
    this._lpx = p.x; this._lpy = p.y; this._lpz = p.z;
    this._lqx = q.x; this._lqy = q.y; this._lqz = q.z; this._lqw = q.w;
    this._lsx = s.x; this._lsy = s.y; this._lsz = s.z;
    this.matrixWorldNeedsUpdate = true;
    return true;
  }

  /**
   * Single node transform step shared by `updateWorldMatrix` and
   * `Scene.updateMatrices`.
   * @private
   * @param {number} parentChanged 1 when the parent world matrix was rebuilt.
   * @returns {number} 1 when this world matrix was rebuilt, 0 otherwise.
   */
  _updateTransformStep(parentChanged) {
    if (this.matrixAutoUpdate === true) this._syncLocalMatrix();
    if (parentChanged === 1 || this.matrixWorldNeedsUpdate === true) {
      const parent = this.parent;
      if (parent === null) this.worldMatrix.copy(this.localMatrix);
      else this.worldMatrix.multiplyMatrices(parent.worldMatrix, this.localMatrix);
      this.matrixWorldNeedsUpdate = false;
      this.worldMatrixVersion = (this.worldMatrixVersion + 1) | 0;
      return 1;
    }
    return 0;
  }

  /**
   * Iteratively updates the world matrices of this node and its sub tree.
   * @param {boolean} [force=false] Force a rebuild even when nothing is dirty.
   * @returns {Node3D} this
   */
  updateWorldMatrix(force = false) {
    const base = _sp;
    _stack[_sp] = this;
    _flagStack[_sp] = force === true ? 1 : 0;
    _sp++;
    while (_sp > base) {
      _sp--;
      const node = _stack[_sp];
      const parentChanged = _flagStack[_sp];
      _stack[_sp] = null;
      const changed = node._updateTransformStep(parentChanged);
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) {
        _stack[_sp] = children[i];
        _flagStack[_sp] = changed;
        _sp++;
      }
    }
    return this;
  }

  /**
   * Marks this node and its whole sub tree as needing a world matrix rebuild.
   * @returns {Node3D} this
   */
  invalidateWorldMatrix() {
    const base = _sp;
    _stack[_sp++] = this;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      node.matrixWorldNeedsUpdate = true;
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) _stack[_sp++] = children[i];
    }
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* World space helpers                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getWorldPosition(out) {
    return out.setFromMatrixPosition(this.worldMatrix);
  }

  /**
   * @param {Quat} out
   * @returns {Quat} out
   */
  getWorldQuaternion(out) {
    this.worldMatrix.decompose(_v1, out, _v2);
    return out;
  }

  /**
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getWorldScale(out) {
    this.worldMatrix.decompose(_v1, _q1, out);
    return out;
  }

  /**
   * World space forward vector (-Z, engine convention).
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getWorldDirection(out) {
    const e = this.worldMatrix.elements;
    return out.set(-e[8], -e[9], -e[10]).normalize();
  }

  /**
   * Transforms a point from local space into world space, in place.
   * @param {Vec3} v
   * @returns {Vec3} v
   */
  localToWorld(v) {
    return v.applyMat4(this.worldMatrix);
  }

  /**
   * Transforms a point from world space into local space, in place.
   * @param {Vec3} v
   * @returns {Vec3} v
   */
  worldToLocal(v) {
    _m1.copy(this.worldMatrix).invert();
    return v.applyMat4(_m1);
  }

  /* ------------------------------------------------------------------ */
  /* Transform mutators                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Orients the node so its -Z axis points at the given world space target.
   * @param {number|Vec3} x
   * @param {number} [y]
   * @param {number} [z]
   * @returns {Node3D} this
   */
  lookAt(x, y, z) {
    if (typeof x === 'object' && x !== null) _lookTarget.copy(x);
    else _lookTarget.set(x, y, z);
    const parent = this.parent;
    if (parent !== null) {
      _m1.copy(parent.worldMatrix).invert();
      _lookTarget.applyMat4(_m1);
    }
    _m1.lookAt(this.position, _lookTarget, Vec3.UP);
    this.quaternion.setFromRotationMatrix(_m1);
    return this;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {Node3D} this
   */
  setPosition(x, y, z) {
    this.position.set(x, y, z);
    return this;
  }

  /**
   * @param {number} x
   * @param {number} [y=x]
   * @param {number} [z=x]
   * @returns {Node3D} this
   */
  setScale(x, y = x, z = x) {
    this.scale.set(x, y, z);
    return this;
  }

  /**
   * @param {import('../math/Euler.js').Euler} e
   * @returns {Node3D} this
   */
  setRotationFromEuler(e) {
    this.quaternion.setFromEuler(e);
    return this;
  }

  /**
   * @param {Vec3} axis Normalized axis in local space.
   * @param {number} angle Radians.
   * @returns {Node3D} this
   */
  setRotationFromAxisAngle(axis, angle) {
    this.quaternion.setFromAxisAngle(axis, angle);
    return this;
  }

  /**
   * Rotates around an axis expressed in local space.
   * @param {Vec3} axis Normalized axis.
   * @param {number} angle Radians.
   * @returns {Node3D} this
   */
  rotateOnAxis(axis, angle) {
    _q1.setFromAxisAngle(axis, angle);
    this.quaternion.multiply(_q1);
    return this;
  }

  /**
   * Rotates around an axis expressed in world space.
   * @param {Vec3} axis Normalized axis.
   * @param {number} angle Radians.
   * @returns {Node3D} this
   */
  rotateOnWorldAxis(axis, angle) {
    _q1.setFromAxisAngle(axis, angle);
    this.quaternion.premultiply(_q1);
    return this;
  }

  /** @param {number} angle Radians. @returns {Node3D} this */
  rotateX(angle) {
    _axis.set(1, 0, 0);
    return this.rotateOnAxis(_axis, angle);
  }

  /** @param {number} angle Radians. @returns {Node3D} this */
  rotateY(angle) {
    _axis.set(0, 1, 0);
    return this.rotateOnAxis(_axis, angle);
  }

  /** @param {number} angle Radians. @returns {Node3D} this */
  rotateZ(angle) {
    _axis.set(0, 0, 1);
    return this.rotateOnAxis(_axis, angle);
  }

  /**
   * Moves along an axis expressed in local space.
   * @param {Vec3} axis Normalized axis.
   * @param {number} distance
   * @returns {Node3D} this
   */
  translateOnAxis(axis, distance) {
    _v1.copy(axis).applyQuat(this.quaternion).multiplyScalar(distance);
    this.position.add(_v1);
    return this;
  }

  /** @param {number} d @returns {Node3D} this */
  translateX(d) {
    _axis.set(1, 0, 0);
    return this.translateOnAxis(_axis, d);
  }

  /** @param {number} d @returns {Node3D} this */
  translateY(d) {
    _axis.set(0, 1, 0);
    return this.translateOnAxis(_axis, d);
  }

  /** @param {number} d @returns {Node3D} this */
  translateZ(d) {
    _axis.set(0, 0, 1);
    return this.translateOnAxis(_axis, d);
  }

  /* ------------------------------------------------------------------ */
  /* Layers                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Puts the node exclusively on one layer.
   * @param {number} index 0..31
   * @returns {Node3D} this
   */
  setLayer(index) {
    this.layers = (1 << (index | 0)) >>> 0;
    return this;
  }

  /** @param {number} index 0..31 @returns {Node3D} this */
  enableLayer(index) {
    this.layers = (this.layers | (1 << (index | 0))) >>> 0;
    return this;
  }

  /** @param {number} index 0..31 @returns {Node3D} this */
  disableLayer(index) {
    this.layers = (this.layers & ~(1 << (index | 0))) >>> 0;
    return this;
  }

  /**
   * @param {number} mask
   * @returns {boolean} True when the node shares at least one layer bit.
   */
  testLayers(mask) {
    return (this.layers & mask) !== 0;
  }

  /* ------------------------------------------------------------------ */
  /* Lookup                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} name
   * @returns {Node3D|null}
   */
  getObjectByName(name) {
    const base = _sp;
    _stack[_sp++] = this;
    let found = null;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      if (found === null) {
        if (node.name === name) {
          found = node;
          continue;
        }
        const children = node.children;
        for (let i = 0, n = children.length; i < n; i++) _stack[_sp++] = children[i];
      }
    }
    return found;
  }

  /**
   * @param {number} id
   * @returns {Node3D|null}
   */
  getObjectById(id) {
    const base = _sp;
    _stack[_sp++] = this;
    let found = null;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      if (found === null) {
        if (node.id === id) {
          found = node;
          continue;
        }
        const children = node.children;
        for (let i = 0, n = children.length; i < n; i++) _stack[_sp++] = children[i];
      }
    }
    return found;
  }

  /* ------------------------------------------------------------------ */
  /* Lifetime                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Subclass hook: releases resources owned by this single node.
   * @protected
   */
  _disposeSelf() {
    this.onBeforeRender = null;
    this.onAfterRender = null;
  }

  /**
   * Detaches the node and releases the whole sub tree, iteratively.
   * @returns {Node3D} this
   */
  dispose() {
    this.removeFromParent();
    const base = _sp;
    _stack[_sp++] = this;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) {
        const child = children[i];
        child.parent = null;
        _stack[_sp++] = child;
      }
      children.length = 0;
      node._disposeSelf();
    }
    return this;
  }
}
