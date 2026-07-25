export namespace UBO_BINDING_POINTS {
    const Camera: number;
    const Lights: number;
    const Shadows: number;
    const Fog: number;
}
export namespace CAMERA_OFFSETS {
    const view: number;
    const proj: number;
    const viewProj: number;
    const invView: number;
    const invProj: number;
    const cameraPos: number;
    const cameraParams: number;
    const resolution: number;
    const timeParams: number;
}
/** Total float count of the `Camera` block (384 bytes). */
export const CAMERA_FLOATS: 96;
export namespace LIGHTS_OFFSETS {
    const ambient: number;
    const dirLightDir: number;
    const dirLightColor: number;
    const lightCounts: number;
}
/** Total float count of the `Lights` block (160 bytes). */
export const LIGHTS_FLOATS: 40;
/** Directional light slots physically present in the block (mirrors DIR_LIGHT_SLOTS). */
export const DIR_LIGHT_SLOTS: 4;
export namespace SHADOWS_OFFSETS {
    const cascadeMatrix: number;
    const cascadeSplits: number;
    const shadowParams: number;
    const shadowParams2: number;
}
/** Total float count of the `Shadows` block (304 bytes). */
export const SHADOWS_FLOATS: 76;
/** Cascade slots physically present in the block. */
export const CASCADE_SLOTS: 4;
export namespace FOG_OFFSETS {
    const color: number;
    const params: number;
}
/** Total float count of the `Fog` block (32 bytes). */
export const FOG_FLOATS: 8;
/**
 * One std140 uniform block: a CPU mirror, its GPU buffer and a dirty float range.
 */
export class UniformBlock {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {string} name Block name as declared in GLSL.
     * @param {number} binding Fixed binding point.
     * @param {number} floatCount Size of the block in floats.
     * @param {Object} [state] StateCache used for the internal binds.
     */
    constructor(gl: WebGL2RenderingContext, name: string, binding: number, floatCount: number, state?: any);
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {string} */
    name: string;
    /** @type {number} */
    binding: number;
    /** @type {Float32Array} CPU mirror of the block. */
    data: Float32Array;
    /** @type {number} Block size in bytes. */
    byteLength: number;
    /** @type {Object|null} */
    state: any | null;
    /** @type {GLBuffer} */
    buffer: GLBuffer;
    /** @private First dirty float (inclusive). */
    private _dirtyMin;
    /** @private Last dirty float (exclusive). */
    private _dirtyMax;
    /** @type {number} Bumped on every real upload. */
    uploads: number;
    /**
     * Marks a float range dirty.
     * @param {number} start Inclusive float index.
     * @param {number} end Exclusive float index.
     */
    markDirty(start: number, end: number): void;
    /** Marks the whole block dirty (used after a context restore). */
    markAll(): void;
    /**
     * Writes one float, marking it dirty only when the value really changed.
     *
     * The comparison happens AFTER the store, against the previous slot value:
     * `data` is a Float32Array, so writing rounds the double to float32 and
     * comparing the incoming double directly would report a change on every single
     * frame for any value that is not exactly representable (1/800, 0.1, ...).
     *
     * @param {number} index Float index.
     * @param {number} value
     * @returns {boolean} true when the mirror changed
     */
    setFloat(index: number, value: number): boolean;
    /**
     * Writes a vec4.
     * @param {number} offset Float offset of the vector.
     * @param {number} x @param {number} y @param {number} z @param {number} w
     * @returns {boolean} true when the mirror changed
     */
    setVec4(offset: number, x: number, y: number, z: number, w: number): boolean;
    /**
     * Writes a column major mat4 from a Mat4 or a raw Float32Array.
     * @param {number} offset Float offset of the matrix.
     * @param {Object|Float32Array} matrix
     * @param {number} [srcOffset=0] Float offset inside `matrix`.
     * @returns {boolean} true when the mirror changed
     */
    setMat4(offset: number, matrix: any | Float32Array, srcOffset?: number): boolean;
    /**
     * Copies a run of floats.
     * @param {number} offset Destination float offset.
     * @param {ArrayLike<number>} src
     * @param {number} count Floats to copy.
     * @param {number} [srcOffset=0]
     * @returns {boolean} true when the mirror changed
     */
    setFloats(offset: number, src: ArrayLike<number>, count: number, srcOffset?: number): boolean;
    /**
     * Ships the dirty range to the GPU.
     * @param {Object} [state] StateCache.
     * @returns {boolean} true when the driver was touched
     */
    upload(state?: any): boolean;
    /**
     * Uploads the dirty range and binds the block to its fixed binding point.
     * @param {Object} state StateCache.
     * @returns {UniformBlock} this
     */
    bind(state: any): UniformBlock;
    /** Releases the GPU buffer. */
    dispose(state: any): void;
}
/**
 * Owns the four engine wide uniform blocks and knows how to fill them from the
 * scene objects.
 */
