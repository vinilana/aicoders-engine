export class SkyMaterial extends Material {
    /** Unit vector pointing towards the sun. @type {Vec3} */
    sunDirection: Vec3;
    /** Linear tint of the solar disc. @type {Color} */
    sunColor: Color;
    /** Global scale on the solar irradiance. @type {number} */
    sunIntensity: number;
    /** Brightness of the disc itself, relative to the irradiance. @type {number} */
    sunDiscIntensity: number;
    /** Angular radius of the disc, in degrees. @type {number} */
    sunAngularRadius: number;
    /** Softness of the disc edge, in cosine units. @type {number} */
    sunDiscSoftness: number;
    /** Rayleigh scattering multiplier. @type {number} */
    rayleigh: number;
    /** Mie scattering multiplier. @type {number} */
    mie: number;
    /** Mie anisotropy, 0 isotropic, towards 1 strongly forward scattering. @type {number} */
    mieDirectionalG: number;
    /** Atmospheric haze, 1 is a pristine sky, 10 is heavy smog. @type {number} */
    turbidity: number;
    /** Overall exposure of the sky, applied before the tone mapper. @type {number} */
    exposure: number;
    /** Fraction of unattenuated light mixed back in as multiple scattering. @type {number} */
    multipleScattering: number;
    /** Width of the fade into the ground colour, in zenith cosine units. @type {number} */
    groundFade: number;
    /** Linear albedo of the virtual ground below the horizon. @type {Color} */
    groundColor: Color;
    /** Enable the fbm cloud layer. @type {boolean} */
    clouds: boolean;
    /** Cloud noise frequency. @type {number} */
    cloudScale: number;
    /** How fast the layer drifts, in units per second. @type {number} */
    cloudSpeed: number;
    /** 0 = clear sky, 1 = fully overcast. @type {number} */
    cloudCoverage: number;
    /** How opaque the clouds are against the sky behind them. @type {number} */
    cloudOpacity: number;
    /** Linear colour of the lit side of the clouds. @type {Color} */
    cloudColor: Color;
    /** @private pre-allocated uniform storage */
    private _sunParams;
    /** @private */
    private _skyParams;
    /** @private */
    private _skyParams2;
    /** @private */
    private _cloudParams;
    /** @private normalized copy of `sunDirection`, uploaded instead of the raw one */
    private _sunDirectionNormalized;
    /** @private */
    private _cloudsActive;
    /** @private */
    private _syncReady;
    /**
     * @private
     * @param {Object} options
     */
    private _applyOptions;
    set uniforms(arg: any);
    /**
     * Uniform bag, synchronised on every read.
     * @returns {Object}
     */
    get uniforms(): any;
    _uniforms: any;
    /**
     * @param {Vec3|Array|Object} direction any {x,y,z} or [x,y,z]
     * @returns {SkyMaterial} this
     */
    setSunDirection(direction: Vec3 | any[] | any): SkyMaterial;
    /**
     * Place the sun with spherical angles.
     * Elevation is measured up from the horizon, azimuth clockwise from +Z towards
     * +X, which matches the usual compass reading of a Y-up right handed world.
     *
     * @param {number} elevationDegrees -90 (nadir) to 90 (zenith)
     * @param {number} azimuthDegrees
     * @returns {SkyMaterial} this
     */
    setSunPosition(elevationDegrees: number, azimuthDegrees: number): SkyMaterial;
    /**
     * Direction the sunlight travels in, i.e. the vector a DirectionalLight should
     * point along. It is the negation of `sunDirection`, which points at the sun.
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getSunLightDirection(out: Vec3): Vec3;
    /**
     * Normalized direction towards the sun.
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getSunDirection(out: Vec3): Vec3;
    /**
     * Enable or disable the cloud layer. This changes the permutation, so it is a
     * proper setter rather than a plain field write.
     * @param {boolean} enabled
     * @param {number} [coverage]
     * @returns {SkyMaterial} this
     */
    setClouds(enabled: boolean, coverage?: number): SkyMaterial;
    /**
     * @returns {Object} the uniform bag
     */
    syncUniforms(): any;
    /**
     * @param {SkyMaterial} source
     * @returns {SkyMaterial} this
     */
    copy(source: SkyMaterial): SkyMaterial;
}
import { Material } from "../Material.js";
import { Vec3 } from "../../math/Vec3.js";
import { Color } from "../../math/Color.js";
