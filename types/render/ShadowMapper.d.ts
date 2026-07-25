export class ShadowMapper {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} [renderer] Owning renderer; `state` and `shaderLib` are
     *        borrowed from it when present.
     * @param {Object} [options]
     * @param {boolean} [options.enabled=true]
     * @param {number} [options.mapSize=2048] Cascade resolution (square).
     * @param {number} [options.cascades=4] 1..4 cascades.
     * @param {number} [options.lambda=0.6] 0 = uniform splits, 1 = logarithmic.
     * @param {number} [options.shadowDistance=0] Max shadowed distance, 0 = from the light/camera.
     * @param {number} [options.depthBias=0.0009] Constant bias, in [0,1] depth units.
     * @param {number} [options.normalBias=2] Normal offset, in texels of cascade 0.
     * @param {number} [options.normalBiasScale=1] Multiplier for `light.shadow.normalBias`.
     * @param {number} [options.slopeScaleBias=1.5] glPolygonOffset factor.
     * @param {number} [options.depthOffsetUnits=2] glPolygonOffset units.
     * @param {number} [options.pcfRadius=1.5] PCF disk radius, in texels.
     * @param {number} [options.softness=1] Global multiplier of the PCF radius.
     * @param {number} [options.cascadeBlend=0] Blend band width in world units, 0 = auto.
     * @param {number} [options.fadeDistance=0] Distance where shadows fade out, 0 = auto.
     * @param {boolean} [options.stabilize=true] Texel snapping.
     * @param {number} [options.casterExtrusion=0] Near plane push back, 0 = auto.
     * @param {string} [options.cullFace='back'] 'back' | 'front' | 'none'.
     * @param {boolean} [options.skipTransparent=true] Blended materials cast nothing.
     * @param {number} [options.layers=0xffffffff] Layer mask of the casters.
     * @param {boolean} [options.spotShadows=true]
     * @param {number} [options.spotMapSize=1024]
     * @param {number} [options.maxSpotShadows=4]
     * @param {boolean} [options.pointShadows=true]
     * @param {number} [options.pointMapSize=512]
     * @param {number} [options.maxPointShadows=2]
     */
    constructor(gl: WebGL2RenderingContext, renderer?: any, options?: {
        enabled?: boolean;
        mapSize?: number;
        cascades?: number;
        lambda?: number;
        shadowDistance?: number;
        depthBias?: number;
        normalBias?: number;
        normalBiasScale?: number;
        slopeScaleBias?: number;
        depthOffsetUnits?: number;
        pcfRadius?: number;
        softness?: number;
        cascadeBlend?: number;
        fadeDistance?: number;
        stabilize?: boolean;
        casterExtrusion?: number;
        cullFace?: string;
        skipTransparent?: boolean;
        layers?: number;
        spotShadows?: boolean;
        spotMapSize?: number;
        maxSpotShadows?: number;
        pointShadows?: boolean;
        pointMapSize?: number;
        maxPointShadows?: number;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object|null} */
    renderer: any | null;
    /** @type {StateCache} */
    state: StateCache;
    /** @type {ShaderLib} */
    shaderLib: ShaderLib;
    /** @type {boolean} */
    enabled: boolean;
    /** @type {number} */
    mapSize: number;
    /** @type {number} */
    cascades: number;
    /** @type {number} */
    lambda: number;
    /** @type {number} */
    shadowDistance: number;
    /** @type {number} */
    depthBias: number;
    /** @type {number} Normal offset expressed in texels of the tightest cascade. */
    normalBias: number;
    /** @type {number} */
    normalBiasScale: number;
    /** @type {number} */
    slopeScaleBias: number;
    /** @type {number} */
    depthOffsetUnits: number;
    /** @type {number} */
    pcfRadius: number;
    /** @type {number} */
    softness: number;
    /** @type {number} */
    cascadeBlend: number;
    /** @type {number} */
    fadeDistance: number;
    /** @type {boolean} */
    stabilize: boolean;
    /** @type {number} */
    casterExtrusion: number;
    /** @type {string} */
    cullFace: string;
    /** @type {boolean} */
    skipTransparent: boolean;
    /** @type {number} Layer mask a mesh must intersect to cast. */
    layers: number;
    /** @type {boolean} */
    spotShadows: boolean;
    /** @type {number} */
    spotMapSize: number;
    /** @type {number} */
    maxSpotShadows: number;
    /** @type {boolean} */
    pointShadows: boolean;
    /** @type {number} */
    pointMapSize: number;
    /** @type {number} */
    maxPointShadows: number;
    /** @type {Float32Array} The whole std140 `Shadows` block. */
    uboData: Float32Array;
    /** @type {Float32Array} mat4 uCascadeMatrix[4] */
    cascadeMatrices: Float32Array;
    /** @type {Float32Array} vec4 uCascadeSplits */
    splits: Float32Array;
    /** @type {Float32Array} vec4 uShadowParams */
    params: Float32Array;
    /** @type {Float32Array} vec4 uShadowParams2 */
    params2: Float32Array;
    /** @type {Float32Array} Alias of {@link params}. */
    shadowParams: Float32Array;
    /** @type {Float32Array} Alias of {@link params2}. */
    shadowParams2: Float32Array;
    /** @type {Float32Array} Alias of {@link splits}. */
    cascadeSplits: Float32Array;
    /** @type {number} Bumped whenever `uboData` changes, for lazy UBO uploads. */
    version: number;
    /** @type {RenderTarget|null} */
    target: RenderTarget | null;
    /** @type {import('./Texture.js').Texture|null} sampler2DArrayShadow, unit 8. */
    texture: import('./Texture.js').Texture | null;
    /** @type {number} Cascades actually filled this frame. */
    cascadeCount: number;
    /** @type {Object|null} Directional light currently driving the cascades. */
    directionalLight: any | null;
    /** @type {Float32Array} World size of one texel, per cascade. */
    cascadeTexelWorldSize: Float32Array;
    /** @type {Float32Array} Radius of the bounding sphere, per cascade. */
    cascadeRadius: Float32Array;
    /** @type {RenderTarget|null} */
    spotTarget: RenderTarget | null;
    /** @type {import('./Texture.js').Texture|null} */
    spotTexture: import('./Texture.js').Texture | null;
    /** @type {Float32Array} world -> spot clip space, one mat4 per slot. */
    spotMatrices: Float32Array;
    /** @type {Float32Array} (near, far, bias, layer) per slot. */
    spotParams: Float32Array;
    /** @type {number} */
    spotCount: number;
    /** @type {RenderTarget[]} One depth cube per shadowed point light. */
    pointTargets: RenderTarget[];
    /** @type {Array<import('./Texture.js').Texture>} */
    pointTextures: Array<import('./Texture.js').Texture>;
    /** @type {Float32Array} (x, y, z, far) per slot. */
    pointParams: Float32Array;
    /** @type {Float32Array} (near, far, bias, unused) per slot. */
    pointParams2: Float32Array;
    /** @type {number} */
    pointCount: number;
    /** @type {Array<Object|null>} Compiled permutations, indexed by variant bits. */
    _programs: Array<any | null>;
    /** @type {Int32Array} Pass token the view projection was last written with. */
    _programTokens: Int32Array;
    /** @type {number} */
    _passToken: number;
    /** @type {Array<Object>} Reused caster list (BVH query output). */
    _casters: Array<any>;
    /** @type {Array<Object>} Reused light list. */
    _lightScratch: Array<any>;
    /** @type {boolean} Whether the maps still hold stale content. */
    _needsClear: boolean;
    /** @private Nesting counter of the shadow render passes. */
    private _passDepth;
    /** @private Viewport saved by `_beginPasses`. */
    private _savedViewport;
    /** @private Storage for the saved viewport. */
    private _viewportScratch;
    _cullEnabled: boolean;
    _cullHalfExtent: number;
    _cullDepthMin: number;
    _cullDepthMax: number;
    _cullView: Mat4;
    /** Per frame statistics. */
    stats: {
        cascades: number;
        spotMaps: number;
        pointFaces: number;
        drawCalls: number;
        casters: number;
        cpuTimeMs: number;
    };
    /** @private Bound scene walker, allocated once. */
    private _collectVisitor;
    /**
     * Enables or disables the whole shadow stage. Disabling clears the maps to
     * "fully lit" on the next update so any shader still sampling them behaves.
     * @param {boolean} enabled
     * @returns {ShadowMapper} this
     */
    setEnabled(enabled: boolean): ShadowMapper;
    /**
     * Changes the cascade resolution. The render target is rebuilt lazily.
     * @param {number} size Square resolution in pixels.
     * @returns {ShadowMapper} this
     */
    resize(size: number): ShadowMapper;
    /**
     * Changes the cascade count (1..4). The render target is rebuilt lazily.
     * @param {number} count
     * @returns {ShadowMapper} this
     */
    setCascadeCount(count: number): ShadowMapper;
    /**
     * @param {number} lambda 0 = uniform splits, 1 = fully logarithmic.
     * @returns {ShadowMapper} this
     */
    setLambda(lambda: number): ShadowMapper;
    /**
     * @param {number} distance Maximum shadowed view distance, 0 = automatic.
     * @returns {ShadowMapper} this
     */
    setShadowDistance(distance: number): ShadowMapper;
    /**
     * @param {number} radius PCF disk radius in texels.
     * @param {number} [softness=this.softness] Global radius multiplier.
     * @returns {ShadowMapper} this
     */
    setSoftness(radius: number, softness?: number): ShadowMapper;
    /**
     * @param {number} depthBias Constant bias in [0,1] depth units.
     * @param {number} [normalBias] Normal offset in texels of cascade 0.
     * @returns {ShadowMapper} this
     */
    setBias(depthBias: number, normalBias?: number): ShadowMapper;
    /**
     * Creates the cascade render target on first use.
     * @private
     * @returns {boolean} true when the target is usable
     */
    private _ensureTarget;
    /**
     * Creates the spot light atlas on first use.
     * @private
     * @returns {boolean}
     */
    private _ensureSpotTarget;
    /**
     * Creates (once) the depth cube of one point light slot.
     * @private
     * @param {number} slot
     * @returns {RenderTarget|null}
     */
    private _ensurePointTarget;
    /**
     * Binds the cascade map to its fixed texture unit on a consumer program.
     * @param {import('./StateCache.js').StateCache} state
     * @param {Object} program
     * @param {number} [unit=8]
     * @returns {boolean} true when the sampler was set
     */
    bind(state: import('./StateCache.js').StateCache, program: any, unit?: number): boolean;
    /**
     * Alias of {@link bind} with the argument order of the other binders.
     * @param {Object} program
     * @param {import('./StateCache.js').StateCache} [state]
     * @param {number} [unit=8]
     * @returns {boolean}
     */
    bindShadowMap(program: any, state?: import('./StateCache.js').StateCache, unit?: number): boolean;
    /**
     * Warms up the shader permutations the scenes are likely to need, so no frame
     * pays for a compile. Called by `Renderer.compile()`.
     * @param {boolean} [instancing=true]
     * @param {boolean} [skinning=true]
     * @param {boolean} [alphaMask=true]
     * @returns {ShadowMapper} this
     */
    precompile(instancing?: boolean, skinning?: boolean, alphaMask?: boolean): ShadowMapper;
    /**
     * Releases every GPU resource owned by the mapper. The shader programs belong
     * to the ShaderLib and are left alone.
     */
    dispose(): void;
    /**
     * Renders every shadow map needed by this frame.
     *
     * @param {Object} scene Scene (its `bvh` broadphase is used when present).
     * @param {Object} camera Active camera, already updated for this frame.
     * @param {Object} [lights] LightManager, or a plain array of lights. When
     *        omitted the lights are taken from `scene.lights`.
     * @returns {ShadowMapper} this
     */
    update(scene: any, camera: any, lights?: any): ShadowMapper;
    /**
     * Alias of {@link update}, matching the `shadowMapper.render(...)` call used
     * in the renderer pipeline description.
     * @param {Object} scene
     * @param {Object} camera
     * @param {Object} [lights]
     * @returns {ShadowMapper} this
     */
    render(scene: any, camera: any, lights?: any): ShadowMapper;
    /**
     * Renders the whole cascade set of one directional light.
     * @param {Object} scene
     * @param {Object} camera
     * @param {Object} dirLight
     * @returns {ShadowMapper} this
     */
    renderCascades(scene: any, camera: any, dirLight: any): ShadowMapper;
    /**
     * Maximum shadowed view distance for this frame.
     * @private
     * @param {Object} camera
     * @param {Object} light
     * @returns {number}
     */
    private _resolveShadowDistance;
    /**
     * Width of the cross fade band between neighbouring cascades.
     * @private
     * @param {number} count
     * @returns {number}
     */
    private _resolveBlendWidth;
    /**
     * Practical split scheme: a blend of the logarithmic and uniform schemes.
     * @private
     * @param {number} near
     * @param {number} far
     * @param {number} count
     */
    private _computeSplits;
    /**
     * Unprojects the eight corners of the camera frustum into world space.
     * Near corners land in `_frustumCorners[0..11]`, far corners in `[12..23]`.
     * @private
     * @param {Object} camera
     */
    private _computeFrustumCorners;
    /**
     * NDC -> world, without depending on any optional camera helper.
     * @private
     * @param {Object} camera
     * @param {number} ndcX
     * @param {number} ndcY
     * @param {number} ndcZ
     * @param {Vec3} out
     * @returns {Vec3} out
     */
    private _unproject;
    /**
     * Builds the orthographic light camera of one cascade and stores its
     * world -> clip matrix, together with the world AABB of the shadow volume and
     * the light space rejection parameters used while collecting casters.
     *
     * @private
     * @param {Object} camera
     * @param {number} index Cascade index.
     * @param {number} sliceNear View depth where the slice starts.
     * @param {number} sliceFar View depth where the slice ends.
     * @param {number} cameraNear
     * @param {number} mapSize
     */
    private _buildCascade;
    /**
     * Builds `_volume` as the world AABB of an oriented box.
     * @private
     * @param {Vec3} origin Center of the near face.
     * @param {Vec3} axisX
     * @param {Vec3} axisY
     * @param {Vec3} axisZ Direction the box extends along.
     * @param {number} halfExtent Half size along X and Y.
     * @param {number} depth Length along Z.
     */
    private _volumeFromBox;
    /**
     * Renders one cascade layer.
     * @private
     * @param {Object} scene
     * @param {number} index
     */
    private _renderCascade;
    /**
     * Renders one perspective shadow map per shadow casting spot light.
     * @private
     * @param {Object} scene
     * @param {Object} camera
     * @param {Object} lights
     */
    private _renderSpotShadows;
    /**
     * Renders a six face depth cube per shadow casting point light.
     * @private
     * @param {Object} scene
     * @param {Object} camera
     * @param {Object} lights
     */
    private _renderPointShadows;
    /**
     * Rejects a punctual light whose whole influence sphere is off screen: its
     * shadow map could never be sampled, so rendering it would be pure waste.
     * @private
     * @param {Object} camera
     * @param {Vec3} position
     * @param {number} radius
     * @returns {boolean}
     */
    private _lightAffectsView;
    /**
     * Builds `_volume` as the world AABB of a sphere.
     * @private
     * @param {Vec3} center
     * @param {number} radius
     */
    private _volumeFromSphere;
    /**
     * Picks the directional light that drives the cascades.
     * @private
     * @param {Object} scene
     * @param {Object} lights
     * @returns {Object|null}
     */
    private _pickDirectionalLight;
    /**
     * Gathers the shadow casting lights of one type into a reusable array.
     * Accepts a LightManager (`dirLights` / `punctualLights`), a plain array of
     * lights, or nothing at all (falls back to `scene.lights`).
     * @private
     * @param {Object} scene
     * @param {Object} lights
     * @param {string} type
     * @returns {Array<Object>}
     */
    private _collectLights;
    /**
     * Fills `_casters` with the meshes that can cast into the current volume.
     * @private
     * @param {Object} scene
     * @returns {number} number of casters
     */
    private _collectCasters;
    /**
     * @private
     * @param {Object} mesh
     * @returns {boolean}
     */
    private _isCaster;
    /**
     * Draws the collected casters with a given world -> clip matrix.
     * @private
     * @param {number} count
     * @param {Mat4} viewProj
     * @param {number} variantBase Extra permutation bits (SHADOW_CLAMP_NEAR).
     */
    private _drawCasters;
    /**
     * Draws one caster (all of its groups when it uses several materials).
     * @private
     * @param {Object} mesh
     * @param {Mat4} viewProj
     * @param {number} variantBase
     * @param {number} token
     */
    private _drawMesh;
    /**
     * Issues one draw call for a range of a geometry.
     * @private
     * @param {Object} mesh
     * @param {Object} geometry
     * @param {Object|null} material
     * @param {number} variant Permutation bits collected so far.
     * @param {Mat4} viewProj
     * @param {number} token Pass token, drives the view projection upload.
     * @param {number} start First element of the range.
     * @param {number} count Element count.
     * @param {number} instanceCount 0 when the mesh is not instanced.
     * @param {Object|null} boneTexture Bone matrices, when skinning is active.
     */
    private _drawRange;
    /**
     * @private
     * @param {Object} material
     * @returns {boolean} whether this material contributes to the shadow map
     */
    private _materialCasts;
    /**
     * Finds the texture holding the cutout alpha of a material.
     * @private
     * @param {Object} material
     * @returns {Object|null}
     */
    private _resolveBaseColorMap;
    /**
     * Returns (compiling on first use) the depth program of one permutation.
     * @private
     * @param {number} variant Bit mask of V_* flags.
     * @returns {Object|null}
     */
    private _getProgram;
    /**
     * Sets up the depth only render state shared by every shadow pass and
     * remembers the viewport so it can be restored afterwards.
     * @private
     */
    private _beginPasses;
    /**
     * Restores the state the renderer expects after the shadow passes.
     * @private
     */
    private _endPasses;
    /**
     * Reads back the viewport the renderer had set. The state cache mirrors it,
     * so no synchronous `getParameter` is needed in the common case.
     * @private
     * @returns {Int32Array}
     */
    private _readViewport;
    /**
     * Clears every cascade layer to "fully lit" so a shader that samples the map
     * while no light casts still shades correctly.
     * @private
     */
    private _clearAllCascades;
    /**
     * Resets the cascade portion of the uniform block to a neutral state.
     * @private
     */
    private _clearCascadeState;
    /**
     * Refreshes the two parameter vectors of the `Shadows` block.
     * @private
     */
    private _writeStaticParams;
    /** @type {number} Size of one shadow texel in [0,1] texture space. */
    get texelSize(): number;
    /** @type {number} Depth bias actually uploaded (always positive). */
    get resolvedDepthBias(): number;
    /** @type {number} World space normal offset actually uploaded. */
    get resolvedNormalBias(): number;
    /** @type {number} Width of the cascade cross fade band, in world units. */
    get resolvedBlendWidth(): number;
    /** @type {number} Distance where the shadows fade out completely. */
    get resolvedFadeDistance(): number;
    /**
     * Copies the whole std140 `Shadows` block into a destination buffer. This is
     * the integration point for UniformBuffers: the layout is guaranteed to be
     * mat4[4] + vec4 + vec4 + vec4, tightly packed.
     *
     * @param {Float32Array} dst
     * @param {number} [offset=0] Destination offset, in floats.
     * @returns {number} How many floats were written.
     */
    writeUBO(dst: Float32Array, offset?: number): number;
    /**
     * Monotonic clock, resolved lazily so the module never touches `performance`
     * at import time.
     * @private
     * @returns {number}
     */
    private _now;
}
import { StateCache } from "./StateCache.js";
import { ShaderLib } from "./ShaderLib.js";
import { RenderTarget } from "./RenderTarget.js";
import { Mat4 } from "../math/Mat4.js";
