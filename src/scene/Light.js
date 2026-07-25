import { Node3D } from './Node3D.js';
import { Color } from '../math/Color.js';
import { Vec3 } from '../math/Vec3.js';
import { EPSILON } from '../math/MathUtils.js';

const _v1 = new Vec3();

/**
 * Base light.
 *
 * Intensity is expressed in candela-like units and punctual lights attenuate
 * physically (1 / d^2) with a smooth window driven by `range`, so a light never
 * leaks past its cluster bounds.
 */
export class Light extends Node3D {
  isLight = true;

  /** @type {'directional'|'point'|'spot'} */
  type = 'directional';

  color = new Color(1, 1, 1);
  intensity = 1;

  /** Cut-off distance for punctual lights (world units). */
  range = 0;

  /** Cosine of the inner cone half angle (spot lights). */
  innerConeCos = 1;
  /** Cosine of the outer cone half angle (spot lights). */
  outerConeCos = 0.7071067811865476;

  castShadow = false;

  /** World space aim point, used when `useTarget` is true. */
  target = new Vec3(0, 0, 0);
  /** When true the light direction is `target - worldPosition`. */
  useTarget = false;

  /** Slot assigned by the shadow mapper, -1 when the light casts no shadow. */
  shadowIndex = -1;

  /**
   * @type {{mapSize: number, bias: number, normalBias: number, near: number,
   *         far: number, cascades: number, lambda: number}}
   */
  shadow = {
    mapSize: 1024,
    bias: -0.0005,
    normalBias: 0.02,
    near: 0.1,
    far: 100,
    cascades: 1,
    lambda: 0.6
  };

  /**
   * @param {'directional'|'point'|'spot'} [type='directional']
   * @param {number|Color} [color=0xffffff] Hex color or Color instance.
   * @param {number} [intensity=1]
   */
  constructor(type = 'directional', color = 0xffffff, intensity = 1) {
    super('Light');
    this.type = type;
    this.setColor(color);
    this.intensity = intensity;
    this.castShadow = false;
    this.receiveShadow = false;
    this.frustumCulled = false;
  }

  /**
   * @param {number|Color} color Hex value or Color instance.
   * @returns {Light} this
   */
  setColor(color) {
    if (typeof color === 'number') this.color.setHex(color);
    else if (color !== null && color !== undefined) this.color.copy(color);
    return this;
  }

  /**
   * Direction the light travels, in world space (normalized).
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getDirection(out) {
    if (this.useTarget === true) {
      _v1.setFromMatrixPosition(this.worldMatrix);
      out.copy(this.target).sub(_v1);
      const len = out.length();
      if (len > EPSILON) return out.divideScalar(len);
    }
    return this.getWorldDirection(out);
  }

  /**
   * Vector pointing from the scene towards the light, which is what the
   * shading equations and the `Lights` uniform block expect.
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getDirectionToLight(out) {
    return this.getDirection(out).negate();
  }

  /**
   * Effective radius of influence used by the clustered light assignment.
   * @returns {number}
   */
  getInfluenceRadius() {
    if (this.type === 'directional') return Infinity;
    if (this.range > 0) return this.range;
    // Solve intensity / d^2 = cutoff for a perceptual cutoff of 1/255.
    const lum = Math.max(this.color.r, Math.max(this.color.g, this.color.b)) * this.intensity;
    return Math.sqrt(Math.max(lum, 0) * 255);
  }

  /** @protected */
  _disposeSelf() {
    super._disposeSelf();
    this.shadowIndex = -1;
  }
}

/**
 * Infinitely distant light. Direction goes from `position` towards `target`
 * (or from the node orientation when `useTarget` is false). Shadows use
 * cascaded shadow maps.
 */
export class DirectionalLight extends Light {
  isDirectionalLight = true;

