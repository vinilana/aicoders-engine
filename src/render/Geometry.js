/**
 * Geometry: CPU-side vertex data plus its GPU mirror (buffers + VAO).
 *
 * Design notes
 *  - Attribute locations are FIXED engine wide (see ATTRIB), so one VAO per
 *    geometry works with every program and can be bound once for many draws.
 *  - Uploads are lazy: nothing touches the GPU until `upload()`/`getVAO()` runs,
 *    and only attributes flagged `needsUpdate` are re-sent. Partial updates use
 *    `bufferSubData` over the dirty vertex range.
 *  - Interleaved layouts are first class: several attributes may share a single
 *    typed array/buffer with a stride, which is the fastest layout on the GPU.
 */

import { AABB } from '../math/AABB.js';
import { Sphere } from '../math/Sphere.js';
import { GLBuffer } from './Buffer.js';
import { VertexArray } from './VertexArray.js';
import { Logger } from '../core/Logger.js';

/** Fixed vertex attribute locations shared by every shader in the engine. */
export const ATTRIB = {
  POSITION: 0,
  NORMAL: 1,
  UV0: 2,
  TANGENT: 3,
  COLOR: 4,
  UV1: 5,
  JOINTS: 6,
  WEIGHTS: 7,
  INSTANCE_MATRIX: 8,
  INSTANCE_COLOR: 12,
  INSTANCE_DATA: 13
};

/** Canonical attribute name -> location. */
export const ATTRIB_NAME_TO_LOC = {
  aPosition: 0,
  aNormal: 1,
  aUV0: 2,
  aTangent: 3,
  aColor: 4,
  aUV1: 5,
  aJoints: 6,
  aWeights: 7,
  aInstanceMatrix: 8,
  aInstanceColor: 12,
  aInstanceData: 13
};

/** GL component types, usable without a live context. */
export const GL_TYPE = {
  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b
};

/** Draw mode name -> GL primitive enum. */
export const DRAW_MODES = {
  points: 0x0000,
  lines: 0x0001,
  'line-loop': 0x0002,
  'line-strip': 0x0003,
  triangles: 0x0004,
  'triangle-strip': 0x0005,
  'triangle-fan': 0x0006
};

let _nextGeometryId = 1;

/**
 * Byte size of a GL component type.
 * @param {number} type
 * @returns {number}
 */
export function glTypeBytes(type) {
  switch (type) {
    case GL_TYPE.BYTE:
    case GL_TYPE.UNSIGNED_BYTE:
      return 1;
    case GL_TYPE.SHORT:
    case GL_TYPE.UNSIGNED_SHORT:
    case GL_TYPE.HALF_FLOAT:
      return 2;
    default:
      return 4;
  }
}

/**
 * Infers the GL component type from a typed array constructor.
 * @param {ArrayBufferView} array
 * @returns {number}
 */
export function glTypeFromArray(array) {
  if (array instanceof Float32Array) return GL_TYPE.FLOAT;
  if (array instanceof Uint16Array) return GL_TYPE.UNSIGNED_SHORT;
  if (array instanceof Uint32Array) return GL_TYPE.UNSIGNED_INT;
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) return GL_TYPE.UNSIGNED_BYTE;
  if (array instanceof Int16Array) return GL_TYPE.SHORT;
  if (array instanceof Int32Array) return GL_TYPE.INT;
  if (array instanceof Int8Array) return GL_TYPE.BYTE;
  return GL_TYPE.FLOAT;
}

/**
 * Resolves a draw mode name (or enum) to a GL primitive enum.
 * @param {string|number} mode
 * @returns {number}
 */
export function drawModeToGL(mode) {
  if (typeof mode === 'number') return mode;
  const v = DRAW_MODES[mode];
  return v === undefined ? DRAW_MODES.triangles : v;
}

/**
 * One vertex attribute: its CPU data, layout and GPU buffer.
 * Kept as a class so every instance shares a single hidden class (V8 perf).
 */
export class GeometryAttribute {
  /**
   * @param {ArrayBufferView} data
   * @param {number} size Components per vertex (1..4).
   * @param {Object} [opts]
   */
  constructor(data, size, opts = {}) {
    /** @type {ArrayBufferView} */
    this.data = data;
    /** @type {number} */
    this.size = size;
    /** @type {number} GL component type. */
    this.type = opts.type !== undefined ? opts.type : glTypeFromArray(data);
    /** @type {boolean} */
    this.normalized = !!opts.normalized;
    /** @type {number} Byte stride, 0 = tightly packed. */
    this.stride = opts.stride || 0;
    /** @type {number} Byte offset inside the buffer. */
    this.offset = opts.offset || 0;
    /** @type {number} Instancing divisor. */
    this.divisor = opts.divisor || 0;
    /** @type {boolean} Feed the shader as an integer attribute. */
    this.integer = !!opts.integer;
    /** @type {string} Buffer usage hint. */
    this.usage = opts.usage || 'static';
    /** @type {import('./Buffer.js').GLBuffer|null} */
    this.buffer = opts.buffer || null;
    /** @type {number} Index into Geometry._interleavedGroups, -1 when standalone. */
    this.group = opts.group !== undefined ? opts.group : -1;
    /** @type {number} Explicit shader location override (-1 = derive from name). */
    this.location = opts.location !== undefined ? opts.location : -1;
    /** @type {boolean} */
    this.needsUpdate = true;
    /** @type {number} */
    this.version = 0;

    const bpe = data.BYTES_PER_ELEMENT || 4;
    /** @type {number} Vertex count described by this attribute. */
    this.count = this.stride > 0
      ? Math.floor((data.byteLength - this.offset) / this.stride)
      : Math.floor(data.length / size);

    /** @type {number} Dirty range start, in ELEMENTS of `data`. */
    this._dirtyStart = 0;
    /** @type {number} Dirty range end (exclusive), in ELEMENTS of `data`. */
    this._dirtyEnd = data.length;
    /** @type {number} */
    this._bpe = bpe;
  }

