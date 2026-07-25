/**
 * Thin, allocation-free wrapper around a WebGLBuffer.
 *
 * Every bind goes through the StateCache so the engine never issues a redundant
 * `gl.bindBuffer`. Binding an ELEMENT_ARRAY_BUFFER mutates the currently bound
 * VAO, so `bind()` defensively unbinds the VAO first; `bindInVAO()` is the
 * explicit opt-out used by VertexArray while recording index buffers.
 */

import { getStateCache } from './StateCache.js';

const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
const GL_UNIFORM_BUFFER = 0x8a11;
const GL_COPY_READ_BUFFER = 0x8f36;
const GL_COPY_WRITE_BUFFER = 0x8f37;
const GL_PIXEL_PACK_BUFFER = 0x88eb;
const GL_PIXEL_UNPACK_BUFFER = 0x88ec;
const GL_TRANSFORM_FEEDBACK_BUFFER = 0x8c8e;

const GL_STREAM_DRAW = 0x88e0;
const GL_STATIC_DRAW = 0x88e4;
const GL_DYNAMIC_DRAW = 0x88e8;

/** Friendly target name -> GL enum. */
const TARGETS = {
  array: GL_ARRAY_BUFFER,
  vertex: GL_ARRAY_BUFFER,
  element: GL_ELEMENT_ARRAY_BUFFER,
  index: GL_ELEMENT_ARRAY_BUFFER,
  uniform: GL_UNIFORM_BUFFER,
  'copy-read': GL_COPY_READ_BUFFER,
  'copy-write': GL_COPY_WRITE_BUFFER,
  'pixel-pack': GL_PIXEL_PACK_BUFFER,
  'pixel-unpack': GL_PIXEL_UNPACK_BUFFER,
  'transform-feedback': GL_TRANSFORM_FEEDBACK_BUFFER
};

/** Friendly usage name -> GL enum. */
const USAGES = {
  static: GL_STATIC_DRAW,
  dynamic: GL_DYNAMIC_DRAW,
  stream: GL_STREAM_DRAW
};

let _nextBufferId = 1;

/** Running total of GPU buffer bytes allocated through GLBuffer. */
let _totalBufferBytes = 0;

/**
 * GPU buffer object with byte accounting and partial upload support.
 */
export class GLBuffer {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {string|number} [target='array'] Friendly name or GL enum.
   * @param {string|number} [usage='static'] Friendly name or GL enum.
   */
  constructor(gl, target = 'array', usage = 'static') {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {number} Engine-side unique id (sorting / debugging). */
    this.uid = _nextBufferId++;
    /** @type {number} GL enum of the default binding target. */
    this.target = typeof target === 'number' ? target : (TARGETS[target] || GL_ARRAY_BUFFER);
    /** @type {number} GL enum of the usage hint. */
    this.usage = typeof usage === 'number' ? usage : (USAGES[usage] || GL_STATIC_DRAW);
    /** @type {WebGLBuffer|null} */
    this.id = gl.createBuffer();
    /** @type {number} Allocated size in bytes. */
    this.byteLength = 0;
    /** @type {number} Bumped on every data upload (useful for invalidation). */
    this.version = 0;
    /** @type {boolean} */
    this.disposed = false;

    if (!this.id) {
      throw new Error('GLBuffer: falha ao criar o buffer WebGL (contexto perdido?).');
    }
  }

  /**
   * Total bytes currently allocated by every live GLBuffer.
   * @type {number}
   */
  static get totalBytes() {
    return _totalBufferBytes;
  }

  /**
   * Binds the buffer to its target.
   * For index buffers this first unbinds the VAO, because binding an element
   * array buffer would otherwise be recorded into the bound VAO.
   * @param {import('./StateCache.js').StateCache} [state]
   */
  bind(state) {
    const st = state || getStateCache(this.gl);
    if (st) {
      if (this.target === GL_ELEMENT_ARRAY_BUFFER) st.bindVAO(null);
      st.bindBuffer(this.target, this.id);
    } else {
      if (this.target === GL_ELEMENT_ARRAY_BUFFER) this.gl.bindVertexArray(null);
      this.gl.bindBuffer(this.target, this.id);
    }
  }

