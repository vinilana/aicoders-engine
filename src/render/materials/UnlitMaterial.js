/**
 * Constant colour material: no lights, no shadows, no environment.
 *
 * Cheapest surface the engine can draw, and the target of the glTF
 * KHR_materials_unlit extension. Like StandardMaterial it exposes `uniforms` as an
 * accessor, so mutating a property is enough - there is no update step to forget.
 */
import { Material } from '../Material.js';
import { Color } from '../../math/Color.js';
import { Vec2 } from '../../math/Vec2.js';
import { Mat3 } from '../../math/Mat3.js';

export class UnlitMaterial extends Material {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    super(Object.assign({ shaderName: 'unlit' }, options));

    /** Linear colour written straight to the framebuffer. @type {Color} */
    this.baseColor = new Color(1, 1, 1);

    /** UV tiling applied to the base colour map. @type {Vec2} */
    this.uvScale = new Vec2(1, 1);
    /** UV offset applied to the base colour map. @type {Vec2} */
    this.uvOffset = new Vec2(0, 0);
    /** UV rotation in radians. @type {number} */
    this.uvRotation = 0;
    /** Pivot of the UV rotation. @type {Vec2} */
    this.uvCenter = new Vec2(0, 0);

    /** Decode the base colour map from sRGB in the shader. @type {boolean} */
    this.srgbDecode = false;
    /** Sample the base colour map with TEXCOORD_1. @type {boolean} */
    this.baseColorUV1 = false;

    /** @private @type {Object|null} */
    this._baseColorMap = null;

    /** @private */
    this._baseColorFactor = new Float32Array(4);
    /** @private */
    this._uvTransform = new Mat3();
    /** @private @type {boolean} */
    this._uvTransformActive = false;
    /** @private */
    this._syncReady = false;

    if (options.baseColor !== undefined) this.setBaseColor(options.baseColor);
    if (options.color !== undefined) this.setBaseColor(options.color);
    if (options.baseColorMap !== undefined) this._baseColorMap = options.baseColorMap || null;
    if (options.map !== undefined) this._baseColorMap = options.map || null;
    if (options.srgbDecode !== undefined) this.srgbDecode = !!options.srgbDecode;
    if (options.baseColorUV1 !== undefined) this.baseColorUV1 = !!options.baseColorUV1;
    if (options.uvScale !== undefined) this._readVec2(options.uvScale, this.uvScale);
    if (options.uvOffset !== undefined) this._readVec2(options.uvOffset, this.uvOffset);
    if (options.uvCenter !== undefined) this._readVec2(options.uvCenter, this.uvCenter);
    if (options.uvRotation !== undefined) this.uvRotation = options.uvRotation;

    // Unlit surfaces are their own light source as far as the pipeline cares.
    this.receiveShadow = options.receiveShadow !== undefined ? options.receiveShadow : false;
    this.receiveIBL = options.receiveIBL !== undefined ? options.receiveIBL : false;

    this._syncReady = true;
    this.syncUniforms();
    this.needsUpdate = true;
  }

  /**
   * @private
   * @param {Object|Array|number} source
   * @param {Vec2} target
   */
  _readVec2(source, target) {
    if (source === null || source === undefined) return;
    if (typeof source === 'number') target.set(source, source);
    else if (source.x !== undefined) target.set(source.x, source.y);
    else if (source.length >= 2) target.set(source[0], source[1]);
  }

  /**
   * Uniform bag, synchronised on every read.
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

  /** Alias matching the common `map` naming. @returns {Object|null} */
  get map() { return this._baseColorMap; }
  set map(value) { this.baseColorMap = value; }

  /**
   * @param {Color|number|string|Array} value
   * @returns {UnlitMaterial} this
   */
  setBaseColor(value) {
    if (value instanceof Color) this.baseColor.copy(value);
    else if (Array.isArray(value) || ArrayBuffer.isView(value)) this.baseColor.set(value[0], value[1], value[2]);
    else this.baseColor.copy(new Color(value));
    return this;
  }

  /**
   * @param {number} scaleX
   * @param {number} scaleY
   * @param {number} [offsetX]
   * @param {number} [offsetY]
   * @param {number} [rotation]
   * @returns {UnlitMaterial} this
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
   * @param {string} mode 'opaque' | 'mask' | 'blend'
   * @param {number} [cutoff]
   * @returns {UnlitMaterial} this
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

  /**
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
    uniforms.uAlphaCutoff = this.alphaTest;

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
      this.needsUpdate = true;
    }

    uniforms.uBaseColorMap = this._baseColorMap;
    return uniforms;
  }

  /**
   * @param {Object} defines
   * @param {Object|null} geometry
   * @param {Object|null} renderContext
   */
  applyOwnDefines(defines, geometry, renderContext) {
    if (this._baseColorMap) {
      defines.USE_BASECOLOR_MAP = 1;
      if (this.baseColorUV1) defines.BASECOLOR_UV1 = 1;
    }
    if (this._uvTransformActive) defines.USE_UV_TRANSFORM = 1;
    if (this.srgbDecode) defines.MANUAL_SRGB_DECODE = 1;

    // Nothing in the unlit shader reads a light, a shadow map or a probe. Dropping
    // those defines also collapses several render contexts onto one permutation.
    delete defines.USE_SHADOWS;
    delete defines.SHADOW_CASCADES;
    delete defines.USE_CLUSTERED;
    delete defines.CLUSTER_X;
    delete defines.CLUSTER_Y;
    delete defines.CLUSTER_Z;
    delete defines.USE_IBL;
    delete defines.MAX_DIR_LIGHTS;
    delete defines.MAX_PUNCTUAL_LIGHTS;
    // No normal, therefore no tangent frame either.
    delete defines.USE_TANGENT;
  }

  /**
   * @param {UnlitMaterial} source
   * @returns {UnlitMaterial} this
   */
  copy(source) {
    super.copy(source);
    if (!(source instanceof UnlitMaterial)) return this;

    this.baseColor.copy(source.baseColor);
    this.uvScale.copy(source.uvScale);
    this.uvOffset.copy(source.uvOffset);
    this.uvCenter.copy(source.uvCenter);
    this.uvRotation = source.uvRotation;
    this.srgbDecode = source.srgbDecode;
    this.baseColorUV1 = source.baseColorUV1;
    this._baseColorMap = source._baseColorMap;

    this.syncUniforms();
    this.needsUpdate = true;
    return this;
  }

  /** Drop the texture reference along with the base class state. */
  dispose() {
    this._baseColorMap = null;
    super.dispose();
  }
}