  /** @type {number} Stride expressed in typed-array elements. */
  get elementStride() {
    return this.stride > 0 ? (this.stride / this._bpe) : this.size;
  }

  /** @type {number} Offset expressed in typed-array elements. */
  get elementOffset() {
    return this.offset > 0 ? (this.offset / this._bpe) : 0;
  }

  /** @type {number} CPU byte size of the attribute data. */
  get byteLength() {
    return this.data ? this.data.byteLength : 0;
  }

  /**
   * Flags a vertex range for re-upload.
   * @param {number} [startVertex=0]
   * @param {number} [vertexCount=Infinity]
   */
  markDirty(startVertex = 0, vertexCount = Infinity) {
    const es = this.elementStride;
    const eo = this.elementOffset;
    const len = this.data.length;
    let s = eo + startVertex * es;
    let e = vertexCount === Infinity ? len : (eo + (startVertex + vertexCount) * es);
    if (s < 0) s = 0;
    if (e > len) e = len;
    if (this.needsUpdate) {
      if (s < this._dirtyStart) this._dirtyStart = s;
      if (e > this._dirtyEnd) this._dirtyEnd = e;
    } else {
      this._dirtyStart = s;
      this._dirtyEnd = e;
    }
    this.needsUpdate = true;
    this.version++;
  }

  /** Flags the whole attribute for re-upload. */
  markAllDirty() {
    this._dirtyStart = 0;
    this._dirtyEnd = this.data.length;
    this.needsUpdate = true;
    this.version++;
  }

  /**
   * Reads one component.
   * @param {number} vertex
   * @param {number} component
   * @returns {number}
   */
  getComponent(vertex, component) {
    return this.data[this.elementOffset + vertex * this.elementStride + component];
  }

  /**
   * Writes one component (does not mark dirty).
   * @param {number} vertex
   * @param {number} component
   * @param {number} value
   */
  setComponent(vertex, component, value) {
    this.data[this.elementOffset + vertex * this.elementStride + component] = value;
  }

  /**
   * Deep copy of the attribute (fresh CPU data, no GPU buffer).
   * @returns {GeometryAttribute}
   */
  clone() {
    const data = this.data.slice();
    return new GeometryAttribute(data, this.size, {
      type: this.type,
      normalized: this.normalized,
      stride: this.stride,
      offset: this.offset,
      divisor: this.divisor,
      integer: this.integer,
      usage: this.usage,
      location: this.location
    });
  }
}

/**
 * A drawable chunk of vertex data.
 */
export class Geometry {
  constructor() {
    /** @type {number} */
    this.id = _nextGeometryId++;
    /** @type {string} */
    this.name = '';
    /** @type {Map<string, GeometryAttribute>} */
    this.attributes = new Map();
    /**
     * Index buffer descriptor or null.
     * @type {{data: ArrayBufferView, type: number, buffer: GLBuffer|null, count: number,
     *         needsUpdate: boolean, usage: string, _dirtyStart: number, _dirtyEnd: number}|null}
     */
    this.index = null;
    /** @type {string} 'triangles' | 'lines' | 'points' | 'line-strip' | ... */
    this.drawMode = 'triangles';
    /** @type {number} -1 = not instanced. */
    this.instanceCount = -1;
    /** @type {{start: number, count: number}} */
    this.drawRange = { start: 0, count: Infinity };
    /** @type {Array<{start: number, count: number, materialIndex: number}>} */
    this.groups = [];
    /** @type {AABB|null} */
    this.boundingBox = null;
    /** @type {Sphere|null} */
    this.boundingSphere = null;
    /** @type {Object} Free-form user payload. */
    this.userData = {};

    /**
     * Interleaved buffer groups shared by several attributes.
     * @type {Array<{data: ArrayBufferView, buffer: GLBuffer|null, usage: string,
     *               needsUpdate: boolean, dirtyStart: number, dirtyEnd: number, stride: number}>}
     * @private
     */
    this._interleavedGroups = [];
    /** @type {VertexArray|null} @private */
    this._vao = null;
    /** @type {number} Geometry version the cached VAO was built from. @private */
    this._vaoVersion = -1;
    /** @type {Map<number, {vao: VertexArray, version: number, geoVersion: number}>|null} @private */
    this._instancedVAOs = null;
    /** @type {WebGL2RenderingContext|null} @private */
    this._gl = null;
    /** @type {number} @private */
    this._version = 0;
  }

  // =======================================================================
  // Attributes
  // =======================================================================

  /**
   * Adds or replaces an attribute.
   * @param {string} name Canonical name ('aPosition', 'aNormal', ...).
   * @param {ArrayBufferView|Array<number>|GeometryAttribute} data
   * @param {number} [size=3] Components per vertex.
   * @param {Object} [opts] type / normalized / stride / offset / divisor / integer / usage / location
   * @returns {Geometry} this
   */
  setAttribute(name, data, size = 3, opts) {
    let attr;
    if (data instanceof GeometryAttribute) {
      attr = data;
    } else {
      let array = data;
      if (Array.isArray(array)) array = new Float32Array(array);
      attr = new GeometryAttribute(array, size, opts || {});
    }
    const previous = this.attributes.get(name);
    if (previous && previous !== attr) this._disposeAttribute(previous);
    this.attributes.set(name, attr);
    this._version++;
    return this;
  }

