/**
 * WebGL2 context creation, extension discovery and hardware capability detection.
 *
 * There is no module scope DOM access here: every reference to `document`,
 * `HTMLCanvasElement` or the context itself happens inside the exported
 * function/class bodies so the module can be imported in Node for headless tests.
 */

import { Logger } from '../core/Logger.js';

/**
 * Default WebGL2 context attributes used by the engine.
 * The engine renders to an HDR offscreen target and composites manually, so the
 * default framebuffer wants no alpha, no MSAA and no preserved drawing buffer.
 */
const DEFAULT_ATTRIBUTES = {
  alpha: false,
  depth: true,
  stencil: false,
  antialias: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  desynchronized: true,
  failIfMajorPerformanceCaveat: false
};

/** Extensions probed at startup. Missing ones simply disable a feature. */
const OPTIONAL_EXTENSIONS = [
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'OES_texture_float_linear',
  'EXT_texture_filter_anisotropic',
  'EXT_disjoint_timer_query_webgl2',
  'KHR_parallel_shader_compile',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_etc1',
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_bptc',
  'WEBGL_compressed_texture_rgtc',
  'WEBGL_compressed_texture_pvrtc',
  'WEBGL_debug_renderer_info',
  'WEBGL_lose_context',
  'WEBGL_multi_draw',
  'EXT_float_blend',
  'EXT_texture_norm16',
  'OES_draw_buffers_indexed'
];

/** Numeric compressed format enum -> readable name (for diagnostics). */
const COMPRESSED_FORMAT_NAMES = {
  0x83f0: 'COMPRESSED_RGB_S3TC_DXT1',
  0x83f1: 'COMPRESSED_RGBA_S3TC_DXT1',
  0x83f2: 'COMPRESSED_RGBA_S3TC_DXT3',
  0x83f3: 'COMPRESSED_RGBA_S3TC_DXT5',
  0x8c4c: 'COMPRESSED_SRGB_S3TC_DXT1',
  0x8c4d: 'COMPRESSED_SRGB_ALPHA_S3TC_DXT1',
  0x8c4e: 'COMPRESSED_SRGB_ALPHA_S3TC_DXT3',
  0x8c4f: 'COMPRESSED_SRGB_ALPHA_S3TC_DXT5',
  0x8dbb: 'COMPRESSED_RED_RGTC1',
  0x8dbc: 'COMPRESSED_SIGNED_RED_RGTC1',
  0x8dbd: 'COMPRESSED_RED_GREEN_RGTC2',
  0x8dbe: 'COMPRESSED_SIGNED_RED_GREEN_RGTC2',
  0x8e8c: 'COMPRESSED_RGBA_BPTC_UNORM',
  0x8e8d: 'COMPRESSED_SRGB_ALPHA_BPTC_UNORM',
  0x8e8e: 'COMPRESSED_RGB_BPTC_SIGNED_FLOAT',
  0x8e8f: 'COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT',
  0x9270: 'COMPRESSED_R11_EAC',
  0x9271: 'COMPRESSED_SIGNED_R11_EAC',
  0x9272: 'COMPRESSED_RG11_EAC',
  0x9273: 'COMPRESSED_SIGNED_RG11_EAC',
  0x9274: 'COMPRESSED_RGB8_ETC2',
  0x9275: 'COMPRESSED_SRGB8_ETC2',
  0x9276: 'COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2',
  0x9277: 'COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2',
  0x9278: 'COMPRESSED_RGBA8_ETC2_EAC',
  0x9279: 'COMPRESSED_SRGB8_ALPHA8_ETC2_EAC',
  0x93b0: 'COMPRESSED_RGBA_ASTC_4x4',
  0x93b1: 'COMPRESSED_RGBA_ASTC_5x4',
  0x93b2: 'COMPRESSED_RGBA_ASTC_5x5',
  0x93b3: 'COMPRESSED_RGBA_ASTC_6x5',
  0x93b4: 'COMPRESSED_RGBA_ASTC_6x6',
  0x93b5: 'COMPRESSED_RGBA_ASTC_8x5',
  0x93b6: 'COMPRESSED_RGBA_ASTC_8x6',
  0x93b7: 'COMPRESSED_RGBA_ASTC_8x8',
  0x93b8: 'COMPRESSED_RGBA_ASTC_10x5',
  0x93b9: 'COMPRESSED_RGBA_ASTC_10x6',
  0x93ba: 'COMPRESSED_RGBA_ASTC_10x8',
  0x93bb: 'COMPRESSED_RGBA_ASTC_10x10',
  0x93bc: 'COMPRESSED_RGBA_ASTC_12x10',
  0x93bd: 'COMPRESSED_RGBA_ASTC_12x12'
};