  /**
   * @param {number|Color} [color=0xffffff]
   * @param {number} [intensity=1]
   */
  constructor(color = 0xffffff, intensity = 1) {
    super('directional', color, intensity);
    this.name = 'DirectionalLight';
    this.useTarget = true;
    this.range = 0;
    this.castShadow = false;
    this.shadow.mapSize = 2048;
    this.shadow.bias = -0.0005;
    this.shadow.normalBias = 0.05;
    this.shadow.near = 0.1;
    this.shadow.far = 500;
    this.shadow.cascades = 4;
    this.shadow.lambda = 0.6;
    this.position.set(0, 10, 10);
  }
}

/**
 * Omnidirectional punctual light with physical 1 / d^2 falloff windowed by
 * `range`.
 */
export class PointLight extends Light {
  isPointLight = true;

  /** Falloff exponent, 2 is physically correct. */
  decay = 2;

  /**
   * @param {number|Color} [color=0xffffff]
   * @param {number} [intensity=1]
   * @param {number} [range=10]
   */
  constructor(color = 0xffffff, intensity = 1, range = 10) {
    super('point', color, intensity);
    this.name = 'PointLight';
    this.useTarget = false;
    this.range = range;
    this.shadow.mapSize = 1024;
    this.shadow.bias = -0.001;
    this.shadow.normalBias = 0.02;
    this.shadow.near = 0.05;
    this.shadow.far = range > 0 ? range : 100;
    this.shadow.cascades = 1;
  }

  /**
   * Sets the range and keeps the shadow far plane consistent.
   * @param {number} range
   * @returns {PointLight} this
   */
  setRange(range) {
    this.range = range;
    this.shadow.far = range > 0 ? range : 100;
    return this;
  }
}

/**
 * Cone shaped punctual light. `angle` is the outer half angle in radians and
 * `penumbra` (0..1) softens the edge towards the cone center.
 */
export class SpotLight extends Light {
  isSpotLight = true;

  /** Falloff exponent, 2 is physically correct. */
  decay = 2;

  /** @private */
  _angle = Math.PI / 6;
  /** @private */
  _penumbra = 0.2;

  /**
   * @param {number|Color} [color=0xffffff]
   * @param {number} [intensity=1]
   * @param {number} [range=10]
   * @param {number} [angle=Math.PI/6] Outer half angle in radians.
   * @param {number} [penumbra=0.2]
   */
  constructor(color = 0xffffff, intensity = 1, range = 10, angle = Math.PI / 6, penumbra = 0.2) {
    super('spot', color, intensity);
    this.name = 'SpotLight';
    this.useTarget = true;
    this.range = range;
    this._angle = angle;
    this._penumbra = penumbra;
    this.updateCone();
    this.shadow.mapSize = 1024;
    this.shadow.bias = -0.0008;
    this.shadow.normalBias = 0.02;
    this.shadow.near = 0.05;
    this.shadow.far = range > 0 ? range : 100;
    this.shadow.cascades = 1;
  }

  /** @returns {number} Outer half angle in radians. */
  get angle() {
    return this._angle;
  }

  /** @param {number} value Outer half angle in radians. */
  set angle(value) {
    this._angle = value;
    this.updateCone();
  }

  /** @returns {number} Penumbra ratio, 0..1. */
  get penumbra() {
    return this._penumbra;
  }

  /** @param {number} value Penumbra ratio, 0..1. */
  set penumbra(value) {
    this._penumbra = value < 0 ? 0 : (value > 1 ? 1 : value);
    this.updateCone();
  }

  /**
   * Recomputes the cached cone cosines from `angle` and `penumbra`.
   * @returns {SpotLight} this
   */
  updateCone() {
    const outer = this._angle;
    const inner = outer * (1 - this._penumbra);
    this.outerConeCos = Math.cos(outer);
    this.innerConeCos = Math.cos(inner);
    // Guarantee a non degenerate interval for the smooth cone falloff.
    if (this.innerConeCos - this.outerConeCos < 1e-4) this.innerConeCos = this.outerConeCos + 1e-4;
    return this;
  }

  /**
   * Sets the range and keeps the shadow far plane consistent.
   * @param {number} range
   * @returns {SpotLight} this
   */
  setRange(range) {
    this.range = range;
    this.shadow.far = range > 0 ? range : 100;
    return this;
  }
}