  /**
   * @param {string} name
   * @returns {GeometryAttribute|null}
   */
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  /**
   * Removes an attribute and releases its GPU buffer (unless interleaved).
   * @param {string} name
   * @returns {Geometry} this
   */
  deleteAttribute(name) {
    const attr = this.attributes.get(name);
    if (attr) {
      this._disposeAttribute(attr);
      this.attributes.delete(name);
      this._version++;
    }
    return this;
  }

  /**
   * Releases the private buffer of an attribute (interleaved groups are owned
   * by the geometry and released in `dispose`).
   * @param {GeometryAttribute} attr
   * @private
   */
  _disposeAttribute(attr) {
    if (attr.group < 0 && attr.buffer) {
      attr.buffer.dispose();
      attr.buffer = null;
    }
  }

  /**
   * Declares several attributes sharing one interleaved buffer.
   *
   * @param {ArrayBufferView|GLBuffer} buffer Interleaved data (or a ready GPU buffer).
   * @param {Object|Array} layout Either an array of attribute descriptors or
   *   `{ stride, count, usage, attributes: [...] }`. Each descriptor is
   *   `{ name, size, offset, type?, normalized?, divisor?, integer? }` with
   *   `offset` and `stride` expressed in BYTES.
   * @returns {Geometry} this
   */
  setInterleaved(buffer, layout) {
    const descriptors = Array.isArray(layout) ? layout : (layout.attributes || []);
    if (descriptors.length === 0) {
      throw new Error('Geometry.setInterleaved: layout sem atributos.');
    }

    const isGPUBuffer = buffer instanceof GLBuffer;
    const data = isGPUBuffer ? null : buffer;

    let stride = (Array.isArray(layout) ? 0 : (layout.stride || 0)) | 0;
    if (!stride) {
      // Derive the stride from the descriptors (largest offset + its size).
      let maxEnd = 0;
      for (let i = 0, n = descriptors.length; i < n; i++) {
        const d = descriptors[i];
        const type = d.type !== undefined ? d.type : GL_TYPE.FLOAT;
        const end = (d.offset || 0) + d.size * glTypeBytes(type);
        if (end > maxEnd) maxEnd = end;
      }
      stride = maxEnd;
    }

    const groupIndex = this._interleavedGroups.length;
    const group = {
      data,
      buffer: isGPUBuffer ? buffer : null,
      usage: (Array.isArray(layout) ? 'static' : (layout.usage || 'static')),
      needsUpdate: !isGPUBuffer,
      dirtyStart: 0,
      dirtyEnd: data ? data.length : 0,
      stride
    };
    this._interleavedGroups.push(group);

    const explicitCount = Array.isArray(layout) ? 0 : (layout.count | 0);
    if (isGPUBuffer && !explicitCount) {
      throw new Error('Geometry.setInterleaved: informe layout.count ao passar um GLBuffer pronto.');
    }

    for (let i = 0, n = descriptors.length; i < n; i++) {
      const d = descriptors[i];
      const array = data || new Float32Array(0);
      const attr = new GeometryAttribute(array, d.size, {
        type: d.type !== undefined ? d.type : GL_TYPE.FLOAT,
        normalized: !!d.normalized,
        stride,
        offset: d.offset || 0,
        divisor: d.divisor || 0,
        integer: !!d.integer,
        usage: group.usage,
        group: groupIndex,
        location: d.location !== undefined ? d.location : -1
      });
      if (explicitCount) attr.count = explicitCount;
      attr.buffer = group.buffer;
      attr.needsUpdate = false; // the group owns the upload
      this.attributes.set(d.name, attr);
    }

    this._version++;
    return this;
  }

  /**
   * Sets (or clears) the index buffer. Plain arrays are converted to
   * Uint16Array or Uint32Array automatically according to the vertex count.
   * @param {ArrayBufferView|Array<number>|null} array
   * @returns {Geometry} this
   */
  setIndex(array) {
    if (array === null || array === undefined) {
      if (this.index && this.index.buffer) this.index.buffer.dispose();
      this.index = null;
      this._version++;
      return this;
    }

    let data = array;
    if (Array.isArray(data)) {
      const vertexCount = this.vertexCount;
      let needs32 = vertexCount > 65535;
      if (!needs32) {
        for (let i = 0, n = data.length; i < n; i++) {
          if (data[i] > 65535) { needs32 = true; break; }
        }
      }
      data = needs32 ? new Uint32Array(data) : new Uint16Array(data);
    }

    const previousBuffer = this.index ? this.index.buffer : null;
    this.index = {
      data,
      type: glTypeFromArray(data),
      buffer: previousBuffer,
      count: data.length,
      needsUpdate: true,
      usage: 'static',
      _dirtyStart: 0,
      _dirtyEnd: data.length
    };
    this._version++;
    return this;
  }

  /**
   * Marks part (or all) of an attribute for re-upload.
   * @param {string} name
   * @param {number} [startVertex=0]
   * @param {number} [vertexCount=Infinity]
   * @returns {Geometry} this
   */
  markAttributeDirty(name, startVertex = 0, vertexCount = Infinity) {
    const attr = this.attributes.get(name);
    if (!attr) return this;
    if (attr.group >= 0) {
      const group = this._interleavedGroups[attr.group];
      if (group && group.data) {
        const es = group.stride / (group.data.BYTES_PER_ELEMENT || 4);
        let s = startVertex * es;
        let e = vertexCount === Infinity ? group.data.length : (startVertex + vertexCount) * es;
        if (s < 0) s = 0;
        if (e > group.data.length) e = group.data.length;
        if (group.needsUpdate) {
          if (s < group.dirtyStart) group.dirtyStart = s;
          if (e > group.dirtyEnd) group.dirtyEnd = e;
        } else {
          group.dirtyStart = s;
          group.dirtyEnd = e;
        }
        group.needsUpdate = true;
      }
      return this;
    }
    attr.markDirty(startVertex, vertexCount);
    return this;
  }

