/**
 * Complete WebGL2 state cache.
 *
 * Every single GL state mutation in the engine must go through this class:
 * `gl.useProgram`, `gl.bindVertexArray`, `gl.bindTexture`, `gl.enable`, blending,
 * depth, culling, viewport, framebuffers and uniform buffer bindings. Each setter
 * compares against the shadowed value and only talks to the driver when it
 * actually changed, which removes the vast majority of redundant GL calls.
 *
 * The class allocates nothing after construction: all shadow state lives in
 * preallocated fields/arrays.
 */

/** Buffer targets tracked by the cache (index order matters, see `_bufferIndex`). */
const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
const GL_UNIFORM_BUFFER = 0x8a11;
const GL_COPY_READ_BUFFER = 0x8f36;
const GL_COPY_WRITE_BUFFER = 0x8f37;
const GL_PIXEL_PACK_BUFFER = 0x88eb;
const GL_PIXEL_UNPACK_BUFFER = 0x88ec;
const GL_TRANSFORM_FEEDBACK_BUFFER = 0x8c8e;

/** Texture targets tracked per unit. */
const GL_TEXTURE_2D = 0x0de1;
const GL_TEXTURE_CUBE_MAP = 0x8513;
const GL_TEXTURE_3D = 0x806f;
const GL_TEXTURE_2D_ARRAY = 0x8c1a;

/** Framebuffer targets. */
const GL_FRAMEBUFFER = 0x8d40;
const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_DRAW_FRAMEBUFFER = 0x8ca9;

/** Number of texture targets tracked per texture unit. */
const TEX_TARGET_COUNT = 4;

/** Sentinel used to mark "cache does not know the driver value". */
const UNKNOWN = -1;

/** Depth/stencil comparison function names -> GL enum. */
const COMPARE_FUNCS = {
  never: 0x0200,
  less: 0x0201,
  equal: 0x0202,
  lequal: 0x0203,
  greater: 0x0204,
  notequal: 0x0205,
  gequal: 0x0206,
  always: 0x0207
};

/** Stencil operation names -> GL enum. */
const STENCIL_OPS = {
  keep: 0x1e00,
  zero: 0,
  replace: 0x1e01,
  incr: 0x1e02,
  'incr-wrap': 0x8507,
  decr: 0x1e03,
  'decr-wrap': 0x8508,
  invert: 0x150a
};

/**
 * One StateCache per GL context. Textures, buffers and render targets look the
 * instance up through `getStateCache(gl)` when the caller did not pass one
 * explicitly, so that internal binds made during resource creation stay in sync.
 * @type {WeakMap<Object, StateCache>}
 */
const _registry = new WeakMap();

/**
 * Returns the StateCache registered for a GL context, if any.
 * @param {WebGL2RenderingContext} gl
 * @returns {StateCache|null}
 */
export function getStateCache(gl) {
  return _registry.get(gl) || null;
}

/**
 * Shadowed WebGL2 state with per-call redundancy elimination and draw statistics.
 */
export class StateCache {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;