  /**
   * Binds without protecting the current VAO. Only VertexArray should use this,
   * while it is recording the index buffer into a VAO on purpose.
   * @param {import('./StateCache.js').StateCache} [state]
   */
  bindInVAO(state) {
    const st = state || getStateCache(this.gl);
    if (st) st.bindBuffer(this.target, this.id);
    else this.gl.bindBuffer(this.target, this.id);
  }

  /**
   * Uploads a full data store, (re)allocating it.
   * @param {ArrayBufferView|ArrayBuffer} data
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {GLBuffer} this
   */
  setData(data, state) {
    this.bind(state);
    const bytes = data ? (data.byteLength | 0) : 0;
    _totalBufferBytes += bytes - this.byteLength;
    this.byteLength = bytes;
    this.gl.bufferData(this.target, data, this.usage);
    this.version++;
    return this;
  }

  /**
   * Allocates (or reallocates) an uninitialized data store.
   * @param {number} byteLength
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {GLBuffer} this
   */
  allocate(byteLength, state) {
    this.bind(state);
    const bytes = byteLength | 0;
    _totalBufferBytes += bytes - this.byteLength;
    this.byteLength = bytes;
    this.gl.bufferData(this.target, bytes, this.usage);
    this.version++;
    return this;
  }

  /**
   * Uploads a sub range without reallocating.
   * @param {ArrayBufferView} data Source typed array.
   * @param {number} [dstByteOffset=0] Destination offset in bytes.
   * @param {number} [srcOffset=0] Source offset in ELEMENTS of `data`.
   * @param {number} [srcLength] Element count to copy (defaults to the rest).
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {GLBuffer} this
   */
  setSubData(data, dstByteOffset = 0, srcOffset = 0, srcLength, state) {
    this.bind(state);
    const length = srcLength === undefined ? (data.length - srcOffset) : srcLength;
    if (length <= 0) return this;
    this.gl.bufferSubData(this.target, dstByteOffset, data, srcOffset, length);
    this.version++;
    return this;
  }

  /**
   * Orphans the current data store (same size, fresh storage). Used by streaming
   * buffers to avoid pipeline stalls when the GPU is still reading the old data.
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {GLBuffer} this
   */
  orphan(state) {
    if (this.byteLength <= 0) return this;
    this.bind(state);
    this.gl.bufferData(this.target, this.byteLength, this.usage);
    this.version++;
    return this;
  }

  /**
   * Reads GPU data back into a typed array (slow, debug only).
   * @param {ArrayBufferView} out
   * @param {number} [srcByteOffset=0]
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {ArrayBufferView} out
   */
  read(out, srcByteOffset = 0, state) {
    const gl = this.gl;
    const st = state || getStateCache(this.gl);
    if (st) st.bindBuffer(GL_COPY_READ_BUFFER, this.id);
    else gl.bindBuffer(GL_COPY_READ_BUFFER, this.id);
    gl.getBufferSubData(GL_COPY_READ_BUFFER, srcByteOffset, out);
    return out;
  }

  /**
   * Bytes this buffer occupies on the GPU.
   * @type {number}
   */
  get memoryBytes() {
    return this.byteLength;
  }

  /**
   * Deletes the GL object and updates the global byte counter.
   * @param {import('./StateCache.js').StateCache} [state]
   */
  dispose(state) {
    if (this.disposed) return;
    this.disposed = true;
    const st = state || getStateCache(this.gl);
    if (st) st.invalidateBuffer(this.target);
    if (this.id) {
      this.gl.deleteBuffer(this.id);
      this.id = null;
    }
    _totalBufferBytes -= this.byteLength;
    this.byteLength = 0;
  }
}

/**
 * Resolves a friendly buffer target name to its GL enum.
 * @param {string|number} name
 * @returns {number}
 */
export function bufferTargetToGL(name) {
  return typeof name === 'number' ? name : (TARGETS[name] || GL_ARRAY_BUFFER);
}

/**
 * Resolves a friendly usage name to its GL enum.
 * @param {string|number} name
 * @returns {number}
 */
export function bufferUsageToGL(name) {
  return typeof name === 'number' ? name : (USAGES[name] || GL_STATIC_DRAW);
}
