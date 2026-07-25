/**
 * Physically based metallic-roughness material, the default surface of the engine.
 *
 * The public properties are the source of truth and can be mutated freely; they are
 * folded into the `uniforms` object lazily, the first time anything reads it in a
 * frame. That is why `uniforms` is an accessor here: the renderer never has to know
 * about a separate "update" step, and a property written between two draw calls is
 * always the one that reaches the GPU.
 *
 * Permutation defines, on the other hand, are only recomputed when `needsUpdate` is
 * raised, which the texture map setters do automatically. Scalars never change the
 * permutation, so writing `material.roughness = 0.3` every frame costs nothing.
 */
import { Material } from '../Material.js';
import { Color } from '../../math/Color.js';
import { Vec2 } from '../../math/Vec2.js';
import { Mat3 } from '../../math/Mat3.js';

/** Reflectance of a dielectric at normal incidence, from its index of refraction. */
function iorToF0(ior) {
  const k = (ior - 1) / (ior + 1);
  return k * k;
}

/**
 * Invert the `reflectance` remap used by the lighting chunk (f0 = 0.16 * r^2), so
 * an artist facing ior + specular intensity pair can drive it.
 */
function f0ToReflectance(f0) {
  const r = Math.sqrt(Math.max(f0, 0) / 0.16);
  return r > 1 ? 1 : r;
}

export class StandardMaterial extends Material {
  /**
   * @param {Object} [options] every public property may be set here
   */
  constructor(options = {}) {
    super(Object.assign({ shaderName: 'standard' }, options));

    /** Linear base colour (albedo for dielectrics, f0 for metals). @type {Color} */
    this.baseColor = new Color(1, 1, 1);
    /** @type {number} 0 = fully rough dielectric, 1 = pure metal */
    this.metallic = 0.0;
    /** @type {number} artist facing (perceptual) roughness */
    this.roughness = 1.0;
    /** Linear emissive colour. @type {Color} */
    this.emissive = new Color(0, 0, 0);
    /** @type {number} multiplier applied to `emissive` (KHR_materials_emissive_strength) */
    this.emissiveIntensity = 1.0;
    /** @type {number} strength of the tangent space normal map */
    this.normalScale = 1.0;
    /** @type {number} how much of the occlusion map is applied */
    this.occlusionStrength = 1.0;
    /** @type {number} index of refraction, drives the dielectric f0 */
    this.ior = 1.5;
    /** @type {number} scales the dielectric f0 without touching the ior */
    this.specularIntensity = 1.0;

    /** UV tiling applied to every map. @type {Vec2} */
    this.uvScale = new Vec2(1, 1);
    /** UV offset applied to every map. @type {Vec2} */
    this.uvOffset = new Vec2(0, 0);
    /** UV rotation in radians, around `uvCenter`. @type {number} */
    this.uvRotation = 0;
    /** Pivot of the UV rotation. @type {Vec2} */
    this.uvCenter = new Vec2(0, 0);

    /** Decode base colour / emissive from sRGB in the shader. @type {boolean} */
    this.srgbDecode = false;
    /** Filter the normal derivatives into roughness to fight specular aliasing. @type {boolean} */
    this.specularAntiAliasing = false;
    /** Invert the green channel of the normal map (DirectX style maps). @type {boolean} */
    this.flipNormalY = false;

    /** Per map UV set selection; false = TEXCOORD_0, true = TEXCOORD_1. */
    this.baseColorUV1 = false;
    this.normalUV1 = false;
    this.metallicRoughnessUV1 = false;
    this.occlusionUV1 = false;
    this.emissiveUV1 = false;

    /** @private @type {Object|null} */
    this._baseColorMap = null;
    /** @private @type {Object|null} */
    this._normalMap = null;
    /** @private @type {Object|null} */
    this._metallicRoughnessMap = null;
    /** @private @type {Object|null} */
    this._occlusionMap = null;
    /** @private @type {Object|null} */
    this._emissiveMap = null;

    /** @private pre-allocated uniform storage, never reallocated */
    this._baseColorFactor = new Float32Array(4);
    /** @private */
    this._emissiveFactor = new Float32Array(3);
    /** @private */
    this._uvTransform = new Mat3();
    /** @private @type {boolean} whether the UV transform is currently non identity */
    this._uvTransformActive = false;
    /** @private guard so the base constructor cannot trigger a premature sync */
    this._syncReady = false;

    this._applyOptions(options);
    this._syncReady = true;
    this.syncUniforms();
    this.needsUpdate = true;
  }

