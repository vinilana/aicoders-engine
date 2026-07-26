import { Node3D } from './Node3D.js';
import { Color } from '../math/Color.js';
import { Vec3 } from '../math/Vec3.js';
import { AABB } from '../math/AABB.js';
import { DynamicBVH } from '../spatial/DynamicBVH.js';

/** Traversal stacks local to this module (reused, never reallocated per call). */
const _stack = [];
const _flagStack = [];
let _sp = 0;

const _displacement = new Vec3();
const _center = new Vec3();

/** Very large finite extent used as the proxy of nodes that opt out of culling. */
const UNBOUNDED = 1e14;

/**
 * Root container of a renderable world.
 *
 * The scene keeps flat lists of meshes / lights / skinned meshes updated
 * incrementally on add and remove (whole sub trees included) and owns the
 * dynamic broadphase used for frustum culling and ray queries.
 */
export class Scene extends Node3D {
  isScene = true;

  /** @type {Color|Object|null} Solid color or cube texture used as background. */
  background = null;
  /** @type {Object|null} IBL environment. */
  environment = null;
  /** @type {{color: Color, density: number, near: number, far: number, mode: string}|null} */
  fog = null;

  ambientLight = new Color(1, 1, 1);
  ambientIntensity = 0.0;

  /** @type {DynamicBVH} */
  bvh = new DynamicBVH();

  /** @type {import('./Mesh.js').Mesh[]} */
  meshes = [];
  /** @type {import('./Light.js').Light[]} */
  lights = [];
  /** @type {import('./SkinnedMesh.js').SkinnedMesh[]} */
  skinnedMeshes = [];

  /** @private Meshes whose world matrix changed during the last updateMatrices. */
  _dirtyMeshes = [];
  /** @private */
  _dirtyCount = 0;
  /** @private Proxy AABB used for nodes with frustumCulled === false. */
  _unboundedAABB = new AABB();

  /**
   * @param {string} [name='Scene']
   */
  constructor(name = 'Scene') {
    super(name);
    this._unboundedAABB.min.set(-UNBOUNDED, -UNBOUNDED, -UNBOUNDED);
    this._unboundedAABB.max.set(UNBOUNDED, UNBOUNDED, UNBOUNDED);
  }

