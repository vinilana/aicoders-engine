/**
 * RenderTarget: framebuffer object with MRT, optional MSAA and layered
 * attachments.
 *
 * Three configurations are supported:
 *  - plain: color textures + depth renderbuffer/texture;
 *  - MSAA: multisampled renderbuffers rendered into, then resolved with
 *    `blitFramebuffer` into the texture-backed FBO on `unbind()`;
 *  - layered: 2D-array or cube attachments, one layer/face bound at a time via
 *    `bindLayer()` - this is what the cascaded shadow mapper uses.
 */

import { Texture, resolveFormat } from './Texture.js';
import { getStateCache } from './StateCache.js';

const GL_FRAMEBUFFER = 0x8d40;
const GL_READ_FRAMEBUFFER = 0x8ca8;
const GL_DRAW_FRAMEBUFFER = 0x8ca9;
const GL_RENDERBUFFER = 0x8d41;

const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_DEPTH_ATTACHMENT = 0x8d00;
const GL_STENCIL_ATTACHMENT = 0x8d20;
const GL_DEPTH_STENCIL_ATTACHMENT = 0x821a;

const GL_TEXTURE_2D = 0x0de1;
const GL_TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;

const GL_COLOR_BUFFER_BIT = 0x4000;
const GL_DEPTH_BUFFER_BIT = 0x0100;
const GL_STENCIL_BUFFER_BIT = 0x0400;

const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_NONE = 0;

/** Framebuffer status enum -> readable cause. */
const FBO_STATUS = {
  0x8cd6: 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT (anexo invalido ou formato nao renderizavel)',
  0x8cd7: 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT (nenhum anexo valido)',
  0x8cd9: 'FRAMEBUFFER_INCOMPLETE_DIMENSIONS (anexos com tamanhos diferentes)',
  0x8cdd: 'FRAMEBUFFER_UNSUPPORTED (combinacao de formatos nao suportada pelo driver)',
  0x8d56: 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE (contagem de amostras inconsistente entre anexos)',
  0x9241: 'FRAMEBUFFER_INCOMPLETE_LAYER_TARGETS (anexos em camadas inconsistentes)'
};

let _nextRTId = 1;
let _totalRenderbufferBytes = 0;

/**
 * Off-screen render destination.
 */
