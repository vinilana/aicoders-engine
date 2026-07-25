/**
 * Texture: 2D, cube, 2D-array and 3D textures with immutable storage.
 *
 * Whenever the dimensions are known up front the texture is allocated with
 * `texStorage2D`/`texStorage3D` (immutable storage), which lets the driver
 * validate completeness once instead of on every draw - measurably faster than
 * repeated `texImage2D` calls. Sub-uploads then go through `texSubImage*`.
 */

import { getStateCache } from './StateCache.js';
import { Logger } from '../core/Logger.js';

const GL_TEXTURE_2D = 0x0de1;
const GL_TEXTURE_CUBE_MAP = 0x8513;
const GL_TEXTURE_3D = 0x806f;
const GL_TEXTURE_2D_ARRAY = 0x8c1a;
const GL_TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;

const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;

const GL_REPEAT = 0x2901;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_MIRRORED_REPEAT = 0x8370;

const GL_COMPARE_REF_TO_TEXTURE = 0x884e;
const GL_LEQUAL = 0x0203;

/** Friendly target name -> GL enum. */
const TARGETS = {
  '2d': GL_TEXTURE_2D,
  cube: GL_TEXTURE_CUBE_MAP,
  cubemap: GL_TEXTURE_CUBE_MAP,
  '2d-array': GL_TEXTURE_2D_ARRAY,
  array: GL_TEXTURE_2D_ARRAY,
  '3d': GL_TEXTURE_3D
};

/** Friendly filter name -> GL enum. */
const FILTERS = {
  nearest: GL_NEAREST,
  linear: GL_LINEAR,
  'nearest-mipmap-nearest': GL_NEAREST_MIPMAP_NEAREST,
  'linear-mipmap-nearest': GL_LINEAR_MIPMAP_NEAREST,
  'nearest-mipmap-linear': GL_NEAREST_MIPMAP_LINEAR,
  'linear-mipmap-linear': GL_LINEAR_MIPMAP_LINEAR,
  trilinear: GL_LINEAR_MIPMAP_LINEAR,
  mipmap: GL_LINEAR_MIPMAP_LINEAR
};

/** Friendly wrap name -> GL enum. */
const WRAPS = {
  repeat: GL_REPEAT,
  clamp: GL_CLAMP_TO_EDGE,
  'clamp-to-edge': GL_CLAMP_TO_EDGE,
  mirror: GL_MIRRORED_REPEAT,
  'mirrored-repeat': GL_MIRRORED_REPEAT
};

/**
 * Per-context cache of the resolved format table and probed extensions.
 * @type {WeakMap<Object, Object>}
 */
const _contextCache = new WeakMap();

let _totalTextureBytes = 0;
let _nextTextureId = 1;

/**
 * Normalizes a format name: lowercase without separators.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name).toLowerCase().replace(/[_\-\s]/g, '');
}

/**
 * Builds the internal-format descriptor table for a context.
 * @param {WebGL2RenderingContext} gl
 * @returns {Object}
 */
