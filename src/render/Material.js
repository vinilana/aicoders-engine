/**
 * Base material.
 *
 * A material is the pairing of a shader name (a key into the ShaderLib) with a bag
 * of uniform values and render state. It never touches WebGL directly: the renderer
 * asks it for the defines a given geometry / frame needs, resolves the program and
 * uploads the uniforms.
 *
 * The permutation defines are cached per (geometry layout, render context) pair
 * behind a numeric signature, so the hot path performs one Map lookup on a number
 * and allocates nothing.
 */

/** Numeric encoding of the `side` property, used in the low byte of the sort key. */
export const SIDE_CODE = { front: 0, back: 1, double: 2 };

/**
 * Fixed texture units, per the architecture contract. Materials expose their maps
 * through these names so the renderer can bind them without a per material table.
 */
export const TEXTURE_UNITS = {
  uBaseColorMap: 0,
  uNormalMap: 1,
  uMetallicRoughnessMap: 2,
  uOcclusionMap: 3,
  uEmissiveMap: 4,
  uClearcoatMap: 5,
  uBoneTexture: 6,
  uLightIndices: 7,
  uShadowMap: 8,
  uClusterGrid: 9,
  uLightData: 10,
  uIrradianceMap: 11,
  uPrefilteredMap: 12,
  uBRDFLUT: 13
};

/** Geometry signature bits. */
const SIG_INSTANCING = 1 << 0;
const SIG_INSTANCE_COLOR = 1 << 1;
const SIG_SKINNING = 1 << 2;
const SIG_VERTEX_COLOR = 1 << 3;
const SIG_TANGENT = 1 << 4;
const SIG_UV1 = 1 << 5;
/** Render context bits. */
const SIG_SHADOWS = 1 << 6;
const SIG_CLUSTERED = 1 << 7;
const SIG_IBL = 1 << 8;
const SIG_FOG = 1 << 9;
const SIG_TONEMAP = 1 << 10;
const SIG_MOTION = 1 << 11;
const SIG_DEPTH_ONLY = 1 << 12;

let _nextMaterialId = 1;

/**
 * Does a geometry expose an attribute? Tolerates both the Map based Geometry and a
 * plain object of attributes.
 * @param {Object|null} geometry
 * @param {string} name
 * @returns {boolean}
 */
function hasAttribute(geometry, name) {
  if (!geometry) return false;
  if (typeof geometry.hasAttribute === 'function') return geometry.hasAttribute(name);
  const attributes = geometry.attributes;
  if (!attributes) return false;
  if (typeof attributes.has === 'function') return attributes.has(name);
  return attributes[name] !== undefined;
}

/** Clamp an integer into an inclusive range. */
function clampInt(value, min, max) {
  const v = value | 0;
  return v < min ? min : (v > max ? max : v);
}

export class Material {
  /**
   * @param {Object} [options] any public field of the class may be passed here
   */
  constructor(options = {}) {
    /** Unique id, stable for the lifetime of the material. */
    this.id = _nextMaterialId++;
    /** @type {string} */
    this.name = options.name !== undefined ? options.name : '';
    /** Key into the ShaderLib. @type {string} */
    this.shaderName = options.shaderName !== undefined ? options.shaderName : 'standard';

    /** Uniform name -> value, uploaded verbatim by the renderer. @type {Object} */
    this.uniforms = {};
    /** Extra permutation defines, merged on top of the derived ones. @type {Object} */
    this.defines = {};

    /** @type {boolean} */
    this.transparent = options.transparent !== undefined ? options.transparent : false;
    /** @type {number} */
    this.opacity = options.opacity !== undefined ? options.opacity : 1;
    /** @type {number} discard threshold used when alphaMode is 'mask' */
    this.alphaTest = options.alphaTest !== undefined ? options.alphaTest : 0;
    /** @type {string} 'opaque' | 'mask' | 'blend' */
    this.alphaMode = options.alphaMode !== undefined ? options.alphaMode : 'opaque';

    /** @type {boolean} */
    this.depthTest = options.depthTest !== undefined ? options.depthTest : true;
    /** @type {boolean} */
    this.depthWrite = options.depthWrite !== undefined ? options.depthWrite : true;
    /** @type {string} 'never'|'less'|'equal'|'lequal'|'greater'|'notequal'|'gequal'|'always' */
    this.depthFunc = options.depthFunc !== undefined ? options.depthFunc : 'less';

    /** @type {string} 'front' | 'back' | 'double' */
    this.side = options.side !== undefined ? options.side : 'front';
    /** @type {string} 'none'|'normal'|'additive'|'multiply'|'premultiplied' */
    this.blending = options.blending !== undefined ? options.blending : 'none';

    /** @type {boolean} */
    this.polygonOffset = options.polygonOffset !== undefined ? options.polygonOffset : false;
    /** @type {number} */
    this.polygonOffsetFactor = options.polygonOffsetFactor !== undefined ? options.polygonOffsetFactor : 0;
    /** @type {number} */
    this.polygonOffsetUnits = options.polygonOffsetUnits !== undefined ? options.polygonOffsetUnits : 0;
    /** @type {boolean} */
    this.wireframe = options.wireframe !== undefined ? options.wireframe : false;

    /** @type {boolean} this material writes into the shadow map */
    this.castShadow = options.castShadow !== undefined ? options.castShadow : true;
    /** @type {boolean} this material samples the shadow map */
    this.receiveShadow = options.receiveShadow !== undefined ? options.receiveShadow : true;
    /** @type {boolean} this material samples the environment probes */
    this.receiveIBL = options.receiveIBL !== undefined ? options.receiveIBL : true;

    /** @type {number} ties are broken by this before depth */
    this.renderOrder = options.renderOrder !== undefined ? options.renderOrder : 0;
    /** Bumped every time `needsUpdate` is raised. @type {number} */
    this.version = 0;
    /** Precomputed uint32 draw call sort key. @type {number} */
    this.sortKey = 0;

    /** @private @type {Map<number,Object>} defines signature -> defines object */
    this._definesCache = new Map();
    /** @private @type {Object|null} last resolved program */
    this._program = null;
    /** @private @type {number} 16 bit hash of the last resolved program key */
    this._programHash = 0;
    /** @private */
    this._needsUpdate = true;

    if (options.defines) this.setDefines(options.defines);
    if (options.uniforms) {
      for (const key in options.uniforms) this.uniforms[key] = options.uniforms[key];
    }

    this._computeSortKey();
  }

