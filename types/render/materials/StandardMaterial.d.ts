export class StandardMaterial extends Material {
    /** Linear base colour (albedo for dielectrics, f0 for metals). @type {Color} */
    baseColor: Color;
    /** @type {number} 0 = fully rough dielectric, 1 = pure metal */
    metallic: number;
    /** @type {number} artist facing (perceptual) roughness */
    roughness: number;
    /** Linear emissive colour. @type {Color} */
    emissive: Color;
    /** @type {number} multiplier applied to `emissive` (KHR_materials_emissive_strength) */
    emissiveIntensity: number;
    /** @type {number} strength of the tangent space normal map */
    normalScale: number;
    /** @type {number} how much of the occlusion map is applied */
    occlusionStrength: number;
    /** @type {number} index of refraction, drives the dielectric f0 */
    ior: number;
    /** @type {number} scales the dielectric f0 without touching the ior */
    specularIntensity: number;
    /** UV tiling applied to every map. @type {Vec2} */
    uvScale: Vec2;
    /** UV offset applied to every map. @type {Vec2} */
    uvOffset: Vec2;
    /** UV rotation in radians, around `uvCenter`. @type {number} */
    uvRotation: number;
    /** Pivot of the UV rotation. @type {Vec2} */
    uvCenter: Vec2;
    /** Decode base colour / emissive from sRGB in the shader. @type {boolean} */
    srgbDecode: boolean;
    /** Filter the normal derivatives into roughness to fight specular aliasing. @type {boolean} */
    specularAntiAliasing: boolean;
    /** Invert the green channel of the normal map (DirectX style maps). @type {boolean} */
    flipNormalY: boolean;
    /** Per map UV set selection; false = TEXCOORD_0, true = TEXCOORD_1. */
    baseColorUV1: boolean;
    normalUV1: boolean;
    metallicRoughnessUV1: boolean;
    occlusionUV1: boolean;
    emissiveUV1: boolean;
    /** @private @type {Object|null} */
    private _baseColorMap;
    /** @private @type {Object|null} */
    private _normalMap;
    /** @private @type {Object|null} */
    private _metallicRoughnessMap;
    /** @private @type {Object|null} */
    private _occlusionMap;
    /** @private @type {Object|null} */
    private _emissiveMap;
    /** @private pre-allocated uniform storage, never reallocated */
    private _baseColorFactor;
    /** @private */
    private _emissiveFactor;
    /** @private */
    private _uvTransform;
    /** @private @type {boolean} whether the UV transform is currently non identity */
    private _uvTransformActive;
    /** @private guard so the base constructor cannot trigger a premature sync */
    private _syncReady;
    /**
     * Copy the recognised option keys onto the instance. Colours accept anything the
     * Color constructor understands, vectors accept `{x,y}` or `[x,y]`.
     * @private
     * @param {Object} options
     */
    private _applyOptions;
    /**
     * @private
     * @param {Object|Array} source
     * @param {Vec2} target
     */
    private _readVec2;
    set uniforms(arg: any);
    /**
     * Uniform bag. Reading it always returns freshly synchronised values, so the
     * renderer can upload it without knowing anything about this class.
     * @returns {Object}
     */
    get uniforms(): any;
    _uniforms: any;
    set baseColorMap(arg: any);
    /** @returns {Object|null} */
    get baseColorMap(): any;
    set normalMap(arg: any);
    /** @returns {Object|null} */
    get normalMap(): any;
    set metallicRoughnessMap(arg: any);
    /** @returns {Object|null} */
    get metallicRoughnessMap(): any;
    set occlusionMap(arg: any);
    /** @returns {Object|null} */
    get occlusionMap(): any;
    set emissiveMap(arg: any);
    /** @returns {Object|null} */
    get emissiveMap(): any;
    /**
     * @param {Color|number|string|Array} value anything Color understands
     * @returns {StandardMaterial} this
     */
    setBaseColor(value: Color | number | string | any[]): StandardMaterial;
    /**
     * @param {Color|number|string|Array} value
     * @param {number} [intensity]
     * @returns {StandardMaterial} this
     */
    setEmissive(value: Color | number | string | any[], intensity?: number): StandardMaterial;
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
    setUVTransform(scaleX: number, scaleY: number, offsetX?: number, offsetY?: number, rotation?: number): StandardMaterial;
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
    setAlphaMode(mode: string, cutoff?: number): StandardMaterial;
    /**
     * Fold the public properties into the uniform bag. Allocation free: every
     * destination buffer is created once in the constructor.
     * @returns {Object} the uniform bag
     */
    syncUniforms(): any;
    /**
     * @param {StandardMaterial} source
     * @returns {StandardMaterial} this
     */
    copy(source: StandardMaterial): StandardMaterial;
}
import { Material } from "../Material.js";
import { Color } from "../../math/Color.js";
import { Vec2 } from "../../math/Vec2.js";