function buildContextInfo(gl) {
  const formats = Object.create(null);

  /**
   * @param {string[]} names Aliases.
   * @param {number} internalFormat
   * @param {number} format
   * @param {number} type
   * @param {number} bytesPerPixel
   * @param {number} components
   * @param {Object} [flags]
   */
  const def = function (names, internalFormat, format, type, bytesPerPixel, components, flags) {
    const desc = {
      name: names[0],
      internalFormat,
      format,
      type,
      bytesPerPixel,
      components,
      isDepth: !!(flags && flags.depth),
      isStencil: !!(flags && flags.stencil),
      isInteger: !!(flags && flags.integer),
      isFloat: !!(flags && flags.float),
      isHalfFloat: !!(flags && flags.halfFloat),
      isSRGB: !!(flags && flags.srgb)
    };
    for (let i = 0; i < names.length; i++) formats[normalizeName(names[i])] = desc;
  };

  def(['rgba8'], gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4, 4);
  def(['rgb8'], gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, 3, 3);
  def(['srgb8_alpha8', 'srgb8alpha8', 'srgba8', 'srgb'], gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, 4, 4, { srgb: true });
  def(['srgb8'], gl.SRGB8, gl.RGB, gl.UNSIGNED_BYTE, 3, 3, { srgb: true });
  def(['rgba16f'], gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, 8, 4, { halfFloat: true });
  def(['rgb16f'], gl.RGB16F, gl.RGB, gl.HALF_FLOAT, 6, 3, { halfFloat: true });
  def(['rgba32f'], gl.RGBA32F, gl.RGBA, gl.FLOAT, 16, 4, { float: true });
  def(['rgb32f'], gl.RGB32F, gl.RGB, gl.FLOAT, 12, 3, { float: true });
  def(['r11f_g11f_b10f', 'r11g11b10', 'r11g11b10f'], gl.R11F_G11F_B10F, gl.RGB, gl.HALF_FLOAT, 4, 3, { halfFloat: true });
  def(['rg16f'], gl.RG16F, gl.RG, gl.HALF_FLOAT, 4, 2, { halfFloat: true });
  def(['rg32f'], gl.RG32F, gl.RG, gl.FLOAT, 8, 2, { float: true });
  def(['rg8'], gl.RG8, gl.RG, gl.UNSIGNED_BYTE, 2, 2);
  def(['r8'], gl.R8, gl.RED, gl.UNSIGNED_BYTE, 1, 1);
  def(['r16f'], gl.R16F, gl.RED, gl.HALF_FLOAT, 2, 1, { halfFloat: true });
  def(['r32f'], gl.R32F, gl.RED, gl.FLOAT, 4, 1, { float: true });
  def(['rgba4'], gl.RGBA4, gl.RGBA, gl.UNSIGNED_SHORT_4_4_4_4, 2, 4);
  def(['rgb565'], gl.RGB565, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, 2, 3);
  def(['rgb10_a2', 'rgb10a2'], gl.RGB10_A2, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, 4, 4);

  def(['r8ui'], gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 1, 1, { integer: true });
  def(['r16ui'], gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, 2, 1, { integer: true });
  def(['r32ui'], gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, 4, 1, { integer: true });
  def(['rg32ui'], gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT, 8, 2, { integer: true });
  def(['rgba32ui'], gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 16, 4, { integer: true });
  def(['rgba16ui'], gl.RGBA16UI, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, 8, 4, { integer: true });

  def(['depth_component16', 'depth16'], gl.DEPTH_COMPONENT16, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, 2, 1, { depth: true });
  def(['depth_component24', 'depth24'], gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, 4, 1, { depth: true });
  def(['depth_component32f', 'depth32f'], gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT, 4, 1, { depth: true, float: true });
  def(['depth24_stencil8', 'depth24stencil8'], gl.DEPTH24_STENCIL8, gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8, 4, 1, { depth: true, stencil: true });
  def(['depth32f_stencil8', 'depth32fstencil8'], gl.DEPTH32F_STENCIL8, gl.DEPTH_STENCIL, gl.FLOAT_32_UNSIGNED_INT_24_8_REV, 8, 1, { depth: true, stencil: true, float: true });

  let anisoExt = null;
  let floatLinear = null;
  try {
    anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  } catch (e) {
    anisoExt = null;
  }
  try {
    floatLinear = gl.getExtension('OES_texture_float_linear');
  } catch (e) {
    floatLinear = null;
  }

  const info = {
    formats,
    anisoExt,
    maxAnisotropy: anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
    floatLinear: !!floatLinear,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0
  };
  _contextCache.set(gl, info);
  return info;
}

/**
 * Returns (and caches) the per-context format/extension info.
 * @param {WebGL2RenderingContext} gl
 * @returns {Object}
 */
function contextInfo(gl) {
  return _contextCache.get(gl) || buildContextInfo(gl);
}

/**
 * Resolves an internal format (name or GL enum) into a full descriptor.
 * @param {WebGL2RenderingContext} gl
 * @param {string|number} internalFormat
 * @param {number} [format] Explicit pixel format when passing a raw enum.
 * @param {number} [type] Explicit pixel type when passing a raw enum.
 * @returns {Object}
 */