  /**
   * Raising this flag invalidates the cached defines, the resolved program and the
   * sort key. The renderer never has to look at it: everything downstream keys off
   * `version`.
   * @returns {boolean}
   */
  get needsUpdate() {
    return this._needsUpdate;
  }

  set needsUpdate(value) {
    this._needsUpdate = !!value;
    if (value) {
      this.version++;
      this._definesCache.clear();
      this._program = null;
      this._computeSortKey();
    }
  }

  /**
   * Recompute the uint32 sort key.
   * Layout: transparent << 31 | renderOrder << 24 | programHash << 8 | side.
   * `renderOrder` is biased by +64 so negative orders keep sorting before zero.
   * @protected
   */
  _computeSortKey() {
    const transparentBit = (this.transparent || this.alphaMode === 'blend') ? 1 : 0;
    const order = clampInt(this.renderOrder + 64, 0, 127);
    const hash = this._programHash & 0xffff;
    const side = SIDE_CODE[this.side] !== undefined ? SIDE_CODE[this.side] : 0;
    this.sortKey = (((transparentBit << 31) | (order << 24) | (hash << 8) | (side & 0xff)) >>> 0);
    return this.sortKey;
  }

  /**
   * Numeric signature of the permutation inputs, used as the defines cache key.
   * @protected
   * @param {Object|null} geometry
   * @param {Object|null} ctx render context
   * @returns {number}
   */
  _definesSignature(geometry, ctx) {
    let signature = 0;

    if (geometry !== null && geometry !== undefined) {
      if (hasAttribute(geometry, 'aInstanceMatrix')) signature |= SIG_INSTANCING;
      if (hasAttribute(geometry, 'aInstanceColor')) signature |= SIG_INSTANCE_COLOR;
      if (hasAttribute(geometry, 'aJoints') && hasAttribute(geometry, 'aWeights')) signature |= SIG_SKINNING;
      if (hasAttribute(geometry, 'aColor')) signature |= SIG_VERTEX_COLOR;
      if (hasAttribute(geometry, 'aTangent')) signature |= SIG_TANGENT;
      if (hasAttribute(geometry, 'aUV1')) signature |= SIG_UV1;
    }

    if (ctx !== null && ctx !== undefined) {
      if (ctx.instancing) signature |= SIG_INSTANCING;
      if (ctx.instanceColor) signature |= SIG_INSTANCE_COLOR;
      if (ctx.skinning) signature |= SIG_SKINNING;
      if (ctx.shadows && this.receiveShadow) signature |= SIG_SHADOWS;
      if (ctx.clustered) signature |= SIG_CLUSTERED;
      if (ctx.ibl && this.receiveIBL) signature |= SIG_IBL;
      if (ctx.fog) signature |= SIG_FOG;
      if (ctx.toneMapping) signature |= SIG_TONEMAP;
      if (ctx.motionVectors) signature |= SIG_MOTION;
      if (ctx.depthOnly) signature |= SIG_DEPTH_ONLY;

      signature |= (clampInt(ctx.shadowCascades !== undefined ? ctx.shadowCascades : 0, 0, 7)) << 13;
      signature |= (clampInt(ctx.maxDirLights !== undefined ? ctx.maxDirLights : 0, 0, 7)) << 16;
      const clusterXY = clampInt(ctx.clusterX !== undefined ? ctx.clusterX : 0, 0, 31) ^
                        clampInt(ctx.clusterY !== undefined ? ctx.clusterY : 0, 0, 31);
      signature |= clusterXY << 19;
      signature |= (clampInt(ctx.clusterZ !== undefined ? ctx.clusterZ : 0, 0, 63)) << 24;
    }

    return signature >>> 0;
  }