    const maxUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) | 0;
    /** @type {number} */
    this.maxTextureUnits = maxUnits > 0 ? maxUnits : 32;
    /** @type {number} Highest unit, reserved for resource creation binds. */
    this.scratchTextureUnit = this.maxTextureUnits - 1;

    const maxUBO = gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) | 0;
    /** @type {number} */
    this.maxUBOBindings = maxUBO > 0 ? maxUBO : 24;

    // --- Shadow state -----------------------------------------------------
    /** @type {WebGLProgram|null} */
    this._program = null;
    /** @type {WebGLVertexArrayObject|null|number} */
    this._vao = UNKNOWN;

    /** @type {Array<WebGLBuffer|null|number>} Indexed by `_bufferIndex`. */
    this._buffers = new Array(8);
    /** @type {Array<WebGLTexture|null|number>} unit * 4 + targetIndex. */
    this._textures = new Array(this.maxTextureUnits * TEX_TARGET_COUNT);
    /** @type {Array<WebGLBuffer|null|number>} Indexed by UBO binding point. */
    this._uboBindings = new Array(this.maxUBOBindings);

    /** @type {number} */
    this._activeTexture = UNKNOWN;
    /** @type {WebGLFramebuffer|null|number} */
    this._drawFramebuffer = UNKNOWN;
    /** @type {WebGLFramebuffer|null|number} */
    this._readFramebuffer = UNKNOWN;
    /** @type {WebGLRenderbuffer|null|number} */
    this._renderbuffer = UNKNOWN;

    this._viewportX = UNKNOWN;
    this._viewportY = UNKNOWN;
    this._viewportW = UNKNOWN;
    this._viewportH = UNKNOWN;

    this._scissorX = UNKNOWN;
    this._scissorY = UNKNOWN;
    this._scissorW = UNKNOWN;
    this._scissorH = UNKNOWN;
    /** @type {boolean|number} */
    this._scissorTest = UNKNOWN;

    /** @type {boolean|number} */
    this._depthTest = UNKNOWN;
    /** @type {boolean|number} */
    this._depthWrite = UNKNOWN;
    /** @type {number} */
    this._depthFunc = UNKNOWN;
    this._depthRangeNear = UNKNOWN;
    this._depthRangeFar = UNKNOWN;

    /** @type {string|number} 'none' | 'back' | 'front' | 'both' */
    this._cullMode = UNKNOWN;
    /** @type {boolean|number} */
    this._cullEnabled = UNKNOWN;
    /** @type {boolean|number} */
    this._frontFaceCCW = UNKNOWN;

    /** @type {string|number} */
    this._blendMode = UNKNOWN;
    /** @type {boolean|number} */
    this._blendEnabled = UNKNOWN;
    this._blendSrcRGB = UNKNOWN;
    this._blendDstRGB = UNKNOWN;
    this._blendSrcAlpha = UNKNOWN;
    this._blendDstAlpha = UNKNOWN;
    this._blendEquationRGB = UNKNOWN;
    this._blendEquationAlpha = UNKNOWN;

    /** @type {boolean|number} */
    this._colorMaskR = UNKNOWN;
    this._colorMaskG = UNKNOWN;
    this._colorMaskB = UNKNOWN;
    this._colorMaskA = UNKNOWN;

    /** @type {boolean|number} */
    this._polygonOffsetEnabled = UNKNOWN;
    this._polygonOffsetFactor = UNKNOWN;
    this._polygonOffsetUnits = UNKNOWN;

    this._clearR = UNKNOWN;
    this._clearG = UNKNOWN;
    this._clearB = UNKNOWN;
    this._clearA = UNKNOWN;
    this._clearDepth = UNKNOWN;
    this._clearStencil = UNKNOWN;

    this._lineWidth = UNKNOWN;

    /** @type {boolean|number} */
    this._stencilTest = UNKNOWN;
    this._stencilFunc = UNKNOWN;
    this._stencilRef = UNKNOWN;
    this._stencilFuncMask = UNKNOWN;
    this._stencilFail = UNKNOWN;
    this._stencilZFail = UNKNOWN;
    this._stencilZPass = UNKNOWN;
    this._stencilWriteMask = UNKNOWN;

    /** @type {boolean|number} */
    this._rasterizerDiscard = UNKNOWN;

    // --- Pixel store ------------------------------------------------------
    this._unpackFlipY = UNKNOWN;
    this._unpackPremultiply = UNKNOWN;
    this._unpackAlignment = UNKNOWN;
    this._unpackColorspace = UNKNOWN;

    /**
     * Per-frame statistics. Reset by the renderer each frame via `resetStats()`.
     * @type {{calls:number, drawCalls:number, triangles:number, points:number,
     *         lines:number, programSwitches:number, vaoSwitches:number,
     *         textureBinds:number, bufferBinds:number, fboBinds:number,
     *         stateChanges:number}}
     */
    this.stats = {
      calls: 0,
      drawCalls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      programSwitches: 0,
      vaoSwitches: 0,
      textureBinds: 0,
      bufferBinds: 0,
      fboBinds: 0,
      stateChanges: 0
    };

    _registry.set(gl, this);
    this.reset();
  }

  // =======================================================================
  // Programs / VAOs
  // =======================================================================

  /**
   * Binds a shader program.
   * @param {WebGLProgram|null} program
   * @returns {boolean} True when the driver was actually touched.
   */
  useProgram(program) {
    const p = program || null;
    if (this._program === p) return false;
    this._program = p;
    this.gl.useProgram(p);
    this.stats.calls++;
    this.stats.programSwitches++;
    return true;
  }

  /**
   * Binds a vertex array object.
   * Also invalidates the ELEMENT_ARRAY_BUFFER shadow because the index buffer
   * binding is part of the VAO state and changes implicitly here.
   * @param {WebGLVertexArrayObject|null} vao
   * @returns {boolean}
   */
  bindVAO(vao) {
    const v = vao || null;
    if (this._vao === v) return false;
    this._vao = v;
    this.gl.bindVertexArray(v);
    this._buffers[1] = UNKNOWN; // ELEMENT_ARRAY_BUFFER now belongs to the new VAO
    this.stats.calls++;
    this.stats.vaoSwitches++;
    return true;
  }

  /**
   * Currently bound VAO (null when none). Lets resources check whether they are
   * bound without reaching into the private shadow state.
   * @returns {WebGLVertexArrayObject|null}
   */
  getBoundVAO() {
    return this._vao === UNKNOWN ? null : this._vao;
  }

  /**
   * Currently bound program (null when none).
   * @returns {WebGLProgram|null}
   */
  getBoundProgram() {
    return this._program === UNKNOWN ? null : this._program;
  }

  // =======================================================================
  // Buffers
  // =======================================================================

  /**
   * Maps a GL buffer target to a dense cache slot.
   * @param {number} target
   * @returns {number} slot index or -1 when untracked
   * @private
   */
  _bufferIndex(target) {
    switch (target) {
      case GL_ARRAY_BUFFER: return 0;
      case GL_ELEMENT_ARRAY_BUFFER: return 1;
      case GL_UNIFORM_BUFFER: return 2;
      case GL_COPY_READ_BUFFER: return 3;
      case GL_COPY_WRITE_BUFFER: return 4;
      case GL_PIXEL_PACK_BUFFER: return 5;
      case GL_PIXEL_UNPACK_BUFFER: return 6;
      case GL_TRANSFORM_FEEDBACK_BUFFER: return 7;
      default: return -1;
    }
  }

  /**
   * Binds a buffer to a target.
   * @param {number} target GL enum.
   * @param {WebGLBuffer|null} buffer
   * @returns {boolean}
   */
  bindBuffer(target, buffer) {
    const buf = buffer || null;
    const idx = this._bufferIndex(target);
    if (idx >= 0 && this._buffers[idx] === buf) return false;
    if (idx >= 0) this._buffers[idx] = buf;
    this.gl.bindBuffer(target, buf);
    this.stats.calls++;
    this.stats.bufferBinds++;
    return true;
  }

  /**
   * Marks a buffer target as unknown (call after external code touched it).
   * @param {number} target
   */
  invalidateBuffer(target) {
    const idx = this._bufferIndex(target);
    if (idx >= 0) this._buffers[idx] = UNKNOWN;
  }

  /**
   * Binds a whole buffer to an indexed uniform block binding point.
   * @param {number} bindingPoint
   * @param {WebGLBuffer|null} buffer
   * @returns {boolean}
   */
  bindUBO(bindingPoint, buffer) {
    const buf = buffer || null;
    if (this._uboBindings[bindingPoint] === buf) return false;
    this._uboBindings[bindingPoint] = buf;
    this.gl.bindBufferBase(GL_UNIFORM_BUFFER, bindingPoint, buf);
    // bindBufferBase also sets the generic UNIFORM_BUFFER binding point.
    this._buffers[2] = buf;
    this.stats.calls++;
    this.stats.bufferBinds++;
    return true;
  }

  /**
   * Binds a sub range of a buffer to a uniform block binding point.
   * Offsets must respect `Capabilities.uboOffsetAlignment`.
   * @param {number} bindingPoint
   * @param {WebGLBuffer|null} buffer
   * @param {number} offset Byte offset.
   * @param {number} size Byte size.
   */
  bindUBORange(bindingPoint, buffer, offset, size) {
    const buf = buffer || null;
    this._uboBindings[bindingPoint] = UNKNOWN; // ranges are never cached
    this.gl.bindBufferRange(GL_UNIFORM_BUFFER, bindingPoint, buf, offset, size);
    this._buffers[2] = buf;
    this.stats.calls++;
    this.stats.bufferBinds++;
  }

  // =======================================================================
  // Textures
  // =======================================================================

  /**
   * Maps a texture target to a dense per-unit slot.
   * @param {number} target
   * @returns {number}
   * @private
   */
  _textureIndex(target) {
    switch (target) {
      case GL_TEXTURE_2D: return 0;
      case GL_TEXTURE_CUBE_MAP: return 1;
      case GL_TEXTURE_2D_ARRAY: return 2;
      case GL_TEXTURE_3D: return 3;
      default: return 0;
    }
  }

  /**
   * Selects the active texture unit.
   * @param {number} unit
   * @returns {boolean}
   */
  activeTexture(unit) {
    if (this._activeTexture === unit) return false;
    this._activeTexture = unit;
    this.gl.activeTexture(0x84c0 + unit); // GL_TEXTURE0
    this.stats.calls++;
    return true;
  }

  /**
   * Binds a texture to a unit, avoiding both redundant binds and redundant
   * `activeTexture` switches.
   * @param {number} unit
   * @param {number} target GL enum.
   * @param {WebGLTexture|null} texture
   * @returns {boolean}
   */
  bindTexture(unit, target, texture) {
    const tex = texture || null;
    const slot = unit * TEX_TARGET_COUNT + this._textureIndex(target);
    if (this._textures[slot] === tex) return false;
    this._textures[slot] = tex;
    this.activeTexture(unit);
    this.gl.bindTexture(target, tex);
    this.stats.calls++;
    this.stats.textureBinds++;
    return true;
  }

  /**
   * Drops every cached binding of a texture object (call before deleting it,
   * otherwise a recycled GL name could be considered "already bound").
   * @param {WebGLTexture} texture
   */
  invalidateTexture(texture) {
    if (!texture) return;
    const arr = this._textures;
    for (let i = 0, n = arr.length; i < n; i++) {
      if (arr[i] === texture) arr[i] = UNKNOWN;
    }
  }

  /**
   * Marks every target of a texture unit as unknown.
   * @param {number} unit
   */
  invalidateTextureUnit(unit) {
    const base = unit * TEX_TARGET_COUNT;
    for (let i = 0; i < TEX_TARGET_COUNT; i++) this._textures[base + i] = UNKNOWN;
  }

  /**
   * Binds a texture on the reserved scratch unit for creation/parameter work,
   * so that the units used by materials (0..15) are never disturbed.
   *
   * Unlike `bindTexture`, this always selects the scratch unit first, even when
   * the binding itself is already cached. `texStorage*`, `texImage*`,
   * `texSubImage*`, `texParameter*` and `generateMipmap` all act on the texture
   * bound to the ACTIVE unit, so a cached bind without an `activeTexture` would
   * send the update to whatever texture the current active unit happens to hold
   * (INVALID_OPERATION when the formats differ, silent corruption when they
   * match).
   * @param {number} target
   * @param {WebGLTexture|null} texture
   * @returns {number} The unit used.
   */
  bindTextureForUpdate(target, texture) {
    const unit = this.scratchTextureUnit;
    this.activeTexture(unit);
    this.bindTexture(unit, target, texture);
    return unit;
  }

  // =======================================================================
  // Framebuffers / renderbuffers
  // =======================================================================

  /**
   * Binds a framebuffer.
   * @param {number} target GL_FRAMEBUFFER, GL_DRAW_FRAMEBUFFER or GL_READ_FRAMEBUFFER.
   * @param {WebGLFramebuffer|null} fbo
   * @returns {boolean}
   */
  bindFramebuffer(target, fbo) {
    const f = fbo || null;
    if (target === GL_FRAMEBUFFER) {
      if (this._drawFramebuffer === f && this._readFramebuffer === f) return false;
      this._drawFramebuffer = f;
      this._readFramebuffer = f;
    } else if (target === GL_DRAW_FRAMEBUFFER) {
      if (this._drawFramebuffer === f) return false;
      this._drawFramebuffer = f;
    } else if (target === GL_READ_FRAMEBUFFER) {
      if (this._readFramebuffer === f) return false;
      this._readFramebuffer = f;
    }
    this.gl.bindFramebuffer(target, f);
    this.stats.calls++;
    this.stats.fboBinds++;
    return true;
  }

  /**
   * Drops every cached binding of a framebuffer (call before deleting it).
   * @param {WebGLFramebuffer} fbo
   */
  invalidateFramebuffer(fbo) {
    if (this._drawFramebuffer === fbo) this._drawFramebuffer = UNKNOWN;
    if (this._readFramebuffer === fbo) this._readFramebuffer = UNKNOWN;
  }

  /**
   * Binds a renderbuffer.
   * @param {WebGLRenderbuffer|null} rb
   * @returns {boolean}
   */
  bindRenderbuffer(rb) {
    const r = rb || null;
    if (this._renderbuffer === r) return false;
    this._renderbuffer = r;
    this.gl.bindRenderbuffer(0x8d41, r); // GL_RENDERBUFFER
    this.stats.calls++;
    return true;
  }

  // =======================================================================
  // Viewport / scissor
  // =======================================================================

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @returns {boolean}
   */
  viewport(x, y, width, height) {
    if (this._viewportX === x && this._viewportY === y &&
        this._viewportW === width && this._viewportH === height) return false;
    this._viewportX = x;
    this._viewportY = y;
    this._viewportW = width;
    this._viewportH = height;
    this.gl.viewport(x, y, width, height);
    this.stats.calls++;
    return true;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @returns {boolean}
   */
  scissor(x, y, width, height) {
    if (this._scissorX === x && this._scissorY === y &&
        this._scissorW === width && this._scissorH === height) return false;
    this._scissorX = x;
    this._scissorY = y;
    this._scissorW = width;
    this._scissorH = height;
    this.gl.scissor(x, y, width, height);
    this.stats.calls++;
    return true;
  }

  /**
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setScissorTest(enabled) {
    const e = !!enabled;
    if (this._scissorTest === e) return false;
    this._scissorTest = e;
    if (e) this.gl.enable(0x0c11); else this.gl.disable(0x0c11); // GL_SCISSOR_TEST
    this.stats.calls++;
    this.stats.stateChanges++;
    return true;
  }

  // =======================================================================
  // Depth
  // =======================================================================

  /**
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setDepthTest(enabled) {
    const e = !!enabled;
    if (this._depthTest === e) return false;
    this._depthTest = e;
    if (e) this.gl.enable(0x0b71); else this.gl.disable(0x0b71); // GL_DEPTH_TEST
    this.stats.calls++;
    this.stats.stateChanges++;
    return true;
  }

  /**
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setDepthWrite(enabled) {
    const e = !!enabled;
    if (this._depthWrite === e) return false;
    this._depthWrite = e;
    this.gl.depthMask(e);
    this.stats.calls++;
    this.stats.stateChanges++;
    return true;
  }

  /**
   * @param {string|number} func Name ('less', 'lequal', ...) or GL enum.
   * @returns {boolean}
   */
  setDepthFunc(func) {
    const f = typeof func === 'number' ? func : (COMPARE_FUNCS[func] || COMPARE_FUNCS.less);
    if (this._depthFunc === f) return false;
    this._depthFunc = f;
    this.gl.depthFunc(f);
    this.stats.calls++;
    this.stats.stateChanges++;
    return true;
  }

  /**
   * @param {number} near
   * @param {number} far
   * @returns {boolean}
   */
  setDepthRange(near, far) {
    if (this._depthRangeNear === near && this._depthRangeFar === far) return false;
    this._depthRangeNear = near;
    this._depthRangeFar = far;
    this.gl.depthRange(near, far);
    this.stats.calls++;
    return true;
  }

  // =======================================================================
  // Rasterizer
  // =======================================================================

  /**
   * @param {string} mode 'none' | 'back' | 'front' | 'both'
   * @returns {boolean}
   */
  setCullFace(mode) {
    if (this._cullMode === mode) return false;
    this._cullMode = mode;
    const gl = this.gl;
    if (mode === 'none') {
      if (this._cullEnabled !== false) {
        this._cullEnabled = false;
        gl.disable(0x0b44); // GL_CULL_FACE
        this.stats.calls++;
      }
    } else {
      if (this._cullEnabled !== true) {
        this._cullEnabled = true;
        gl.enable(0x0b44);
        this.stats.calls++;
      }
      let face = 0x0405; // GL_BACK
      if (mode === 'front') face = 0x0404; // GL_FRONT
      else if (mode === 'both') face = 0x0408; // GL_FRONT_AND_BACK
      gl.cullFace(face);
      this.stats.calls++;
    }
    this.stats.stateChanges++;
    return true;
  }

  /**
   * @param {boolean} ccw True for counter-clockwise front faces (engine default).
   * @returns {boolean}
   */
  setFrontFace(ccw) {
    const e = !!ccw;
    if (this._frontFaceCCW === e) return false;
    this._frontFaceCCW = e;
    this.gl.frontFace(e ? 0x0901 : 0x0900); // GL_CCW : GL_CW
    this.stats.calls++;
    this.stats.stateChanges++;
    return true;
  }

  /**
   * @param {boolean} enabled
   * @param {number} [factor=1]
   * @param {number} [units=1]
   * @returns {boolean}
   */
  setPolygonOffset(enabled, factor, units) {
    const e = !!enabled;
    const gl = this.gl;
    let changed = false;
    if (this._polygonOffsetEnabled !== e) {
      this._polygonOffsetEnabled = e;
      if (e) gl.enable(0x8037); else gl.disable(0x8037); // GL_POLYGON_OFFSET_FILL
      this.stats.calls++;
      changed = true;
    }
    if (e) {
      const f = factor === undefined ? 1 : factor;
      const u = units === undefined ? 1 : units;
      if (this._polygonOffsetFactor !== f || this._polygonOffsetUnits !== u) {
        this._polygonOffsetFactor = f;
        this._polygonOffsetUnits = u;
        gl.polygonOffset(f, u);
        this.stats.calls++;
        changed = true;
      }
    }
    if (changed) this.stats.stateChanges++;
    return changed;
  }

  /**
   * WebGL2 only guarantees a line width of 1; kept for completeness.
   * @param {number} width
   * @returns {boolean}
   */
  setLineWidth(width) {
    if (this._lineWidth === width) return false;
    this._lineWidth = width;
    this.gl.lineWidth(width);
    this.stats.calls++;
    return true;
  }

  /**
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setRasterizerDiscard(enabled) {
    const e = !!enabled;
    if (this._rasterizerDiscard === e) return false;
    this._rasterizerDiscard = e;
    if (e) this.gl.enable(0x8c89); else this.gl.disable(0x8c89); // GL_RASTERIZER_DISCARD
    this.stats.calls++;
    return true;
  }

  // =======================================================================
  // Blending / color mask
  // =======================================================================

  /**
   * Applies one of the engine blend presets.
   * @param {string} mode 'none' | 'normal' | 'additive' | 'multiply' | 'premultiplied'
   * @returns {boolean}
   */
  setBlending(mode) {
    if (this._blendMode === mode) return false;
    this._blendMode = mode;

    if (mode === 'none' || !mode) {
      if (this._blendEnabled !== false) {
        this._blendEnabled = false;
        this.gl.disable(0x0be2); // GL_BLEND
        this.stats.calls++;
        this.stats.stateChanges++;
      }
      return true;
    }

    if (this._blendEnabled !== true) {
      this._blendEnabled = true;
      this.gl.enable(0x0be2);
      this.stats.calls++;
    }

    const ZERO = 0;
    const ONE = 1;
    const SRC_ALPHA = 0x0302;
    const ONE_MINUS_SRC_ALPHA = 0x0303;
    const DST_COLOR = 0x0306;
    const DST_ALPHA = 0x0304;
    const FUNC_ADD = 0x8006;

    switch (mode) {
      case 'additive':
        this._applyBlendFunc(SRC_ALPHA, ONE, ONE, ONE, FUNC_ADD, FUNC_ADD);
        break;
      case 'multiply':
        this._applyBlendFunc(DST_COLOR, ZERO, DST_ALPHA, ZERO, FUNC_ADD, FUNC_ADD);
        break;
      case 'premultiplied':
        this._applyBlendFunc(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA, FUNC_ADD, FUNC_ADD);
        break;
      case 'normal':
      default:
        this._applyBlendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA, FUNC_ADD, FUNC_ADD);
        break;
    }
    this.stats.stateChanges++;
    return true;
  }

  /**
   * Applies a fully custom separate blend function; switches the cached mode to
   * 'custom' so a later preset re-applies correctly.
   * @param {number} srcRGB
   * @param {number} dstRGB
   * @param {number} srcAlpha
   * @param {number} dstAlpha
   * @param {number} [equationRGB=0x8006]
   * @param {number} [equationAlpha=0x8006]
   */
  setBlendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha, equationRGB, equationAlpha) {
    if (this._blendEnabled !== true) {
      this._blendEnabled = true;
      this.gl.enable(0x0be2);
      this.stats.calls++;
    }
    this._blendMode = 'custom';
    this._applyBlendFunc(
      srcRGB, dstRGB, srcAlpha, dstAlpha,
      equationRGB === undefined ? 0x8006 : equationRGB,
      equationAlpha === undefined ? (equationRGB === undefined ? 0x8006 : equationRGB) : equationAlpha
    );
  }

  /**
   * @private
   */
  _applyBlendFunc(srcRGB, dstRGB, srcAlpha, dstAlpha, eqRGB, eqAlpha) {
    const gl = this.gl;
    if (this._blendSrcRGB !== srcRGB || this._blendDstRGB !== dstRGB ||
        this._blendSrcAlpha !== srcAlpha || this._blendDstAlpha !== dstAlpha) {
      this._blendSrcRGB = srcRGB;
      this._blendDstRGB = dstRGB;
      this._blendSrcAlpha = srcAlpha;
      this._blendDstAlpha = dstAlpha;
      gl.blendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha);
      this.stats.calls++;
    }
    if (this._blendEquationRGB !== eqRGB || this._blendEquationAlpha !== eqAlpha) {
      this._blendEquationRGB = eqRGB;
      this._blendEquationAlpha = eqAlpha;
      gl.blendEquationSeparate(eqRGB, eqAlpha);
      this.stats.calls++;
    }
  }

  /**
   * @param {boolean} r
   * @param {boolean} g
   * @param {boolean} b
   * @param {boolean} a
   * @returns {boolean}
   */
  setColorMask(r, g, b, a) {
    const rr = !!r;
    const gg = !!g;
    const bb = !!b;
    const aa = !!a;
    if (this._colorMaskR === rr && this._colorMaskG === gg &&
        this._colorMaskB === bb && this._colorMaskA === aa) return false;
    this._colorMaskR = rr;
    this._colorMaskG = gg;
    this._colorMaskB = bb;
    this._colorMaskA = aa;
    this.gl.colorMask(rr, gg, bb, aa);
    this.stats.calls++;
    this.stats.stateChanges++;
    return true;
  }

  // =======================================================================
  // Stencil
  // =======================================================================

  /**
   * @param {boolean} enabled
   * @returns {boolean}
   */
  setStencilTest(enabled) {
    const e = !!enabled;
    if (this._stencilTest === e) return false;
    this._stencilTest = e;
    if (e) this.gl.enable(0x0b90); else this.gl.disable(0x0b90); // GL_STENCIL_TEST
    this.stats.calls++;
    return true;
  }

  /**
   * @param {string|number} func
   * @param {number} ref
   * @param {number} mask
   * @returns {boolean}
   */
  setStencilFunc(func, ref, mask) {
    const f = typeof func === 'number' ? func : (COMPARE_FUNCS[func] || COMPARE_FUNCS.always);
    if (this._stencilFunc === f && this._stencilRef === ref && this._stencilFuncMask === mask) return false;
    this._stencilFunc = f;
    this._stencilRef = ref;
    this._stencilFuncMask = mask;
    this.gl.stencilFunc(f, ref, mask);
    this.stats.calls++;
    return true;
  }

  /**
   * @param {string|number} fail
   * @param {string|number} zfail
   * @param {string|number} zpass
   * @returns {boolean}
   */
  setStencilOp(fail, zfail, zpass) {
    const f = typeof fail === 'number' ? fail : (STENCIL_OPS[fail] !== undefined ? STENCIL_OPS[fail] : STENCIL_OPS.keep);
    const zf = typeof zfail === 'number' ? zfail : (STENCIL_OPS[zfail] !== undefined ? STENCIL_OPS[zfail] : STENCIL_OPS.keep);
    const zp = typeof zpass === 'number' ? zpass : (STENCIL_OPS[zpass] !== undefined ? STENCIL_OPS[zpass] : STENCIL_OPS.keep);
    if (this._stencilFail === f && this._stencilZFail === zf && this._stencilZPass === zp) return false;
    this._stencilFail = f;
    this._stencilZFail = zf;
    this._stencilZPass = zp;
    this.gl.stencilOp(f, zf, zp);
    this.stats.calls++;
    return true;
  }

  /**
   * @param {number} mask
   * @returns {boolean}
   */
  setStencilMask(mask) {
    if (this._stencilWriteMask === mask) return false;
    this._stencilWriteMask = mask;
    this.gl.stencilMask(mask);
    this.stats.calls++;
    return true;
  }

  // =======================================================================
  // Pixel store
  // =======================================================================

  /**
   * @param {boolean} flipY
   * @param {boolean} premultiply
   * @param {number} alignment 1, 2, 4 or 8.
   */
  setPixelStore(flipY, premultiply, alignment) {
    const gl = this.gl;
    const f = !!flipY;
    const p = !!premultiply;
    if (this._unpackFlipY !== f) {
      this._unpackFlipY = f;
      gl.pixelStorei(0x9240, f); // UNPACK_FLIP_Y_WEBGL
      this.stats.calls++;
    }
    if (this._unpackPremultiply !== p) {
      this._unpackPremultiply = p;
      gl.pixelStorei(0x9241, p); // UNPACK_PREMULTIPLY_ALPHA_WEBGL
      this.stats.calls++;
    }
    if (alignment !== undefined && this._unpackAlignment !== alignment) {
      this._unpackAlignment = alignment;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      this.stats.calls++;
    }
  }

  // =======================================================================
  // Clearing
  // =======================================================================

  /**
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @param {number} a
   * @returns {boolean}
   */
  setClearColor(r, g, b, a) {
    const aa = a === undefined ? 1 : a;
    if (this._clearR === r && this._clearG === g && this._clearB === b && this._clearA === aa) return false;
    this._clearR = r;
    this._clearG = g;
    this._clearB = b;
    this._clearA = aa;
    this.gl.clearColor(r, g, b, aa);
    this.stats.calls++;
    return true;
  }

  /**
   * @param {number} depth
   * @returns {boolean}
   */
  setClearDepth(depth) {
    if (this._clearDepth === depth) return false;
    this._clearDepth = depth;
    this.gl.clearDepth(depth);
    this.stats.calls++;
    return true;
  }

  /**
   * @param {number} value
   * @returns {boolean}
   */
  setClearStencil(value) {
    if (this._clearStencil === value) return false;
    this._clearStencil = value;
    this.gl.clearStencil(value);
    this.stats.calls++;
    return true;
  }

  /**
   * Clears the bound framebuffer. Automatically re-enables the write masks that
   * a clear requires (a disabled depth mask silently discards a depth clear).
   * @param {boolean} [color=true]
   * @param {boolean} [depth=true]
   * @param {boolean} [stencil=false]
   */
  clear(color, depth, stencil) {
    const doColor = color === undefined ? true : !!color;
    const doDepth = depth === undefined ? true : !!depth;
    const doStencil = stencil === undefined ? false : !!stencil;

    let bits = 0;
    if (doColor) {
      this.setColorMask(true, true, true, true);
      bits |= 0x00004000; // GL_COLOR_BUFFER_BIT
    }
    if (doDepth) {
      this.setDepthWrite(true);
      bits |= 0x00000100; // GL_DEPTH_BUFFER_BIT
    }
    if (doStencil) {
      this.setStencilMask(0xff);
      bits |= 0x00000400; // GL_STENCIL_BUFFER_BIT
    }
    if (bits !== 0) {
      this.gl.clear(bits);
      this.stats.calls++;
    }
  }

  // =======================================================================
  // Material state
  // =======================================================================

  /**
   * Applies the render state block of a Material in one shot.
   * @param {Object} material
   */
  applyMaterialState(material) {
    this.setDepthTest(material.depthTest !== false);
    this.setDepthWrite(material.depthWrite !== false);
    this.setDepthFunc(material.depthFunc || 'less');

    const side = material.side || 'front';
    if (side === 'double') this.setCullFace('none');
    else if (side === 'back') this.setCullFace('front');
    else this.setCullFace('back');

    let blending = material.blending;
    if (!blending || blending === 'none') blending = material.transparent ? 'normal' : 'none';
    this.setBlending(blending);

    this.setPolygonOffset(
      !!material.polygonOffset,
      material.polygonOffsetFactor,
      material.polygonOffsetUnits
    );

    const write = material.colorWrite !== false;
    this.setColorMask(write, write, write, write);
  }

  // =======================================================================
  // Draw helpers (keep the statistics honest)
  // =======================================================================

  /**
   * Counts primitives for the statistics block.
   * @param {number} mode GL primitive mode.
   * @param {number} count Vertex/index count.
   * @param {number} instances
   * @private
   */
  _countPrimitives(mode, count, instances) {
    const n = instances > 0 ? instances : 1;
    switch (mode) {
      case 0x0004: // TRIANGLES
        this.stats.triangles += (count / 3) * n;
        break;
      case 0x0005: // TRIANGLE_STRIP
      case 0x0006: // TRIANGLE_FAN
        this.stats.triangles += (count >= 3 ? count - 2 : 0) * n;
        break;
      case 0x0001: // LINES
        this.stats.lines += (count / 2) * n;
        break;
      case 0x0003: // LINE_STRIP
        this.stats.lines += (count >= 2 ? count - 1 : 0) * n;
        break;
      case 0x0002: // LINE_LOOP
        this.stats.lines += count * n;
        break;
      case 0x0000: // POINTS
        this.stats.points += count * n;
        break;
      default:
        break;
    }
  }

  /**
   * @param {number} mode
   * @param {number} first
   * @param {number} count
   */
  drawArrays(mode, first, count) {
    this.gl.drawArrays(mode, first, count);
    this.stats.calls++;
    this.stats.drawCalls++;
    this._countPrimitives(mode, count, 1);
  }

  /**
   * @param {number} mode
   * @param {number} count
   * @param {number} type
   * @param {number} byteOffset
   */
  drawElements(mode, count, type, byteOffset) {
    this.gl.drawElements(mode, count, type, byteOffset);
    this.stats.calls++;
    this.stats.drawCalls++;
    this._countPrimitives(mode, count, 1);
  }

  /**
   * @param {number} mode
   * @param {number} first
   * @param {number} count
   * @param {number} instanceCount
   */
  drawArraysInstanced(mode, first, count, instanceCount) {
    this.gl.drawArraysInstanced(mode, first, count, instanceCount);
    this.stats.calls++;
    this.stats.drawCalls++;
    this._countPrimitives(mode, count, instanceCount);
  }

  /**
   * @param {number} mode
   * @param {number} count
   * @param {number} type
   * @param {number} byteOffset
   * @param {number} instanceCount
   */
  drawElementsInstanced(mode, count, type, byteOffset, instanceCount) {
    this.gl.drawElementsInstanced(mode, count, type, byteOffset, instanceCount);
    this.stats.calls++;
    this.stats.drawCalls++;
    this._countPrimitives(mode, count, instanceCount);
  }

  // =======================================================================
  // Lifecycle
  // =======================================================================

  /** Zeroes the per-frame statistics. */
  resetStats() {
    const s = this.stats;
    s.calls = 0;
    s.drawCalls = 0;
    s.triangles = 0;
    s.points = 0;
    s.lines = 0;
    s.programSwitches = 0;
    s.vaoSwitches = 0;
    s.textureBinds = 0;
    s.bufferBinds = 0;
    s.fboBinds = 0;
    s.stateChanges = 0;
  }

  /**
   * Invalidates the whole shadow state and pushes a known default state to the
   * driver. Call this whenever foreign code (a devtools overlay, another
   * library, a context restore) may have touched the GL state machine.
   */
  reset() {
    const gl = this.gl;

    this._program = UNKNOWN;
    this._vao = UNKNOWN;
    for (let i = 0; i < 8; i++) this._buffers[i] = UNKNOWN;
    for (let i = 0, n = this._textures.length; i < n; i++) this._textures[i] = UNKNOWN;
    for (let i = 0, n = this._uboBindings.length; i < n; i++) this._uboBindings[i] = UNKNOWN;
    this._activeTexture = UNKNOWN;
    this._drawFramebuffer = UNKNOWN;
    this._readFramebuffer = UNKNOWN;
    this._renderbuffer = UNKNOWN;
    this._viewportX = UNKNOWN;
    this._viewportY = UNKNOWN;
    this._viewportW = UNKNOWN;
    this._viewportH = UNKNOWN;
    this._scissorX = UNKNOWN;
    this._scissorY = UNKNOWN;
    this._scissorW = UNKNOWN;
    this._scissorH = UNKNOWN;
    this._scissorTest = UNKNOWN;
    this._depthTest = UNKNOWN;
    this._depthWrite = UNKNOWN;
    this._depthFunc = UNKNOWN;
    this._depthRangeNear = UNKNOWN;
    this._depthRangeFar = UNKNOWN;
    this._cullMode = UNKNOWN;
    this._cullEnabled = UNKNOWN;
    this._frontFaceCCW = UNKNOWN;
    this._blendMode = UNKNOWN;
    this._blendEnabled = UNKNOWN;
    this._blendSrcRGB = UNKNOWN;
    this._blendDstRGB = UNKNOWN;
    this._blendSrcAlpha = UNKNOWN;
    this._blendDstAlpha = UNKNOWN;
    this._blendEquationRGB = UNKNOWN;
    this._blendEquationAlpha = UNKNOWN;
    this._colorMaskR = UNKNOWN;
    this._colorMaskG = UNKNOWN;
    this._colorMaskB = UNKNOWN;
    this._colorMaskA = UNKNOWN;
    this._polygonOffsetEnabled = UNKNOWN;
    this._polygonOffsetFactor = UNKNOWN;
    this._polygonOffsetUnits = UNKNOWN;
    this._clearR = UNKNOWN;
    this._clearG = UNKNOWN;
    this._clearB = UNKNOWN;
    this._clearA = UNKNOWN;
    this._clearDepth = UNKNOWN;
    this._clearStencil = UNKNOWN;
    this._lineWidth = UNKNOWN;
    this._stencilTest = UNKNOWN;
    this._stencilFunc = UNKNOWN;
    this._stencilRef = UNKNOWN;
    this._stencilFuncMask = UNKNOWN;
    this._stencilFail = UNKNOWN;
    this._stencilZFail = UNKNOWN;
    this._stencilZPass = UNKNOWN;
    this._stencilWriteMask = UNKNOWN;
    this._rasterizerDiscard = UNKNOWN;
    this._unpackFlipY = UNKNOWN;
    this._unpackPremultiply = UNKNOWN;
    this._unpackAlignment = UNKNOWN;

    // Push a deterministic default state so cache and driver agree.
    this.useProgram(null);
    this.bindVAO(null);
    this.bindFramebuffer(GL_FRAMEBUFFER, null);
    this.setDepthTest(true);
    this.setDepthWrite(true);
    this.setDepthFunc('less');
    this.setDepthRange(0, 1);
    this.setCullFace('back');
    this.setFrontFace(true);
    this.setBlending('none');
    this.setColorMask(true, true, true, true);
    this.setPolygonOffset(false, 0, 0);
    this.setScissorTest(false);
    this.setStencilTest(false);
    this.setStencilMask(0xff);
    this.setRasterizerDiscard(false);
    this.setClearColor(0, 0, 0, 1);
    this.setClearDepth(1);
    this.setClearStencil(0);
    this.setLineWidth(1);
    this.setPixelStore(false, false, 4);

    gl.activeTexture(0x84c0);
    this._activeTexture = 0;
  }

  /** Releases the registry entry. The GL context itself is not destroyed here. */
  dispose() {
    _registry.delete(this.gl);
  }
}
