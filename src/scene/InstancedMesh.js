import { Mesh } from './Mesh.js';
import { Mat4 } from '../math/Mat4.js';
import { AABB } from '../math/AABB.js';
import { Sphere } from '../math/Sphere.js';

const _m4 = new Mat4();
const _aabb = new AABB();

/** Float32 components per instance for each stream. */
const MATRIX_COMPONENTS = 16;
const COLOR_COMPONENTS = 4;
const DATA_COMPONENTS = 4;

/**
 * Mesh drawn `count` times in a single draw call.
 *
 * Per instance streams live in plain Float32Arrays owned by this node and are
 * uploaded incrementally: every setter widens a dirty range and `upload()` only
 * pushes that range through `gl.bufferSubData`. The arrays are also published as
 * geometry attributes (`aInstanceMatrix`, `aInstanceColor`, `aInstanceData`) so
 * a renderer that simply calls `geometry.upload()` still gets correct data.
 *
 * Note: the geometry of an InstancedMesh is not shareable with another
 * InstancedMesh, since the instance attributes are stored on it.
 */
export class InstancedMesh extends Mesh {
  isInstancedMesh = true;

  /** @type {number} Number of instances actually drawn. */
  count = 0;
  /** @type {number} Allocated instance slots. */
  capacity = 0;

  /** @type {Float32Array} Column major 4x4 matrix per instance. */
  instanceMatrix = null;
  /** @type {Float32Array|null} RGBA per instance. */
  instanceColor = null;
  /** @type {Float32Array|null} Free-form vec4 per instance. */
  instanceData = null;

  /** Local space bounds of every instance, in mesh space. */
  instanceBoundingBox = new AABB();
  /** Local space bounding sphere of every instance, in mesh space. */
  instanceBoundingSphere = new Sphere();

  /** @private Dirty ranges expressed in instance indices. */
  _matrixDirtyMin = 0;
  /** @private */
  _matrixDirtyMax = -1;
  /** @private */
  _colorDirtyMin = 0;
  /** @private */
  _colorDirtyMax = -1;
  /** @private */
  _dataDirtyMin = 0;
  /** @private */
  _dataDirtyMax = -1;

  /** @private Buffers must be recreated (capacity changed). */
  _reallocate = true;
  /** @private Instance bounds need a rebuild. */
  _boundsDirty = true;

  /**
   * @param {import('../render/Geometry.js').Geometry|null} geometry
   * @param {Object|Object[]|null} material
   * @param {number} [capacity=1] Number of instance slots to allocate.
   * @param {{useColor?: boolean, useData?: boolean, count?: number}} [options={}]
   */
  constructor(geometry, material, capacity = 1, options = {}) {
    super(geometry, material);
    this.name = 'InstancedMesh';
    const cap = capacity > 0 ? capacity | 0 : 1;
    this.capacity = cap;
    this.instanceMatrix = new Float32Array(cap * MATRIX_COMPONENTS);
    for (let i = 0; i < cap; i++) {
      const o = i * MATRIX_COMPONENTS;
      this.instanceMatrix[o] = 1;
      this.instanceMatrix[o + 5] = 1;
      this.instanceMatrix[o + 10] = 1;
      this.instanceMatrix[o + 15] = 1;
    }
    if (options.useColor === true) {
      this.instanceColor = new Float32Array(cap * COLOR_COMPONENTS).fill(1);
      this._colorDirtyMin = 0;
      this._colorDirtyMax = cap - 1;
    }
    if (options.useData === true) {
      this.instanceData = new Float32Array(cap * DATA_COMPONENTS);
      this._dataDirtyMin = 0;
      this._dataDirtyMax = cap - 1;
    }
    this.count = options.count !== undefined ? Math.min(options.count | 0, cap) : cap;
    this._matrixDirtyMin = 0;
    this._matrixDirtyMax = cap - 1;
    this.frustumCulled = true;
  }