  /**
   * Derive the permutation defines for a geometry and a render context.
   * The result is cached; callers must treat it as read only.
   *
   * @param {Object|null} geometry
   * @param {Object|null} [renderContext] `{ shadows, shadowCascades, clustered,
   *        clusterX, clusterY, clusterZ, ibl, fog, toneMapping, motionVectors,
   *        depthOnly, instancing, skinning, maxDirLights, maxPunctualLights }`
   * @returns {Object}
   */
  getDefines(geometry, renderContext = null) {
    const signature = this._definesSignature(geometry, renderContext);
    const cached = this._definesCache.get(signature);
    if (cached !== undefined) return cached;

    const defines = {};
    const ctx = renderContext || null;

    // --- geometry driven ----------------------------------------------------
    if ((signature & SIG_INSTANCING) !== 0) defines.USE_INSTANCING = 1;
    if ((signature & SIG_INSTANCE_COLOR) !== 0) defines.USE_INSTANCE_COLOR = 1;
    if ((signature & SIG_SKINNING) !== 0) defines.USE_SKINNING = 1;
    if ((signature & SIG_VERTEX_COLOR) !== 0) defines.USE_VERTEX_COLOR = 1;
    if ((signature & SIG_TANGENT) !== 0) defines.USE_TANGENT = 1;
    if ((signature & SIG_UV1) !== 0) defines.USE_UV1 = 1;

    // --- material driven ----------------------------------------------------
    if (this.alphaMode === 'mask' || this.alphaTest > 0) defines.ALPHA_MODE_MASK = 1;
    if (this.alphaMode === 'blend' || this.transparent) defines.ALPHA_MODE_BLEND = 1;
    if (this.side === 'double') defines.DOUBLE_SIDED = 1;

    // --- render context driven ---------------------------------------------
    if ((signature & SIG_SHADOWS) !== 0) {
      defines.USE_SHADOWS = 1;
      defines.SHADOW_CASCADES = clampInt(ctx && ctx.shadowCascades !== undefined ? ctx.shadowCascades : 4, 1, 4);
    }
    if ((signature & SIG_CLUSTERED) !== 0) {
      defines.USE_CLUSTERED = 1;
      defines.CLUSTER_X = clampInt(ctx && ctx.clusterX !== undefined ? ctx.clusterX : 16, 1, 64);
      defines.CLUSTER_Y = clampInt(ctx && ctx.clusterY !== undefined ? ctx.clusterY : 9, 1, 64);
      defines.CLUSTER_Z = clampInt(ctx && ctx.clusterZ !== undefined ? ctx.clusterZ : 24, 1, 64);
    }
    if ((signature & SIG_IBL) !== 0) defines.USE_IBL = 1;
    if ((signature & SIG_FOG) !== 0) defines.USE_FOG = 1;
    if ((signature & SIG_TONEMAP) !== 0) defines.USE_TONEMAP = 1;
    if ((signature & SIG_MOTION) !== 0) defines.USE_MOTION_VECTORS = 1;
    if ((signature & SIG_DEPTH_ONLY) !== 0) defines.DEPTH_ONLY = 1;

    defines.MAX_DIR_LIGHTS = clampInt(ctx && ctx.maxDirLights !== undefined ? ctx.maxDirLights : 4, 1, 4);
    defines.MAX_PUNCTUAL_LIGHTS = clampInt(
      ctx && ctx.maxPunctualLights !== undefined ? ctx.maxPunctualLights : 256, 1, 4096
    );

    // --- subclass and user overrides ---------------------------------------
    this.applyOwnDefines(defines, geometry, ctx);
    for (const key in this.defines) {
      const value = this.defines[key];
      if (value === false || value === null || value === undefined) {
        delete defines[key];
      } else {
        defines[key] = value === true ? 1 : value;
      }
    }

    this._definesCache.set(signature, defines);
    return defines;
  }

  /**
   * Hook for subclasses: add the defines that depend on the material's own state
   * (which maps are bound, which features are enabled). Called before the explicit
   * `defines` object is merged, so the user always wins.
   *
   * @param {Object} defines mutable defines object
   * @param {Object|null} geometry
   * @param {Object|null} renderContext
   */
  applyOwnDefines(defines, geometry, renderContext) {
    // Nothing by default. StandardMaterial and friends override this.
  }

