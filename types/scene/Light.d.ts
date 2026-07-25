/**
 * Base light.
 *
 * Intensity is expressed in candela-like units and punctual lights attenuate
 * physically (1 / d^2) with a smooth window driven by `range`, so a light never
 * leaks past its cluster bounds.
 */
export class Light extends Node3D {
    /**
     * @param {'directional'|'point'|'spot'} [type='directional']
     * @param {number|Color} [color=0xffffff] Hex color or Color instance.
     * @param {number} [intensity=1]
     */
    constructor(type?: 'directional' | 'point' | 'spot', color?: number | Color, intensity?: number);
    /** @type {'directional'|'point'|'spot'} */
    type: 'directional' | 'point' | 'spot';
    color: Color;
    intensity: number;
    /** Cut-off distance for punctual lights (world units). */
    range: number;
    /** Cosine of the inner cone half angle (spot lights). */
    innerConeCos: number;
    /** Cosine of the outer cone half angle (spot lights). */
    outerConeCos: number;
    /** World space aim point, used when `useTarget` is true. */
    target: Vec3;
    /** When true the light direction is `target - worldPosition`. */
    useTarget: boolean;
    /** Slot assigned by the shadow mapper, -1 when the light casts no shadow. */
    shadowIndex: number;
    /**
     * @type {{mapSize: number, bias: number, normalBias: number, near: number,
     *         far: number, cascades: number, lambda: number}}
     */
    shadow: {
        mapSize: number;
        bias: number;
        normalBias: number;
        near: number;
        far: number;
        cascades: number;
        lambda: number;
    };
    /**
     * @param {number|Color} color Hex value or Color instance.
     * @returns {Light} this
     */
    setColor(color: number | Color): Light;
    /**
     * Direction the light travels, in world space (normalized).
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getDirection(out: Vec3): Vec3;
    /**
     * Vector pointing from the scene towards the light, which is what the
     * shading equations and the `Lights` uniform block expect.
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getDirectionToLight(out: Vec3): Vec3;
    /**
     * Effective radius of influence used by the clustered light assignment.
     * @returns {number}
     */
    getInfluenceRadius(): number;
}
/**
 * Infinitely distant light. Direction goes from `position` towards `target`
 * (or from the node orientation when `useTarget` is false). Shadows use
 * cascaded shadow maps.
 */
export class DirectionalLight extends Light {
    /**
     * @param {number|Color} [color=0xffffff]
     * @param {number} [intensity=1]
     */
    constructor(color?: number | Color, intensity?: number);
    isDirectionalLight: boolean;
}
/**
 * Omnidirectional punctual light with physical 1 / d^2 falloff windowed by
 * `range`.
 */
export class PointLight extends Light {
    /**
     * @param {number|Color} [color=0xffffff]
     * @param {number} [intensity=1]
     * @param {number} [range=10]
     */
    constructor(color?: number | Color, intensity?: number, range?: number);
    isPointLight: boolean;
    /** Falloff exponent, 2 is physically correct. */
    decay: number;
    /**
     * Sets the range and keeps the shadow far plane consistent.
     * @param {number} range
     * @returns {PointLight} this
     */
    setRange(range: number): PointLight;
}
/**
 * Cone shaped punctual light. `angle` is the outer half angle in radians and
 * `penumbra` (0..1) softens the edge towards the cone center.
 */
export class SpotLight extends Light {
    /**
     * @param {number|Color} [color=0xffffff]
     * @param {number} [intensity=1]
     * @param {number} [range=10]
     * @param {number} [angle=Math.PI/6] Outer half angle in radians.
     * @param {number} [penumbra=0.2]
     */
    constructor(color?: number | Color, intensity?: number, range?: number, angle?: number, penumbra?: number);
    isSpotLight: boolean;
    /** Falloff exponent, 2 is physically correct. */
    decay: number;
    /** @private */
    private _angle;
    /** @private */
    private _penumbra;
    /** @param {number} value Outer half angle in radians. */
    set angle(arg: number);
    /** @returns {number} Outer half angle in radians. */
    get angle(): number;
    /** @param {number} value Penumbra ratio, 0..1. */
    set penumbra(arg: number);
    /** @returns {number} Penumbra ratio, 0..1. */
    get penumbra(): number;
    /**
     * Recomputes the cached cone cosines from `angle` and `penumbra`.
     * @returns {SpotLight} this
     */
    updateCone(): SpotLight;
    /**
     * Sets the range and keeps the shadow far plane consistent.
     * @param {number} range
     * @returns {SpotLight} this
     */
    setRange(range: number): SpotLight;
}
import { Node3D } from "./Node3D.js";
import { Color } from "../math/Color.js";
import { Vec3 } from "../math/Vec3.js";