/**
 * Immutable snapshot of everything the renderer needs to know about the GPU.
 * Queried once at startup; every value is a plain number/boolean/string so it
 * can be serialized into the stats overlay without extra work.
 */
export class Capabilities {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object<string,Object>} extensions Map of extension name -> object (null when absent).
   */
  constructor(gl, extensions) {
    const ext = extensions || {};

    /** @type {Object<string,Object>} */
    this.extensions = ext;

    // --- Texturing limits -------------------------------------------------
    /** @type {number} */
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
    /** @type {number} */
    this.maxCubeMapSize = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) | 0;
    /** @type {number} */
    this.max3DTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) | 0;
    /** @type {number} Texture units addressable from a single fragment shader. */
    this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) | 0;
    /** @type {number} Texture units addressable across the whole pipeline. */
    this.maxCombinedTextureUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) | 0;
    /** @type {number} */
    this.maxVertexTextureUnits = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) | 0;
    /** @type {number} */
    this.maxArrayTextureLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) | 0;

    // --- Anisotropic filtering -------------------------------------------
    const aniso = ext.EXT_texture_filter_anisotropic;
    /** @type {Object|null} */
    this.anisotropic = aniso || null;
    /** @type {number} Always >= 1, even if the driver reports a bogus value. */
    this.maxAnisotropy = aniso ? Math.max(1, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) : 1;

    // --- Framebuffer / MSAA ----------------------------------------------
    /** @type {number} */
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) | 0;
    /** @type {number} */
    this.maxColorAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) | 0;
    /** @type {number} */
    this.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS) | 0;
    /** @type {number} */
    this.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) | 0;

    // --- Uniform buffers --------------------------------------------------
    /** @type {number} */
    this.maxUBOSize = gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) | 0;
    /** @type {number} */
    this.maxUBOBindings = gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) | 0;
    /** @type {number} Required alignment (bytes) for bindBufferRange offsets. */
    this.uboOffsetAlignment = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) | 0;
    /** @type {number} */
    this.maxVertexUniformBlocks = gl.getParameter(gl.MAX_VERTEX_UNIFORM_BLOCKS) | 0;
    /** @type {number} */
    this.maxFragmentUniformBlocks = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_BLOCKS) | 0;

    // --- Vertex pipeline --------------------------------------------------
    /** @type {number} */
    this.maxVertexAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) | 0;
    /** @type {number} */
    this.maxVaryingComponents = gl.getParameter(gl.MAX_VARYING_COMPONENTS) | 0;
    /** @type {number} */
    this.maxVertexUniformVectors = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) | 0;
    /** @type {number} */
    this.maxFragmentUniformVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) | 0;
    /** @type {Int32Array|Array<number>} */
    this.maxViewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);

    // --- Feature flags ----------------------------------------------------
    /** @type {boolean} Float/half-float color attachments (HDR pipeline). */
    this.colorBufferFloat = !!ext.EXT_color_buffer_float;
    /** @type {boolean} */
    this.colorBufferHalfFloat = !!(ext.EXT_color_buffer_float || ext.EXT_color_buffer_half_float);
    /** @type {boolean} Linear filtering of 32F textures. */
    this.textureFloatLinear = !!ext.OES_texture_float_linear;
    /** @type {boolean} Half float linear filtering is core in WebGL2. */
    this.textureHalfFloatLinear = true;
    /** @type {Object|null} */
    this.timerQuery = ext.EXT_disjoint_timer_query_webgl2 || null;
    /** @type {Object|null} */
    this.parallelShaderCompile = ext.KHR_parallel_shader_compile || null;
    /** @type {boolean} Blending onto 32F render targets. */
    this.floatBlend = !!ext.EXT_float_blend;
    /** @type {Object|null} */
    this.multiDraw = ext.WEBGL_multi_draw || null;
    /** @type {Object|null} */
    this.loseContext = ext.WEBGL_lose_context || null;

    // --- Compressed texture formats --------------------------------------
    const rawFormats = gl.getParameter(gl.COMPRESSED_TEXTURE_FORMATS);
    const formats = [];
    const formatNames = [];
    if (rawFormats) {
      for (let i = 0, n = rawFormats.length; i < n; i++) {
        const f = rawFormats[i] | 0;
        formats.push(f);
        formatNames.push(COMPRESSED_FORMAT_NAMES[f] || ('0x' + f.toString(16)));
      }
    }
    /** @type {number[]} */
    this.compressedFormats = formats;
    /** @type {string[]} */
    this.compressedFormatNames = formatNames;
    /** @type {boolean} */
    this.s3tc = !!ext.WEBGL_compressed_texture_s3tc;
    /** @type {boolean} */
    this.etc = !!ext.WEBGL_compressed_texture_etc;
    /** @type {boolean} */
    this.astc = !!ext.WEBGL_compressed_texture_astc;
    /** @type {boolean} */
    this.bptc = !!ext.WEBGL_compressed_texture_bptc;

    // --- Shader precision -------------------------------------------------
    const hf = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    /** @type {boolean} True when the fragment stage really supports highp. */
    this.highpFragment = !!hf && hf.precision > 0;
    /** @type {string} 'highp' or 'mediump' - what shaders should declare. */
    this.precision = this.highpFragment ? 'highp' : 'mediump';

    // --- Identification ---------------------------------------------------
    const dbg = ext.WEBGL_debug_renderer_info;
    /** @type {string} */
    this.vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '') : String(gl.getParameter(gl.VENDOR) || '');
    /** @type {string} */
    this.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : String(gl.getParameter(gl.RENDERER) || '');
    /** @type {string} */
    this.version = String(gl.getParameter(gl.VERSION) || '');
    /** @type {string} */
    this.glslVersion = String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || '');

    const lowered = (this.renderer + ' ' + this.vendor).toLowerCase();
    /** @type {boolean} Heuristic: integrated/mobile GPUs get cheaper defaults. */
    this.isMobile = lowered.indexOf('adreno') >= 0 || lowered.indexOf('mali') >= 0 ||
      lowered.indexOf('powervr') >= 0 || lowered.indexOf('apple gpu') >= 0;
  }

  /**
   * Tells whether a probed extension is present.
   * @param {string} name
   * @returns {boolean}
   */
  hasExtension(name) {
    return !!this.extensions[name];
  }

  /**
   * Returns a probed extension object or null.
   * @param {string} name
   * @returns {Object|null}
   */
  getExtension(name) {
    return this.extensions[name] || null;
  }

  /**
   * Clamps a requested anisotropy level to what the GPU supports.
   * @param {number} value
   * @returns {number}
   */
  clampAnisotropy(value) {
    const v = value | 0;
    if (v < 1) return 1;
    return v > this.maxAnisotropy ? this.maxAnisotropy : v;
  }

  /**
   * Clamps a requested MSAA sample count.
   * @param {number} samples
   * @returns {number}
   */
  clampSamples(samples) {
    const s = samples | 0;
    if (s <= 1) return 0;
    return s > this.maxSamples ? this.maxSamples : s;
  }

  /**
   * Human readable multi-line summary, used by Stats and the console banner.
   * @returns {string}
   */
  toString() {
    return [
      'GPU: ' + this.renderer,
      'Vendor: ' + this.vendor,
      'GLSL: ' + this.glslVersion,
      'MaxTexture: ' + this.maxTextureSize + ' | Layers: ' + this.maxArrayTextureLayers,
      'MaxSamples: ' + this.maxSamples + ' | MRT: ' + this.maxColorAttachments,
      'UBO: ' + this.maxUBOSize + 'B x ' + this.maxUBOBindings + ' (align ' + this.uboOffsetAlignment + ')',
      'Anisotropy: ' + this.maxAnisotropy,
      'FloatRT: ' + this.colorBufferFloat + ' | FloatLinear: ' + this.textureFloatLinear,
      'TimerQuery: ' + !!this.timerQuery + ' | ParallelCompile: ' + !!this.parallelShaderCompile
    ].join('\n');
  }
}