  /**
   * Resolve (and cache) the program for a set of defines.
   * @param {Object} shaderLib
   * @param {Object|null} defines
   * @returns {Object} Program
   */
  getProgram(shaderLib, defines) {
    const program = shaderLib.get(this.shaderName, defines || null);
    if (program !== this._program) {
      this._program = program;
      const hash = program.hash !== undefined ? program.hash : 0;
      if (hash !== this._programHash) {
        this._programHash = hash;
        this._computeSortKey();
      }
    }
    return program;
  }

  /** @returns {Object|null} the program resolved by the last getProgram() call */
  get program() {
    return this._program;
  }

  /**
   * Set one uniform value.
   * @param {string} name
   * @param {*} value
   * @returns {Material} this
   */
  setUniform(name, value) {
    this.uniforms[name] = value;
    return this;
  }

  /**
   * @param {string} name
   * @returns {*}
   */
  getUniform(name) {
    return this.uniforms[name];
  }

  /**
   * Set many uniforms at once.
   * @param {Object} values
   * @returns {Material} this
   */
  setUniforms(values) {
    if (!values) return this;
    for (const key in values) this.uniforms[key] = values[key];
    return this;
  }

  /**
   * Add or replace permutation defines. A value of `false` is an explicit opt out:
   * it is remembered and removes the define even when the geometry or the render
   * context would have derived it.
   * @param {Object} defines
   * @returns {Material} this
   */
  setDefines(defines) {
    if (!defines) return this;
    let changed = false;
    for (const key in defines) {
      if (this.defines[key] !== defines[key]) {
        this.defines[key] = defines[key];
        changed = true;
      }
    }
    if (changed) this.needsUpdate = true;
    return this;
  }

  /**
   * Toggle a single define.
   * @param {string} name
   * @param {*} value `false` disables the define even if it would be derived,
   *        `null` / `undefined` drops the override and restores the derived value
   * @returns {Material} this
   */
  setDefine(name, value) {
    if (value === null || value === undefined) {
      if (!(name in this.defines)) return this;
      delete this.defines[name];
    } else {
      if (this.defines[name] === value) return this;
      this.defines[name] = value;
    }
    this.needsUpdate = true;
    return this;
  }

  /**
   * Upload every uniform of this material to a program, binding texture valued
   * uniforms to their fixed unit. Values that the permutation compiled away are
   * silently skipped.
   *
   * @param {Object} program
   * @param {Object} state StateCache
   * @returns {number} how many uniforms were written
   */
  applyUniforms(program, state) {
    let written = 0;
    const uniforms = this.uniforms;
    for (const name in uniforms) {
      const value = uniforms[name];
      if (value === null || value === undefined) continue;
      if (value.isTexture === true || (value.target !== undefined && typeof value.bind === 'function')) {
        const unit = TEXTURE_UNITS[name] !== undefined ? TEXTURE_UNITS[name] : 14;
        if (program.setTexture(name, value, unit, state)) written++;
      } else if (program.setUniform(name, value)) {
        written++;
      }
    }
    return written;
  }

  /**
   * Copy every property of another material of the same class.
   * @param {Material} source
   * @returns {Material} this
   */
  copy(source) {
    this.name = source.name;
    this.shaderName = source.shaderName;
    this.transparent = source.transparent;
    this.opacity = source.opacity;
    this.alphaTest = source.alphaTest;
    this.alphaMode = source.alphaMode;
    this.depthTest = source.depthTest;
    this.depthWrite = source.depthWrite;
    this.depthFunc = source.depthFunc;
    this.side = source.side;
    this.blending = source.blending;
    this.polygonOffset = source.polygonOffset;
    this.polygonOffsetFactor = source.polygonOffsetFactor;
    this.polygonOffsetUnits = source.polygonOffsetUnits;
    this.wireframe = source.wireframe;
    this.castShadow = source.castShadow;
    this.receiveShadow = source.receiveShadow;
    this.receiveIBL = source.receiveIBL;
    this.renderOrder = source.renderOrder;

    this.uniforms = {};
    for (const key in source.uniforms) this.uniforms[key] = source.uniforms[key];
    this.defines = {};
    for (const key in source.defines) this.defines[key] = source.defines[key];

    this.needsUpdate = true;
    return this;
  }

  /**
   * @returns {Material} a new material of the same concrete class
   */
  clone() {
    return new this.constructor().copy(this);
  }

  /**
   * Release the cached state. Textures are owned by whoever created them and are
   * deliberately not disposed here.
   */
  dispose() {
    this._definesCache.clear();
    this._program = null;
    this.uniforms = {};
    this.defines = {};
  }
}
