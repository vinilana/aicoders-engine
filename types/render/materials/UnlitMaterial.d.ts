export class UnlitMaterial extends Material {
    /** Linear colour written straight to the framebuffer. @type {Color} */
    baseColor: Color;
    /** UV tiling applied to the base colour map. @type {Vec2} */
    uvScale: Vec2;
    /** UV offset applied to the base colour map. @type {Vec2} */
    uvOffset: Vec2;
    /** UV rotation in radians. @type {number} */
    uvRotation: any;
    /** Pivot of the UV rotation. @type {Vec2} */
    uvCenter: Vec2;
    /** Decode the base colour map from sRGB in the shader. @type {boolean} */
    srgbDecode: boolean;
    /** Sample the base colour map with TEXCOORD_1. @type {boolean} */
    baseColorUV1: boolean;
    /** @private @type {Object|null} */
    private _baseColorMap;
    /** @private */
    private _baseColorFactor;
    /** @private */
    private _uvTransform;
    /** @private @type {boolean} */
    private _uvTransformActive;
    /** @private */
    private _syncReady;
    receiveShadow: any;
    receiveIBL: any;
    /**
     * @private
     * @param {Object|Array|number} source
     * @param {Vec2} target
     */
    private _readVec2;
    set uniforms(arg: any);
    /**
     * Uniform bag, synchronised on every read.
     * @returns {Object}
     */
    get uniforms(): any;
    _uniforms: any;
    set baseColorMap(arg: any);
    /** @returns {Object|null} */
    get baseColorMap(): any;
    set map(arg: any);
    /** Alias matching the common `map` naming. @returns {Object|null} */
    get map(): any;
    /**
     * @param {Color|number|string|Array} value
     * @returns {UnlitMaterial} this
     */
    setBaseColor(value: Color | number | string | any[]): UnlitMaterial;
    /**
     * @param {number} scaleX
     * @param {number} scaleY
     * @param {number} [offsetX]
     * @param {number} [offsetY]
     * @param {number} [rotation]
     * @returns {UnlitMaterial} this
     */
    setUVTransform(scaleX: number, scaleY: number, offsetX?: number, offsetY?: number, rotation?: number): UnlitMaterial;
    /**
     * @param {string} mode 'opaque' | 'mask' | 'blend'
     * @param {number} [cutoff]
     * @returns {UnlitMaterial} this
     */
    setAlphaMode(mode: string, cutoff?: number): UnlitMaterial;
    /**
     * @returns {Object} the uniform bag
     */
    syncUniforms(): any;
    /**
     * @param {UnlitMaterial} source
     * @returns {UnlitMaterial} this
     */
    copy(source: UnlitMaterial): UnlitMaterial;
}
import { Material } from "../Material.js";
import { Color } from "../../math/Color.js";
import { Vec2 } from "../../math/Vec2.js";