  /**
   * Marks the index buffer for re-upload.
   * @param {number} [start=0] First index element.
   * @param {number} [count=Infinity]
   * @returns {Geometry} this
   */
  markIndexDirty(start = 0, count = Infinity) {
    const idx = this.index;
    if (!idx) return this;
    const len = idx.data.length;
    let s = start | 0;
    let e = count === Infinity ? len : (start + count);
    if (s < 0) s = 0;
    if (e > len) e = len;
    if (idx.needsUpdate) {
      if (s < idx._dirtyStart) idx._dirtyStart = s;
      if (e > idx._dirtyEnd) idx._dirtyEnd = e;
    } else {
      idx._dirtyStart = s;
      idx._dirtyEnd = e;
    }
    idx.needsUpdate = true;
    return this;
  }

  // =======================================================================
  // Groups / draw range
  // =======================================================================

  /**
   * Adds a multi-material group.
   * @param {number} start First index/vertex.
   * @param {number} count Element count.
   * @param {number} [materialIndex=0]
   * @returns {Geometry} this
   */
  addGroup(start, count, materialIndex = 0) {
    this.groups.push({ start: start | 0, count: count | 0, materialIndex: materialIndex | 0 });
    return this;
  }

  /** Removes every group. @returns {Geometry} this */
  clearGroups() {
    this.groups.length = 0;
    return this;
  }

  /**
   * Restricts drawing to a sub range.
   * @param {number} start
   * @param {number} count
   * @returns {Geometry} this
   */
  setDrawRange(start, count) {
    this.drawRange.start = start | 0;
    this.drawRange.count = count;
    return this;
  }

  /** @type {number} Vertices described by aPosition (0 when absent). */
  get vertexCount() {
    const pos = this.attributes.get('aPosition');
    return pos ? pos.count : 0;
  }

  /** @type {number} Total drawable elements (indices when indexed). */
  get elementCount() {
    return this.index ? this.index.count : this.vertexCount;
  }

  /** @type {number} Triangle count of the current draw range. */
  get triangleCount() {
    if (this.drawMode !== 'triangles') return 0;
    return (this.getDrawCount() / 3) | 0;
  }

  /** @type {number} GL enum of the index type, 0 when non indexed. */
  get indexType() {
    return this.index ? this.index.type : 0;
  }

  /** @type {number} Byte size of one index. */
  get indexBytesPerElement() {
    return this.index ? glTypeBytes(this.index.type) : 0;
  }

  /**
   * First element to draw, honouring `drawRange`.
   * @returns {number}
   */
  getDrawStart() {
    const s = this.drawRange.start | 0;
    return s < 0 ? 0 : s;
  }

  /**
   * Element count to draw, honouring `drawRange` and the available data.
   * @returns {number}
   */
  getDrawCount() {
    const total = this.elementCount;
    const start = this.getDrawStart();
    const available = total - start;
    if (available <= 0) return 0;
    const requested = this.drawRange.count;
    if (requested === Infinity || requested === undefined || requested < 0) return available;
    return requested < available ? (requested | 0) : available;
  }

  // =======================================================================
  // Bounds
  // =======================================================================

  /**
   * Computes the axis aligned bounding box from aPosition.
   * @returns {Geometry} this
   */
  computeBoundingBox() {
    if (!this.boundingBox) this.boundingBox = new AABB();
    const box = this.boundingBox;
    const pos = this.attributes.get('aPosition');
    if (!pos || pos.count === 0) {
      box.makeEmpty();
      return this;
    }
    const data = pos.data;
    const stride = pos.elementStride;
    const offset = pos.elementOffset;
    const n = pos.count;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0, p = offset; i < n; i++, p += stride) {
      const x = data[p];
      const y = data[p + 1];
      const z = data[p + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    box.min.set(minX, minY, minZ);
    box.max.set(maxX, maxY, maxZ);
    return this;
  }

  /**
   * Computes a tight bounding sphere: Ritter's approximation followed by an
   * exact containment refinement pass (keeps Ritter's better center, then grows
   * the radius to the farthest vertex).
   * @returns {Geometry} this
   */
  computeBoundingSphere() {
    if (!this.boundingSphere) this.boundingSphere = new Sphere();
    const sphere = this.boundingSphere;
    const pos = this.attributes.get('aPosition');
    if (!pos || pos.count === 0) {
      sphere.center.set(0, 0, 0);
      sphere.radius = 0;
      return this;
    }

    const data = pos.data;
    const stride = pos.elementStride;
    const offset = pos.elementOffset;
    const n = pos.count;

    if (n === 1) {
      sphere.center.set(data[offset], data[offset + 1], data[offset + 2]);
      sphere.radius = 0;
      return this;
    }

    // Pass 1: axis extremes.
    let minXi = offset;
    let maxXi = offset;
    let minYi = offset;
    let maxYi = offset;
    let minZi = offset;
    let maxZi = offset;
    for (let i = 1, p = offset + stride; i < n; i++, p += stride) {
      if (data[p] < data[minXi]) minXi = p;
      if (data[p] > data[maxXi]) maxXi = p;
      if (data[p + 1] < data[minYi + 1]) minYi = p;
      if (data[p + 1] > data[maxYi + 1]) maxYi = p;
      if (data[p + 2] < data[minZi + 2]) minZi = p;
      if (data[p + 2] > data[maxZi + 2]) maxZi = p;
    }

    const dx1 = data[maxXi] - data[minXi];
    const dy1 = data[maxXi + 1] - data[minXi + 1];
    const dz1 = data[maxXi + 2] - data[minXi + 2];
    const spanX = dx1 * dx1 + dy1 * dy1 + dz1 * dz1;

    const dx2 = data[maxYi] - data[minYi];
    const dy2 = data[maxYi + 1] - data[minYi + 1];
    const dz2 = data[maxYi + 2] - data[minYi + 2];
    const spanY = dx2 * dx2 + dy2 * dy2 + dz2 * dz2;

    const dx3 = data[maxZi] - data[minZi];
    const dy3 = data[maxZi + 1] - data[minZi + 1];
    const dz3 = data[maxZi + 2] - data[minZi + 2];
    const spanZ = dx3 * dx3 + dy3 * dy3 + dz3 * dz3;

    let a = minXi;
    let b = maxXi;
    let span = spanX;
    if (spanY > span) { a = minYi; b = maxYi; span = spanY; }
    if (spanZ > span) { a = minZi; b = maxZi; span = spanZ; }

    let cx = (data[a] + data[b]) * 0.5;
    let cy = (data[a + 1] + data[b + 1]) * 0.5;
    let cz = (data[a + 2] + data[b + 2]) * 0.5;
    let radius = Math.sqrt(span) * 0.5;

    // Pass 2: Ritter growth.
    for (let i = 0, p = offset; i < n; i++, p += stride) {
      const ex = data[p] - cx;
      const ey = data[p + 1] - cy;
      const ez = data[p + 2] - cz;
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 > radius * radius) {
        const d = Math.sqrt(d2);
        const newRadius = (radius + d) * 0.5;
        const k = (d - newRadius) / d;
        cx += ex * k;
        cy += ey * k;
        cz += ez * k;
        radius = newRadius;
      }
    }

    // Pass 3: exact containment (radius only, center stays).
    let maxD2 = 0;
    for (let i = 0, p = offset; i < n; i++, p += stride) {
      const ex = data[p] - cx;
      const ey = data[p + 1] - cy;
      const ez = data[p + 2] - cz;
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 > maxD2) maxD2 = d2;
    }