  /**
   * Copy the recognised option keys onto the instance. Colours accept anything the
   * Color constructor understands, vectors accept `{x,y}` or `[x,y]`.
   * @private
   * @param {Object} options
   */
  _applyOptions(options) {
    if (options.baseColor !== undefined) this.setBaseColor(options.baseColor);
    if (options.color !== undefined) this.setBaseColor(options.color);
    if (options.metallic !== undefined) this.metallic = options.metallic;
    if (options.roughness !== undefined) this.roughness = options.roughness;
    if (options.emissive !== undefined) this.setEmissive(options.emissive);
    if (options.emissiveIntensity !== undefined) this.emissiveIntensity = options.emissiveIntensity;
    if (options.normalScale !== undefined) this.normalScale = options.normalScale;
    if (options.occlusionStrength !== undefined) this.occlusionStrength = options.occlusionStrength;
    if (options.ior !== undefined) this.ior = options.ior;
    if (options.specularIntensity !== undefined) this.specularIntensity = options.specularIntensity;

    if (options.uvScale !== undefined) this._readVec2(options.uvScale, this.uvScale);
    if (options.uvOffset !== undefined) this._readVec2(options.uvOffset, this.uvOffset);
    if (options.uvCenter !== undefined) this._readVec2(options.uvCenter, this.uvCenter);
    if (options.uvRotation !== undefined) this.uvRotation = options.uvRotation;

    if (options.srgbDecode !== undefined) this.srgbDecode = !!options.srgbDecode;
    if (options.specularAntiAliasing !== undefined) this.specularAntiAliasing = !!options.specularAntiAliasing;
    if (options.flipNormalY !== undefined) this.flipNormalY = !!options.flipNormalY;

    if (options.baseColorUV1 !== undefined) this.baseColorUV1 = !!options.baseColorUV1;
    if (options.normalUV1 !== undefined) this.normalUV1 = !!options.normalUV1;
    if (options.metallicRoughnessUV1 !== undefined) this.metallicRoughnessUV1 = !!options.metallicRoughnessUV1;
    if (options.occlusionUV1 !== undefined) this.occlusionUV1 = !!options.occlusionUV1;
    if (options.emissiveUV1 !== undefined) this.emissiveUV1 = !!options.emissiveUV1;

    if (options.baseColorMap !== undefined) this._baseColorMap = options.baseColorMap;
    if (options.normalMap !== undefined) this._normalMap = options.normalMap;
    if (options.metallicRoughnessMap !== undefined) this._metallicRoughnessMap = options.metallicRoughnessMap;
    if (options.occlusionMap !== undefined) this._occlusionMap = options.occlusionMap;
    if (options.emissiveMap !== undefined) this._emissiveMap = options.emissiveMap;
  }

  /**
   * @private
   * @param {Object|Array} source
   * @param {Vec2} target
   */
  _readVec2(source, target) {
    if (source === null || source === undefined) return;
    if (typeof source === 'number') target.set(source, source);
    else if (source.x !== undefined) target.set(source.x, source.y);
    else if (source.length >= 2) target.set(source[0], source[1]);
  }

  /* ---------------------------------------------------------------- accessors */

  /**
   * Uniform bag. Reading it always returns freshly synchronised values, so the
   * renderer can upload it without knowing anything about this class.
   * @returns {Object}
   */
  get uniforms() {
    this.syncUniforms();
    return this._uniforms;
  }

  set uniforms(value) {
    this._uniforms = value || {};
  }

  /** @returns {Object|null} */
  get baseColorMap() { return this._baseColorMap; }
  set baseColorMap(value) {
    if (this._baseColorMap === value) return;
    this._baseColorMap = value || null;
    this.needsUpdate = true;
  }

  /** @returns {Object|null} */
  get normalMap() { return this._normalMap; }
  set normalMap(value) {
    if (this._normalMap === value) return;
    this._normalMap = value || null;
    this.needsUpdate = true;
  }

  /** @returns {Object|null} */
  get metallicRoughnessMap() { return this._metallicRoughnessMap; }
  set metallicRoughnessMap(value) {
    if (this._metallicRoughnessMap === value) return;
    this._metallicRoughnessMap = value || null;
    this.needsUpdate = true;
  }

  /** @returns {Object|null} */
  get occlusionMap() { return this._occlusionMap; }
  set occlusionMap(value) {
    if (this._occlusionMap === value) return;
    this._occlusionMap = value || null;
    this.needsUpdate = true;
  }

