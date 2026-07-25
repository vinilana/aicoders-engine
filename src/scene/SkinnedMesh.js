import { Mesh } from './Mesh.js';
import { Mat4 } from '../math/Mat4.js';

/**
 * Mesh deformed on the GPU by a `Skeleton`.
 *
 * Shader side the skinning matrix is
 * `bindMatrixInverse * boneMatrix[j] * bindMatrix`, with `boneMatrix` coming
 * from the skeleton bone texture.
 */
export class SkinnedMesh extends Mesh {
  isSkinnedMesh = true;

  /** @type {import('./Skeleton.js').Skeleton|null} */
  skeleton = null;

  bindMatrix = new Mat4();
  bindMatrixInverse = new Mat4();

  /** 'attached' follows the mesh world matrix, 'detached' stays on the bind pose. */
  bindMode = 'attached';

  /** Extra world units added to the bounds to compensate for deformation. */
  boundsPadding = 0;

  /** @type {number} Index inside `Scene.skinnedMeshes`. */
  _skinIndex = -1;

  /**
   * @param {import('../render/Geometry.js').Geometry|null} [geometry=null]
   * @param {Object|Object[]|null} [material=null]
   */
  constructor(geometry = null, material = null) {
    super(geometry, material);
    this.name = 'SkinnedMesh';
    this.frustumCulled = true;
  }

  /**
   * Attaches a skeleton. When `bindMatrix` is omitted the current world matrix
   * is used, which is what a freshly loaded model expects.
   * @param {import('./Skeleton.js').Skeleton} skeleton
   * @param {Mat4} [bindMatrix]
   * @returns {SkinnedMesh} this
   */
  bind(skeleton, bindMatrix) {
    this.skeleton = skeleton;
    let matrix = bindMatrix;
    if (matrix === undefined || matrix === null) {
      this.updateWorldMatrix(true);
      matrix = this.worldMatrix;
    }
    this.bindMatrix.copy(matrix);
    this.bindMatrixInverse.copy(matrix).invert();
    return this;
  }

  /**
   * Refreshes the skinning matrices. Called by `Scene.updateMatrices()` once
   * every bone world matrix is up to date.
   * @returns {SkinnedMesh} this
   */
  updateSkeleton() {
    const skeleton = this.skeleton;
    if (skeleton === null) return this;
    skeleton.update();
    if (this.bindMode === 'attached') {
      this.bindMatrixInverse.copy(this.worldMatrix).invert();
    } else {
      this.bindMatrixInverse.copy(this.bindMatrix).invert();
    }
    return this;
  }

  /**
   * Transforms the bind pose bounds into world space and inflates them by
   * `boundsPadding` so animation does not pop out of the culling volume.
   * @param {boolean} [force=false]
   * @returns {SkinnedMesh} this
   */
  updateWorldBounds(force = false) {
    const before = this._boundsVersion;
    super.updateWorldBounds(force);
    if (this.boundsPadding > 0 && (force === true || this._boundsVersion !== before)) {
      this.boundingBoxWorld.expandByScalar(this.boundsPadding);
      this.boundingSphereWorld.radius += this.boundsPadding;
    }
    return this;
  }

  /**
   * Rescales the `aWeights` attribute so every vertex sums to one.
   * @returns {SkinnedMesh} this
   */
  normalizeSkinWeights() {
    const geometry = this.geometry;
    if (geometry === null || typeof geometry.getAttribute !== 'function') return this;
    const attr = geometry.getAttribute('aWeights');
    if (attr === null || attr === undefined || attr.data === undefined) return this;
    const data = attr.data;
    const size = attr.size > 0 ? attr.size : 4;
    const stride = attr.stride > 0 && attr.stride >= size * 4 ? attr.stride >> 2 : size;
    const offset = attr.offset > 0 ? attr.offset >> 2 : 0;
    const count = attr.count > 0 ? attr.count : Math.floor((data.length - offset) / stride);
    for (let i = 0, o = offset; i < count; i++, o += stride) {
      let sum = 0;
      for (let k = 0; k < size; k++) sum += data[o + k];
      if (sum > 0) {
        const inv = 1 / sum;
        for (let k = 0; k < size; k++) data[o + k] *= inv;
      } else {
        data[o] = 1;
        for (let k = 1; k < size; k++) data[o + k] = 0;
      }
    }
    attr.needsUpdate = true;
    if (typeof geometry.markAttributeDirty === 'function') geometry.markAttributeDirty('aWeights');
    return this;
  }

  /** @protected */
  _disposeSelf() {
    super._disposeSelf();
    this.skeleton = null;
    this._skinIndex = -1;
  }
}
