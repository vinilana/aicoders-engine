/**
 * Procedural atmosphere material, paired with the `sky` program.
 *
 * Drive it either by writing `sunDirection` directly or, more conveniently, with
 * `setSunPosition(elevation, azimuth)` in degrees. Everything else is a physical
 * knob of the scattering model: `turbidity` controls how hazy the air is,
 * `rayleigh` how strongly short wavelengths scatter (the blueness), `mie` how much
 * aerosol haze surrounds the sun, and `mieDirectionalG` how tight that halo is.
 *
 * Meant to be drawn on `createSkyboxCube()` geometry. The render state it sets -
 * depth writes off, LEQUAL depth test - is what lets the shader pin every fragment
 * to the far plane, so the sky costs one depth-rejected fragment wherever the scene
 * already covers the screen.
 */
import { Material } from '../Material.js';
import { Color } from '../../math/Color.js';
import { Vec3 } from '../../math/Vec3.js';

const DEG2RAD = Math.PI / 180;

export class SkyMaterial extends Material {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    super(Object.assign({
      shaderName: 'sky',
      depthWrite: false,
      depthTest: true,
      depthFunc: 'lequal',
      side: 'front',
      castShadow: false,
      receiveShadow: false,
      receiveIBL: false
    }, options));

    /** Unit vector pointing towards the sun. @type {Vec3} */
    this.sunDirection = new Vec3(0, 0.7071, 0.7071);
    /** Linear tint of the solar disc. @type {Color} */
    this.sunColor = new Color(1, 0.96, 0.9);
    /** Global scale on the solar irradiance. @type {number} */
    this.sunIntensity = 1.0;
    /** Brightness of the disc itself, relative to the irradiance. @type {number} */
    this.sunDiscIntensity = 20.0;
    /** Angular radius of the disc, in degrees. @type {number} */
    this.sunAngularRadius = 0.6;
    /** Softness of the disc edge, in cosine units. @type {number} */
    this.sunDiscSoftness = 2e-5;

    /** Rayleigh scattering multiplier. @type {number} */
    this.rayleigh = 1.0;
    /** Mie scattering multiplier. @type {number} */
    this.mie = 0.005;
    /** Mie anisotropy, 0 isotropic, towards 1 strongly forward scattering. @type {number} */
    this.mieDirectionalG = 0.8;
    /** Atmospheric haze, 1 is a pristine sky, 10 is heavy smog. @type {number} */
    this.turbidity = 2.0;

    /** Overall exposure of the sky, applied before the tone mapper. @type {number} */
    this.exposure = 1.0;
    /** Fraction of unattenuated light mixed back in as multiple scattering. @type {number} */
    this.multipleScattering = 0.15;
    /** Width of the fade into the ground colour, in zenith cosine units. @type {number} */
    this.groundFade = 0.05;
    /** Linear albedo of the virtual ground below the horizon. @type {Color} */
    this.groundColor = new Color(0.18, 0.16, 0.14);

    /** Enable the fbm cloud layer. @type {boolean} */
    this.clouds = false;
    /** Cloud noise frequency. @type {number} */
    this.cloudScale = 1.5;
    /** How fast the layer drifts, in units per second. @type {number} */
    this.cloudSpeed = 0.01;
    /** 0 = clear sky, 1 = fully overcast. @type {number} */
    this.cloudCoverage = 0.5;
    /** How opaque the clouds are against the sky behind them. @type {number} */
    this.cloudOpacity = 1.0;
    /** Linear colour of the lit side of the clouds. @type {Color} */
    this.cloudColor = new Color(1, 1, 1);

    /** @private pre-allocated uniform storage */
    this._sunParams = new Float32Array(4);
    /** @private */
    this._skyParams = new Float32Array(4);
    /** @private */
    this._skyParams2 = new Float32Array(4);
    /** @private */
    this._cloudParams = new Float32Array(4);
    /** @private normalized copy of `sunDirection`, uploaded instead of the raw one */
    this._sunDirectionNormalized = new Vec3(0, 0.7071, 0.7071);
    /** @private */
    this._cloudsActive = false;
    /** @private */
    this._syncReady = false;