export function resolveFormat(gl, internalFormat, format, type) {
  const info = contextInfo(gl);
  if (typeof internalFormat === 'string') {
    const desc = info.formats[normalizeName(internalFormat)];
    if (!desc) {
      throw new Error('Texture: internalFormat desconhecido "' + internalFormat + '".');
    }
    if (format === undefined && type === undefined) return desc;
    return {
      name: desc.name,
      internalFormat: desc.internalFormat,
      format: format === undefined ? desc.format : format,
      type: type === undefined ? desc.type : type,
      bytesPerPixel: desc.bytesPerPixel,
      components: desc.components,
      isDepth: desc.isDepth,
      isStencil: desc.isStencil,
      isInteger: desc.isInteger,
      isFloat: desc.isFloat,
      isHalfFloat: desc.isHalfFloat,
      isSRGB: desc.isSRGB
    };
  }

  // Raw enum: try to find a matching descriptor for the metadata.
  const keys = Object.keys(info.formats);
  for (let i = 0, n = keys.length; i < n; i++) {
    const desc = info.formats[keys[i]];
    if (desc.internalFormat === internalFormat) {
      if (format === undefined && type === undefined) return desc;
      return {
        name: desc.name,
        internalFormat,
        format: format === undefined ? desc.format : format,
        type: type === undefined ? desc.type : type,
        bytesPerPixel: desc.bytesPerPixel,
        components: desc.components,
        isDepth: desc.isDepth,
        isStencil: desc.isStencil,
        isInteger: desc.isInteger,
        isFloat: desc.isFloat,
        isHalfFloat: desc.isHalfFloat,
        isSRGB: desc.isSRGB
      };
    }
  }

  return {
    name: 'custom',
    internalFormat,
    format: format === undefined ? gl.RGBA : format,
    type: type === undefined ? gl.UNSIGNED_BYTE : type,
    bytesPerPixel: 4,
    components: 4,
    isDepth: false,
    isStencil: false,
    isInteger: false,
    isFloat: false,
    isHalfFloat: false,
    isSRGB: false
  };
}

/**
 * Resolves a filter name/enum.
 * @param {string|number} f
 * @param {number} fallback
 * @returns {number}
 */
function resolveFilter(f, fallback) {
  if (f === undefined || f === null) return fallback;
  if (typeof f === 'number') return f;
  const v = FILTERS[f];
  return v === undefined ? fallback : v;
}

/**
 * Resolves a wrap name/enum.
 * @param {string|number} w
 * @param {number} fallback
 * @returns {number}
 */
function resolveWrap(w, fallback) {
  if (w === undefined || w === null) return fallback;
  if (typeof w === 'number') return w;
  const v = WRAPS[w];
  return v === undefined ? fallback : v;
}

/**
 * True when the filter samples mip levels.
 * @param {number} filter
 * @returns {boolean}
 */
function isMipmapFilter(filter) {
  return filter === GL_NEAREST_MIPMAP_NEAREST || filter === GL_LINEAR_MIPMAP_NEAREST ||
    filter === GL_NEAREST_MIPMAP_LINEAR || filter === GL_LINEAR_MIPMAP_LINEAR;
}

/**
 * True for DOM-ish upload sources (ImageBitmap, HTMLImageElement, canvas, video).
 * @param {*} data
 * @returns {boolean}
 */
function isPixelSource(data) {
  if (!data || typeof data !== 'object') return false;
  if (ArrayBuffer.isView(data)) return false;
  return typeof data.width === 'number' || typeof data.videoWidth === 'number' ||
    typeof data.naturalWidth === 'number';
}

/**
 * GPU texture object.
 */