    sphere.center.set(cx, cy, cz);
    sphere.radius = Math.sqrt(maxD2);
    return this;
  }

  // =======================================================================
  // Normals / tangents
  // =======================================================================

  /**
   * Recomputes smooth vertex normals. Face contributions are weighted by the
   * un-normalized cross product, i.e. by triangle area, which gives much better
   * results on irregular meshes than plain averaging.
   * @returns {Geometry} this
   */
  computeNormals() {
    const pos = this.attributes.get('aPosition');
    if (!pos) return this;

    const vCount = pos.count;
    const pData = pos.data;
    const pStride = pos.elementStride;
    const pOffset = pos.elementOffset;

    let normal = this.attributes.get('aNormal');
    if (!normal || normal.count !== vCount || normal.size < 3) {
      normal = new GeometryAttribute(new Float32Array(vCount * 3), 3, { type: GL_TYPE.FLOAT });
      this.attributes.set('aNormal', normal);
      this._version++;
    }
    const nData = normal.data;
    const nStride = normal.elementStride;
    const nOffset = normal.elementOffset;

    for (let i = 0, p = nOffset; i < vCount; i++, p += nStride) {
      nData[p] = 0;
      nData[p + 1] = 0;
      nData[p + 2] = 0;
    }

    const index = this.index ? this.index.data : null;
    const triCount = index ? ((index.length / 3) | 0) : ((vCount / 3) | 0);

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index[t * 3] : t * 3;
      const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
      const i2 = index ? index[t * 3 + 2] : t * 3 + 2;

      const a = pOffset + i0 * pStride;
      const b = pOffset + i1 * pStride;
      const c = pOffset + i2 * pStride;

      const e1x = pData[b] - pData[a];
      const e1y = pData[b + 1] - pData[a + 1];
      const e1z = pData[b + 2] - pData[a + 2];
      const e2x = pData[c] - pData[a];
      const e2y = pData[c + 1] - pData[a + 1];
      const e2z = pData[c + 2] - pData[a + 2];

      // Cross product length equals twice the triangle area: area weighting.
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      const na = nOffset + i0 * nStride;
      const nb = nOffset + i1 * nStride;
      const nc = nOffset + i2 * nStride;

      nData[na] += nx; nData[na + 1] += ny; nData[na + 2] += nz;
      nData[nb] += nx; nData[nb + 1] += ny; nData[nb + 2] += nz;
      nData[nc] += nx; nData[nc + 1] += ny; nData[nc + 2] += nz;
    }

    for (let i = 0, p = nOffset; i < vCount; i++, p += nStride) {
      const x = nData[p];
      const y = nData[p + 1];
      const z = nData[p + 2];
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len > 1e-12) {
        const inv = 1 / len;
        nData[p] = x * inv;
        nData[p + 1] = y * inv;
        nData[p + 2] = z * inv;
      } else {
        nData[p] = 0;
        nData[p + 1] = 1;
        nData[p + 2] = 0;
      }
    }

    this.markAttributeDirty('aNormal');
    return this;
  }

  /**
   * Computes per-vertex tangents (MikkTSpace style: per-triangle UV gradients
   * accumulated per vertex, Gram-Schmidt orthonormalization against the normal,
   * handedness stored in `w`). Requires aPosition, aNormal and aUV0; when UVs
   * are missing a deterministic orthogonal basis is generated instead.
   * @returns {Geometry} this
   */
  computeTangents() {
    const pos = this.attributes.get('aPosition');
    if (!pos) return this;
    if (!this.attributes.has('aNormal')) this.computeNormals();
    const normal = this.attributes.get('aNormal');
    const uv = this.attributes.get('aUV0');

    const vCount = pos.count;
    let tangent = this.attributes.get('aTangent');
    if (!tangent || tangent.count !== vCount || tangent.size !== 4) {
      tangent = new GeometryAttribute(new Float32Array(vCount * 4), 4, { type: GL_TYPE.FLOAT });
      this.attributes.set('aTangent', tangent);
      this._version++;
    }

    const nData = normal.data;
    const nStride = normal.elementStride;
    const nOffset = normal.elementOffset;
    const tData = tangent.data;
    const tStride = tangent.elementStride;
    const tOffset = tangent.elementOffset;

    if (!uv) {
      // No UVs: build an arbitrary but stable basis orthogonal to the normal.
      for (let i = 0, np = nOffset, tp = tOffset; i < vCount; i++, np += nStride, tp += tStride) {
        const nx = nData[np];
        const ny = nData[np + 1];
        const nz = nData[np + 2];
        let ax = 0;
        let ay = 0;
        let az = 1;
        if (Math.abs(nz) > 0.9) { ax = 1; ay = 0; az = 0; }
        let tx = ay * nz - az * ny;
        let ty = az * nx - ax * nz;
        let tz = ax * ny - ay * nx;
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        tData[tp] = tx / len;
        tData[tp + 1] = ty / len;
        tData[tp + 2] = tz / len;
        tData[tp + 3] = 1;
      }
      this.markAttributeDirty('aTangent');
      return this;
    }

    const pData = pos.data;
    const pStride = pos.elementStride;
    const pOffset = pos.elementOffset;
    const uData = uv.data;
    const uStride = uv.elementStride;
    const uOffset = uv.elementOffset;

    const tan1 = new Float32Array(vCount * 3);
    const tan2 = new Float32Array(vCount * 3);

    const index = this.index ? this.index.data : null;
    const triCount = index ? ((index.length / 3) | 0) : ((vCount / 3) | 0);

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index[t * 3] : t * 3;
      const i1 = index ? index[t * 3 + 1] : t * 3 + 1;
      const i2 = index ? index[t * 3 + 2] : t * 3 + 2;

      const pa = pOffset + i0 * pStride;
      const pb = pOffset + i1 * pStride;
      const pc = pOffset + i2 * pStride;
      const ua = uOffset + i0 * uStride;
      const ub = uOffset + i1 * uStride;
      const uc = uOffset + i2 * uStride;

      const x1 = pData[pb] - pData[pa];
      const y1 = pData[pb + 1] - pData[pa + 1];
      const z1 = pData[pb + 2] - pData[pa + 2];
      const x2 = pData[pc] - pData[pa];
      const y2 = pData[pc + 1] - pData[pa + 1];
      const z2 = pData[pc + 2] - pData[pa + 2];

      const s1 = uData[ub] - uData[ua];
      const t1 = uData[ub + 1] - uData[ua + 1];
      const s2 = uData[uc] - uData[ua];
      const t2 = uData[uc + 1] - uData[ua + 1];

      const det = s1 * t2 - s2 * t1;
      if (det === 0 || !isFinite(det)) continue;
      const r = 1 / det;

      const sdx = (t2 * x1 - t1 * x2) * r;
      const sdy = (t2 * y1 - t1 * y2) * r;
      const sdz = (t2 * z1 - t1 * z2) * r;
      const tdx = (s1 * x2 - s2 * x1) * r;
      const tdy = (s1 * y2 - s2 * y1) * r;
      const tdz = (s1 * z2 - s2 * z1) * r;

      const a3 = i0 * 3;
      const b3 = i1 * 3;
      const c3 = i2 * 3;

      tan1[a3] += sdx; tan1[a3 + 1] += sdy; tan1[a3 + 2] += sdz;
      tan1[b3] += sdx; tan1[b3 + 1] += sdy; tan1[b3 + 2] += sdz;
      tan1[c3] += sdx; tan1[c3 + 1] += sdy; tan1[c3 + 2] += sdz;

      tan2[a3] += tdx; tan2[a3 + 1] += tdy; tan2[a3 + 2] += tdz;
      tan2[b3] += tdx; tan2[b3 + 1] += tdy; tan2[b3 + 2] += tdz;
      tan2[c3] += tdx; tan2[c3 + 1] += tdy; tan2[c3 + 2] += tdz;
    }

    for (let i = 0; i < vCount; i++) {
      const np = nOffset + i * nStride;
      const tp = tOffset + i * tStride;
      const i3 = i * 3;

      const nx = nData[np];
      const ny = nData[np + 1];
      const nz = nData[np + 2];
      let tx = tan1[i3];
      let ty = tan1[i3 + 1];
      let tz = tan1[i3 + 2];

      // Gram-Schmidt: t' = normalize(t - n * dot(n, t))
      const d = nx * tx + ny * ty + nz * tz;
      tx -= nx * d;
      ty -= ny * d;
      tz -= nz * d;

      let len = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (len < 1e-10) {
        // Degenerate UVs: fall back to any vector orthogonal to the normal.
        let ax = 0;
        let ay = 0;
        let az = 1;
        if (Math.abs(nz) > 0.9) { ax = 1; ay = 0; az = 0; }
        tx = ay * nz - az * ny;
        ty = az * nx - ax * nz;
        tz = ax * ny - ay * nx;
        len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      }
      const inv = 1 / len;
      tx *= inv;
      ty *= inv;
      tz *= inv;

      // Handedness: sign of dot(cross(n, t), bitangent)
      const cx = ny * tz - nz * ty;
      const cy = nz * tx - nx * tz;
      const cz = nx * ty - ny * tx;
      const w = (cx * tan2[i3] + cy * tan2[i3 + 1] + cz * tan2[i3 + 2]) < 0 ? -1 : 1;

      tData[tp] = tx;
      tData[tp + 1] = ty;
      tData[tp + 2] = tz;
      tData[tp + 3] = w;
    }

    this.markAttributeDirty('aTangent');
    return this;
  }

  // =======================================================================
  // GPU upload
  // =======================================================================

  /**
   * Uploads whatever changed since the last call.
   * @param {WebGL2RenderingContext} gl
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {Geometry} this
   */
  upload(gl, state) {
    this._gl = gl;

    // Interleaved groups first (they own shared buffers).
    const groups = this._interleavedGroups;
    for (let i = 0, n = groups.length; i < n; i++) {
      const group = groups[i];
      if (!group.data) continue;
      if (!group.buffer) {
        group.buffer = new GLBuffer(gl, 'array', group.usage);
        group.buffer.setData(group.data, state);
        group.needsUpdate = false;
      } else if (group.needsUpdate) {
        this._uploadRange(group.buffer, group.data, group.dirtyStart, group.dirtyEnd, state);
        group.needsUpdate = false;
      }
      group.dirtyStart = 0;
      group.dirtyEnd = 0;
    }

    // Standalone attributes.
    const it = this.attributes.values();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      const attr = entry.value;
      if (attr.group >= 0) {
        const group = groups[attr.group];
        if (group) attr.buffer = group.buffer;
        attr.needsUpdate = false;
        continue;
      }
      if (!attr.buffer) {
        attr.buffer = new GLBuffer(gl, 'array', attr.usage);
        attr.buffer.setData(attr.data, state);
        attr.needsUpdate = false;
      } else if (attr.needsUpdate) {
        this._uploadRange(attr.buffer, attr.data, attr._dirtyStart, attr._dirtyEnd, state);
        attr.needsUpdate = false;
      }
      attr._dirtyStart = 0;
      attr._dirtyEnd = 0;
    }

    // Index buffer.
    const idx = this.index;
    if (idx) {
      if (!idx.buffer) {
        idx.buffer = new GLBuffer(gl, 'element', idx.usage);
        idx.buffer.setData(idx.data, state);
        idx.needsUpdate = false;
      } else if (idx.needsUpdate) {
        this._uploadRange(idx.buffer, idx.data, idx._dirtyStart, idx._dirtyEnd, state);
        idx.needsUpdate = false;
      }
      idx._dirtyStart = 0;
      idx._dirtyEnd = 0;
    }

    return this;
  }

  /**
   * Full or partial buffer upload depending on how much of it is dirty.
   * @private
   */
  _uploadRange(buffer, data, start, end, state) {
    const bpe = data.BYTES_PER_ELEMENT || 4;
    const total = data.length;
    if (buffer.byteLength !== data.byteLength) {
      buffer.setData(data, state);
      return;
    }
    let s = start | 0;
    let e = end === undefined ? total : (end | 0);
    if (s < 0) s = 0;
    if (e > total) e = total;
    if (e <= s) return;
    if (s === 0 && e === total) {
      buffer.setSubData(data, 0, 0, total, state);
    } else {
      buffer.setSubData(data, s * bpe, s, e - s, state);
    }
  }

  /**
   * Returns the cached VAO, creating (or rebuilding) it when needed.
   * @param {WebGL2RenderingContext} gl
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {VertexArray}
   */
  getVAO(gl, state) {
    this.upload(gl, state);
    if (this._vao && this._vaoVersion === this._version) return this._vao;

    if (this._vao) {
      this._vao.dispose(state);
      this._vao = null;
    }

    const vao = new VertexArray(gl, state);
    this._bindAttributesTo(vao);
    if (this.index && this.index.buffer) vao.setIndexBuffer(this.index.buffer);
    this._vao = vao;
    this._vaoVersion = this._version;
    return vao;
  }

  /**
   * Records every geometry attribute into a VAO.
   * @param {VertexArray} vao
   * @private
   */
  _bindAttributesTo(vao) {
    const it = this.attributes.entries();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      const name = entry.value[0];
      const attr = entry.value[1];
      if (!attr.buffer) continue;

      let location = attr.location;
      if (location < 0) {
        const mapped = ATTRIB_NAME_TO_LOC[name];
        if (mapped === undefined) {
          Logger.warn('Geometry: atributo "' + name + '" sem location conhecida - ignorado no VAO.');
          continue;
        }
        location = mapped;
      }

      if (attr.size === 16 || (name === 'aInstanceMatrix' && attr.size === 4 && attr.stride >= 64)) {
        // mat4 attribute occupying 4 consecutive locations.
        vao.setMatrixAttribute(location, attr.buffer, attr.stride || 64, attr.offset, attr.divisor || 1);
        continue;
      }

      vao.setAttribute(
        location, attr.buffer, attr.size, attr.type, attr.normalized,
        attr.stride, attr.offset, attr.divisor, attr.integer
      );
    }
  }

  /**
   * Returns a VAO that combines this geometry with per-instance attributes.
   * Used by InstancedMesh, which owns the instance buffers: the geometry itself
   * stays shareable between meshes.
   *
   * @param {WebGL2RenderingContext} gl
   * @param {import('./StateCache.js').StateCache} state
   * @param {number} key Unique owner id (e.g. the InstancedMesh id).
   * @param {Array<{location: number, buffer: GLBuffer, size: number, type?: number,
   *                normalized?: boolean, stride?: number, offset?: number,
   *                divisor?: number, matrix?: boolean, integer?: boolean}>} instanceAttributes
   * @param {number} [version=0] Bump to force a rebuild (e.g. after `grow()`).
   * @returns {VertexArray}
   */
  getVAOWithInstanceAttributes(gl, state, key, instanceAttributes, version = 0) {
    this.upload(gl, state);
    if (!this._instancedVAOs) this._instancedVAOs = new Map();

    const cached = this._instancedVAOs.get(key);
    if (cached && cached.version === version && cached.geoVersion === this._version) return cached.vao;
    if (cached) cached.vao.dispose(state);

    const vao = new VertexArray(gl, state);
    this._bindAttributesTo(vao);
    if (this.index && this.index.buffer) vao.setIndexBuffer(this.index.buffer);

    for (let i = 0, n = instanceAttributes.length; i < n; i++) {
      const a = instanceAttributes[i];
      if (!a || !a.buffer) continue;
      const divisor = a.divisor === undefined ? 1 : a.divisor;
      if (a.matrix) {
        vao.setMatrixAttribute(a.location, a.buffer, a.stride || 64, a.offset || 0, divisor);
      } else {
        vao.setAttribute(
          a.location, a.buffer, a.size,
          a.type === undefined ? GL_TYPE.FLOAT : a.type,
          !!a.normalized, a.stride || 0, a.offset || 0, divisor, !!a.integer
        );
      }
    }

    this._instancedVAOs.set(key, { vao, version, geoVersion: this._version });
    return vao;
  }

  /**
   * Releases an instanced VAO variant (call from InstancedMesh.dispose).
   * @param {number} key
   * @param {import('./StateCache.js').StateCache} [state]
   */
  releaseInstanceVAO(key, state) {
    if (!this._instancedVAOs) return;
    const cached = this._instancedVAOs.get(key);
    if (cached) {
      cached.vao.dispose(state);
      this._instancedVAOs.delete(key);
    }
  }

  // =======================================================================
  // Misc
  // =======================================================================

  /** @type {number} Total CPU/GPU bytes held by this geometry. */
  get memoryBytes() {
    let bytes = 0;
    const groups = this._interleavedGroups;
    for (let i = 0, n = groups.length; i < n; i++) {
      if (groups[i].data) bytes += groups[i].data.byteLength;
    }
    const it = this.attributes.values();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      if (entry.value.group < 0) bytes += entry.value.byteLength;
    }
    if (this.index) bytes += this.index.data.byteLength;
    return bytes;
  }

  /**
   * Deep copy: fresh CPU arrays, no GPU resources (they are recreated lazily).
   * @returns {Geometry}
   */
  clone() {
    const g = new Geometry();
    g.name = this.name;
    g.drawMode = this.drawMode;
    g.instanceCount = this.instanceCount;
    g.drawRange.start = this.drawRange.start;
    g.drawRange.count = this.drawRange.count;

    for (let i = 0, n = this.groups.length; i < n; i++) {
      const gr = this.groups[i];
      g.groups.push({ start: gr.start, count: gr.count, materialIndex: gr.materialIndex });
    }

    // Clone interleaved groups keeping the sharing intact.
    const groupMap = new Array(this._interleavedGroups.length);
    for (let i = 0, n = this._interleavedGroups.length; i < n; i++) {
      const src = this._interleavedGroups[i];
      const copy = {
        data: src.data ? src.data.slice() : null,
        buffer: null,
        usage: src.usage,
        needsUpdate: true,
        dirtyStart: 0,
        dirtyEnd: src.data ? src.data.length : 0,
        stride: src.stride
      };
      g._interleavedGroups.push(copy);
      groupMap[i] = copy;
    }

    const it = this.attributes.entries();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      const name = entry.value[0];
      const attr = entry.value[1];
      if (attr.group >= 0) {
        const copy = new GeometryAttribute(groupMap[attr.group].data, attr.size, {
          type: attr.type,
          normalized: attr.normalized,
          stride: attr.stride,
          offset: attr.offset,
          divisor: attr.divisor,
          integer: attr.integer,
          usage: attr.usage,
          group: attr.group,
          location: attr.location
        });
        copy.count = attr.count;
        copy.needsUpdate = false;
        g.attributes.set(name, copy);
      } else {
        g.attributes.set(name, attr.clone());
      }
    }

    if (this.index) {
      g.index = {
        data: this.index.data.slice(),
        type: this.index.type,
        buffer: null,
        count: this.index.count,
        needsUpdate: true,
        usage: this.index.usage,
        _dirtyStart: 0,
        _dirtyEnd: this.index.data.length
      };
    }

    if (this.boundingBox) g.boundingBox = this.boundingBox.clone();
    if (this.boundingSphere) g.boundingSphere = this.boundingSphere.clone();
    return g;
  }

  /**
   * Releases every GPU resource owned by this geometry. The CPU arrays stay
   * usable, so a disposed geometry can be uploaded again.
   * @param {WebGL2RenderingContext} [gl]
   * @param {import('./StateCache.js').StateCache} [state]
   */
  dispose(gl, state) {
    if (this._vao) {
      this._vao.dispose(state);
      this._vao = null;
    }
    if (this._instancedVAOs) {
      const it = this._instancedVAOs.values();
      for (let entry = it.next(); !entry.done; entry = it.next()) {
        entry.value.vao.dispose(state);
      }
      this._instancedVAOs.clear();
      this._instancedVAOs = null;
    }

    const groups = this._interleavedGroups;
    for (let i = 0, n = groups.length; i < n; i++) {
      if (groups[i].buffer) {
        groups[i].buffer.dispose(state);
        groups[i].buffer = null;
      }
      groups[i].needsUpdate = true;
      groups[i].dirtyStart = 0;
      groups[i].dirtyEnd = groups[i].data ? groups[i].data.length : 0;
    }

    const it = this.attributes.values();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      const attr = entry.value;
      if (attr.group < 0 && attr.buffer) {
        attr.buffer.dispose(state);
        attr.buffer = null;
      } else if (attr.group >= 0) {
        attr.buffer = null;
      }
      attr.markAllDirty();
    }

    if (this.index) {
      if (this.index.buffer) {
        this.index.buffer.dispose(state);
        this.index.buffer = null;
      }
      this.index.needsUpdate = true;
      this.index._dirtyStart = 0;
      this.index._dirtyEnd = this.index.data.length;
    }

    this._vaoVersion = -1;
    this._gl = null;
  }
}