export class UniformBuffers {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} state StateCache instance.
     */
    constructor(gl: WebGL2RenderingContext, state: any);
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object} */
    state: any;
    /** @type {UniformBlock} binding 0 */
    camera: UniformBlock;
    /** @type {UniformBlock} binding 1 */
    lights: UniformBlock;
    /** @type {UniformBlock} binding 2 */
    shadows: UniformBlock;
    /** @type {UniformBlock} binding 3 */
    fog: UniformBlock;
    /** @type {boolean} True while the scene has fog enabled. */
    fogEnabled: boolean;
    /** @type {number} Directional lights written by the last updateLights(). */
    dirLightCount: number;
    /** @type {number} Punctual lights reported by the last updateLights(). */
    punctualLightCount: number;
    /**
     * Fills the `Camera` block.
     *
     * `uInvView` is the camera world matrix (the exact inverse of the view matrix)
     * and `uCameraParams.w` is derived from the projection matrix so the value is
     * right for any camera, including hand authored projections.
     *
     * @param {Object} camera Camera with viewMatrix / projectionMatrix / worldMatrix.
     * @param {number} width Framebuffer width in pixels.
     * @param {number} height Framebuffer height in pixels.
     * @param {Object|number|null} [time] Time instance, elapsed seconds, or null.
     * @returns {UniformBuffers} this
     */
    updateCamera(camera: any, width: number, height: number, time?: any | number | null): UniformBuffers;
    /**
     * Fills the `Lights` block from a LightManager (or any object exposing
     * `dirLights` / `punctualLights` arrays).
     *
     * @param {Object|null} lightManager `{ dirLights, punctualLights }`
     * @param {Object|null} [scene] Scene, read for the ambient term.
     * @param {boolean} [clusterEnabled=false] Whether the clustered path is live.
     * @returns {UniformBuffers} this
     */
    updateLights(lightManager: any | null, scene?: any | null, clusterEnabled?: boolean): UniformBuffers;
    /**
     * Fills the `Shadows` block from a ShadowMapper.
     *
     * Every field is probed with a fallback, so a shadow mapper that only exposes
     * `cascadeMatrices` + `splits` (the contract minimum) still produces a valid
     * block; richer implementations can publish `shadowParams` / `shadowParams2`
     * Float32Arrays or the individual scalars listed below.
     *
     * @param {Object|null} shadowMapper
     * @returns {UniformBuffers} this
     */
    updateShadows(shadowMapper: any | null): UniformBuffers;
    /**
     * Zeroes the cascade count so every shader treats the scene as fully lit.
     * @returns {UniformBuffers} this
     */
    disableShadows(): UniformBuffers;
    /**
     * Fills the `Fog` block from `scene.fog`.
     * @param {Object|null} scene
     * @returns {boolean} true when fog is enabled this frame
     */
    updateFog(scene: any | null): boolean;
    /**
     * Uploads every dirty range and binds the four blocks to their binding points.
     * @param {Object} [state] StateCache override.
     * @returns {UniformBuffers} this
     */
    bindAll(state?: any): UniformBuffers;
    /**
     * Uploads every dirty range without binding.
     * @param {Object} [state] StateCache override.
     * @returns {UniformBuffers} this
     */
    uploadAll(state?: any): UniformBuffers;
    /**
     * Forces a full re-upload of every block. Call it after a context restore.
     * @returns {UniformBuffers} this
     */
    invalidate(): UniformBuffers;
    /** @type {number} Total GPU bytes held by the four blocks. */
    get memoryBytes(): number;
    /** Releases every GPU buffer. */
    dispose(state: any): void;
}
import { GLBuffer } from "./Buffer.js";