export class Texture {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object} [options]
   * @param {number} [options.width=1]
   * @param {number} [options.height=1]
   * @param {number} [options.depth=1] Layers (2d-array) or slices (3d).
   * @param {string} [options.target='2d'] '2d' | 'cube' | '2d-array' | '3d'
   * @param {string|number} [options.internalFormat='rgba8']
   * @param {number} [options.format] Overrides the descriptor pixel format.
   * @param {number} [options.type] Overrides the descriptor pixel type.
   * @param {string|number} [options.minFilter]
   * @param {string|number} [options.magFilter='linear']
   * @param {string|number} [options.wrapS='repeat']
   * @param {string|number} [options.wrapT='repeat']
   * @param {string|number} [options.wrapR='clamp']
   * @param {number} [options.anisotropy=1]
   * @param {boolean} [options.generateMipmaps=false]
   * @param {boolean} [options.flipY=false]
   * @param {boolean} [options.premultiply=false]
   * @param {ArrayBufferView|Object} [options.data]
   * @param {Array} [options.images] Six faces for cube maps.
   * @param {number} [options.levels] Explicit mip level count.
   * @param {boolean} [options.compareMode=false] Enables shadow comparison.
   * @param {number} [options.compareFunc] Comparison function (default LEQUAL).
   * @param {boolean} [options.immutable=true] Use texStorage when possible.
   * @param {import('./StateCache.js').StateCache} [options.state]
   */
  constructor(gl, options = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {number} */
    this.uid = _nextTextureId++;
    /** @type {string} */
    this.name = options.name || '';
    /** @type {WebGLTexture|null} */
    this.id = gl.createTexture();
    if (!this.id) throw new Error('Texture: falha ao criar a textura WebGL (contexto perdido?).');

    const info = contextInfo(gl);
    /** @private */
    this._info = info;
    /** @private */
    this._state = options.state || null;

    /** @type {string} */
    this.targetName = options.target || '2d';
    /** @type {number} GL enum of the texture target. */
    this.target = TARGETS[this.targetName];
    if (this.target === undefined) {
      throw new Error('Texture: target desconhecido "' + this.targetName + '".');
    }

    /** @type {boolean} */
    this.isCube = this.target === GL_TEXTURE_CUBE_MAP;
    /** @type {boolean} */
    this.isArray = this.target === GL_TEXTURE_2D_ARRAY;
    /** @type {boolean} */
    this.is3D = this.target === GL_TEXTURE_3D;
    /** @type {boolean} True when the target uses texStorage3D/texSubImage3D. */
    this.isVolume = this.isArray || this.is3D;

    /** @type {number} */
    this.width = options.width !== undefined ? (options.width | 0) : 1;
    /** @type {number} */
    this.height = options.height !== undefined ? (options.height | 0) : 1;
    /** @type {number} */
    this.depth = options.depth !== undefined ? Math.max(1, options.depth | 0) : 1;

    /** @type {Object} Resolved internal format descriptor. */
    this.descriptor = resolveFormat(gl, options.internalFormat || 'rgba8', options.format, options.type);
    /** @type {number} */
    this.internalFormat = this.descriptor.internalFormat;
    /** @type {number} */
    this.format = this.descriptor.format;
    /** @type {number} */
    this.type = this.descriptor.type;

    /** @type {boolean} */
    this.generateMipmapsEnabled = !!options.generateMipmaps && !this.descriptor.isDepth;

    const defaultMin = this.generateMipmapsEnabled ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR;
    /** @type {number} */
    this.minFilter = resolveFilter(options.minFilter, defaultMin);
    /** @type {number} */
    this.magFilter = resolveFilter(options.magFilter, GL_LINEAR);

    // Integer and unfilterable float formats must use NEAREST.
    const needsNearest = this.descriptor.isInteger ||
      (this.descriptor.isFloat && !info.floatLinear && !this.descriptor.isDepth);
    if (needsNearest) {
      this.minFilter = isMipmapFilter(this.minFilter) ? GL_NEAREST_MIPMAP_NEAREST : GL_NEAREST;
      this.magFilter = GL_NEAREST;
    }

    const defaultWrap = this.isCube ? GL_CLAMP_TO_EDGE : GL_REPEAT;
    /** @type {number} */
    this.wrapS = resolveWrap(options.wrapS, defaultWrap);
    /** @type {number} */
    this.wrapT = resolveWrap(options.wrapT, defaultWrap);
    /** @type {number} */
    this.wrapR = resolveWrap(options.wrapR, GL_CLAMP_TO_EDGE);

    /** @type {number} */
    this.anisotropy = Math.max(1, Math.min(options.anisotropy || 1, info.maxAnisotropy));
    /** @type {boolean} */
    this.flipY = !!options.flipY;
    /** @type {boolean} */
    this.premultiply = !!options.premultiply;
    /** @type {boolean} */
    this.compareMode = !!options.compareMode;
    /** @type {number} */
    this.compareFunc = options.compareFunc || GL_LEQUAL;
    /** @type {boolean} */
    this.immutable = options.immutable !== false;

    /** @type {number} Mip level count. */
    this.levels = options.levels !== undefined
      ? Math.max(1, options.levels | 0)
      : (this.generateMipmapsEnabled ? this._maxLevels() : 1);

    /** @type {boolean} Storage already allocated. */
    this.allocated = false;
    /** @type {boolean} */
    this.disposed = false;
    /** @type {number} */
    this.version = 0;
    /**
     * Bytes counted into the global total for the CURRENT storage. Kept
     * separate from `memoryBytes` because a resize mutates the dimensions
     * before the old storage is released.
     * @type {number}
     * @private
     */
    this._allocatedBytes = 0;

    if (this.width > 0 && this.height > 0) {
      this._allocate();
      this._applyParameters();

      if (options.images) {
        const images = options.images;
        for (let i = 0, n = Math.min(images.length, this.isCube ? 6 : images.length); i < n; i++) {
          if (images[i]) this.upload(images[i], 0, i);
        }
        if (this.generateMipmapsEnabled) this.generateMipmaps();
      } else if (options.data !== undefined && options.data !== null) {
        this.upload(options.data, 0, this.isVolume ? -1 : 0);
        if (this.generateMipmapsEnabled) this.generateMipmaps();
      }
    }
  }

  /** Total bytes allocated by every live Texture. @type {number} */
  static get totalBytes() {
    return _totalTextureBytes;
  }

  /**
   * Full mip chain length for the current dimensions.
   * @returns {number}
   * @private
   */
  _maxLevels() {
    let size = Math.max(this.width, this.height);
    if (this.is3D) size = Math.max(size, this.depth);
    return Math.max(1, Math.floor(Math.log2(size)) + 1);
  }

  /**
   * Binds this texture on the scratch unit for creation/parameter work.
   * @returns {import('./StateCache.js').StateCache|null}
   * @private
   */
  _bindSelf() {
    let st = this._state;
    if (!st) {
      st = getStateCache(this.gl);
      this._state = st;
    }
    if (st) st.bindTextureForUpdate(this.target, this.id);
    else this.gl.bindTexture(this.target, this.id);
    return st;
  }

  /**
   * Configures the unpack pixel-store state for an upload.
   * The alignment must be derived from the width of the rows ACTUALLY being
   * uploaded: using the full texture width would make the driver expect padded
   * rows and shift the pixels of a narrow sub-update.
   * @param {boolean} forSource True when uploading a DOM source.
   * @param {number} [rowPixels] Row width of this upload (defaults to the texture width).
   * @private
   */
  _setPixelStore(forSource, rowPixels) {
    const gl = this.gl;
    const st = this._state || getStateCache(gl);
    const width = rowPixels === undefined ? this.width : rowPixels;
    const rowBytes = this.descriptor.bytesPerPixel * width;
    let alignment = 1;
    if (rowBytes % 8 === 0) alignment = 8;
    else if (rowBytes % 4 === 0) alignment = 4;
    else if (rowBytes % 2 === 0) alignment = 2;

    if (st) {
      st.setPixelStore(this.flipY, this.premultiply && forSource, alignment);
    } else {
      gl.pixelStorei(0x9240, this.flipY);
      gl.pixelStorei(0x9241, this.premultiply && forSource);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
    }
  }

  /**
   * Allocates the (immutable when possible) storage.
   * @private
   */
  _allocate() {
    if (this.allocated) return;
    const gl = this.gl;
    this._bindSelf();

    if (this.immutable) {
      if (this.isVolume) {
        gl.texStorage3D(this.target, this.levels, this.internalFormat, this.width, this.height, this.depth);
      } else {
        // For cube maps texStorage2D allocates all six faces at once.
        gl.texStorage2D(this.target, this.levels, this.internalFormat, this.width, this.height);
      }
    } else {
      this._setPixelStore(false);
      if (this.isVolume) {
        gl.texImage3D(this.target, 0, this.internalFormat, this.width, this.height, this.depth,
          0, this.format, this.type, null);
      } else if (this.isCube) {
        for (let f = 0; f < 6; f++) {
          gl.texImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, this.internalFormat,
            this.width, this.height, 0, this.format, this.type, null);
        }
      } else {
        gl.texImage2D(this.target, 0, this.internalFormat, this.width, this.height,
          0, this.format, this.type, null);
      }
    }

    this.allocated = true;
    this._allocatedBytes = this.memoryBytes;
    _totalTextureBytes += this._allocatedBytes;
  }

  /**
   * Pushes filters, wrap modes, anisotropy and compare mode to the driver.
   * @returns {Texture} this
   */
  _applyParameters() {
    const gl = this.gl;
    this._bindSelf();

    // A mipmap min filter on a texture without mips makes it incomplete.
    let minFilter = this.minFilter;
    if (this.levels <= 1 && isMipmapFilter(minFilter)) {
      minFilter = (minFilter === GL_NEAREST_MIPMAP_NEAREST || minFilter === GL_NEAREST_MIPMAP_LINEAR)
        ? GL_NEAREST : GL_LINEAR;
    }

    gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, this.magFilter);
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, this.wrapS);
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, this.wrapT);
    if (this.isVolume) gl.texParameteri(this.target, gl.TEXTURE_WRAP_R, this.wrapR);

    if (this.compareMode) {
      gl.texParameteri(this.target, gl.TEXTURE_COMPARE_MODE, GL_COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(this.target, gl.TEXTURE_COMPARE_FUNC, this.compareFunc);
    } else {
      gl.texParameteri(this.target, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    }

    const aniso = this._info.anisoExt;
    if (aniso && this.anisotropy > 1 && !this.descriptor.isInteger) {
      gl.texParameterf(this.target, aniso.TEXTURE_MAX_ANISOTROPY_EXT, this.anisotropy);
    }

    gl.texParameteri(this.target, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(this.target, gl.TEXTURE_MAX_LEVEL, this.levels - 1);
    return this;
  }

  /**
   * Uploads pixel data.
   *
   * For 2D-array/3D targets `face` is the layer index; pass `-1` to upload the
   * whole volume in one call. For cube maps `face` is 0..5.
   *
   * @param {ArrayBufferView|Object|null} data
   * @param {number} [level=0]
   * @param {number} [face=0]
   * @returns {Texture} this
   */
  upload(data, level = 0, face = 0) {
    const gl = this.gl;
    if (!this.allocated) this._allocate();
    this._bindSelf();

    const w = Math.max(1, this.width >> level);
    const h = Math.max(1, this.height >> level);

    const source = isPixelSource(data);
    this._setPixelStore(source, w);

    if (this.isVolume) {
      const d = this.is3D ? Math.max(1, this.depth >> level) : this.depth;
      if (face < 0) {
        if (this.immutable) {
          gl.texSubImage3D(this.target, level, 0, 0, 0, w, h, d, this.format, this.type, data);
        } else {
          gl.texImage3D(this.target, level, this.internalFormat, w, h, d, 0, this.format, this.type, data);
        }
      } else {
        gl.texSubImage3D(this.target, level, 0, 0, face, w, h, 1, this.format, this.type, data);
      }
      this.version++;
      return this;
    }

    const target = this.isCube ? (GL_TEXTURE_CUBE_MAP_POSITIVE_X + face) : this.target;

    if (this.immutable) {
      if (source) {
        gl.texSubImage2D(target, level, 0, 0, this.format, this.type, data);
      } else {
        gl.texSubImage2D(target, level, 0, 0, w, h, this.format, this.type, data);
      }
    } else if (source) {
      gl.texImage2D(target, level, this.internalFormat, this.format, this.type, data);
    } else {
      gl.texImage2D(target, level, this.internalFormat, w, h, 0, this.format, this.type, data);
    }

    this.version++;
    return this;
  }

  /**
   * Partial 2D update.
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {ArrayBufferView|Object} data
   * @param {number} [level=0]
   * @param {number} [face=0]
   * @returns {Texture} this
   */
  updateSubImage(x, y, width, height, data, level = 0, face = 0) {
    const gl = this.gl;
    if (!this.allocated) this._allocate();
    this._bindSelf();
    this._setPixelStore(isPixelSource(data), width);

    if (this.isVolume) {
      gl.texSubImage3D(this.target, level, x, y, face, width, height, 1, this.format, this.type, data);
    } else {
      const target = this.isCube ? (GL_TEXTURE_CUBE_MAP_POSITIVE_X + face) : this.target;
      gl.texSubImage2D(target, level, x, y, width, height, this.format, this.type, data);
    }
    this.version++;
    return this;
  }

  /**
   * Uploads a whole layer of a 2D-array / 3D texture.
   * @param {ArrayBufferView|Object} data
   * @param {number} layer
   * @param {number} [level=0]
   * @returns {Texture} this
   */
  uploadLayer(data, layer, level = 0) {
    return this.upload(data, level, layer);
  }

  /**
   * Sets the texture content from an image-like source, adopting its size.
   * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} img
   * @param {number} [face=0] Cube face when applicable.
   * @returns {Texture} this
   */
  setFromImage(img, face = 0) {
    const w = (img.naturalWidth || img.videoWidth || img.width) | 0;
    const h = (img.naturalHeight || img.videoHeight || img.height) | 0;

    if (w > 0 && h > 0 && (w !== this.width || h !== this.height || !this.allocated)) {
      this.width = w;
      this.height = h;
      if (this.generateMipmapsEnabled) this.levels = this._maxLevels();
      this._reallocate();
    }

    this.upload(img, 0, face);
    if (this.generateMipmapsEnabled) this.generateMipmaps();
    return this;
  }

  /**
   * Recreates the GL object with the current dimensions. Required because
   * immutable storage cannot be resized.
   * @private
   */
  _reallocate() {
    const gl = this.gl;
    const st = this._state || getStateCache(gl);
    // Use the recorded size: the new dimensions are already in place.
    _totalTextureBytes -= this._allocatedBytes;
    this._allocatedBytes = 0;
    if (st) st.invalidateTexture(this.id);
    if (this.id) gl.deleteTexture(this.id);
    this.id = gl.createTexture();
    this.allocated = false;
    this._allocate();
    this._applyParameters();
  }

  /**
   * Resizes the texture, discarding its content.
   * @param {number} width
   * @param {number} height
   * @param {number} [depth]
   * @returns {Texture} this
   */
  resize(width, height, depth) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const d = depth === undefined ? this.depth : Math.max(1, depth | 0);
    if (w === this.width && h === this.height && d === this.depth && this.allocated) return this;
    this.width = w;
    this.height = h;
    this.depth = d;
    if (this.generateMipmapsEnabled) this.levels = this._maxLevels();
    this._reallocate();
    return this;
  }

  /**
   * @param {string|number} min
   * @param {string|number} mag
   * @returns {Texture} this
   */
  setFilters(min, mag) {
    this.minFilter = resolveFilter(min, this.minFilter);
    this.magFilter = resolveFilter(mag, this.magFilter);
    this._applyParameters();
    return this;
  }

  /**
   * @param {string|number} s
   * @param {string|number} t
   * @param {string|number} [r]
   * @returns {Texture} this
   */
  setWrap(s, t, r) {
    this.wrapS = resolveWrap(s, this.wrapS);
    this.wrapT = resolveWrap(t === undefined ? s : t, this.wrapT);
    if (r !== undefined) this.wrapR = resolveWrap(r, this.wrapR);
    this._applyParameters();
    return this;
  }

  /**
   * @param {number} value
   * @returns {Texture} this
   */
  setAnisotropy(value) {
    this.anisotropy = Math.max(1, Math.min(value, this._info.maxAnisotropy));
    this._applyParameters();
    return this;
  }

  /**
   * Enables or disables hardware shadow comparison (sampler2DShadow).
   * @param {boolean} enabled
   * @param {number} [func]
   * @returns {Texture} this
   */
  setCompareMode(enabled, func) {
    this.compareMode = !!enabled;
    if (func !== undefined) this.compareFunc = func;
    this._applyParameters();
    return this;
  }

  /**
   * Generates the mip chain.
   * @returns {Texture} this
   */
  generateMipmaps() {
    if (this.descriptor.isDepth || this.descriptor.isInteger) return this;
    const gl = this.gl;
    if (this.levels <= 1) {
      if (this.immutable) {
        // Immutable storage cannot grow a mip chain after the fact, and
        // reallocating here would silently throw away the current content
        // (catastrophic for a render target). Refuse and tell the caller.
        Logger.warn('Texture "' + (this.name || this.uid) + '": generateMipmaps() ignorado - ' +
          'a textura foi criada com 1 nivel. Crie-a com generateMipmaps: true.');
        return this;
      }
      this.levels = this._maxLevels();
    }
    this._bindSelf();
    gl.generateMipmap(this.target);
    this.generateMipmapsEnabled = true;
    this._applyParameters();
    this.version++;
    return this;
  }

  /**
   * Binds the texture to a shader texture unit.
   * @param {import('./StateCache.js').StateCache} state
   * @param {number} unit
   * @returns {Texture} this
   */
  bind(state, unit) {
    const st = state || this._state || getStateCache(this.gl);
    if (st) st.bindTexture(unit, this.target, this.id);
    else this.gl.bindTexture(this.target, this.id);
    return this;
  }

  /** @type {number} Approximate GPU footprint in bytes (mips included). */
  get memoryBytes() {
    if (!this.allocated) return 0;
    let bytes = this.width * this.height * this.descriptor.bytesPerPixel;
    if (this.isVolume) bytes *= this.depth;
    if (this.isCube) bytes *= 6;
    if (this.levels > 1) bytes = Math.ceil(bytes * 1.3333333);
    return bytes;
  }

  /**
   * Deletes the GL object and updates the memory counter.
   * @param {import('./StateCache.js').StateCache} [state]
   */
  dispose(state) {
    if (this.disposed) return;
    this.disposed = true;
    const st = state || this._state || getStateCache(this.gl);
    _totalTextureBytes -= this._allocatedBytes;
    this._allocatedBytes = 0;
    if (st) st.invalidateTexture(this.id);
    if (this.id) {
      this.gl.deleteTexture(this.id);
      this.id = null;
    }
    this.allocated = false;
  }
}