    this._applyOptions(options);
    this._syncReady = true;
    this._cloudsActive = this.clouds;
    this.syncUniforms();
    this.needsUpdate = true;
  }

  /**
   * @private
   * @param {Object} options
   */
  _applyOptions(options) {
    if (options.sunDirection !== undefined) this.setSunDirection(options.sunDirection);
    if (options.sunElevation !== undefined || options.sunAzimuth !== undefined) {
      this.setSunPosition(
        options.sunElevation !== undefined ? options.sunElevation : 45,
        options.sunAzimuth !== undefined ? options.sunAzimuth : 135
      );
    }
    if (options.sunColor !== undefined) this.sunColor.copy(new Color(options.sunColor));
    if (options.sunIntensity !== undefined) this.sunIntensity = options.sunIntensity;
    if (options.sunDiscIntensity !== undefined) this.sunDiscIntensity = options.sunDiscIntensity;
    if (options.sunAngularRadius !== undefined) this.sunAngularRadius = options.sunAngularRadius;
    if (options.sunDiscSoftness !== undefined) this.sunDiscSoftness = options.sunDiscSoftness;

    if (options.rayleigh !== undefined) this.rayleigh = options.rayleigh;
    if (options.mie !== undefined) this.mie = options.mie;
    if (options.mieDirectionalG !== undefined) this.mieDirectionalG = options.mieDirectionalG;
    if (options.turbidity !== undefined) this.turbidity = options.turbidity;

    if (options.exposure !== undefined) this.exposure = options.exposure;
    if (options.multipleScattering !== undefined) this.multipleScattering = options.multipleScattering;
    if (options.groundFade !== undefined) this.groundFade = options.groundFade;
    if (options.groundColor !== undefined) this.groundColor.copy(new Color(options.groundColor));

    if (options.clouds !== undefined) this.clouds = !!options.clouds;
    if (options.cloudScale !== undefined) this.cloudScale = options.cloudScale;
    if (options.cloudSpeed !== undefined) this.cloudSpeed = options.cloudSpeed;
    if (options.cloudCoverage !== undefined) this.cloudCoverage = options.cloudCoverage;
    if (options.cloudOpacity !== undefined) this.cloudOpacity = options.cloudOpacity;
    if (options.cloudColor !== undefined) this.cloudColor.copy(new Color(options.cloudColor));
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

  /**
   * @param {Vec3|Array|Object} direction any {x,y,z} or [x,y,z]
   * @returns {SkyMaterial} this
   */
  setSunDirection(direction) {
    if (direction === null || direction === undefined) return this;
    if (direction.x !== undefined) this.sunDirection.set(direction.x, direction.y, direction.z);
    else if (direction.length >= 3) this.sunDirection.set(direction[0], direction[1], direction[2]);
    return this;
  }

  /**
   * Place the sun with spherical angles.
   * Elevation is measured up from the horizon, azimuth clockwise from +Z towards
   * +X, which matches the usual compass reading of a Y-up right handed world.
   *
   * @param {number} elevationDegrees -90 (nadir) to 90 (zenith)
   * @param {number} azimuthDegrees
   * @returns {SkyMaterial} this
   */
  setSunPosition(elevationDegrees, azimuthDegrees) {
    const elevation = elevationDegrees * DEG2RAD;
    const azimuth = azimuthDegrees * DEG2RAD;
    const cosElevation = Math.cos(elevation);
    this.sunDirection.set(
      cosElevation * Math.sin(azimuth),
      Math.sin(elevation),
      cosElevation * Math.cos(azimuth)
    );
    return this;
  }

  /**
   * Direction the sunlight travels in, i.e. the vector a DirectionalLight should
   * point along. It is the negation of `sunDirection`, which points at the sun.
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getSunLightDirection(out) {
    out.copy(this._sunDirectionNormalized).negate();
    return out;
  }

  /**
   * Normalized direction towards the sun.
   * @param {Vec3} out
   * @returns {Vec3} out
   */
  getSunDirection(out) {
    return out.copy(this._sunDirectionNormalized);
  }

  /**
   * Enable or disable the cloud layer. This changes the permutation, so it is a
   * proper setter rather than a plain field write.
   * @param {boolean} enabled
   * @param {number} [coverage]
   * @returns {SkyMaterial} this
   */
  setClouds(enabled, coverage) {
    const value = !!enabled;
    if (coverage !== undefined) this.cloudCoverage = coverage;
    if (this.clouds === value) return this;
    this.clouds = value;
    this._cloudsActive = value;
    this.needsUpdate = true;
    return this;
  }

  /**
   * @returns {Object} the uniform bag
   */
  syncUniforms() {
    const uniforms = this._uniforms;
    if (this._syncReady !== true || !uniforms) return uniforms;

    // The shader normalizes too, but doing it here keeps a zero length vector from
    // silently producing a sun stuck at the horizon.
    const sunDirection = this._sunDirectionNormalized.copy(this.sunDirection);
    if (sunDirection.lengthSq() < 1e-12) sunDirection.set(0, 1, 0);
    else sunDirection.normalize();
    uniforms.uSunDirection = sunDirection;
    uniforms.uSunColor = this.sunColor;
    uniforms.uGroundColor = this.groundColor;

    const sunParams = this._sunParams;
    sunParams[0] = this.sunIntensity;
    sunParams[1] = this.sunDiscIntensity;
    sunParams[2] = Math.cos(Math.max(this.sunAngularRadius, 0) * DEG2RAD);
    sunParams[3] = Math.max(this.sunDiscSoftness, 1e-6);
    uniforms.uSunParams = sunParams;

    const skyParams = this._skyParams;
    skyParams[0] = this.rayleigh;
    skyParams[1] = this.mie;
    skyParams[2] = this.mieDirectionalG;
    skyParams[3] = this.turbidity;
    uniforms.uSkyParams = skyParams;

    const skyParams2 = this._skyParams2;
    skyParams2[0] = this.exposure;
    skyParams2[1] = this.multipleScattering;
    skyParams2[2] = this.groundFade;
    skyParams2[3] = 0;
    uniforms.uSkyParams2 = skyParams2;

    if (this.clouds) {
      const cloudParams = this._cloudParams;
      cloudParams[0] = this.cloudScale;
      cloudParams[1] = this.cloudSpeed;
      cloudParams[2] = this.cloudCoverage;
      cloudParams[3] = this.cloudOpacity;
      uniforms.uCloudParams = cloudParams;
      uniforms.uCloudColor = this.cloudColor;
    } else if (uniforms.uCloudParams !== undefined) {
      uniforms.uCloudParams = null;
      uniforms.uCloudColor = null;
    }

    if (this.clouds !== this._cloudsActive) {
      this._cloudsActive = this.clouds;
      this.needsUpdate = true;
    }

    return uniforms;
  }

  /**
   * @param {Object} defines
   * @param {Object|null} geometry
   * @param {Object|null} renderContext
   */
  applyOwnDefines(defines, geometry, renderContext) {
    if (this._cloudsActive) defines.USE_CLOUDS = 1;

    // The sky is the light source, not a receiver, and it is drawn before the fog
    // is meaningful (it already contains its own aerial perspective).
    delete defines.USE_SHADOWS;
    delete defines.SHADOW_CASCADES;
    delete defines.USE_CLUSTERED;
    delete defines.CLUSTER_X;
    delete defines.CLUSTER_Y;
    delete defines.CLUSTER_Z;
    delete defines.USE_IBL;
    delete defines.USE_FOG;
    delete defines.MAX_DIR_LIGHTS;
    delete defines.MAX_PUNCTUAL_LIGHTS;
    delete defines.USE_SKINNING;
    delete defines.USE_TANGENT;
    delete defines.USE_UV1;
    delete defines.USE_VERTEX_COLOR;
  }

  /**
   * @param {SkyMaterial} source
   * @returns {SkyMaterial} this
   */
  copy(source) {
    super.copy(source);
    if (!(source instanceof SkyMaterial)) return this;

    this.sunDirection.copy(source.sunDirection);
    this.sunColor.copy(source.sunColor);
    this.sunIntensity = source.sunIntensity;
    this.sunDiscIntensity = source.sunDiscIntensity;
    this.sunAngularRadius = source.sunAngularRadius;
    this.sunDiscSoftness = source.sunDiscSoftness;

    this.rayleigh = source.rayleigh;
    this.mie = source.mie;
    this.mieDirectionalG = source.mieDirectionalG;
    this.turbidity = source.turbidity;

    this.exposure = source.exposure;
    this.multipleScattering = source.multipleScattering;
    this.groundFade = source.groundFade;
    this.groundColor.copy(source.groundColor);

    this.clouds = source.clouds;
    this._cloudsActive = source.clouds;
    this.cloudScale = source.cloudScale;
    this.cloudSpeed = source.cloudSpeed;
    this.cloudCoverage = source.cloudCoverage;
    this.cloudOpacity = source.cloudOpacity;
    this.cloudColor.copy(source.cloudColor);

    this.syncUniforms();
    this.needsUpdate = true;
    return this;
  }
}