  /* ------------------------------------------------------------------ */
  /* Dirty tracking                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * True while any instance stream still has to be uploaded.
   * Setting it to true marks every stream fully dirty.
   * @returns {boolean}
   */
  get needsUpdate() {
    return this._matrixDirtyMax >= this._matrixDirtyMin ||
      this._colorDirtyMax >= this._colorDirtyMin ||
      this._dataDirtyMax >= this._dataDirtyMin;
  }

  /**
   * @param {boolean} value
   */
  set needsUpdate(value) {
    if (value === true) {
      const last = this.capacity - 1;
      this._matrixDirtyMin = 0;
      this._matrixDirtyMax = last;
      if (this.instanceColor !== null) {
        this._colorDirtyMin = 0;
        this._colorDirtyMax = last;
      }
      if (this.instanceData !== null) {
        this._dataDirtyMin = 0;
        this._dataDirtyMax = last;
      }
      this._boundsDirty = true;
    } else {
      this._matrixDirtyMin = 0;
      this._matrixDirtyMax = -1;
      this._colorDirtyMin = 0;
      this._colorDirtyMax = -1;
      this._dataDirtyMin = 0;
      this._dataDirtyMax = -1;
    }
  }

  /**
   * Flags the matching geometry attribute so a renderer that only calls
   * `geometry.upload()` still refreshes the data. Called once per frame at
   * most, when a dirty range opens.
   * @private
   * @param {string} name
   */
  _flagAttribute(name) {
    const geometry = this.geometry;
    if (geometry === null || typeof geometry.getAttribute !== 'function') return;
    const attr = geometry.getAttribute(name);
    if (attr === null || attr === undefined) return;
    attr.needsUpdate = true;
    if (typeof geometry.markAttributeDirty === 'function') geometry.markAttributeDirty(name);
  }

  /**
   * @private
   * @param {number} index
   */
  _markMatrixDirty(index) {
    if (this._matrixDirtyMax < this._matrixDirtyMin) {
      this._matrixDirtyMin = index;
      this._matrixDirtyMax = index;
      this._flagAttribute('aInstanceMatrix');
    } else {
      if (index < this._matrixDirtyMin) this._matrixDirtyMin = index;
      if (index > this._matrixDirtyMax) this._matrixDirtyMax = index;
    }
    this._boundsDirty = true;
    // Force the scene to refresh the broadphase proxy next frame.
    this.matrixWorldNeedsUpdate = true;
  }

  /**
   * @private
   * @param {number} index
   */
  _markColorDirty(index) {
    if (this._colorDirtyMax < this._colorDirtyMin) {
      this._colorDirtyMin = index;
      this._colorDirtyMax = index;
      this._flagAttribute('aInstanceColor');
    } else {
      if (index < this._colorDirtyMin) this._colorDirtyMin = index;
      if (index > this._colorDirtyMax) this._colorDirtyMax = index;
    }
  }