/**
 * Creates a 2D texture.
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts]
 * @returns {Texture}
 */
export function createTexture2D(gl, opts = {}) {
  const o = Object.assign({}, opts);
  o.target = '2d';
  return new Texture(gl, o);
}

/**
 * Creates a cube map texture.
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts] `size` may be used instead of width/height.
 * @returns {Texture}
 */
export function createTextureCube(gl, opts = {}) {
  const o = Object.assign({}, opts);
  o.target = 'cube';
  if (o.size !== undefined) {
    o.width = o.size;
    o.height = o.size;
  }
  if (o.wrapS === undefined) o.wrapS = 'clamp';
  if (o.wrapT === undefined) o.wrapT = 'clamp';
  return new Texture(gl, o);
}

/**
 * Creates a 2D array texture (cascaded shadow maps, texture atlases...).
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts] Requires `depth` (layer count).
 * @returns {Texture}
 */
export function createTextureArray(gl, opts = {}) {
  const o = Object.assign({}, opts);
  o.target = '2d-array';
  if (o.layers !== undefined && o.depth === undefined) o.depth = o.layers;
  return new Texture(gl, o);
}

/**
 * Creates a 3D texture.
 * @param {WebGL2RenderingContext} gl
 * @param {Object} [opts]
 * @returns {Texture}
 */
