/**
 * ShadowMapper: cascaded shadow maps for the directional light, plus
 * perspective shadow maps for spot lights and cube shadow maps for point
 * lights.
 *
 * Directional pipeline, per cascade:
 *   1. the camera sub frustum for the cascade slice is rebuilt in world space
 *      by interpolating the eight corners of the full frustum (view depth is an
 *      affine function of world position, so the interpolation is exact for both
 *      perspective and orthographic cameras);
 *   2. a bounding SPHERE is fitted around those corners. A sphere is invariant
 *      under rotation, so the extent of the light camera never changes while the
 *      player looks around - the classic source of cascade shimmering;
 *   3. the sphere center is quantized to a whole shadow map texel in light space
 *      (snapping), which removes the remaining sub texel crawling;
 *   4. an orthographic light camera is built around the snapped sphere with its
 *      near plane pushed backwards along the light direction, so occluders that
 *      sit outside the camera frustum still make it into the map. The shader
 *      additionally clamps clip z to the near plane (SHADOW_CLAMP_NEAR), which
 *      keeps even the occluders beyond that extension casting;
 *   5. only the relevant casters are drawn: the scene broadphase (DynamicBVH) is
 *      queried with the world AABB of the cascade volume, then each candidate is
 *      rejected exactly against the light space box.
 *
 * Bias strategy: a constant depth bias plus a normal offset proportional to the
 * world size of a shadow texel (both uploaded in the `Shadows` uniform block and
 * consumed by the `shadow` GLSL chunk), plus a slope scaled offset applied by the
 * rasterizer through glPolygonOffset while the cascades are rendered.
 *
 * The `Shadows` std140 block this class fills is, byte for byte:
 *   mat4 uCascadeMatrix[4];  // 64 floats, world -> cascade clip space
 *   vec4 uCascadeSplits;     // far view distance of each cascade
 *   vec4 uShadowParams;      // texelSize, depthBias, normalBias, softness
 *   vec4 uShadowParams2;     // cascadeCount, pcfRadius, blendWidth, fadeDistance
 * `uboData` is exactly that layout, and `cascadeMatrices` / `splits` / `params` /
 * `params2` are views into it, so UniformBuffers can upload it with a single set().
 */

import { Vec3 } from '../math/Vec3.js';
import { Mat4 } from '../math/Mat4.js';
import { AABB } from '../math/AABB.js';
import { Sphere } from '../math/Sphere.js';
import { Logger } from '../core/Logger.js';
import { StateCache, getStateCache } from './StateCache.js';
import { RenderTarget } from './RenderTarget.js';
import { ShaderLib } from './ShaderLib.js';
import { drawModeToGL, glTypeBytes } from './Geometry.js';
import { SHADOW_SHADER_NAME, register as registerShadowShader } from './shaders/shadow.js';

const GL_FRAMEBUFFER = 0x8d40;

/** Program permutation bits. */
const V_INSTANCING = 1;
const V_SKINNING = 2;
const V_ALPHA = 4;
const V_BASECOLOR_MAP = 8;
const V_CLAMP_NEAR = 16;
const VARIANT_COUNT = 32;

/** Fixed texture units, mirroring the contract table. */
const UNIT_BASECOLOR = 0;
const UNIT_BONE_TEXTURE = 6;
const UNIT_SHADOW_MAP = 8;

/** Hard limit imposed by `vec4 uCascadeSplits` / `mat4 uCascadeMatrix[4]`. */
const MAX_CASCADES = 4;

/** Number of floats in the std140 `Shadows` block. */
const SHADOW_UBO_FLOATS = 76;

/** Cube map face forward/up vectors, in GL cube map order. */
const CUBE_FACE_DIR = new Float32Array([
  1, 0, 0, -1, 0, 0,
  0, 1, 0, 0, -1, 0,
  0, 0, 1, 0, 0, -1
]);
const CUBE_FACE_UP = new Float32Array([
  0, -1, 0, 0, -1, 0,
  0, 0, 1, 0, 0, -1,
  0, -1, 0, 0, -1, 0
]);

// --- module scope scratch, never allocated per frame -------------------------
const _lightDir = new Vec3();
const _up = new Vec3();
const _center = new Vec3();
const _eye = new Vec3();
const _target = new Vec3();
const _corner = new Vec3();
const _axisX = new Vec3();
const _axisY = new Vec3();
const _ORIGIN = new Vec3(0, 0, 0);
const _UP_Y = new Vec3(0, 1, 0);
const _UP_Z = new Vec3(0, 0, 1);

const _viewMatrix = new Mat4();
const _rotationView = new Mat4();
const _rotationWorld = new Mat4();
const _projMatrix = new Mat4();
const _viewProj = new Mat4();

const _volume = new AABB();
const _lightSphere = new Sphere();

/** 8 world space corners of the full camera frustum: 4 near then 4 far. */
const _frustumCorners = new Float32Array(24);
/** 8 world space corners of the current cascade slice. */
const _sliceCorners = new Float32Array(24);
/** Scratch vec4 uniforms. */
const _uvTransform = new Float32Array(4);
const _baseColorFactor = new Float32Array(4);

/** NDC xy of the four frustum corners, in a fixed order. */
const _NDC_X = [-1, 1, 1, -1];
const _NDC_Y = [-1, -1, 1, 1];

/**
 * Clamps a value into a range.
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampNumber(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Reads an option with a numeric fallback.
 * @param {Object} options
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numberOption(options, name, fallback) {
  const value = options[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Duck typed texture test: anything that can bind itself to a unit.
 * @param {*} value
 * @returns {boolean}
 */
function isTexture(value) {
  return value !== null && value !== undefined &&
    (value.isTexture === true || (value.target !== undefined && typeof value.bind === 'function'));
}