  /**
   * @private
   * @param {number} index
   */
  _markDataDirty(index) {
    if (this._dataDirtyMax < this._dataDirtyMin) {
      this._dataDirtyMin = index;
      this._dataDirtyMax = index;
      this._flagAttribute('aInstanceData');
    } else {
      if (index < this._dataDirtyMin) this._dataDirtyMin = index;
      if (index > this._dataDirtyMax) this._dataDirtyMax = index;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per instance accessors                                              */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} index
   * @param {Mat4} matrix
   * @returns {InstancedMesh} this
   */
  setMatrixAt(index, matrix) {
    if (index < 0 || index >= this.capacity) return this;
    matrix.toArray(this.instanceMatrix, index * MATRIX_COMPONENTS);
    this._markMatrixDirty(index);
    return this;
  }

  /**
   * @param {number} index
   * @param {Mat4} matrix Receives the instance transform.
   * @returns {Mat4} matrix
   */
  getMatrixAt(index, matrix) {
    return matrix.fromArray(this.instanceMatrix, index * MATRIX_COMPONENTS);
  }

  /**
   * Composes position / rotation / scale straight into the instance buffer,
   * without going through a temporary matrix.
   * @param {number} index
   * @param {import('../math/Vec3.js').Vec3} position
   * @param {import('../math/Quat.js').Quat} quaternion
   * @param {import('../math/Vec3.js').Vec3} scale
   * @returns {InstancedMesh} this
   */
  setTransformAt(index, position, quaternion, scale) {
    if (index < 0 || index >= this.capacity) return this;
    const a = this.instanceMatrix;
    const o = index * MATRIX_COMPONENTS;

    const x = quaternion.x;
    const y = quaternion.y;
    const z = quaternion.z;
    const w = quaternion.w;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const sx = scale.x;
    const sy = scale.y;
    const sz = scale.z;

    a[o] = (1 - (yy + zz)) * sx;
    a[o + 1] = (xy + wz) * sx;
    a[o + 2] = (xz - wy) * sx;
    a[o + 3] = 0;
    a[o + 4] = (xy - wz) * sy;
    a[o + 5] = (1 - (xx + zz)) * sy;
    a[o + 6] = (yz + wx) * sy;
    a[o + 7] = 0;
    a[o + 8] = (xz + wy) * sz;
    a[o + 9] = (yz - wx) * sz;
    a[o + 10] = (1 - (xx + yy)) * sz;
    a[o + 11] = 0;
    a[o + 12] = position.x;
    a[o + 13] = position.y;
    a[o + 14] = position.z;
    a[o + 15] = 1;

    this._markMatrixDirty(index);
    return this;
  }

  /**
   * @param {number} index
   * @param {import('../math/Color.js').Color} color
   * @param {number} [alpha=1]
   * @returns {InstancedMesh} this
   */
  setColorAt(index, color, alpha = 1) {
    if (index < 0 || index >= this.capacity) return this;
    if (this.instanceColor === null) this.enableInstanceColor();
    const o = index * COLOR_COMPONENTS;
    const a = this.instanceColor;
    a[o] = color.r;
    a[o + 1] = color.g;
    a[o + 2] = color.b;
    a[o + 3] = alpha;
    this._markColorDirty(index);
    return this;
  }

  /**
   * @param {number} index
   * @param {import('../math/Color.js').Color} out Receives the instance color.
   * @returns {import('../math/Color.js').Color} out
   */
  getColorAt(index, out) {
    if (this.instanceColor === null) return out;
    const o = index * COLOR_COMPONENTS;
    const a = this.instanceColor;
    out.r = a[o];
    out.g = a[o + 1];
    out.b = a[o + 2];
    return out;
  }

  /**
   * @param {number} index
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} w
   * @returns {InstancedMesh} this
   */
  setDataAt(index, x, y, z, w) {
    if (index < 0 || index >= this.capacity) return this;
    if (this.instanceData === null) this.enableInstanceData();
    const o = index * DATA_COMPONENTS;
    const a = this.instanceData;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = w;
    this._markDataDirty(index);
    return this;
  }

  /**
   * Allocates the per instance color stream.
   * @returns {InstancedMesh} this
   */
  enableInstanceColor() {
    if (this.instanceColor !== null) return this;
    this.instanceColor = new Float32Array(this.capacity * COLOR_COMPONENTS).fill(1);
    this._colorDirtyMin = 0;
    this._colorDirtyMax = this.capacity - 1;
    this._reallocate = true;
    return this;
  }

  /**
   * Allocates the free-form per instance vec4 stream.
   * @returns {InstancedMesh} this
   */
  enableInstanceData() {
    if (this.instanceData !== null) return this;
    this.instanceData = new Float32Array(this.capacity * DATA_COMPONENTS);
    this._dataDirtyMin = 0;
    this._dataDirtyMax = this.capacity - 1;
    this._reallocate = true;
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Capacity                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Sets how many instances are drawn, growing the storage when needed.
   * @param {number} n
   * @returns {InstancedMesh} this
   */
  setCount(n) {
    let value = n | 0;
    if (value < 0) value = 0;
    if (value > this.capacity) this.grow(value);
    this.count = value;
    const geometry = this.geometry;
    if (geometry !== null) geometry.instanceCount = value;
    this._boundsDirty = true;
    this.matrixWorldNeedsUpdate = true;
    return this;
  }

  /**
   * Grows the instance storage, preserving existing data. The capacity at least
   * doubles so repeated growth stays amortized.
   * @param {number} newCapacity
   * @returns {InstancedMesh} this
   */
  grow(newCapacity) {
    let cap = newCapacity | 0;
    if (cap <= this.capacity) return this;
    const doubled = this.capacity * 2;
    if (doubled > cap) cap = doubled;

    const matrices = new Float32Array(cap * MATRIX_COMPONENTS);
    matrices.set(this.instanceMatrix);
    for (let i = this.capacity; i < cap; i++) {
      const o = i * MATRIX_COMPONENTS;
      matrices[o] = 1;
      matrices[o + 5] = 1;
      matrices[o + 10] = 1;
      matrices[o + 15] = 1;
    }
    this.instanceMatrix = matrices;

    if (this.instanceColor !== null) {
      const colors = new Float32Array(cap * COLOR_COMPONENTS).fill(1);
      colors.set(this.instanceColor);
      this.instanceColor = colors;
    }
    if (this.instanceData !== null) {
      const data = new Float32Array(cap * DATA_COMPONENTS);
      data.set(this.instanceData);
      this.instanceData = data;
    }

    this.capacity = cap;
    this._reallocate = true;
    this.needsUpdate = true;
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Bounds                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuilds the union of every instance bounding box, in mesh local space.
   * @returns {InstancedMesh} this
   */
  computeBounds() {
    this._boundsDirty = false;
    const geometry = this.geometry;
    this.instanceBoundingBox.makeEmpty();
    if (geometry === null) return this;
    if (geometry.boundingBox === null || geometry.boundingBox === undefined) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box === null || box === undefined) return this;
    const matrices = this.instanceMatrix;
    for (let i = 0, n = this.count; i < n; i++) {
      _m4.fromArray(matrices, i * MATRIX_COMPONENTS);
      _aabb.copy(box).applyMat4(_m4);
      this.instanceBoundingBox.expandByAABB(_aabb);
    }
    if (this.instanceBoundingBox.isEmpty() === false) {
      this.instanceBoundingBox.getBoundingSphere(this.instanceBoundingSphere);
    } else {
      this.instanceBoundingSphere.radius = 0;
    }
    return this;
  }

  /**
   * Transforms the instance bounds into world space.
   * @param {boolean} [force=false]
   * @returns {InstancedMesh} this
   */
  updateWorldBounds(force = false) {
    const geometry = this.geometry;
    if (geometry === null) return this;
    const rebuilt = this._boundsDirty;
    if (rebuilt === true) this.computeBounds();
    if (force === false && rebuilt === false && this._boundsVersion === this.worldMatrixVersion) return this;
    this._boundsVersion = this.worldMatrixVersion;
    if (this.instanceBoundingBox.isEmpty() === true) {
      this.boundingBoxWorld.makeEmpty();
      this.boundingSphereWorld.radius = 0;
      return this;
    }
    this.boundingBoxWorld.copy(this.instanceBoundingBox).applyMat4(this.worldMatrix);
    this.boundingBoxWorld.getBoundingSphere(this.boundingSphereWorld);
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* GPU upload                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Publishes the instance streams as geometry attributes with divisor 1.
   * @private
   */
  _ensureAttributes() {
    const geometry = this.geometry;
    if (geometry === null || typeof geometry.setAttribute !== 'function') return;
    if (this._reallocate === true || geometry.hasAttribute('aInstanceMatrix') === false) {
      geometry.setAttribute('aInstanceMatrix', this.instanceMatrix, MATRIX_COMPONENTS, {
        divisor: 1,
        dynamic: true,
        normalized: false
      });
      this._flagAttribute('aInstanceMatrix');
      if (this.instanceColor !== null) {
        geometry.setAttribute('aInstanceColor', this.instanceColor, COLOR_COMPONENTS, {
          divisor: 1,
          dynamic: true,
          normalized: false
        });
        this._flagAttribute('aInstanceColor');
      }
      if (this.instanceData !== null) {
        geometry.setAttribute('aInstanceData', this.instanceData, DATA_COMPONENTS, {
          divisor: 1,
          dynamic: true,
          normalized: false
        });
        this._flagAttribute('aInstanceData');
      }
      this._reallocate = false;
    }
    geometry.instanceCount = this.count;
  }

  /**
   * Uploads only the dirty instance ranges.
   * @private
   * @param {string} name Attribute name.
   * @param {Float32Array} array
   * @param {number} components Float32 components per instance.
   * @param {number} min First dirty instance.
   * @param {number} max Last dirty instance.
   */
  _uploadRange(name, array, components, min, max) {
    const geometry = this.geometry;
    if (max < min) return;
    const attr = geometry.getAttribute(name);
    if (attr === null || attr === undefined) return;
    attr.data = array;
    const buffer = attr.buffer;
    if (buffer !== null && buffer !== undefined && typeof buffer.setSubData === 'function' &&
      buffer.byteLength >= array.byteLength) {
      const start = min * components;
      const length = (max - min + 1) * components;
      buffer.setSubData(array, start * 4, start, length);
      attr.needsUpdate = false;
    } else {
      attr.needsUpdate = true;
      if (typeof geometry.markAttributeDirty === 'function') geometry.markAttributeDirty(name);
    }
  }

  /**
   * Pushes the dirty instance ranges to the GPU. Safe to call every frame: it
   * is a no-op when nothing changed.
   * @param {WebGL2RenderingContext} gl
   * @param {Object} state StateCache.
   * @returns {InstancedMesh} this
   */
  upload(gl, state) {
    const geometry = this.geometry;
    if (geometry === null) return this;
    this._ensureAttributes();

    const matrixAttr = geometry.getAttribute('aInstanceMatrix');
    const hasBuffers = matrixAttr !== null && matrixAttr !== undefined &&
      matrixAttr.buffer !== null && matrixAttr.buffer !== undefined;
    if (hasBuffers === false) {
      // First upload: let the geometry allocate the backing GL buffers with the
      // full data, then start tracking incremental ranges from the next frame.
      if (typeof geometry.upload === 'function') geometry.upload(gl, state);
      this._matrixDirtyMin = 0;
      this._matrixDirtyMax = -1;
      this._colorDirtyMin = 0;
      this._colorDirtyMax = -1;
      this._dataDirtyMin = 0;
      this._dataDirtyMax = -1;
      return this;
    }

    this._uploadRange('aInstanceMatrix', this.instanceMatrix, MATRIX_COMPONENTS, this._matrixDirtyMin, this._matrixDirtyMax);
    this._matrixDirtyMin = 0;
    this._matrixDirtyMax = -1;
    if (this.instanceColor !== null) {
      this._uploadRange('aInstanceColor', this.instanceColor, COLOR_COMPONENTS, this._colorDirtyMin, this._colorDirtyMax);
      this._colorDirtyMin = 0;
      this._colorDirtyMax = -1;
    }
    if (this.instanceData !== null) {
      this._uploadRange('aInstanceData', this.instanceData, DATA_COMPONENTS, this._dataDirtyMin, this._dataDirtyMax);
      this._dataDirtyMin = 0;
      this._dataDirtyMax = -1;
    }
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Picking                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Tests every instance against the ray.
   * @param {Object} raycaster
   * @param {Array} intersects
   * @returns {Array} intersects
   */
  raycast(raycaster, intersects) {
    if (this.geometry === null || this.visible === false) return intersects;
    const layers = raycaster.layers;
    if (typeof layers === 'number' && (layers & this.layers) === 0) return intersects;
    const matrices = this.instanceMatrix;
    for (let i = 0, n = this.count; i < n; i++) {
      _m4.fromArray(matrices, i * MATRIX_COMPONENTS);
      _m4.premultiply(this.worldMatrix);
      this._raycastMatrix(raycaster, intersects, _m4, i);
    }
    return intersects;
  }

  /** @protected */
  _disposeSelf() {
    super._disposeSelf();
    this.instanceMatrix = null;
    this.instanceColor = null;
    this.instanceData = null;
    this.count = 0;
    this.capacity = 0;
  }
}
