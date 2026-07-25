/**
 * Collects and ranks the lights that affect a frame.
 */
export class LightManager {
    /**
     * @param {Object} [options]
     * @param {number} [options.maxDirLights=4] Directional slots in the Lights UBO.
     * @param {number} [options.maxPunctualLights=1024] Point + spot lights kept per frame.
     *   `options.maxLights` is accepted as an alias, so passing a Renderer straight
     *   in (`new LightManager(renderer)`) inherits its clustered light budget.
     * @param {number} [options.maxShadowedDirectional=1] Directional shadow slots.
     * @param {number} [options.maxShadowedPunctual=0] Punctual shadow slots.
     * @param {boolean} [options.cullPunctual=true] Frustum cull punctual lights.
     */
    constructor(options?: {
        maxDirLights?: number;
        maxPunctualLights?: number;
        maxShadowedDirectional?: number;
        maxShadowedPunctual?: number;
        cullPunctual?: boolean;
    });
    /** @type {number} */
    maxDirLights: number;
    /** @type {number} */
    maxPunctualLights: number;
    /** @type {number} */
    maxShadowedDirectional: number;
    /** @type {number} */
    maxShadowedPunctual: number;
    /** @type {boolean} */
    cullPunctual: boolean;
    /**
     * Directional lights of this frame, strongest first.
     * @type {import('../scene/Light.js').Light[]}
     */
    dirLights: import('../scene/Light.js').Light[];
    /**
     * Point and spot lights of this frame, most important first.
     * @type {import('../scene/Light.js').Light[]}
     */
    punctualLights: import('../scene/Light.js').Light[];
    /**
     * Lights that own a shadow slot, directional ones first.
     * @type {import('../scene/Light.js').Light[]}
     */
    shadowLights: import('../scene/Light.js').Light[];
    /** @type {number} Directional + punctual lights kept this frame. */
    visibleCount: number;
    /**
     * Set by the renderer once ClusteredLighting reports its state. Mirrored
     * into `uLightCounts.z` by UniformBuffers.
     * @type {boolean}
     */
    clusterEnabled: boolean;
    /** @type {Color} Ambient irradiance colour copied from the scene. */
    ambientColor: Color;
    /**
     * Same instance as `ambientColor`, under the name UniformBuffers looks for.
     * @type {Color}
     */
    ambientLight: Color;
    /** @type {number} Ambient intensity copied from the scene. */
    ambientIntensity: number;
    /**
     * Collection statistics of the last `collect()`.
     * @type {{total: number, directional: number, punctual: number,
     *         culled: number, skipped: number, dropped: number, shadowed: number}}
     */
    stats: {
        total: number;
        directional: number;
        punctual: number;
        culled: number;
        skipped: number;
        dropped: number;
        shadowed: number;
    };
    /** @private Camera of the collection in progress. */
    private _camera;
    /** @private Camera world position of the collection in progress. */
    private _eye;
    /** @private Bound traversal callback, created once. */
    private _visitBound;
    /**
     * Clears the frame state without touching the configuration.
     * @returns {LightManager} this
     */
    reset(): LightManager;
    /**
     * Rebuilds `dirLights` / `punctualLights` for this frame.
     *
     * The camera must already have an up to date world matrix, view matrix and
     * frustum (the renderer does that before calling in).
     *
     * @param {import('../scene/Scene.js').Scene} scene
     * @param {import('../scene/Camera.js').Camera} camera
     * @returns {LightManager} this
     */
    collect(scene: import('../scene/Scene.js').Scene, camera: import('../scene/Camera.js').Camera): LightManager;
    /**
     * Tests one node and pushes it into the right bucket.
     * @param {import('../scene/Node3D.js').Node3D} node
     * @private
     */
    private _visit;
    /**
     * Sorts both buckets by descending importance and applies the punctual cap.
     * Called by `collect()`; exposed so a renderer can re-rank after moving the
     * camera without collecting again.
     * @param {import('../scene/Camera.js').Camera} [camera] Re-evaluates the ranking when given.
     * @returns {LightManager} this
     */
    sortByImportance(camera?: import('../scene/Camera.js').Camera): LightManager;
    /**
     * Hands out shadow slots to the most important casters and clears the rest.
     * @private
     */
    private _assignShadowIndices;
    /** @returns {number} Directional lights kept this frame. */
    getDirectionalCount(): number;
    /** @returns {number} Punctual lights kept this frame. */
    getPunctualCount(): number;
    /**
     * Directional light that owns the cascaded shadow map, if any.
     * @returns {import('../scene/Light.js').Light|null}
     */
    getPrimaryShadowLight(): import('../scene/Light.js').Light | null;
    /**
     * Strongest directional light of the frame, shadow casting or not.
     * @returns {import('../scene/Light.js').Light|null}
     */
    getKeyLight(): import('../scene/Light.js').Light | null;
    /** @returns {boolean} True when at least one directional shadow was assigned. */
    hasDirectionalShadow(): boolean;
    /**
     * Writes the direction TOWARDS a light, which is what the shading equations
     * and the `Lights` uniform block expect.
     * @param {import('../scene/Light.js').Light} light
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    getDirectionToLight(light: import('../scene/Light.js').Light, out: Vec3): Vec3;
    /** Drops every reference held by the manager. */
    dispose(): void;
}
import { Color } from "../math/Color.js";
import { Vec3 } from "../math/Vec3.js";
