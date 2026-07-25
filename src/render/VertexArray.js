/**
 * Vertex Array Object wrapper.
 *
 * Because every shader in the engine declares the same `layout(location = N)`
 * slots (see ATTRIB in Geometry.js), a single VAO built for a Geometry is valid
 * for every program - which is what makes the "bind VAO once, draw many" fast
 * path possible.
 */

import { getStateCache } from './StateCache.js';

const GL_BYTE = 0x1400;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_SHORT = 0x1402;
const GL_UNSIGNED_SHORT = 0x1403;
const GL_INT = 0x1404;
const GL_UNSIGNED_INT = 0x1405;

let _nextVAOId = 1;

/**
 * Wraps a WebGLVertexArrayObject and records attribute layouts into it.
 */
export class VertexArray {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {import('./StateCache.js').StateCache} [state] Optional explicit cache.
   */
  constructor(gl, state) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {number} */
    this.uid = _nextVAOId++;
    /** @type {WebGLVertexArrayObject|null} */
    this.id = gl.createVertexArray();
    /** @type {import('./StateCache.js').StateCache|null} */
    this.state = state || null;
    /** @type {number} Bitmask of enabled attribute locations. */
    this.enabledMask = 0;
    /** @type {import('./Buffer.js').GLBuffer|null} */
    this.indexBuffer = null;
    /** @type {boolean} */
    this.disposed = false;

    if (!this.id) {
      throw new Error('VertexArray: falha ao criar o VAO (contexto perdido?).');
    }
  }

  /**
   * Resolves the state cache to use for internal binds.
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {import('./StateCache.js').StateCache|null}
   * @private
   */
  _cache(state) {
    if (state) {
      this.state = state;
      return state;
    }
    if (this.state) return this.state;
    const st = getStateCache(this.gl);
    if (st) this.state = st;
    return st;
  }

  /**
   * Makes this VAO current.
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {VertexArray} this
   */
  bind(state) {
    const st = this._cache(state);
    if (st) st.bindVAO(this.id);
    else this.gl.bindVertexArray(this.id);
    return this;
  }

  /**
   * Records one vertex attribute into the VAO.
   *
   * Integer typed attributes are recorded with `vertexAttribIPointer` only when
   * `integer` is true; otherwise integer data is converted to float by the GPU
   * (which is what the engine wants for e.g. `aJoints`, declared as `vec4`).
   *
   * @param {number} location layout(location = N)
   * @param {import('./Buffer.js').GLBuffer} buffer Vertex buffer holding the data.
   * @param {number} size Components per vertex (1..4).
   * @param {number} [type=0x1406] GL component type (FLOAT by default).
   * @param {boolean} [normalized=false]
   * @param {number} [stride=0] Byte stride (0 = tightly packed).
   * @param {number} [offset=0] Byte offset into the buffer.
   * @param {number} [divisor=0] Instancing divisor.
   * @param {boolean} [integer=false] Use vertexAttribIPointer.
   * @returns {VertexArray} this
   */
  setAttribute(location, buffer, size, type = 0x1406, normalized = false, stride = 0, offset = 0, divisor = 0, integer = false) {
    const gl = this.gl;
    const st = this._cache();
    this.bind(st);
    buffer.bindInVAO(st);

    gl.enableVertexAttribArray(location);
    this.enabledMask |= (1 << location);

    const isIntegerType = type === GL_BYTE || type === GL_UNSIGNED_BYTE ||
      type === GL_SHORT || type === GL_UNSIGNED_SHORT ||
      type === GL_INT || type === GL_UNSIGNED_INT;

    if (integer && isIntegerType && !normalized) {
      gl.vertexAttribIPointer(location, size, type, stride, offset);
    } else {
      gl.vertexAttribPointer(location, size, type, normalized, stride, offset);
    }

    if (divisor) gl.vertexAttribDivisor(location, divisor);
    else gl.vertexAttribDivisor(location, 0);

    return this;
  }

  /**
   * Records a mat4 attribute occupying four consecutive locations
   * (used for `aInstanceMatrix` at locations 8..11).
   * @param {number} baseLocation First location.
   * @param {import('./Buffer.js').GLBuffer} buffer
   * @param {number} [stride=64] Byte stride between matrices.
   * @param {number} [offset=0] Byte offset of the first matrix.
   * @param {number} [divisor=1]
   * @returns {VertexArray} this
   */
  setMatrixAttribute(baseLocation, buffer, stride = 64, offset = 0, divisor = 1) {
    for (let i = 0; i < 4; i++) {
      this.setAttribute(baseLocation + i, buffer, 4, 0x1406, false, stride, offset + i * 16, divisor, false);
    }
    return this;
  }

  /**
   * Disables an attribute location in this VAO.
   * @param {number} location
   * @returns {VertexArray} this
   */
  disableAttribute(location) {
    this.bind();
    this.gl.disableVertexAttribArray(location);
    this.enabledMask &= ~(1 << location);
    return this;
  }

  /**
   * Records the index buffer into the VAO.
   * @param {import('./Buffer.js').GLBuffer|null} buffer
   * @returns {VertexArray} this
   */
  setIndexBuffer(buffer) {
    const st = this._cache();
    this.bind(st);
    this.indexBuffer = buffer || null;
    if (buffer) {
      buffer.bindInVAO(st);
    } else if (st) {
      st.bindBuffer(0x8893, null); // GL_ELEMENT_ARRAY_BUFFER
    } else {
      this.gl.bindBuffer(0x8893, null);
    }
    return this;
  }

  /**
   * Deletes the GL object.
   * @param {import('./StateCache.js').StateCache} [state]
   */
  dispose(state) {
    if (this.disposed) return;
    this.disposed = true;
    const st = this._cache(state);
    if (st && st.getBoundVAO() === this.id) st.bindVAO(null);
    if (this.id) {
      this.gl.deleteVertexArray(this.id);
      this.id = null;
    }
    this.indexBuffer = null;
    this.enabledMask = 0;
  }
}