  /* ------------------------------------------------------------------ */
  /* Registration                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Registers a sub tree into the flat lists. Called by `Node3D.add`.
   * @param {Node3D} root
   * @internal
   */
  _onNodeAdded(root) {
    const base = _sp;
    _stack[_sp++] = root;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      if (node.isMesh === true) {
        if (node._listIndex === -1) {
          node._listIndex = this.meshes.length;
          this.meshes.push(node);
        }
        node.matrixWorldNeedsUpdate = true;
        if (node.isSkinnedMesh === true && node._skinIndex === -1) {
          node._skinIndex = this.skinnedMeshes.length;
          this.skinnedMeshes.push(node);
        }
      } else if (node.isLight === true) {
        if (node._listIndex === -1) {
          node._listIndex = this.lights.length;
          this.lights.push(node);
        }
      }
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) _stack[_sp++] = children[i];
    }
  }

  /**
   * Unregisters a sub tree from the flat lists and the broadphase.
   * Called by `Node3D.remove`.
   * @param {Node3D} root
   * @internal
   */
  _onNodeRemoved(root) {
    const base = _sp;
    _stack[_sp++] = root;
    while (_sp > base) {
      const node = _stack[--_sp];
      _stack[_sp] = null;
      if (node.isMesh === true) {
        this._removeFromList(this.meshes, node);
        if (node.isSkinnedMesh === true && node._skinIndex !== -1) {
          const list = this.skinnedMeshes;
          const idx = node._skinIndex;
          const last = list.length - 1;
          if (idx !== last) {
            list[idx] = list[last];
            list[idx]._skinIndex = idx;
          }
          list.pop();
          node._skinIndex = -1;
        }
        if (node._bvhProxy !== -1) {
          this.bvh.remove(node._bvhProxy);
          node._bvhProxy = -1;
        }
      } else if (node.isLight === true) {
        this._removeFromList(this.lights, node);
      }
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) _stack[_sp++] = children[i];
    }
    // Any pending dirty entry may now point at a detached node; entries are
    // validated in updateBVH() so nothing else is needed here.
  }

  /**
   * Swap-remove helper keeping `_listIndex` coherent.
   * @private
   * @param {Node3D[]} list
   * @param {Node3D} node
   */
  _removeFromList(list, node) {
    const idx = node._listIndex;
    if (idx === -1 || list[idx] !== node) return;
    const last = list.length - 1;
    if (idx !== last) {
      list[idx] = list[last];
      list[idx]._listIndex = idx;
    }
    list.pop();
    node._listIndex = -1;
  }

  /* ------------------------------------------------------------------ */
  /* Per frame update                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Single iterative pass over the whole graph: recomposes local matrices that
   * changed, multiplies them by the parent world matrix and records the meshes
   * whose world matrix was rebuilt so `updateBVH()` only touches those.
   * Skinned meshes are refreshed at the end, once every bone is up to date.
   * @returns {Scene} this
   */
  updateMatrices() {
    this._dirtyCount = 0;
    const dirty = this._dirtyMeshes;
    let dirtyCount = 0;

    const base = _sp;
    _stack[_sp] = this;
    _flagStack[_sp] = 0;
    _sp++;
    while (_sp > base) {
      _sp--;
      const node = _stack[_sp];
      const parentChanged = _flagStack[_sp];
      _stack[_sp] = null;
      const changed = node._updateTransformStep(parentChanged);
      // A mesh needs its broad phase proxy refreshed when its world matrix
      // changed *at all* — not only when it changed inside this call.
      //
      // Anyone may legitimately call `updateWorldMatrix(true)` themselves (to
      // read a world position mid frame, say). Doing so clears the dirty flags,
      // so by the time this walk runs the node reports "unchanged" and, if that
      // were the only test, its proxy would keep the bounds it had at spawn.
      // The mesh then vanishes the moment it moves away from where it started,
      // while still casting a shadow — the shadow pass does not consult the
      // broad phase. Comparing versions instead makes the result independent of
      // who updated the matrix.
      if (node.isMesh === true &&
          (changed === 1 ||
           node.worldMatrixVersion !== node._bvhVersion ||
           node._geometryVersion !== node._bvhGeometryVersion)) {
        dirty[dirtyCount++] = node;
      }
      const children = node.children;
      for (let i = 0, n = children.length; i < n; i++) {
        _stack[_sp] = children[i];
        _flagStack[_sp] = changed;
        _sp++;
      }
    }
    this._dirtyCount = dirtyCount;

    const skinned = this.skinnedMeshes;
    for (let i = 0, n = skinned.length; i < n; i++) skinned[i].updateSkeleton();
    return this;
  }

  /**
   * Inserts / refreshes the broadphase proxies of the meshes whose world
   * matrix changed during the last `updateMatrices()` call.
   * @returns {Scene} this
   */
  updateBVH() {
    const bvh = this.bvh;
    const dirty = this._dirtyMeshes;
    for (let i = 0, n = this._dirtyCount; i < n; i++) {
      const mesh = dirty[i];
      dirty[i] = null;
      if (mesh._listIndex === -1) continue;
      mesh.updateWorldBounds();
      if (mesh.geometry === null) continue;
      const aabb = mesh.frustumCulled === true ? mesh.boundingBoxWorld : this._unboundedAABB;
      if (aabb.isEmpty() === true) continue;
      aabb.getCenter(_center);
      if (mesh._bvhProxy === -1) {
        _displacement.set(0, 0, 0);
        mesh._bvhProxy = bvh.insert(aabb, mesh);
      } else {
        _displacement.set(
          _center.x - mesh._prevCenterX,
          _center.y - mesh._prevCenterY,
          _center.z - mesh._prevCenterZ
        );
        bvh.update(mesh._bvhProxy, aabb, _displacement);
      }
      mesh._prevCenterX = _center.x;
      mesh._prevCenterY = _center.y;
      mesh._prevCenterZ = _center.z;
      // Records which world matrix these bounds came from, so the walk above
      // can tell a stale proxy from a current one.
      mesh._bvhVersion = mesh.worldMatrixVersion;
      mesh._bvhGeometryVersion = mesh._geometryVersion;
    }
    this._dirtyCount = 0;
    return this;
  }

  /**
   * Forces a mesh to be re-evaluated by the next `updateBVH()` call. Use it
   * after changing `frustumCulled` or the geometry of a static mesh.
   * @param {import('./Mesh.js').Mesh} mesh
   * @returns {Scene} this
   */
  markMeshDirty(mesh) {
    if (mesh === null || mesh === undefined || mesh.isMesh !== true) return this;
    this._dirtyMeshes[this._dirtyCount++] = mesh;
    return this;
  }

  /**
   * Rebuilds the broadphase from scratch. Useful after loading a large amount
   * of static geometry.
   * @returns {Scene} this
   */
  rebuildBVH() {
    const bvh = this.bvh;
    const meshes = this.meshes;
    for (let i = 0, n = meshes.length; i < n; i++) {
      const mesh = meshes[i];
      if (mesh._bvhProxy !== -1) {
        bvh.remove(mesh._bvhProxy);
        mesh._bvhProxy = -1;
      }
    }
    this._dirtyCount = 0;
    for (let i = 0, n = meshes.length; i < n; i++) this._dirtyMeshes[this._dirtyCount++] = meshes[i];
    this.updateBVH();
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Fog helpers                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Enables linear fog.
   * @param {Color} color
   * @param {number} near
   * @param {number} far
   * @returns {Scene} this
   */
  setFogLinear(color, near, far) {
    if (this.fog === null) this.fog = { color: new Color(1, 1, 1), density: 0, near: 1, far: 100, mode: 'linear' };
    this.fog.color.copy(color);
    this.fog.near = near;
    this.fog.far = far;
    this.fog.mode = 'linear';
    return this;
  }

  /**
   * Enables exponential squared fog.
   * @param {Color} color
   * @param {number} density
   * @returns {Scene} this
   */
  setFogExp2(color, density) {
    if (this.fog === null) this.fog = { color: new Color(1, 1, 1), density: 0, near: 1, far: 100, mode: 'exp2' };
    this.fog.color.copy(color);
    this.fog.density = density;
    this.fog.mode = 'exp2';
    return this;
  }

  /**
   * Disables fog.
   * @returns {Scene} this
   */
  clearFog() {
    this.fog = null;
    return this;
  }

  /**
   * Sets the ambient term.
   * @param {Color} color
   * @param {number} [intensity=1]
   * @returns {Scene} this
   */
  setAmbient(color, intensity = 1) {
    this.ambientLight.copy(color);
    this.ambientIntensity = intensity;
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Lifetime                                                            */
  /* ------------------------------------------------------------------ */

  /** @protected */
  _disposeSelf() {
    super._disposeSelf();
    const meshes = this.meshes;
    for (let i = 0, n = meshes.length; i < n; i++) {
      const mesh = meshes[i];
      if (mesh._bvhProxy !== -1) {
        this.bvh.remove(mesh._bvhProxy);
        mesh._bvhProxy = -1;
      }
      mesh._listIndex = -1;
    }
    const lights = this.lights;
    for (let i = 0, n = lights.length; i < n; i++) lights[i]._listIndex = -1;
    meshes.length = 0;
    lights.length = 0;
    this.skinnedMeshes.length = 0;
    this._dirtyMeshes.length = 0;
    this._dirtyCount = 0;
    this.background = null;
    this.environment = null;
    this.fog = null;
  }
}