export class ShadowMapper {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object} [renderer] Owning renderer; `state` and `shaderLib` are
   *        borrowed from it when present.
   * @param {Object} [options]
   * @param {boolean} [options.enabled=true]
   * @param {number} [options.mapSize=2048] Cascade resolution (square).
   * @param {number} [options.cascades=4] 1..4 cascades.
   * @param {number} [options.lambda=0.6] 0 = uniform splits, 1 = logarithmic.
   * @param {number} [options.shadowDistance=0] Max shadowed distance, 0 = from the light/camera.
   * @param {number} [options.depthBias=0.0009] Constant bias, in [0,1] depth units.
   * @param {number} [options.normalBias=2] Normal offset, in texels of cascade 0.
   * @param {number} [options.normalBiasScale=1] Multiplier for `light.shadow.normalBias`.
   * @param {number} [options.slopeScaleBias=1.5] glPolygonOffset factor.
   * @param {number} [options.depthOffsetUnits=2] glPolygonOffset units.
   * @param {number} [options.pcfRadius=1.5] PCF disk radius, in texels.
   * @param {number} [options.softness=1] Global multiplier of the PCF radius.
   * @param {number} [options.cascadeBlend=0] Blend band width in world units, 0 = auto.
   * @param {number} [options.fadeDistance=0] Distance where shadows fade out, 0 = auto.
   * @param {boolean} [options.stabilize=true] Texel snapping.
   * @param {number} [options.casterExtrusion=0] Near plane push back, 0 = auto.
   * @param {string} [options.cullFace='back'] 'back' | 'front' | 'none'.
   * @param {boolean} [options.skipTransparent=true] Blended materials cast nothing.
   * @param {number} [options.layers=0xffffffff] Layer mask of the casters.
   * @param {boolean} [options.spotShadows=true]
   * @param {number} [options.spotMapSize=1024]
   * @param {number} [options.maxSpotShadows=4]
   * @param {boolean} [options.pointShadows=true]
   * @param {number} [options.pointMapSize=512]
   * @param {number} [options.maxPointShadows=2]
   */
  constructor(gl, renderer = null, options = {}) {
    const opts = options || {};

    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} */
    this.renderer = renderer || null;
    /** @type {StateCache} */
    this.state = (renderer && renderer.state)
      ? renderer.state
      : (getStateCache(gl) || new StateCache(gl));
    /** @type {ShaderLib} */
    this.shaderLib = (renderer && renderer.shaderLib) ? renderer.shaderLib : new ShaderLib(gl);
    registerShadowShader(this.shaderLib);

    // --- configuration ----------------------------------------------------
    /** @type {boolean} */
    this.enabled = opts.enabled !== false;
    /** @type {number} */
    this.mapSize = Math.max(16, numberOption(opts, 'mapSize', numberOption(opts, 'shadowMapSize', 2048)) | 0);
    /** @type {number} */
    this.cascades = clampNumber(numberOption(opts, 'cascades', MAX_CASCADES) | 0, 1, MAX_CASCADES);
    /** @type {number} */
    this.lambda = clampNumber(numberOption(opts, 'lambda', 0.6), 0, 1);
    /** @type {number} */
    this.shadowDistance = Math.max(0, numberOption(opts, 'shadowDistance', 0));
    /** @type {number} */
    this.depthBias = numberOption(opts, 'depthBias', 0.0009);
    /** @type {number} Normal offset expressed in texels of the tightest cascade. */
    this.normalBias = numberOption(opts, 'normalBias', 2);
    /** @type {number} */
    this.normalBiasScale = numberOption(opts, 'normalBiasScale', 1);
    /** @type {number} */
    this.slopeScaleBias = numberOption(opts, 'slopeScaleBias', 1.5);
    /** @type {number} */
    this.depthOffsetUnits = numberOption(opts, 'depthOffsetUnits', 2);
    /** @type {number} */
    this.pcfRadius = Math.max(0, numberOption(opts, 'pcfRadius', 1.5));
    /** @type {number} */
    this.softness = Math.max(0, numberOption(opts, 'softness', 1));
    /** @type {number} */
    this.cascadeBlend = Math.max(0, numberOption(opts, 'cascadeBlend', 0));
    /** @type {number} */
    this.fadeDistance = Math.max(0, numberOption(opts, 'fadeDistance', 0));
    /** @type {boolean} */
    this.stabilize = opts.stabilize !== false;
    /** @type {number} */
    this.casterExtrusion = Math.max(0, numberOption(opts, 'casterExtrusion', 0));
    /** @type {string} */
    this.cullFace = typeof opts.cullFace === 'string' ? opts.cullFace : 'back';
    /** @type {boolean} */
    this.skipTransparent = opts.skipTransparent !== false;
    /** @type {number} Layer mask a mesh must intersect to cast. */
    this.layers = opts.layers === undefined ? 0xffffffff : (opts.layers >>> 0);

    /** @type {boolean} */
    this.spotShadows = opts.spotShadows !== false;
    /** @type {number} */
    this.spotMapSize = Math.max(16, numberOption(opts, 'spotMapSize', 1024) | 0);
    /** @type {number} */
    this.maxSpotShadows = Math.max(0, numberOption(opts, 'maxSpotShadows', 4) | 0);

    /** @type {boolean} */
    this.pointShadows = opts.pointShadows !== false;
    /** @type {number} */
    this.pointMapSize = Math.max(16, numberOption(opts, 'pointMapSize', 512) | 0);
    /** @type {number} */
    this.maxPointShadows = Math.max(0, numberOption(opts, 'maxPointShadows', 2) | 0);

    // --- uniform block mirror --------------------------------------------
    /** @type {Float32Array} The whole std140 `Shadows` block. */
    this.uboData = new Float32Array(SHADOW_UBO_FLOATS);
    /** @type {Float32Array} mat4 uCascadeMatrix[4] */
    this.cascadeMatrices = this.uboData.subarray(0, 64);
    /** @type {Float32Array} vec4 uCascadeSplits */
    this.splits = this.uboData.subarray(64, 68);
    /** @type {Float32Array} vec4 uShadowParams */
    this.params = this.uboData.subarray(68, 72);
    /** @type {Float32Array} vec4 uShadowParams2 */
    this.params2 = this.uboData.subarray(72, 76);
    /** @type {Float32Array} Alias of {@link params}. */
    this.shadowParams = this.params;
    /** @type {Float32Array} Alias of {@link params2}. */
    this.shadowParams2 = this.params2;
    /** @type {Float32Array} Alias of {@link splits}. */
    this.cascadeSplits = this.splits;
    /** @type {number} Bumped whenever `uboData` changes, for lazy UBO uploads. */
    this.version = 0;

    // --- directional resources -------------------------------------------
    /** @type {RenderTarget|null} */
    this.target = null;
    /** @type {import('./Texture.js').Texture|null} sampler2DArrayShadow, unit 8. */
    this.texture = null;
    /** @type {number} Cascades actually filled this frame. */
    this.cascadeCount = 0;
    /** @type {Object|null} Directional light currently driving the cascades. */
    this.directionalLight = null;
    /** @type {Float32Array} World size of one texel, per cascade. */
    this.cascadeTexelWorldSize = new Float32Array(MAX_CASCADES);
    /** @type {Float32Array} Radius of the bounding sphere, per cascade. */
    this.cascadeRadius = new Float32Array(MAX_CASCADES);

    // --- spot resources ---------------------------------------------------
    /** @type {RenderTarget|null} */
    this.spotTarget = null;
    /** @type {import('./Texture.js').Texture|null} */
    this.spotTexture = null;
    /** @type {Float32Array} world -> spot clip space, one mat4 per slot. */
    this.spotMatrices = new Float32Array(16 * Math.max(1, this.maxSpotShadows));
    /** @type {Float32Array} (near, far, bias, layer) per slot. */
    this.spotParams = new Float32Array(4 * Math.max(1, this.maxSpotShadows));
    /** @type {number} */
    this.spotCount = 0;

    // --- point resources --------------------------------------------------
    /** @type {RenderTarget[]} One depth cube per shadowed point light. */
    this.pointTargets = [];
    /** @type {Array<import('./Texture.js').Texture>} */
    this.pointTextures = [];
    /** @type {Float32Array} (x, y, z, far) per slot. */
    this.pointParams = new Float32Array(4 * Math.max(1, this.maxPointShadows));
    /** @type {Float32Array} (near, far, bias, unused) per slot. */
    this.pointParams2 = new Float32Array(4 * Math.max(1, this.maxPointShadows));
    /** @type {number} */
    this.pointCount = 0;

    // --- runtime state ----------------------------------------------------
    /** @type {Array<Object|null>} Compiled permutations, indexed by variant bits. */
    this._programs = new Array(VARIANT_COUNT).fill(null);
    /** @type {Int32Array} Pass token the view projection was last written with. */
    this._programTokens = new Int32Array(VARIANT_COUNT).fill(-1);
    /** @type {number} */
    this._passToken = 0;
    /** @type {Array<Object>} Reused caster list (BVH query output). */
    this._casters = [];
    /** @type {Array<Object>} Reused light list. */
    this._lightScratch = [];
    /** @type {boolean} Whether the maps still hold stale content. */
    this._needsClear = true;
    /** @private Nesting counter of the shadow render passes. */
    this._passDepth = 0;
    /** @private Viewport saved by `_beginPasses`. */
    this._savedViewport = null;
    /** @private Storage for the saved viewport. */
    this._viewportScratch = new Int32Array(4);

    // Light space rejection parameters of the pass being rendered.
    this._cullEnabled = false;
    this._cullHalfExtent = 0;
    this._cullDepthMin = 0;
    this._cullDepthMax = 0;
    this._cullView = new Mat4();

    /** Per frame statistics. */
    this.stats = {
      cascades: 0,
      spotMaps: 0,
      pointFaces: 0,
      drawCalls: 0,
      casters: 0,
      cpuTimeMs: 0
    };

    /** @private Bound scene walker, allocated once. */
    this._collectVisitor = (node) => {
      if (node.isMesh === true) this._casters.push(node);
    };

    this._writeStaticParams();
  }

  // =========================================================================
  // Configuration
  // =========================================================================

  /**
   * Enables or disables the whole shadow stage. Disabling clears the maps to
   * "fully lit" on the next update so any shader still sampling them behaves.
   * @param {boolean} enabled
   * @returns {ShadowMapper} this
   */
  setEnabled(enabled) {
    const value = !!enabled;
    if (value === this.enabled) return this;
    this.enabled = value;
    this._needsClear = true;
    if (value === false) this._clearCascadeState();
    return this;
  }

  /**
   * Changes the cascade resolution. The render target is rebuilt lazily.
   * @param {number} size Square resolution in pixels.
   * @returns {ShadowMapper} this
   */
  resize(size) {
    const value = Math.max(16, size | 0);
    if (value === this.mapSize) return this;
    this.mapSize = value;
    if (this.target !== null) {
      this.target.dispose(this.state);
      this.target = null;
      this.texture = null;
    }
    this._needsClear = true;
    this._writeStaticParams();
    return this;
  }

  /**
   * Changes the cascade count (1..4). The render target is rebuilt lazily.
   * @param {number} count
   * @returns {ShadowMapper} this
   */
  setCascadeCount(count) {
    const value = clampNumber(count | 0, 1, MAX_CASCADES);
    if (value === this.cascades) return this;
    this.cascades = value;
    if (this.target !== null) {
      this.target.dispose(this.state);
      this.target = null;
      this.texture = null;
    }
    this._needsClear = true;
    return this;
  }

  /**
   * @param {number} lambda 0 = uniform splits, 1 = fully logarithmic.
   * @returns {ShadowMapper} this
   */
  setLambda(lambda) {
    this.lambda = clampNumber(lambda, 0, 1);
    return this;
  }

  /**
   * @param {number} distance Maximum shadowed view distance, 0 = automatic.
   * @returns {ShadowMapper} this
   */
  setShadowDistance(distance) {
    this.shadowDistance = Math.max(0, distance);
    return this;
  }

  /**
   * @param {number} radius PCF disk radius in texels.
   * @param {number} [softness=this.softness] Global radius multiplier.
   * @returns {ShadowMapper} this
   */
  setSoftness(radius, softness) {
    this.pcfRadius = Math.max(0, radius);
    if (softness !== undefined) this.softness = Math.max(0, softness);
    this._writeStaticParams();
    return this;
  }

  /**
   * @param {number} depthBias Constant bias in [0,1] depth units.
   * @param {number} [normalBias] Normal offset in texels of cascade 0.
   * @returns {ShadowMapper} this
   */
  setBias(depthBias, normalBias) {
    this.depthBias = depthBias;
    if (normalBias !== undefined) this.normalBias = normalBias;
    this._writeStaticParams();
    return this;
  }

  // =========================================================================
  // Resources
  // =========================================================================

  /**
   * Creates the cascade render target on first use.
   * @private
   * @returns {boolean} true when the target is usable
   */
  _ensureTarget() {
    if (this.target !== null) return true;
    try {
      this.target = new RenderTarget(this.gl, this.mapSize, this.mapSize, {
        name: 'csm',
        colorAttachments: 0,
        depth: true,
        depthTexture: true,
        depthFormat: 'depth32f',
        // At least two layers even with a single cascade: the GLSL chunk samples
        // through a sampler2DArrayShadow, and a one layer target would be created
        // as a plain 2D texture. The extra layer is never rendered nor sampled.
        layers: Math.max(2, this.cascades),
        compareMode: true,
        filter: 'linear',
        wrap: 'clamp',
        state: this.state
      });
    } catch (error) {
      Logger.error('ShadowMapper: falha ao criar o mapa de sombras (' + this.mapSize +
        'x' + this.mapSize + 'x' + this.cascades + '): ' + error.message);
      this.target = null;
      this.texture = null;
      this.enabled = false;
      return false;
    }
    this.texture = this.target.depthTexture;
    this._needsClear = true;
    return true;
  }

  /**
   * Creates the spot light atlas on first use.
   * @private
   * @returns {boolean}
   */
  _ensureSpotTarget() {
    if (this.spotTarget !== null) return true;
    if (this.maxSpotShadows <= 0) return false;
    try {
      // Always at least two layers so the sampler type stays sampler2DArrayShadow
      // no matter how many spot lights the scene happens to have.
      this.spotTarget = new RenderTarget(this.gl, this.spotMapSize, this.spotMapSize, {
        name: 'spotShadows',
        colorAttachments: 0,
        depth: true,
        depthTexture: true,
        depthFormat: 'depth32f',
        layers: Math.max(2, this.maxSpotShadows),
        compareMode: true,
        filter: 'linear',
        wrap: 'clamp',
        state: this.state
      });
    } catch (error) {
      Logger.error('ShadowMapper: falha ao criar o atlas de spot lights: ' + error.message);
      this.spotTarget = null;
      this.spotTexture = null;
      this.spotShadows = false;
      return false;
    }
    this.spotTexture = this.spotTarget.depthTexture;
    return true;
  }

  /**
   * Creates (once) the depth cube of one point light slot.
   * @private
   * @param {number} slot
   * @returns {RenderTarget|null}
   */
  _ensurePointTarget(slot) {
    const existing = this.pointTargets[slot];
    if (existing !== undefined && existing !== null) return existing;
    try {
      const target = new RenderTarget(this.gl, this.pointMapSize, this.pointMapSize, {
        name: 'pointShadow' + slot,
        colorAttachments: 0,
        depth: true,
        depthTexture: true,
        depthFormat: 'depth32f',
        isCube: true,
        compareMode: true,
        filter: 'linear',
        wrap: 'clamp',
        state: this.state
      });
      this.pointTargets[slot] = target;
      this.pointTextures[slot] = target.depthTexture;
      return target;
    } catch (error) {
      Logger.error('ShadowMapper: falha ao criar o cubemap de point light: ' + error.message);
      this.pointShadows = false;
      return null;
    }
  }

  /**
   * Binds the cascade map to its fixed texture unit on a consumer program.
   * @param {import('./StateCache.js').StateCache} state
   * @param {Object} program
   * @param {number} [unit=8]
   * @returns {boolean} true when the sampler was set
   */
  bind(state, program, unit = UNIT_SHADOW_MAP) {
    if (this.texture === null || program === null || program === undefined) return false;
    if (typeof program.setTexture !== 'function') return false;
    return program.setTexture('uShadowMap', this.texture, unit, state || this.state);
  }

  /**
   * Alias of {@link bind} with the argument order of the other binders.
   * @param {Object} program
   * @param {import('./StateCache.js').StateCache} [state]
   * @param {number} [unit=8]
   * @returns {boolean}
   */
  bindShadowMap(program, state, unit = UNIT_SHADOW_MAP) {
    return this.bind(state || this.state, program, unit);
  }

  /**
   * Warms up the shader permutations the scenes are likely to need, so no frame
   * pays for a compile. Called by `Renderer.compile()`.
   * @param {boolean} [instancing=true]
   * @param {boolean} [skinning=true]
   * @param {boolean} [alphaMask=true]
   * @returns {ShadowMapper} this
   */
  precompile(instancing = true, skinning = true, alphaMask = true) {
    const base = V_CLAMP_NEAR;
    this._getProgram(base);
    if (instancing) this._getProgram(base | V_INSTANCING);
    if (skinning) this._getProgram(base | V_SKINNING);
    if (alphaMask) {
      this._getProgram(base | V_ALPHA | V_BASECOLOR_MAP);
      if (instancing) this._getProgram(base | V_INSTANCING | V_ALPHA | V_BASECOLOR_MAP);
    }
    if (this.spotShadows || this.pointShadows) {
      this._getProgram(0);
      if (instancing) this._getProgram(V_INSTANCING);
      if (alphaMask) this._getProgram(V_ALPHA | V_BASECOLOR_MAP);
    }
    return this;
  }

  /**
   * Releases every GPU resource owned by the mapper. The shader programs belong
   * to the ShaderLib and are left alone.
   */
  dispose() {
    const state = this.state;
    if (this.target !== null) {
      this.target.dispose(state);
      this.target = null;
    }
    if (this.spotTarget !== null) {
      this.spotTarget.dispose(state);
      this.spotTarget = null;
    }
    for (let i = 0, n = this.pointTargets.length; i < n; i++) {
      const target = this.pointTargets[i];
      if (target !== null && target !== undefined) target.dispose(state);
    }
    this.pointTargets.length = 0;
    this.pointTextures.length = 0;
    this.texture = null;
    this.spotTexture = null;
    this.directionalLight = null;
    this.cascadeCount = 0;
    this.spotCount = 0;
    this.pointCount = 0;
    this._casters.length = 0;
    this._lightScratch.length = 0;
    for (let i = 0; i < VARIANT_COUNT; i++) {
      this._programs[i] = null;
      this._programTokens[i] = -1;
    }
    this._clearCascadeState();
  }

  // =========================================================================
  // Frame entry points
  // =========================================================================

  /**
   * Renders every shadow map needed by this frame.
   *
   * @param {Object} scene Scene (its `bvh` broadphase is used when present).
   * @param {Object} camera Active camera, already updated for this frame.
   * @param {Object} [lights] LightManager, or a plain array of lights. When
   *        omitted the lights are taken from `scene.lights`.
   * @returns {ShadowMapper} this
   */
  update(scene, camera, lights) {
    const startTime = this._now();
    const stats = this.stats;
    stats.cascades = 0;
    stats.spotMaps = 0;
    stats.pointFaces = 0;
    stats.drawCalls = 0;
    stats.casters = 0;

    if (this.enabled === false || scene === null || scene === undefined ||
        camera === null || camera === undefined) {
      this._clearCascadeState();
      this.spotCount = 0;
      this.pointCount = 0;
      stats.cpuTimeMs = this._now() - startTime;
      return this;
    }

    if (this._ensureTarget() === false) {
      this._clearCascadeState();
      stats.cpuTimeMs = this._now() - startTime;
      return this;
    }

    if (typeof camera.updateProjectionIfNeeded === 'function') camera.updateProjectionIfNeeded();

    const directional = this._pickDirectionalLight(scene, lights);
    this.directionalLight = directional;

    this._beginPasses();

    if (directional !== null) {
      this.renderCascades(scene, camera, directional);
    } else {
      const hadCascades = this.cascadeCount > 0;
      this._clearCascadeState();
      // Only repaint the map on the frame the light goes away: leaving stale
      // depth around would shadow the scene if something sampled it anyway.
      if (hadCascades === true) this._needsClear = true;
      if (this._needsClear === true) this._clearAllCascades();
    }

    // The disabled branches still walk the lights so their `shadowIndex` is
    // cleared instead of pointing at a map that is no longer refreshed.
    if (this.spotShadows === true) {
      this._renderSpotShadows(scene, camera, lights);
    } else {
      this._collectLights(scene, lights, 'spot');
      this.spotCount = 0;
    }

    if (this.pointShadows === true) {
      this._renderPointShadows(scene, camera, lights);
    } else {
      this._collectLights(scene, lights, 'point');
      this.pointCount = 0;
    }

    this._endPasses();

    stats.cpuTimeMs = this._now() - startTime;
    return this;
  }

  /**
   * Alias of {@link update}, matching the `shadowMapper.render(...)` call used
   * in the renderer pipeline description.
   * @param {Object} scene
   * @param {Object} camera
   * @param {Object} [lights]
   * @returns {ShadowMapper} this
   */
  render(scene, camera, lights) {
    return this.update(scene, camera, lights);
  }

  /**
   * Renders the whole cascade set of one directional light.
   * @param {Object} scene
   * @param {Object} camera
   * @param {Object} dirLight
   * @returns {ShadowMapper} this
   */
  renderCascades(scene, camera, dirLight) {
    if (dirLight === null || dirLight === undefined) return this;
    if (this._ensureTarget() === false) return this;

    const ownPass = this._passDepth === 0;
    if (ownPass) this._beginPasses();

    // Also set when called directly, so the bias resolution sees the right light.
    this.directionalLight = dirLight;

    const count = this.cascades;
    const near = Math.max(1e-4, camera.near);
    const far = this._resolveShadowDistance(camera, dirLight);

    this._computeSplits(near, far, count);
    this._computeFrustumCorners(camera);

    // Light direction: the vector the light travels along.
    if (typeof dirLight.getDirection === 'function') dirLight.getDirection(_lightDir);
    else _lightDir.set(0, -1, 0);
    if (_lightDir.lengthSq() < 1e-12) _lightDir.set(0, -1, 0);
    _lightDir.normalize();
    _up.copy(Math.abs(_lightDir.y) > 0.99 ? _UP_Z : _UP_Y);

    // Rotation-only light basis, used for texel snapping.
    _rotationView.makeView(_ORIGIN, _lightDir, _up);
    _rotationWorld.lookAt(_ORIGIN, _lightDir, _up);

    const blend = this._resolveBlendWidth(count);
    const state = this.state;
    const mapSize = this.mapSize;

    state.setPolygonOffset(true, this.slopeScaleBias, this.depthOffsetUnits);

    for (let i = 0; i < count; i++) {
      const sliceNear = i === 0 ? near : Math.max(near, this.splits[i - 1] - blend);
      const sliceFar = this.splits[i];
      this._buildCascade(camera, i, sliceNear, sliceFar, near, mapSize);
      this._renderCascade(scene, i);
    }

    // Unused slots mirror the last valid cascade so a shader compiled with more
    // cascades than we render still samples something sane.
    for (let i = count; i < MAX_CASCADES; i++) {
      this.cascadeMatrices.copyWithin(i * 16, (count - 1) * 16, count * 16);
      this.splits[i] = this.splits[count - 1];
    }

    state.setPolygonOffset(false, 0, 0);

    this.cascadeCount = count;
    this._needsClear = false;
    this._writeStaticParams();
    this.stats.cascades = count;

    if (ownPass) this._endPasses();
    return this;
  }

  // =========================================================================
  // Cascade construction
  // =========================================================================

  /**
   * Maximum shadowed view distance for this frame.
   * @private
   * @param {Object} camera
   * @param {Object} light
   * @returns {number}
   */
  _resolveShadowDistance(camera, light) {
    let distance = this.shadowDistance;
    if (distance <= 0 && light.shadow !== undefined && light.shadow !== null &&
        typeof light.shadow.far === 'number' && light.shadow.far > 0) {
      distance = light.shadow.far;
    }
    if (distance <= 0) distance = camera.far;
    const cameraFar = Number.isFinite(camera.far) ? camera.far : distance;
    return Math.max(camera.near * 2, Math.min(distance, cameraFar));
  }

  /**
   * Width of the cross fade band between neighbouring cascades.
   * @private
   * @param {number} count
   * @returns {number}
   */
  _resolveBlendWidth(count) {
    if (this.cascadeBlend > 0) return this.cascadeBlend;
    // 8% of the tightest cascade: wide enough to hide the switch, narrow enough
    // that the double lookup only happens on a thin band of pixels.
    const first = this.splits[0];
    const blend = first * 0.08;
    if (count <= 1) return 0;
    return blend < 0.05 ? 0.05 : blend;
  }

  /**
   * Practical split scheme: a blend of the logarithmic and uniform schemes.
   * @private
   * @param {number} near
   * @param {number} far
   * @param {number} count
   */
  _computeSplits(near, far, count) {
    const splits = this.splits;
    const range = far - near;
    const ratio = far / near;
    const lambda = this.lambda;
    for (let i = 1; i <= count; i++) {
      const p = i / count;
      const logarithmic = near * Math.pow(ratio, p);
      const uniform = near + range * p;
      splits[i - 1] = lambda * logarithmic + (1 - lambda) * uniform;
    }
    splits[count - 1] = far;
    for (let i = count; i < MAX_CASCADES; i++) splits[i] = far;
  }

  /**
   * Unprojects the eight corners of the camera frustum into world space.
   * Near corners land in `_frustumCorners[0..11]`, far corners in `[12..23]`.
   * @private
   * @param {Object} camera
   */
  _computeFrustumCorners(camera) {
    const out = _frustumCorners;
    for (let i = 0; i < 4; i++) {
      this._unproject(camera, _NDC_X[i], _NDC_Y[i], -1, _corner);
      out[i * 3] = _corner.x;
      out[i * 3 + 1] = _corner.y;
      out[i * 3 + 2] = _corner.z;
      this._unproject(camera, _NDC_X[i], _NDC_Y[i], 1, _corner);
      out[12 + i * 3] = _corner.x;
      out[12 + i * 3 + 1] = _corner.y;
      out[12 + i * 3 + 2] = _corner.z;
    }
  }

  /**
   * NDC -> world, without depending on any optional camera helper.
   * @private
   * @param {Object} camera
   * @param {number} ndcX
   * @param {number} ndcY
   * @param {number} ndcZ
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  _unproject(camera, ndcX, ndcY, ndcZ, out) {
    const ip = camera.projectionMatrixInverse.elements;
    const x = ip[0] * ndcX + ip[4] * ndcY + ip[8] * ndcZ + ip[12];
    const y = ip[1] * ndcX + ip[5] * ndcY + ip[9] * ndcZ + ip[13];
    const z = ip[2] * ndcX + ip[6] * ndcY + ip[10] * ndcZ + ip[14];
    const w = ip[3] * ndcX + ip[7] * ndcY + ip[11] * ndcZ + ip[15];
    const inv = w !== 0 ? 1 / w : 1;
    out.set(x * inv, y * inv, z * inv);
    return out.applyMat4(camera.worldMatrix);
  }

  /**
   * Builds the orthographic light camera of one cascade and stores its
   * world -> clip matrix, together with the world AABB of the shadow volume and
   * the light space rejection parameters used while collecting casters.
   *
   * @private
   * @param {Object} camera
   * @param {number} index Cascade index.
   * @param {number} sliceNear View depth where the slice starts.
   * @param {number} sliceFar View depth where the slice ends.
   * @param {number} cameraNear
   * @param {number} mapSize
   */
  _buildCascade(camera, index, sliceNear, sliceFar, cameraNear, mapSize) {
    const cameraFar = Number.isFinite(camera.far) ? camera.far : sliceFar;
    const span = cameraFar - cameraNear;
    const tNear = span > 1e-9 ? (sliceNear - cameraNear) / span : 0;
    const tFar = span > 1e-9 ? (sliceFar - cameraNear) / span : 1;

    // Straight lines in world space, and view depth is affine in world position,
    // so a plain lerp between the near and far corner is exact.
    const src = _frustumCorners;
    const dst = _sliceCorners;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < 4; i++) {
      const n = i * 3;
      const f = 12 + i * 3;
      const dx = src[f] - src[n];
      const dy = src[f + 1] - src[n + 1];
      const dz = src[f + 2] - src[n + 2];

      const nx = src[n] + dx * tNear;
      const ny = src[n + 1] + dy * tNear;
      const nz = src[n + 2] + dz * tNear;
      dst[n] = nx;
      dst[n + 1] = ny;
      dst[n + 2] = nz;

      const fx = src[n] + dx * tFar;
      const fy = src[n + 1] + dy * tFar;
      const fz = src[n + 2] + dz * tFar;
      dst[f] = fx;
      dst[f + 1] = fy;
      dst[f + 2] = fz;

      cx += nx + fx;
      cy += ny + fy;
      cz += nz + fz;
    }
    cx *= 0.125;
    cy *= 0.125;
    cz *= 0.125;

    // Bounding sphere of the slice: rotation invariant, so the light camera
    // extent stays constant while the camera turns.
    let radiusSq = 0;
    for (let i = 0; i < 8; i++) {
      const o = i * 3;
      const dx = dst[o] - cx;
      const dy = dst[o + 1] - cy;
      const dz = dst[o + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > radiusSq) radiusSq = d;
    }
    let radius = Math.sqrt(radiusSq);
    // Quantize the radius so float noise in the corner positions cannot make the
    // projection breathe from frame to frame.
    radius = Math.ceil(radius * 16) / 16;
    if (radius < 1e-4) radius = 1e-4;

    _center.set(cx, cy, cz);

    const texelWorldSize = (radius * 2) / mapSize;
    if (this.stabilize === true) {
      // Snap the center to a whole texel of the light space grid.
      _center.applyMat4(_rotationView);
      _center.x = Math.floor(_center.x / texelWorldSize) * texelWorldSize;
      _center.y = Math.floor(_center.y / texelWorldSize) * texelWorldSize;
      _center.applyMat4(_rotationWorld);
    }

    const extrusion = this.casterExtrusion > 0 ? this.casterExtrusion : radius * 2;
    const back = radius + extrusion;

    _eye.copy(_center).addScaled(_lightDir, -back);
    _viewMatrix.makeView(_eye, _center, _up);
    _projMatrix.orthographic(-radius, radius, -radius, radius, 0, back + radius);
    _viewProj.multiplyMatrices(_projMatrix, _viewMatrix);
    _viewProj.toArray(this.cascadeMatrices, index * 16);

    this.cascadeTexelWorldSize[index] = texelWorldSize;
    this.cascadeRadius[index] = radius;

    // Light space rejection box: x/y inside +-radius, depth inside [0, back+radius].
    this._cullView.copy(_viewMatrix);
    this._cullEnabled = true;
    this._cullHalfExtent = radius;
    this._cullDepthMin = -(back + radius);
    this._cullDepthMax = 0;

    // World AABB of the very same box, used to query the broadphase.
    const ve = _viewMatrix.elements;
    _axisX.set(ve[0], ve[4], ve[8]);
    _axisY.set(ve[1], ve[5], ve[9]);
    this._volumeFromBox(_eye, _axisX, _axisY, _lightDir, radius, back + radius);
  }

  /**
   * Builds `_volume` as the world AABB of an oriented box.
   * @private
   * @param {Vec3} origin Center of the near face.
   * @param {Vec3} axisX
   * @param {Vec3} axisY
   * @param {Vec3} axisZ Direction the box extends along.
   * @param {number} halfExtent Half size along X and Y.
   * @param {number} depth Length along Z.
   */
  _volumeFromBox(origin, axisX, axisY, axisZ, halfExtent, depth) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < 8; i++) {
      const sx = (i & 1) === 0 ? -halfExtent : halfExtent;
      const sy = (i & 2) === 0 ? -halfExtent : halfExtent;
      const sz = (i & 4) === 0 ? 0 : depth;
      const x = origin.x + axisX.x * sx + axisY.x * sy + axisZ.x * sz;
      const y = origin.y + axisX.y * sx + axisY.y * sy + axisZ.y * sz;
      const z = origin.z + axisX.z * sx + axisY.z * sy + axisZ.z * sz;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    _volume.min.set(minX, minY, minZ);
    _volume.max.set(maxX, maxY, maxZ);
  }

  /**
   * Renders one cascade layer.
   * @private
   * @param {Object} scene
   * @param {number} index
   */
  _renderCascade(scene, index) {
    const state = this.state;
    this.target.bindLayer(index, 0, state);
    state.setClearDepth(1);
    state.clear(false, true, false);

    const count = this._collectCasters(scene);
    this.stats.casters += count;
    if (count === 0) return;

    _viewProj.fromArray(this.cascadeMatrices, index * 16);
    this._drawCasters(count, _viewProj, V_CLAMP_NEAR);
  }

  // =========================================================================
  // Spot and point shadows
  // =========================================================================

  /**
   * Renders one perspective shadow map per shadow casting spot light.
   * @private
   * @param {Object} scene
   * @param {Object} camera
   * @param {Object} lights
   */
  _renderSpotShadows(scene, camera, lights) {
    const list = this._collectLights(scene, lights, 'spot');
    const budget = Math.min(this.maxSpotShadows, list.length);
    this.spotCount = 0;
    if (budget <= 0) return;
    if (this._ensureSpotTarget() === false) return;

    const state = this.state;
    state.setPolygonOffset(true, this.slopeScaleBias, this.depthOffsetUnits);

    let slot = 0;
    for (let i = 0, n = list.length; i < n && slot < budget; i++) {
      const light = list[i];
      const shadow = light.shadow || null;
      const near = shadow !== null && shadow.near > 0 ? shadow.near : 0.05;
      let far = shadow !== null && shadow.far > 0 ? shadow.far : 0;
      if (far <= near) far = light.range > 0 ? light.range : 100;

      _eye.setFromMatrixPosition(light.worldMatrix);
      if (this._lightAffectsView(camera, _eye, far) === false) continue;

      if (typeof light.getDirection === 'function') light.getDirection(_lightDir);
      else _lightDir.set(0, -1, 0);
      if (_lightDir.lengthSq() < 1e-12) _lightDir.set(0, -1, 0);
      _lightDir.normalize();
      _up.copy(Math.abs(_lightDir.y) > 0.99 ? _UP_Z : _UP_Y);
      _target.copy(_eye).add(_lightDir);

      const outerCos = clampNumber(light.outerConeCos !== undefined ? light.outerConeCos : 0.707, -0.999, 0.999);
      // A little slack around the cone so the PCF kernel never samples outside it.
      const fovY = clampNumber(2 * Math.acos(outerCos) * 1.06, 0.02, Math.PI * 0.98);

      _viewMatrix.makeView(_eye, _target, _up);
      _projMatrix.perspective(fovY, 1, near, far);
      _viewProj.multiplyMatrices(_projMatrix, _viewMatrix);
      _viewProj.toArray(this.spotMatrices, slot * 16);

      const p = slot * 4;
      this.spotParams[p] = near;
      this.spotParams[p + 1] = far;
      this.spotParams[p + 2] = shadow !== null && typeof shadow.bias === 'number' ? Math.abs(shadow.bias) : this.depthBias;
      this.spotParams[p + 3] = slot;
      light.shadowIndex = slot;

      this._volumeFromSphere(_eye, far);
      this._cullEnabled = false;

      this.spotTarget.bindLayer(slot, 0, state);
      state.setClearDepth(1);
      state.clear(false, true, false);

      const casters = this._collectCasters(scene);
      this.stats.casters += casters;
      if (casters > 0) this._drawCasters(casters, _viewProj, 0);

      this.stats.spotMaps++;
      slot++;
    }

    state.setPolygonOffset(false, 0, 0);
    this.spotCount = slot;
  }

  /**
   * Renders a six face depth cube per shadow casting point light.
   * @private
   * @param {Object} scene
   * @param {Object} camera
   * @param {Object} lights
   */
  _renderPointShadows(scene, camera, lights) {
    const list = this._collectLights(scene, lights, 'point');
    const budget = Math.min(this.maxPointShadows, list.length);
    this.pointCount = 0;
    if (budget <= 0) return;

    const state = this.state;
    state.setPolygonOffset(true, this.slopeScaleBias, this.depthOffsetUnits);

    let slot = 0;
    for (let i = 0, n = list.length; i < n && slot < budget; i++) {
      const light = list[i];
      const shadow = light.shadow || null;
      const near = shadow !== null && shadow.near > 0 ? shadow.near : 0.05;
      let far = shadow !== null && shadow.far > 0 ? shadow.far : 0;
      if (far <= near) far = light.range > 0 ? light.range : 100;

      _eye.setFromMatrixPosition(light.worldMatrix);
      if (this._lightAffectsView(camera, _eye, far) === false) continue;

      const target = this._ensurePointTarget(slot);
      if (target === null) break;

      const p = slot * 4;
      this.pointParams[p] = _eye.x;
      this.pointParams[p + 1] = _eye.y;
      this.pointParams[p + 2] = _eye.z;
      this.pointParams[p + 3] = far;
      this.pointParams2[p] = near;
      this.pointParams2[p + 1] = far;
      this.pointParams2[p + 2] = shadow !== null && typeof shadow.bias === 'number' ? Math.abs(shadow.bias) : this.depthBias;
      this.pointParams2[p + 3] = 0;
      light.shadowIndex = slot;

      this._volumeFromSphere(_eye, far);
      this._cullEnabled = false;
      const casters = this._collectCasters(scene);
      this.stats.casters += casters;

      _projMatrix.perspective(Math.PI * 0.5, 1, near, far);

      for (let face = 0; face < 6; face++) {
        const o = face * 3;
        _lightDir.set(CUBE_FACE_DIR[o], CUBE_FACE_DIR[o + 1], CUBE_FACE_DIR[o + 2]);
        _up.set(CUBE_FACE_UP[o], CUBE_FACE_UP[o + 1], CUBE_FACE_UP[o + 2]);
        _target.copy(_eye).add(_lightDir);
        _viewMatrix.makeView(_eye, _target, _up);
        _viewProj.multiplyMatrices(_projMatrix, _viewMatrix);

        target.bindFace(face, 0, state);
        state.setClearDepth(1);
        state.clear(false, true, false);
        if (casters > 0) this._drawCasters(casters, _viewProj, 0);
        this.stats.pointFaces++;
      }

      slot++;
    }

    state.setPolygonOffset(false, 0, 0);
    this.pointCount = slot;
  }

  /**
   * Rejects a punctual light whose whole influence sphere is off screen: its
   * shadow map could never be sampled, so rendering it would be pure waste.
   * @private
   * @param {Object} camera
   * @param {Vec3} position
   * @param {number} radius
   * @returns {boolean}
   */
  _lightAffectsView(camera, position, radius) {
    if (camera === null || camera === undefined) return true;
    const frustum = camera.frustum;
    if (frustum === null || frustum === undefined || typeof frustum.intersectsSphere !== 'function') {
      return true;
    }
    _lightSphere.center.copy(position);
    _lightSphere.radius = radius;
    return frustum.intersectsSphere(_lightSphere);
  }

  /**
   * Builds `_volume` as the world AABB of a sphere.
   * @private
   * @param {Vec3} center
   * @param {number} radius
   */
  _volumeFromSphere(center, radius) {
    _volume.min.set(center.x - radius, center.y - radius, center.z - radius);
    _volume.max.set(center.x + radius, center.y + radius, center.z + radius);
  }

  // =========================================================================
  // Caster collection and drawing
  // =========================================================================

  /**
   * Picks the directional light that drives the cascades.
   * @private
   * @param {Object} scene
   * @param {Object} lights
   * @returns {Object|null}
   */
  _pickDirectionalLight(scene, lights) {
    const list = this._collectLights(scene, lights, 'directional');
    let best = null;
    let bestScore = -1;
    for (let i = 0, n = list.length; i < n; i++) {
      const light = list[i];
      const color = light.color;
      const luminance = color === undefined || color === null
        ? 1
        : (color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722);
      const score = Math.max(0, luminance) * Math.max(0, light.intensity === undefined ? 1 : light.intensity);
      if (score > bestScore) {
        bestScore = score;
        best = light;
      }
    }
    if (best !== null) best.shadowIndex = 0;
    return best;
  }

  /**
   * Gathers the shadow casting lights of one type into a reusable array.
   * Accepts a LightManager (`dirLights` / `punctualLights`), a plain array of
   * lights, or nothing at all (falls back to `scene.lights`).
   * @private
   * @param {Object} scene
   * @param {Object} lights
   * @param {string} type
   * @returns {Array<Object>}
   */
  _collectLights(scene, lights, type) {
    const out = this._lightScratch;
    out.length = 0;

    let source = null;
    if (lights !== null && lights !== undefined) {
      if (Array.isArray(lights)) {
        source = lights;
      } else if (type === 'directional') {
        if (Array.isArray(lights.dirLights)) source = lights.dirLights;
        else if (Array.isArray(lights.lights)) source = lights.lights;
      } else {
        if (Array.isArray(lights.punctualLights)) source = lights.punctualLights;
        else if (Array.isArray(lights.lights)) source = lights.lights;
      }
    }
    if (source === null && scene !== null && scene !== undefined && Array.isArray(scene.lights)) {
      source = scene.lights;
    }
    if (source === null) return out;

    for (let i = 0, n = source.length; i < n; i++) {
      const light = source[i];
      if (light === null || light === undefined) continue;
      if (light.type !== type) continue;
      // The shadow mapper owns `shadowIndex`; clearing it here means a light that
      // stops being shadowed this frame never leaves a stale slot behind.
      light.shadowIndex = -1;
      if (light.castShadow !== true) continue;
      if (light.visible === false) continue;
      const layers = light.layers === undefined ? 1 : light.layers;
      if ((this.layers & layers) === 0) continue;
      out.push(light);
    }
    return out;
  }

  /**
   * Fills `_casters` with the meshes that can cast into the current volume.
   * @private
   * @param {Object} scene
   * @returns {number} number of casters
   */
  _collectCasters(scene) {
    const casters = this._casters;
    casters.length = 0;

    const bvh = scene.bvh;
    if (bvh !== null && bvh !== undefined && typeof bvh.queryAABB === 'function') {
      bvh.queryAABB(_volume, casters);
    } else if (Array.isArray(scene.meshes)) {
      const meshes = scene.meshes;
      for (let i = 0, n = meshes.length; i < n; i++) casters.push(meshes[i]);
    } else if (typeof scene.traverse === 'function') {
      scene.traverse(this._collectVisitor);
    }

    // Compact in place, keeping only the meshes that really cast.
    let write = 0;
    for (let i = 0, n = casters.length; i < n; i++) {
      const mesh = casters[i];
      if (this._isCaster(mesh) === false) continue;
      casters[write++] = mesh;
    }
    casters.length = write;
    return write;
  }

  /**
   * @private
   * @param {Object} mesh
   * @returns {boolean}
   */
  _isCaster(mesh) {
    if (mesh === null || mesh === undefined) return false;
    if (mesh.isMesh !== true) return false;
    if (mesh.visible === false) return false;
    if (mesh.castShadow !== true) return false;
    if (mesh.geometry === null || mesh.geometry === undefined) return false;
    const layers = mesh.layers === undefined ? 1 : mesh.layers;
    if ((this.layers & layers) === 0) return false;
    if (mesh.isInstancedMesh === true && mesh.count <= 0) return false;

    if (this._cullEnabled === true) {
      // Exact rejection against the light space box of the cascade.
      // `updateWorldBounds` is a single version compare when nothing moved.
      if (typeof mesh.updateWorldBounds === 'function') mesh.updateWorldBounds();
      const sphere = mesh.boundingSphereWorld;
      if (sphere !== null && sphere !== undefined && sphere.radius >= 0) {
        const e = this._cullView.elements;
        const c = sphere.center;
        const r = sphere.radius;
        const x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
        const y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
        const z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
        const limit = this._cullHalfExtent + r;
        if (x < -limit || x > limit) return false;
        if (y < -limit || y > limit) return false;
        if (z < this._cullDepthMin - r || z > this._cullDepthMax + r) return false;
      }
    }
    return true;
  }

  /**
   * Draws the collected casters with a given world -> clip matrix.
   * @private
   * @param {number} count
   * @param {Mat4} viewProj
   * @param {number} variantBase Extra permutation bits (SHADOW_CLAMP_NEAR).
   */
  _drawCasters(count, viewProj, variantBase) {
    const casters = this._casters;
    this._passToken++;
    const token = this._passToken;

    for (let i = 0; i < count; i++) {
      this._drawMesh(casters[i], viewProj, variantBase, token);
    }
  }

  /**
   * Draws one caster (all of its groups when it uses several materials).
   * @private
   * @param {Object} mesh
   * @param {Mat4} viewProj
   * @param {number} variantBase
   * @param {number} token
   */
  _drawMesh(mesh, viewProj, variantBase, token) {
    const gl = this.gl;
    const state = this.state;
    const geometry = mesh.geometry;

    if (mesh.isInstancedMesh === true && typeof mesh.upload === 'function') {
      mesh.upload(gl, state);
    }

    const vao = geometry.getVAO(gl, state);
    if (vao === null || vao === undefined) return;
    vao.bind(state);

    const instanceCount = mesh.isInstancedMesh === true
      ? (mesh.count | 0)
      : (geometry.instanceCount > 0 ? geometry.instanceCount | 0 : 0);

    let variant = variantBase;
    if (instanceCount > 0 && geometry.hasAttribute('aInstanceMatrix')) variant |= V_INSTANCING;

    const skeleton = mesh.isSkinnedMesh === true ? mesh.skeleton : null;
    const skinning = skeleton !== null && skeleton !== undefined &&
      geometry.hasAttribute('aJoints') && geometry.hasAttribute('aWeights');

    // Refresh the bone matrices once per mesh, not once per group: the shadow
    // pass runs before the color pass, so it owns the upload of this frame.
    let boneTexture = null;
    if (skinning === true) {
      variant |= V_SKINNING;
      boneTexture = typeof skeleton.computeBoneTexture === 'function'
        ? (skeleton.computeBoneTexture(gl) || skeleton.boneTexture)
        : skeleton.boneTexture;
    }

    const material = mesh.material;
    const groups = geometry.groups;

    if (Array.isArray(material) && groups !== undefined && groups !== null && groups.length > 0) {
      for (let g = 0, n = groups.length; g < n; g++) {
        const group = groups[g];
        const slot = material[group.materialIndex | 0] || material[0] || null;
        this._drawRange(mesh, geometry, slot, variant, viewProj, token,
          group.start | 0, group.count | 0, instanceCount, boneTexture);
      }
      return;
    }

    const single = Array.isArray(material) ? (material[0] || null) : material;
    this._drawRange(mesh, geometry, single, variant, viewProj, token,
      geometry.getDrawStart(), geometry.getDrawCount(), instanceCount, boneTexture);
  }

  /**
   * Issues one draw call for a range of a geometry.
   * @private
   * @param {Object} mesh
   * @param {Object} geometry
   * @param {Object|null} material
   * @param {number} variant Permutation bits collected so far.
   * @param {Mat4} viewProj
   * @param {number} token Pass token, drives the view projection upload.
   * @param {number} start First element of the range.
   * @param {number} count Element count.
   * @param {number} instanceCount 0 when the mesh is not instanced.
   * @param {Object|null} boneTexture Bone matrices, when skinning is active.
   */
  _drawRange(mesh, geometry, material, variant, viewProj, token, start, count, instanceCount, boneTexture) {
    if (count <= 0) return;
    if (this._materialCasts(material) === false) return;

    const state = this.state;

    let map = null;
    let alphaMask = false;
    if (material !== null && material !== undefined) {
      alphaMask = material.alphaMode === 'mask' ||
        (typeof material.alphaTest === 'number' && material.alphaTest > 0);
      if (alphaMask === true) {
        map = this._resolveBaseColorMap(material);
        if (map !== null && geometry.hasAttribute('aUV0') === false) map = null;
      }
    }

    let finalVariant = variant;
    if (alphaMask === true) {
      finalVariant |= V_ALPHA;
      if (map !== null) finalVariant |= V_BASECOLOR_MAP;
    }

    const program = this._getProgram(finalVariant);
    if (program === null) return;
    if (program.use(state) === false) return;

    if (this._programTokens[finalVariant] !== token) {
      this._programTokens[finalVariant] = token;
      program.setUniform('uShadowViewProj', viewProj);
    }
    program.setUniform('uModelMatrix', mesh.worldMatrix);

    if ((finalVariant & V_SKINNING) !== 0) {
      if (boneTexture !== null && boneTexture !== undefined) {
        program.setTexture('uBoneTexture', boneTexture, UNIT_BONE_TEXTURE, state);
      }
      program.setUniform('uBindMatrix', mesh.bindMatrix);
      program.setUniform('uBindMatrixInverse', mesh.bindMatrixInverse);
    }

    if ((finalVariant & V_ALPHA) !== 0) {
      const opacity = typeof material.opacity === 'number' ? material.opacity : 1;
      _baseColorFactor[0] = 1;
      _baseColorFactor[1] = 1;
      _baseColorFactor[2] = 1;
      _baseColorFactor[3] = opacity;
      program.setUniform('uBaseColorFactor', _baseColorFactor);

      let cutoff = typeof material.alphaTest === 'number' && material.alphaTest > 0
        ? material.alphaTest
        : (typeof material.alphaCutoff === 'number' ? material.alphaCutoff : 0.5);
      if (!(cutoff > 0)) cutoff = 0.5;
      program.setUniform('uAlphaCutoff', cutoff);

      if ((finalVariant & V_BASECOLOR_MAP) !== 0) {
        const scale = material.uvScale;
        const offset = material.uvOffset;
        _uvTransform[0] = scale !== undefined && scale !== null && typeof scale.x === 'number' ? scale.x : 1;
        _uvTransform[1] = scale !== undefined && scale !== null && typeof scale.y === 'number' ? scale.y : 1;
        _uvTransform[2] = offset !== undefined && offset !== null && typeof offset.x === 'number' ? offset.x : 0;
        _uvTransform[3] = offset !== undefined && offset !== null && typeof offset.y === 'number' ? offset.y : 0;
        program.setUniform('uUVTransform', _uvTransform);
        program.setTexture('uBaseColorMap', map, UNIT_BASECOLOR, state);
      }
    }

    // Culling: a double sided material must not be culled or its shadow would
    // disappear; everything else uses the configured face.
    const side = material !== null && material !== undefined ? material.side : 'front';
    if (side === 'double') state.setCullFace('none');
    else if (side === 'back' && this.cullFace === 'back') state.setCullFace('front');
    else state.setCullFace(this.cullFace);

    const mode = drawModeToGL(geometry.drawMode);
    const index = geometry.index;

    if (index !== null && index !== undefined && index.buffer !== null && index.buffer !== undefined) {
      const byteOffset = start * glTypeBytes(index.type);
      if (instanceCount > 0) {
        state.drawElementsInstanced(mode, count, index.type, byteOffset, instanceCount);
      } else {
        state.drawElements(mode, count, index.type, byteOffset);
      }
    } else if (instanceCount > 0) {
      state.drawArraysInstanced(mode, start, count, instanceCount);
    } else {
      state.drawArrays(mode, start, count);
    }
    this.stats.drawCalls++;
  }

  /**
   * @private
   * @param {Object} material
   * @returns {boolean} whether this material contributes to the shadow map
   */
  _materialCasts(material) {
    if (material === null || material === undefined) return true;
    if (material.castShadow === false) return false;
    if (this.skipTransparent === true) {
      if (material.alphaMode === 'blend') return false;
      if (material.transparent === true && material.alphaMode !== 'mask') return false;
    }
    return true;
  }

  /**
   * Finds the texture holding the cutout alpha of a material.
   * @private
   * @param {Object} material
   * @returns {Object|null}
   */
  _resolveBaseColorMap(material) {
    if (isTexture(material.baseColorMap)) return material.baseColorMap;
    if (isTexture(material.map)) return material.map;
    const uniforms = material.uniforms;
    if (uniforms !== null && uniforms !== undefined) {
      if (isTexture(uniforms.uBaseColorMap)) return uniforms.uBaseColorMap;
      if (isTexture(uniforms.uAlphaMap)) return uniforms.uAlphaMap;
    }
    return null;
  }

  // =========================================================================
  // Programs and GL state
  // =========================================================================

  /**
   * Returns (compiling on first use) the depth program of one permutation.
   * @private
   * @param {number} variant Bit mask of V_* flags.
   * @returns {Object|null}
   */
  _getProgram(variant) {
    // `program === null` means the ShaderLib disposed it (the shadow source was
    // re-registered); the cache then heals itself on the next draw.
    const cached = this._programs[variant];
    if (cached !== null && cached.program !== null) return cached;
    this._programTokens[variant] = -1;

    const defines = {};
    if ((variant & V_INSTANCING) !== 0) defines.USE_INSTANCING = 1;
    if ((variant & V_SKINNING) !== 0) defines.USE_SKINNING = 1;
    if ((variant & V_ALPHA) !== 0) defines.ALPHA_MODE_MASK = 1;
    if ((variant & V_BASECOLOR_MAP) !== 0) defines.USE_BASECOLOR_MAP = 1;
    if ((variant & V_CLAMP_NEAR) !== 0) defines.SHADOW_CLAMP_NEAR = 1;

    let program = null;
    try {
      program = this.shaderLib.get(SHADOW_SHADER_NAME, defines);
    } catch (error) {
      Logger.error('ShadowMapper: falha ao compilar o shader de sombra: ' + error.message);
      return null;
    }
    this._programs[variant] = program;
    return program;
  }

  /**
   * Sets up the depth only render state shared by every shadow pass and
   * remembers the viewport so it can be restored afterwards.
   * @private
   */
  _beginPasses() {
    if (this._passDepth === undefined) this._passDepth = 0;
    this._passDepth++;
    if (this._passDepth > 1) return;

    const state = this.state;
    this._savedViewport = this._readViewport();
    state.setScissorTest(false);
    state.setDepthTest(true);
    state.setDepthWrite(true);
    state.setDepthFunc('less');
    state.setBlending('none');
    state.setColorMask(false, false, false, false);
    state.setFrontFace(true);
  }

  /**
   * Restores the state the renderer expects after the shadow passes.
   * @private
   */
  _endPasses() {
    if (this._passDepth === undefined || this._passDepth === 0) return;
    this._passDepth--;
    if (this._passDepth > 0) return;

    const state = this.state;
    state.setPolygonOffset(false, 0, 0);
    state.setColorMask(true, true, true, true);
    state.setCullFace('back');
    state.bindFramebuffer(GL_FRAMEBUFFER, null);

    const viewport = this._savedViewport;
    if (viewport !== null && viewport !== undefined) {
      state.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    }
  }

  /**
   * Reads back the viewport the renderer had set. The state cache mirrors it,
   * so no synchronous `getParameter` is needed in the common case.
   * @private
   * @returns {Int32Array}
   */
  _readViewport() {
    if (this._viewportScratch === undefined) this._viewportScratch = new Int32Array(4);
    const out = this._viewportScratch;
    const state = this.state;
    if (state !== null && typeof state._viewportW === 'number' && state._viewportW > 0 &&
        typeof state._viewportH === 'number' && state._viewportH > 0) {
      out[0] = state._viewportX;
      out[1] = state._viewportY;
      out[2] = state._viewportW;
      out[3] = state._viewportH;
      return out;
    }
    out[0] = 0;
    out[1] = 0;
    out[2] = this.gl.drawingBufferWidth;
    out[3] = this.gl.drawingBufferHeight;
    return out;
  }

  /**
   * Clears every cascade layer to "fully lit" so a shader that samples the map
   * while no light casts still shades correctly.
   * @private
   */
  _clearAllCascades() {
    if (this.target === null) return;
    const state = this.state;
    state.setDepthWrite(true);
    state.setClearDepth(1);
    for (let i = 0, n = this.cascades; i < n; i++) {
      this.target.bindLayer(i, 0, state);
      state.clear(false, true, false);
    }
    this._needsClear = false;
  }

  /**
   * Resets the cascade portion of the uniform block to a neutral state.
   * @private
   */
  _clearCascadeState() {
    this.cascadeCount = 0;
    this.directionalLight = null;
    const matrices = this.cascadeMatrices;
    for (let i = 0; i < MAX_CASCADES; i++) {
      const o = i * 16;
      for (let k = 0; k < 16; k++) matrices[o + k] = 0;
      matrices[o] = 1;
      matrices[o + 5] = 1;
      matrices[o + 10] = 1;
      matrices[o + 15] = 1;
      this.splits[i] = 0;
    }
    this._writeStaticParams();
  }

  /**
   * Refreshes the two parameter vectors of the `Shadows` block.
   * @private
   */
  _writeStaticParams() {
    const params = this.params;
    const params2 = this.params2;

    const texelSize = 1 / this.mapSize;
    const texelWorld = this.cascadeCount > 0 ? this.cascadeTexelWorldSize[0] : 0;

    let normalBias = this.normalBias * texelWorld;
    const light = this.directionalLight;
    if (light !== null && light !== undefined && light.shadow !== null && light.shadow !== undefined &&
        typeof light.shadow.normalBias === 'number') {
      normalBias += light.shadow.normalBias * this.normalBiasScale;
    }

    let depthBias = this.depthBias;
    if (light !== null && light !== undefined && light.shadow !== null && light.shadow !== undefined &&
        typeof light.shadow.bias === 'number' && light.shadow.bias !== 0) {
      // The GLSL chunk subtracts the bias, so both the "negative bias" convention
      // and a plain positive offset end up doing the right thing.
      depthBias = Math.abs(light.shadow.bias);
    }

    params[0] = texelSize;
    params[1] = depthBias;
    params[2] = normalBias;
    params[3] = this.softness;

    const count = this.cascadeCount;
    params2[0] = count;
    params2[1] = this.pcfRadius;
    params2[2] = count > 1 ? this._resolveBlendWidth(count) : 0;
    params2[3] = this.fadeDistance > 0
      ? this.fadeDistance
      : (count > 0 ? this.splits[count - 1] : 0);

    this.version++;
  }

  /** @type {number} Size of one shadow texel in [0,1] texture space. */
  get texelSize() {
    return this.params[0];
  }

  /** @type {number} Depth bias actually uploaded (always positive). */
  get resolvedDepthBias() {
    return this.params[1];
  }

  /** @type {number} World space normal offset actually uploaded. */
  get resolvedNormalBias() {
    return this.params[2];
  }

  /** @type {number} Width of the cascade cross fade band, in world units. */
  get resolvedBlendWidth() {
    return this.params2[2];
  }

  /** @type {number} Distance where the shadows fade out completely. */
  get resolvedFadeDistance() {
    return this.params2[3];
  }

  /**
   * Copies the whole std140 `Shadows` block into a destination buffer. This is
   * the integration point for UniformBuffers: the layout is guaranteed to be
   * mat4[4] + vec4 + vec4 + vec4, tightly packed.
   *
   * @param {Float32Array} dst
   * @param {number} [offset=0] Destination offset, in floats.
   * @returns {number} How many floats were written.
   */
  writeUBO(dst, offset = 0) {
    dst.set(this.uboData, offset);
    return SHADOW_UBO_FLOATS;
  }

  /**
   * Monotonic clock, resolved lazily so the module never touches `performance`
   * at import time.
   * @private
   * @returns {number}
   */
  _now() {
    const perf = globalThis.performance;
    return perf !== undefined && perf !== null && typeof perf.now === 'function' ? perf.now() : Date.now();
  }
}