/**
 * Creates a WebGL2 rendering context with the engine defaults and probes
 * every optional extension the renderer can take advantage of.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|string} canvas Canvas element or CSS selector.
 * @param {Object} [options] Context attributes plus `onContextLost` / `onContextRestored` hooks.
 * @returns {{gl: WebGL2RenderingContext, caps: Capabilities, canvas: Object,
 *            attributes: Object, isWebGL2: boolean, lose: Function, restore: Function,
 *            dispose: Function}}
 */
export function createGLContext(canvas, options = {}) {
  let element = canvas;

  if (typeof element === 'string') {
    if (typeof document === 'undefined') {
      throw new Error('createGLContext: seletor de canvas informado mas nao existe DOM neste ambiente.');
    }
    element = document.querySelector(canvas);
    if (!element) {
      throw new Error('createGLContext: nenhum elemento encontrado para o seletor "' + canvas + '".');
    }
  }

  if (!element) {
    if (typeof document === 'undefined') {
      throw new Error('createGLContext: nenhum canvas informado e nao existe DOM neste ambiente.');
    }
    element = document.createElement('canvas');
  }

  if (typeof element.getContext !== 'function') {
    throw new Error('createGLContext: o alvo informado nao e um canvas valido (getContext ausente).');
  }

  const attributes = {
    alpha: options.alpha !== undefined ? !!options.alpha : DEFAULT_ATTRIBUTES.alpha,
    depth: options.depth !== undefined ? !!options.depth : DEFAULT_ATTRIBUTES.depth,
    stencil: options.stencil !== undefined ? !!options.stencil : DEFAULT_ATTRIBUTES.stencil,
    antialias: options.antialias !== undefined ? !!options.antialias : DEFAULT_ATTRIBUTES.antialias,
    premultipliedAlpha: options.premultipliedAlpha !== undefined
      ? !!options.premultipliedAlpha : DEFAULT_ATTRIBUTES.premultipliedAlpha,
    preserveDrawingBuffer: options.preserveDrawingBuffer !== undefined
      ? !!options.preserveDrawingBuffer : DEFAULT_ATTRIBUTES.preserveDrawingBuffer,
    powerPreference: options.powerPreference || DEFAULT_ATTRIBUTES.powerPreference,
    desynchronized: options.desynchronized !== undefined
      ? !!options.desynchronized : DEFAULT_ATTRIBUTES.desynchronized,
    failIfMajorPerformanceCaveat: options.failIfMajorPerformanceCaveat !== undefined
      ? !!options.failIfMajorPerformanceCaveat : DEFAULT_ATTRIBUTES.failIfMajorPerformanceCaveat
  };

  let gl = null;
  try {
    gl = element.getContext('webgl2', attributes);
  } catch (e) {
    gl = null;
  }

  if (!gl) {
    // Second chance without the exotic flags: some drivers reject `desynchronized`.
    try {
      gl = element.getContext('webgl2', {
        alpha: attributes.alpha,
        depth: attributes.depth,
        stencil: attributes.stencil,
        antialias: attributes.antialias,
        premultipliedAlpha: attributes.premultipliedAlpha,
        preserveDrawingBuffer: attributes.preserveDrawingBuffer
      });
    } catch (e) {
      gl = null;
    }
  }

  if (!gl) {
    const hasWebGL1 = (function () {
      try {
        return !!(element.getContext('webgl') || element.getContext('experimental-webgl'));
      } catch (e) {
        return false;
      }
    })();

    throw new Error(
      'WebGL2 nao esta disponivel neste navegador/dispositivo.\n' +
      'A AICoders Engine exige WebGL2 (OpenGL ES 3.0) e nao possui fallback para WebGL1.\n' +
      (hasWebGL1
        ? 'Este navegador suporta apenas WebGL1. Atualize o navegador ou os drivers da GPU.'
        : 'Nenhum contexto WebGL pode ser criado. Verifique se a aceleracao por hardware esta ativada.') +
      '\nDicas: use Chrome/Edge/Firefox atualizados, ative "Usar aceleracao grafica quando disponivel" ' +
      'e confira chrome://gpu para bloqueios de driver.'
    );
  }

  // --- Probe optional extensions -----------------------------------------
  const extensions = Object.create(null);
  for (let i = 0, n = OPTIONAL_EXTENSIONS.length; i < n; i++) {
    const name = OPTIONAL_EXTENSIONS[i];
    let obj = null;
    try {
      obj = gl.getExtension(name);
    } catch (e) {
      obj = null;
    }
    extensions[name] = obj || null;
  }

  const caps = new Capabilities(gl, extensions);

  if (!caps.colorBufferFloat) {
    Logger.warn('GLContext: EXT_color_buffer_float ausente - o pipeline HDR usara RGBA8 (banding).');
  }
  if (!caps.textureFloatLinear) {
    Logger.debug('GLContext: OES_texture_float_linear ausente - texturas 32F usarao filtro NEAREST.');
  }

  // --- Context loss handling ---------------------------------------------
  let listenersAttached = false;
  const handleLost = function (event) {
    if (options.preventContextLossDefault !== false && event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    Logger.error('GLContext: contexto WebGL perdido.');
    if (typeof options.onContextLost === 'function') options.onContextLost(event);
  };
  const handleRestored = function (event) {
    Logger.info('GLContext: contexto WebGL restaurado.');
    if (typeof options.onContextRestored === 'function') options.onContextRestored(event);
  };

  if (typeof element.addEventListener === 'function') {
    element.addEventListener('webglcontextlost', handleLost, false);
    element.addEventListener('webglcontextrestored', handleRestored, false);
    listenersAttached = true;
  }

  return {
    /** @type {WebGL2RenderingContext} */
    gl,
    /** @type {Capabilities} */
    caps,
    /** @type {Object} */
    canvas: element,
    /** @type {Object} */
    attributes,
    /** @type {boolean} */
    isWebGL2: true,

    /** Forces a context loss (debug/testing of the restore path). */
    lose() {
      const ext = caps.loseContext;
      if (ext) ext.loseContext();
    },

    /** Restores a context previously lost through `lose()`. */
    restore() {
      const ext = caps.loseContext;
      if (ext) ext.restoreContext();
    },

    /** Detaches the context-loss listeners. */
    dispose() {
      if (listenersAttached && typeof element.removeEventListener === 'function') {
        element.removeEventListener('webglcontextlost', handleLost, false);
        element.removeEventListener('webglcontextrestored', handleRestored, false);
        listenersAttached = false;
      }
    }
  };
}