  /** @returns {Object|null} */
  get emissiveMap() { return this._emissiveMap; }
  set emissiveMap(value) {
    if (this._emissiveMap === value) return;
    this._emissiveMap = value || null;
    this.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ setters */

  /**
   * @param {Color|number|string|Array} value anything Color understands
   * @returns {StandardMaterial} this
   */
  setBaseColor(value) {
    if (value instanceof Color) this.baseColor.copy(value);
    else if (Array.isArray(value) || ArrayBuffer.isView(value)) this.baseColor.set(value[0], value[1], value[2]);
    else this.baseColor.copy(new Color(value));
    return this;
  }

  /**
   * @param {Color|number|string|Array} value
   * @param {number} [intensity]
   * @returns {StandardMaterial} this
   */
  setEmissive(value, intensity) {
    if (value instanceof Color) this.emissive.copy(value);
    else if (Array.isArray(value) || ArrayBuffer.isView(value)) this.emissive.set(value[0], value[1], value[2]);
    else this.emissive.copy(new Color(value));
    if (intensity !== undefined) this.emissiveIntensity = intensity;
    return this;
  }

  /**
   * Set the whole UV transform at once. Unlike writing `uvScale` / `uvOffset` in
   * place, this raises `needsUpdate` immediately, so the permutation switches on
   * the very next draw instead of the next frame.
   *
   * @param {number} scaleX
   * @param {number} scaleY
   * @param {number} [offsetX]
   * @param {number} [offsetY]
   * @param {number} [rotation] radians
   * @returns {StandardMaterial} this
   */
  setUVTransform(scaleX, scaleY, offsetX = 0, offsetY = 0, rotation = 0) {
    this.uvScale.set(scaleX, scaleY);
    this.uvOffset.set(offsetX, offsetY);
    this.uvRotation = rotation;
    this.syncUniforms();
    this.needsUpdate = true;
    return this;
  }

  /**
   * Switch the transparency mode and the render state that goes with it.
   *
   * Following the glTF rules, the cutoff only applies to 'mask': switching to
   * 'blend' or 'opaque' without an explicit cutoff clears it, so a material does
   * not keep discarding fragments after it was told to blend them.
   *
   * @param {string} mode 'opaque' | 'mask' | 'blend'
   * @param {number} [cutoff] alpha threshold, only meaningful for 'mask'
   * @returns {StandardMaterial} this
   */
  setAlphaMode(mode, cutoff) {
    this.alphaMode = mode;
    if (cutoff !== undefined) this.alphaTest = cutoff;
    else if (mode !== 'mask') this.alphaTest = 0;
    if (mode === 'blend') {
      this.transparent = true;
      this.blending = 'normal';
      this.depthWrite = false;
    } else if (mode === 'mask') {
      this.transparent = false;
      this.blending = 'none';
      this.depthWrite = true;
      if (this.alphaTest <= 0) this.alphaTest = 0.5;
    } else {
      this.transparent = false;
      this.blending = 'none';
      this.depthWrite = true;
    }
    this.needsUpdate = true;
    return this;
  }

  /* -------------------------------------------------------------- uniform sync */

  /**
   * Fold the public properties into the uniform bag. Allocation free: every
   * destination buffer is created once in the constructor.
   * @returns {Object} the uniform bag
   */
  syncUniforms() {
    const uniforms = this._uniforms;
    if (this._syncReady !== true || !uniforms) return uniforms;

    const baseColorFactor = this._baseColorFactor;
    baseColorFactor[0] = this.baseColor.r;
    baseColorFactor[1] = this.baseColor.g;
    baseColorFactor[2] = this.baseColor.b;
    baseColorFactor[3] = this.opacity;
    uniforms.uBaseColorFactor = baseColorFactor;

    const emissiveFactor = this._emissiveFactor;
    const emissiveIntensity = this.emissiveIntensity;
    emissiveFactor[0] = this.emissive.r * emissiveIntensity;
    emissiveFactor[1] = this.emissive.g * emissiveIntensity;
    emissiveFactor[2] = this.emissive.b * emissiveIntensity;
    uniforms.uEmissiveFactor = emissiveFactor;

    uniforms.uMetallic = this.metallic;
    uniforms.uRoughness = this.roughness;
    uniforms.uNormalScale = this.normalScale;
    uniforms.uOcclusionStrength = this.occlusionStrength;
    uniforms.uAlphaCutoff = this.alphaTest;
    uniforms.uReflectance = f0ToReflectance(iorToF0(this.ior) * this.specularIntensity);

    // The UV transform is only uploaded (and only compiled in) when it does
    // something; the identity case must not cost a mat3 multiply per vertex.
    const scaleX = this.uvScale.x;
    const scaleY = this.uvScale.y;
    const offsetX = this.uvOffset.x;
    const offsetY = this.uvOffset.y;
    const rotation = this.uvRotation;
    const active = scaleX !== 1 || scaleY !== 1 || offsetX !== 0 || offsetY !== 0 || rotation !== 0;

    if (active) {
      this._uvTransform.setUvTransform(
        offsetX, offsetY, scaleX, scaleY, rotation, this.uvCenter.x, this.uvCenter.y
      );
      uniforms.uUVTransform = this._uvTransform;
    } else if (uniforms.uUVTransform !== undefined) {
      uniforms.uUVTransform = null;
    }
    if (active !== this._uvTransformActive) {
      this._uvTransformActive = active;
      // Flips the USE_UV_TRANSFORM permutation on the next define resolution.
      this.needsUpdate = true;
    }

    uniforms.uBaseColorMap = this._baseColorMap;
    uniforms.uNormalMap = this._normalMap;
    uniforms.uMetallicRoughnessMap = this._metallicRoughnessMap;
    uniforms.uOcclusionMap = this._occlusionMap;
    uniforms.uEmissiveMap = this._emissiveMap;

    return uniforms;
  }

  /* ------------------------------------------------------------------ defines */

  /**
   * Add the defines that depend on this material's own configuration.
   * @param {Object} defines
   * @param {Object|null} geometry
   * @param {Object|null} renderContext
   */
  applyOwnDefines(defines, geometry, renderContext) {
    if (this._baseColorMap) {
      defines.USE_BASECOLOR_MAP = 1;
      if (this.baseColorUV1) defines.BASECOLOR_UV1 = 1;
    }
    if (this._normalMap) {
      defines.USE_NORMAL_MAP = 1;
      if (this.normalUV1) defines.NORMAL_UV1 = 1;
      if (this.flipNormalY) defines.FLIP_NORMAL_Y = 1;
    }
    if (this._metallicRoughnessMap) {
      defines.USE_MR_MAP = 1;
      if (this.metallicRoughnessUV1) defines.MR_UV1 = 1;
    }
    if (this._occlusionMap) {
      defines.USE_OCCLUSION_MAP = 1;
      if (this.occlusionUV1) defines.OCCLUSION_UV1 = 1;
    }
    if (this._emissiveMap) {
      defines.USE_EMISSIVE_MAP = 1;
      if (this.emissiveUV1) defines.EMISSIVE_UV1 = 1;
    }
    if (this._uvTransformActive) defines.USE_UV_TRANSFORM = 1;
    if (this.srgbDecode) defines.MANUAL_SRGB_DECODE = 1;
    if (this.specularAntiAliasing) defines.USE_SPECULAR_AA = 1;
  }

  /* --------------------------------------------------------------------- copy */

  /**
   * @param {StandardMaterial} source
   * @returns {StandardMaterial} this
   */
  copy(source) {
    super.copy(source);
    if (!(source instanceof StandardMaterial)) return this;

    this.baseColor.copy(source.baseColor);
    this.metallic = source.metallic;
    this.roughness = source.roughness;
    this.emissive.copy(source.emissive);
    this.emissiveIntensity = source.emissiveIntensity;
    this.normalScale = source.normalScale;
    this.occlusionStrength = source.occlusionStrength;
    this.ior = source.ior;
    this.specularIntensity = source.specularIntensity;

    this.uvScale.copy(source.uvScale);
    this.uvOffset.copy(source.uvOffset);
    this.uvCenter.copy(source.uvCenter);
    this.uvRotation = source.uvRotation;

    this.srgbDecode = source.srgbDecode;
    this.specularAntiAliasing = source.specularAntiAliasing;
    this.flipNormalY = source.flipNormalY;

    this.baseColorUV1 = source.baseColorUV1;
    this.normalUV1 = source.normalUV1;
    this.metallicRoughnessUV1 = source.metallicRoughnessUV1;
    this.occlusionUV1 = source.occlusionUV1;
    this.emissiveUV1 = source.emissiveUV1;

    this._baseColorMap = source._baseColorMap;
    this._normalMap = source._normalMap;
    this._metallicRoughnessMap = source._metallicRoughnessMap;
    this._occlusionMap = source._occlusionMap;
    this._emissiveMap = source._emissiveMap;

    this.syncUniforms();
    this.needsUpdate = true;
    return this;
  }

  /** Drop the texture references along with the base class state. */
  dispose() {
    this._baseColorMap = null;
    this._normalMap = null;
    this._metallicRoughnessMap = null;
    this._occlusionMap = null;
    this._emissiveMap = null;
    super.dispose();
  }
}