export class RenderTarget {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} width
   * @param {number} height
   * @param {Object} [options]
   * @param {number} [options.colorAttachments=1] 0..4 color textures (0 = depth only).
   * @param {string|string[]} [options.colorFormat='rgba8'] One format, or one per attachment.
   * @param {boolean} [options.depth=true] Attach a depth buffer.
   * @param {boolean} [options.depthTexture=false] Depth as a sampleable texture.
   * @param {string} [options.depthFormat='depth24']
   * @param {number} [options.samples=0] MSAA sample count (0 = disabled).
   * @param {string} [options.wrap='clamp']
   * @param {string} [options.filter='linear']
   * @param {number} [options.layers=1] Layer count (creates 2D-array attachments).
   * @param {boolean} [options.isCube=false] Cube map attachments.
   * @param {boolean} [options.generateMipmaps=false]
   * @param {boolean} [options.compareMode=false] Shadow comparison on the depth texture.
   * @param {import('./StateCache.js').StateCache} [options.state]
   */
  constructor(gl, width, height, options = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {number} */
    this.uid = _nextRTId++;
    /** @type {string} */
    this.name = options.name || '';
    /** @type {number} */
    this.width = Math.max(1, width | 0);
    /** @type {number} */
    this.height = Math.max(1, height | 0);

    /** @private */
    this._stateRef = options.state || null;

    const layers = Math.max(1, (options.layers || 1) | 0);
    const isCube = !!options.isCube;

    /** @type {number} */
    this.layers = layers;
    /** @type {boolean} */
    this.isCube = isCube;
    /** @type {boolean} */
    this.isLayered = layers > 1 && !isCube;

    /** @type {number} */
    this.colorAttachmentCount = options.colorAttachments === undefined ? 1 : (options.colorAttachments | 0);
    /** @type {string|string[]} */
    this.colorFormat = options.colorFormat || 'rgba8';
    /** @type {boolean} */
    this.hasDepth = options.depth !== false;
    /** @type {boolean} */
    this.useDepthTexture = !!options.depthTexture;
    /** @type {string} */
    this.depthFormat = options.depthFormat || 'depth24';
    /** @type {string} */
    this.wrap = options.wrap || 'clamp';
    /** @type {string} */
    this.filter = options.filter || 'linear';
    /** @type {boolean} */
    this.generateMipmaps = !!options.generateMipmaps;
    /** @type {boolean} */
    this.compareMode = !!options.compareMode;

    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) | 0;
    let samples = (options.samples || 0) | 0;
    if (samples > maxSamples) samples = maxSamples;
    if (samples <= 1) samples = 0;
    // Multisampled renderbuffers cannot be layered or cube.
    if (this.isLayered || isCube) samples = 0;
    /** @type {number} */
    this.samples = samples;

    /** @type {Texture[]} Resolved color textures. */
    this.textures = [];
    /** @type {Texture|null} */
    this.depthTexture = null;
    /** @type {WebGLFramebuffer|null} Texture-backed FBO. */
    this.resolveFramebuffer = null;
    /** @type {WebGLFramebuffer|null} FBO actually rendered into. */
    this.framebuffer = null;
    /** @type {WebGLRenderbuffer|null} */
    this.depthRenderbuffer = null;
    /** @type {WebGLRenderbuffer[]} */
    this.colorRenderbuffers = [];
    /** @type {number} Currently bound layer/face. */
    this.currentLayer = 0;
    /** @type {boolean} */
    this.disposed = false;
    /** @private */
    this._needsResolve = false;
    /** @private */
    this._drawBuffers = null;

    this._build();
  }

  /**
   * Alias kept for contract compatibility: the FBO the renderer binds.
   * @type {WebGLFramebuffer|null}
   */
  get id() {
    return this.framebuffer;
  }

  /** First color texture (the common case). @type {Texture|null} */
  get texture() {
    return this.textures.length > 0 ? this.textures[0] : null;
  }

  /**
   * Resolves the state cache used for internal binds.
   * @returns {import('./StateCache.js').StateCache|null}
   * @private
   */
  _state() {
    if (this._stateRef) return this._stateRef;
    this._stateRef = getStateCache(this.gl);
    return this._stateRef;
  }

  /**
   * Binds a framebuffer through the cache when available.
   * @param {number} target
   * @param {WebGLFramebuffer|null} fbo
   * @private
   */
  _bindFBO(target, fbo) {
    const st = this._state();
    if (st) st.bindFramebuffer(target, fbo);
    else this.gl.bindFramebuffer(target, fbo);
  }

  /**
   * Color format for attachment i.
   * @param {number} i
   * @returns {string}
   * @private
   */
  _formatFor(i) {
    if (Array.isArray(this.colorFormat)) {
      return this.colorFormat[i] || this.colorFormat[this.colorFormat.length - 1];
    }
    return this.colorFormat;
  }

  /**
   * Creates every GL resource.
   * @private
   */
  _build() {
    const gl = this.gl;
    const st = this._state();

    // ---- Texture-backed FBO --------------------------------------------
    this.resolveFramebuffer = gl.createFramebuffer();
    this._bindFBO(GL_FRAMEBUFFER, this.resolveFramebuffer);

    const target = this.isCube ? 'cube' : (this.isLayered ? '2d-array' : '2d');

    for (let i = 0; i < this.colorAttachmentCount; i++) {
      const tex = new Texture(gl, {
        target,
        width: this.width,
        height: this.height,
        depth: this.isLayered ? this.layers : 1,
        internalFormat: this._formatFor(i),
        minFilter: this.generateMipmaps ? 'linear-mipmap-linear' : this.filter,
        magFilter: this.filter,
        wrapS: this.wrap,
        wrapT: this.wrap,
        wrapR: this.wrap,
        generateMipmaps: this.generateMipmaps,
        state: st
      });
      tex.name = (this.name || 'rt') + '.color' + i;
      this.textures.push(tex);
      this._attachColor(i, tex, 0, 0);
    }

    // ---- Depth ----------------------------------------------------------
    if (this.hasDepth) {
      const depthDesc = resolveFormat(gl, this.depthFormat);
      const attachment = depthDesc.isStencil ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT;

      if (this.useDepthTexture) {
        this.depthTexture = new Texture(gl, {
          target,
          width: this.width,
          height: this.height,
          depth: this.isLayered ? this.layers : 1,
          internalFormat: this.depthFormat,
          minFilter: this.compareMode ? 'linear' : 'nearest',
          magFilter: this.compareMode ? 'linear' : 'nearest',
          wrapS: 'clamp',
          wrapT: 'clamp',
          wrapR: 'clamp',
          generateMipmaps: false,
          compareMode: this.compareMode,
          state: st
        });
        this.depthTexture.name = (this.name || 'rt') + '.depth';
        this._attachTexture(attachment, this.depthTexture, 0, 0);
      } else if (this.samples === 0) {
        this.depthRenderbuffer = this._createRenderbuffer(depthDesc.internalFormat, 0);
        gl.framebufferRenderbuffer(GL_FRAMEBUFFER, attachment, GL_RENDERBUFFER, this.depthRenderbuffer);
      }
    }

    this._setupDrawBuffers();
    this._checkStatus('resolve');

    // ---- Multisampled FBO ----------------------------------------------
    if (this.samples > 0) {
      this.framebuffer = gl.createFramebuffer();
      this._bindFBO(GL_FRAMEBUFFER, this.framebuffer);

      for (let i = 0; i < this.colorAttachmentCount; i++) {
        const desc = resolveFormat(gl, this._formatFor(i));
        const rb = this._createRenderbuffer(desc.internalFormat, this.samples);
        this.colorRenderbuffers.push(rb);
        gl.framebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0 + i, GL_RENDERBUFFER, rb);
      }

      if (this.hasDepth) {
        const depthDesc = resolveFormat(gl, this.depthFormat);
        const attachment = depthDesc.isStencil ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT;
        this.depthRenderbuffer = this._createRenderbuffer(depthDesc.internalFormat, this.samples);
        gl.framebufferRenderbuffer(GL_FRAMEBUFFER, attachment, GL_RENDERBUFFER, this.depthRenderbuffer);
      }

      this._setupDrawBuffers();
      this._checkStatus('msaa');
    } else {
      this.framebuffer = this.resolveFramebuffer;
    }

    this._bindFBO(GL_FRAMEBUFFER, null);
  }

  /**
   * Creates a (possibly multisampled) renderbuffer and accounts its memory.
   * @param {number} internalFormat
   * @param {number} samples
   * @returns {WebGLRenderbuffer}
   * @private
   */
  _createRenderbuffer(internalFormat, samples) {
    const gl = this.gl;
    const st = this._state();
    const rb = gl.createRenderbuffer();
    if (st) st.bindRenderbuffer(rb);
    else gl.bindRenderbuffer(GL_RENDERBUFFER, rb);

    if (samples > 0) {
      gl.renderbufferStorageMultisample(GL_RENDERBUFFER, samples, internalFormat, this.width, this.height);
    } else {
      gl.renderbufferStorage(GL_RENDERBUFFER, internalFormat, this.width, this.height);
    }

    _totalRenderbufferBytes += this.width * this.height * 4 * Math.max(1, samples);
    return rb;
  }

  /**
   * Attaches a color texture (layer/face aware).
   * @private
   */
  _attachColor(index, tex, layer, level) {
    this._attachTexture(GL_COLOR_ATTACHMENT0 + index, tex, layer, level);
  }

  /**
   * Attaches a texture to an attachment point.
   * @param {number} attachment
   * @param {Texture} tex
   * @param {number} layer
   * @param {number} level
   * @private
   */
  _attachTexture(attachment, tex, layer, level) {
    const gl = this.gl;
    if (tex.isCube) {
      gl.framebufferTexture2D(GL_FRAMEBUFFER, attachment,
        GL_TEXTURE_CUBE_MAP_POSITIVE_X + layer, tex.id, level);
    } else if (tex.isVolume) {
      gl.framebufferTextureLayer(GL_FRAMEBUFFER, attachment, tex.id, level, layer);
    } else {
      gl.framebufferTexture2D(GL_FRAMEBUFFER, attachment, GL_TEXTURE_2D, tex.id, level);
    }
  }

  /**
   * Declares the draw buffers of the currently bound FBO.
   * @private
   */
  _setupDrawBuffers() {
    const gl = this.gl;
    if (this.colorAttachmentCount === 0) {
      gl.drawBuffers([GL_NONE]);
      gl.readBuffer(GL_NONE);
      return;
    }
    if (!this._drawBuffers || this._drawBuffers.length !== this.colorAttachmentCount) {
      this._drawBuffers = new Array(this.colorAttachmentCount);
    }
    for (let i = 0; i < this.colorAttachmentCount; i++) {
      this._drawBuffers[i] = GL_COLOR_ATTACHMENT0 + i;
    }
    gl.drawBuffers(this._drawBuffers);
  }

  /**
   * Restricts rendering to a subset of the color attachments.
   * @param {number[]|null} indices Attachment indices, or null to restore all.
   * @returns {RenderTarget} this
   */
  setDrawBuffers(indices) {
    const gl = this.gl;
    this._bindFBO(GL_FRAMEBUFFER, this.framebuffer);
    if (!indices) {
      this._setupDrawBuffers();
      return this;
    }
    const list = new Array(this.colorAttachmentCount);
    for (let i = 0; i < this.colorAttachmentCount; i++) list[i] = GL_NONE;
    for (let i = 0, n = indices.length; i < n; i++) {
      const idx = indices[i] | 0;
      if (idx >= 0 && idx < this.colorAttachmentCount) list[idx] = GL_COLOR_ATTACHMENT0 + idx;
    }
    gl.drawBuffers(list);
    return this;
  }

  /**
   * Validates the currently bound framebuffer.
   * @param {string} which Label used in the error message.
   * @private
   */
  _checkStatus(which) {
    const gl = this.gl;
    const status = gl.checkFramebufferStatus(GL_FRAMEBUFFER);
    if (status === gl.FRAMEBUFFER_COMPLETE) return;
    const reason = FBO_STATUS[status] || ('status desconhecido 0x' + status.toString(16));
    throw new Error(
      'RenderTarget[' + (this.name || this.uid) + '/' + which + ']: framebuffer incompleto - ' + reason +
      '. (' + this.width + 'x' + this.height +
      ', anexos=' + this.colorAttachmentCount +
      ', formato=' + (Array.isArray(this.colorFormat) ? this.colorFormat.join(',') : this.colorFormat) +
      ', depth=' + (this.hasDepth ? this.depthFormat : 'none') +
      ', samples=' + this.samples +
      ', layers=' + this.layers + ')'
    );
  }

  /**
   * Makes this target current and sets the viewport to its full size.
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {RenderTarget} this
   */
  bind(state) {
    if (state) this._stateRef = state;
    const st = this._state();
    if (st) {
      st.bindFramebuffer(GL_FRAMEBUFFER, this.framebuffer);
      st.viewport(0, 0, this.width, this.height);
    } else {
      this.gl.bindFramebuffer(GL_FRAMEBUFFER, this.framebuffer);
      this.gl.viewport(0, 0, this.width, this.height);
    }
    this._needsResolve = this.samples > 0;
    return this;
  }

  /**
   * Attaches a specific layer (2D-array) or face (cube) to every layered
   * attachment and binds the target. Used once per cascade by the shadow mapper.
   * @param {number} layerIndex
   * @param {number} [level=0]
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {RenderTarget} this
   */
  bindLayer(layerIndex, level = 0, state) {
    if (state) this._stateRef = state;
    const st = this._state();
    this._bindFBO(GL_FRAMEBUFFER, this.resolveFramebuffer);

    for (let i = 0, n = this.textures.length; i < n; i++) {
      const tex = this.textures[i];
      if (tex.isCube || tex.isVolume) this._attachColor(i, tex, layerIndex, level);
    }
    if (this.depthTexture && (this.depthTexture.isCube || this.depthTexture.isVolume)) {
      const attachment = this.depthTexture.descriptor.isStencil
        ? GL_DEPTH_STENCIL_ATTACHMENT : GL_DEPTH_ATTACHMENT;
      this._attachTexture(attachment, this.depthTexture, layerIndex, level);
    }

    this.currentLayer = layerIndex;
    this._checkStatus('layer' + layerIndex);

    const w = Math.max(1, this.width >> level);
    const h = Math.max(1, this.height >> level);
    if (st) st.viewport(0, 0, w, h);
    else this.gl.viewport(0, 0, w, h);
    return this;
  }

  /**
   * Alias of `bindLayer` for cube map targets.
   * @param {number} face 0..5
   * @param {number} [level=0]
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {RenderTarget} this
   */
  bindFace(face, level = 0, state) {
    return this.bindLayer(face, level, state);
  }

  /**
   * Resolves MSAA (when needed) and unbinds to the default framebuffer.
   * @param {import('./StateCache.js').StateCache} [state]
   * @returns {RenderTarget} this
   */
  unbind(state) {
    if (state) this._stateRef = state;
    if (this._needsResolve) this.resolve();
    this._bindFBO(GL_FRAMEBUFFER, null);
    return this;
  }

  /**
   * Blits the multisampled attachments into the texture-backed FBO.
   * Each color attachment is resolved individually because `blitFramebuffer`
   * only ever reads from the current read buffer.
   * @returns {RenderTarget} this
   */
  resolve() {
    if (this.samples === 0) return this;
    const gl = this.gl;

    this._bindFBO(GL_READ_FRAMEBUFFER, this.framebuffer);
    this._bindFBO(GL_DRAW_FRAMEBUFFER, this.resolveFramebuffer);

    const list = new Array(this.colorAttachmentCount);
    for (let i = 0; i < this.colorAttachmentCount; i++) {
      for (let j = 0; j < this.colorAttachmentCount; j++) {
        list[j] = (i === j) ? (GL_COLOR_ATTACHMENT0 + j) : GL_NONE;
      }
      gl.readBuffer(GL_COLOR_ATTACHMENT0 + i);
      gl.drawBuffers(list);
      gl.blitFramebuffer(
        0, 0, this.width, this.height,
        0, 0, this.width, this.height,
        GL_COLOR_BUFFER_BIT, GL_NEAREST
      );
    }

    if (this.colorAttachmentCount > 0) {
      // Restore the full draw buffer set on the resolve FBO.
      this._bindFBO(GL_FRAMEBUFFER, this.resolveFramebuffer);
      this._setupDrawBuffers();
      this._bindFBO(GL_READ_FRAMEBUFFER, this.framebuffer);
      this._bindFBO(GL_DRAW_FRAMEBUFFER, this.resolveFramebuffer);
    }

    if (this.hasDepth && this.useDepthTexture) {
      gl.blitFramebuffer(
        0, 0, this.width, this.height,
        0, 0, this.width, this.height,
        GL_DEPTH_BUFFER_BIT, GL_NEAREST
      );
    }

    this._needsResolve = false;
    return this;
  }

  /**
   * Blits this target into another one (or into the default framebuffer).
   * @param {RenderTarget|null} target Destination, null = screen.
   * @param {number} [mask=GL_COLOR_BUFFER_BIT] Buffer bits to copy.
   * @param {number} [filter] GL_NEAREST or GL_LINEAR (forced to NEAREST for depth).
   * @returns {RenderTarget} this
   */
  blitTo(target, mask = GL_COLOR_BUFFER_BIT, filter) {
    const gl = this.gl;
    if (this._needsResolve) this.resolve();

    const src = this.samples > 0 ? this.resolveFramebuffer : this.framebuffer;
    // Blitting into a multisampled FBO is only legal when both sides have the
    // same sample count, so single-sampled sources always target the resolve FBO.
    const dst = target
      ? ((target.samples > 0 && this.samples > 0) ? target.framebuffer : target.resolveFramebuffer)
      : null;
    const dw = target ? target.width : this.width;
    const dh = target ? target.height : this.height;

    const usesDepth = (mask & (GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT)) !== 0;
    let f = filter === undefined ? GL_LINEAR : filter;
    if (usesDepth) f = GL_NEAREST;

    this._bindFBO(GL_READ_FRAMEBUFFER, src);
    this._bindFBO(GL_DRAW_FRAMEBUFFER, dst);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, dw, dh, mask, f);

    if (target) target._needsResolve = false;
    return this;
  }

  /**
   * Resizes the target, discarding its contents.
   * @param {number} width
   * @param {number} height
   * @returns {RenderTarget} this
   */
  resize(width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    if (w === this.width && h === this.height) return this;
    this._releaseResources();
    this.width = w;
    this.height = h;
    this._build();
    return this;
  }

  /**
   * Regenerates the mip chains of the color textures (bloom/reflection chains).
   * Only textures created with `generateMipmaps: true` have a chain to fill;
   * the others are skipped instead of being reallocated, which would discard
   * whatever was just rendered into them.
   * @returns {RenderTarget} this
   */
  generateMipmapsForTextures() {
    for (let i = 0, n = this.textures.length; i < n; i++) {
      const tex = this.textures[i];
      if (tex.levels > 1) tex.generateMipmaps();
    }
    return this;
  }

  /** @type {number} Approximate GPU footprint of this target. */
  get memoryBytes() {
    let bytes = 0;
    for (let i = 0, n = this.textures.length; i < n; i++) bytes += this.textures[i].memoryBytes;
    if (this.depthTexture) bytes += this.depthTexture.memoryBytes;
    const rbCount = this.colorRenderbuffers.length + (this.depthRenderbuffer ? 1 : 0);
    bytes += rbCount * this.width * this.height * 4 * Math.max(1, this.samples);
    return bytes;
  }

  /** Total bytes held by renderbuffers across every RenderTarget. @type {number} */
  static get totalRenderbufferBytes() {
    return _totalRenderbufferBytes;
  }

  /**
   * Deletes every GL resource but keeps the instance reusable (used by resize).
   * @private
   */
  _releaseResources() {
    const gl = this.gl;
    const st = this._state();

    for (let i = 0, n = this.textures.length; i < n; i++) this.textures[i].dispose(st);
    this.textures.length = 0;

    if (this.depthTexture) {
      this.depthTexture.dispose(st);
      this.depthTexture = null;
    }

    for (let i = 0, n = this.colorRenderbuffers.length; i < n; i++) {
      gl.deleteRenderbuffer(this.colorRenderbuffers[i]);
      _totalRenderbufferBytes -= this.width * this.height * 4 * Math.max(1, this.samples);
    }
    this.colorRenderbuffers.length = 0;

    if (this.depthRenderbuffer) {
      gl.deleteRenderbuffer(this.depthRenderbuffer);
      _totalRenderbufferBytes -= this.width * this.height * 4 * Math.max(1, this.samples);
      this.depthRenderbuffer = null;
    }

    if (this.framebuffer && this.framebuffer !== this.resolveFramebuffer) {
      if (st) st.invalidateFramebuffer(this.framebuffer);
      gl.deleteFramebuffer(this.framebuffer);
    }
    if (this.resolveFramebuffer) {
      if (st) st.invalidateFramebuffer(this.resolveFramebuffer);
      gl.deleteFramebuffer(this.resolveFramebuffer);
    }
    this.framebuffer = null;
    this.resolveFramebuffer = null;
    this._needsResolve = false;
  }

  /**
   * Releases everything. The instance must not be used afterwards.
   * @param {import('./StateCache.js').StateCache} [state]
   */
  dispose(state) {
    if (this.disposed) return;
    if (state) this._stateRef = state;
    this._releaseResources();
    this.disposed = true;
  }
}