export function createTexture3D(gl, opts = {}) {
  const o = Object.assign({}, opts);
  o.target = '3d';
  return new Texture(gl, o);
}

/**
 * Creates a texture straight from a typed array (lookup tables, light data...).
 * Defaults to NEAREST filtering and clamped wrapping, which is what data
 * textures almost always want.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {ArrayBufferView} typedArray
 * @param {number} width
 * @param {number} height
 * @param {string|number} [internalFormat='rgba32f']
 * @param {number} [format]
 * @param {number} [type]
 * @returns {Texture}
 */
export function createDataTexture(gl, typedArray, width, height, internalFormat = 'rgba32f', format, type) {
  return new Texture(gl, {
    target: '2d',
    width,
    height,
    internalFormat,
    format,
    type,
    data: typedArray,
    minFilter: 'nearest',
    magFilter: 'nearest',
    wrapS: 'clamp',
    wrapT: 'clamp',
    generateMipmaps: false,
    flipY: false
  });
}

/**
 * Convenience: 1x1 white texture used as a fallback for missing maps.
 * @param {WebGL2RenderingContext} gl
 * @returns {Texture}
 */
export function createWhiteTexture(gl) {
  const data = new Uint8Array([255, 255, 255, 255]);
  const tex = new Texture(gl, {
    width: 1,
    height: 1,
    internalFormat: 'rgba8',
    data,
    minFilter: 'linear',
    magFilter: 'linear',
    wrapS: 'clamp',
    wrapT: 'clamp'
  });
  tex.name = 'white';
  return tex;
}

/**
 * Logs a warning when a texture exceeds the hardware limit.
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 * @returns {boolean} True when the size fits.
 */
export function validateTextureSize(gl, size) {
  const max = contextInfo(gl).maxTextureSize;
  if (size > max) {
    Logger.warn('Texture: tamanho ' + size + ' excede o maximo suportado (' + max + ').');
    return false;
  }
  return true;
}
