/** Texture units the `ibl` chunk samples from. */
export const IBL_TEXTURE_UNITS: Readonly<{
    IRRADIANCE: 11;
    PREFILTERED: 12;
    BRDF_LUT: 13;
}>;
/**
 * Precomputed environment lighting.
 */
export class IBL {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} [renderer] Owning Renderer; `state`, `shaderLib` and `caps`
     *        are taken from it when present.
     * @param {Object} [options]
     * @param {number} [options.irradianceSize=32]
     * @param {number} [options.prefilterSize=128]
     * @param {number} [options.prefilterMips=6]
     * @param {number} [options.brdfSize=256]
     * @param {number} [options.skySize=256] Face size of a generated sky cube.
     * @param {number} [options.equirectSize=256] Face size of a converted panorama.
     * @param {number} [options.irradianceSamples=512]
     * @param {number} [options.prefilterBaseSamples=64] Samples of the first rough mip.
     * @param {number} [options.prefilterMaxSamples=256]
     * @param {number} [options.brdfSamples=1024]
     * @param {number} [options.intensity=1]
     */
    constructor(gl: WebGL2RenderingContext, renderer?: any, options?: {
        irradianceSize?: number;
        prefilterSize?: number;
        prefilterMips?: number;
        brdfSize?: number;
        skySize?: number;
        equirectSize?: number;
        irradianceSamples?: number;
        prefilterBaseSamples?: number;
        prefilterMaxSamples?: number;
        brdfSamples?: number;
        intensity?: number;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object|null} */
    renderer: any | null;
    /** @type {StateCache} */
    state: StateCache;
    /** @private */
    private _ownsShaderLib;
    /** @type {ShaderLib} */
    shaderLib: ShaderLib;
    /** @type {Object|null} */
    caps: any | null;
    /** @type {boolean} True when float color attachments are renderable. */
    floatTargets: boolean;
    /** @type {string} Internal format of the generated cube maps. */
    hdrFormat: string;
    /** @type {string} Internal format of the BRDF LUT. */
    lutFormat: string;
    /** Generation sizes and sample counts. */
    options: {
        irradianceSize: number;
        prefilterSize: number;
        prefilterMips: number;
        brdfSize: number;
        skySize: number;
        equirectSize: number;
        irradianceSamples: number;
        prefilterBaseSamples: number;
        prefilterMaxSamples: number;
        brdfSamples: number;
    };
    /** @type {Texture|null} Diffuse irradiance cube (stores E / PI). */
    irradianceMap: Texture | null;
    /** @type {Texture|null} GGX prefiltered radiance cube. */
    prefilteredMap: Texture | null;
    /** @type {Texture|null} Split sum DFG LUT. */
    brdfLUT: Texture | null;
    /** @type {Texture|null} Environment the maps were generated from. */
    sourceCube: Texture | null;
    /** @type {number} Highest valid mip of `prefilteredMap`. */
    maxMipLevel: number;
    /** @type {number} Global multiplier applied to every environment lookup. */
    intensity: number;
    /** @type {number} Strength of the geometric horizon fade (0..1). */
    horizonOcclusion: number;
    /** @type {boolean} True once the three maps are valid. */
    ready: boolean;
    /** @type {Float32Array} Value of `uIBLParams` for the shading pass. */
    params: Float32Array;
    /** @private True when `sourceCube` was created here and must be disposed. */
    private _ownsSource;
    /** @private */
    private _brdfReady;
    /** @private */
    private _fbo;
    /** @private @type {Int32Array|null} Viewport saved across a generation. */
    private _savedViewport;
    /** @private */
    private _quadBuffer;
    /** @private */
    private _quadVAO;
    /**
     * @returns {boolean}
     * @private
     */
    private _detectFloatSupport;
    /**
     * Creates the shared full screen triangle used by every generation pass.
     * @private
     */
    private _buildQuad;
    /**
     * Uses an existing cube map as the environment and regenerates every product.
     * The texture is not taken ownership of and is never disposed by this class.
     * @param {Texture} cube
     * @returns {IBL} this
     */
    fromCubeTexture(cube: Texture): IBL;
    /**
     * Renders the six faces of an analytic sky into a cube map and uses it as the
     * environment.
     *
     * @param {Object} [params]
     * @param {Array<number>|Object} [params.sunDirection=[0.3,0.5,-0.8]] Direction
     *        towards the sun (normalized internally).
     * @param {number} [params.turbidity=3] Haze; 2 = very clear, 10 = hazy.
     * @param {number} [params.rayleigh=2] Blue scattering strength.
     * @param {number} [params.mieCoefficient=0.005]
     * @param {number} [params.mieDirectionalG=0.8] Forward scattering anisotropy.
     * @param {number} [params.luminance=1] Linear radiance the model is normalised
     *        against: it is the value of a NOON zenith (sun straight up). The sky
     *        of any other sun elevation keeps its physical ratio to that anchor, so
     *        a 40 degree sun gives a zenith around 0.03 and a horizon around 0.2,
     *        and dusk goes much darker. Raise it to brighten the whole environment.
     * @param {number} [params.sunDiskIntensity=1] Scale of the sun disc only. Set
     *        it to 0 when a DirectionalLight already represents the sun, so its
     *        energy is not counted twice.
     * @param {number} [params.maxRadiance=500] Radiance clamp. The physical sun
     *        disc is ~2.6e5 times brighter than the sky, which no 128^2 prefiltered
     *        cube can integrate without fireflies; clamping keeps the specular
     *        convolution stable at the cost of some sun energy in the environment.
     * @param {Array<number>|Object} [params.groundColor=[0.12,0.11,0.1]]
     * @param {number} [params.groundAlbedo=1]
     * @param {number} [params.horizonBlend=0.03]
     * @param {number} [params.cloudCoverage=0] 0 = clear sky.
     * @param {number} [params.cloudScale=2]
     * @param {number} [params.cloudFade=0.15] Horizon fade of the cloud layer.
     * @param {number} [params.cloudTime=0]
     * @param {number} [params.size] Face size, defaults to `options.skySize`.
     * @returns {IBL} this
     */
    fromProceduralSky(params?: {
        sunDirection?: Array<number> | any;
        turbidity?: number;
        rayleigh?: number;
        mieCoefficient?: number;
        mieDirectionalG?: number;
        luminance?: number;
        sunDiskIntensity?: number;
        maxRadiance?: number;
        groundColor?: Array<number> | any;
        groundAlbedo?: number;
        horizonBlend?: number;
        cloudCoverage?: number;
        cloudScale?: number;
        cloudFade?: number;
        cloudTime?: number;
        size?: number;
    }): IBL;
    /**
     * Projects an equirectangular panorama into a cube map and uses it as the
     * environment.
     *
     * @param {Texture} texture 2D panorama (2:1 aspect ratio).
     * @param {Object} [params]
     * @param {number} [params.size] Face size, defaults to `options.equirectSize`.
     * @param {boolean} [params.flipV=false] Flip the vertical axis (set it when the
     *        panorama was uploaded with `flipY: true`).
     * @param {number} [params.rotation=0] Azimuth rotation in radians.
     * @param {number} [params.intensity=1] Multiplier applied while converting.
     * @param {boolean} [params.srgb=false] Decode the source from sRGB to linear.
     * @returns {IBL} this
     */
    fromEquirectangular(texture: Texture, params?: {
        size?: number;
        flipV?: boolean;
        rotation?: number;
        intensity?: number;
        srgb?: boolean;
    }): IBL;
    /**
     * Replaces the environment source.
     * @param {Texture} cube
     * @param {boolean} owned
     * @private
     */
    private _setSource;
    /**
     * Regenerates irradiance, prefiltered radiance and (once) the BRDF LUT from the
     * current source cube.
     * @returns {IBL} this
     */
    generate(): IBL;
    /**
     * Generates only the BRDF LUT, which does not depend on the environment.
     * @returns {IBL} this
     */
    generateBRDFLUT(): IBL;
    /**
     * Creates the output textures the first time they are needed.
     * @private
     */
    private _ensureOutputs;
    /** @private */
    private _ensureBRDF;
    /**
     * Creates a cube map in the environment format.
     * @param {number} size
     * @param {boolean} mipmaps
     * @param {string} name
     * @returns {Texture}
     * @private
     */
    private _createCube;
    /**
     * Diffuse irradiance: cosine importance sampling of the source cube, read from
     * a low mip so a few hundred samples are already noise free.
     * @private
     */
    private _generateIrradiance;
    /**
     * Specular radiance: one GGX integration per (face, mip). The sample count
     * grows with roughness and every fetch picks a source mip from the sample solid
     * angle, which is what keeps the rough levels clean.
     * @private
     */
    private _generatePrefiltered;
    /**
     * Split sum DFG term. Environment independent, so it is only ever built once.
     * @private
     */
    private _generateBRDF;
    /**
     * Highest mip index available on the source cube.
     * @returns {number}
     * @private
     */
    private _sourceMaxLod;
    /**
     * Sets the render state every generation pass needs and binds the triangle.
     * @private
     */
    private _beginPasses;
    /**
     * Restores a sane state for the frame that follows the generation.
     * @private
     */
    private _endPasses;
    /**
     * Attaches one cube face (and mip) of a texture as the color target.
     * @param {Texture} texture
     * @param {number} face 0..5
     * @param {number} level
     * @param {number} size Face size at this level.
     * @private
     */
    private _bindCubeFace;
    /**
     * Attaches a 2D texture as the color target.
     * @param {Texture} texture
     * @private
     */
    private _bindTexture2D;
    /**
     * Validates the generation framebuffer once per unique failure.
     * @param {string} label
     * @private
     */
    private _checkFramebuffer;
    /**
     * Draws the full screen triangle.
     * @private
     */
    private _draw;
    /**
     * Refreshes `params`, the value of the `uIBLParams` uniform.
     * @returns {Float32Array} the same array
     */
    updateParams(): Float32Array;
    /**
     * Binds the three maps to their fixed units and uploads `uIBLParams`.
     * Safe to call on a program that does not use IBL: unknown uniforms are
     * silently ignored.
     * @param {StateCache} state
     * @param {Object} program Program instance.
     * @returns {boolean} true when the environment was bound
     */
    bind(state: StateCache, program: any): boolean;
    /**
     * @param {number} value Global environment multiplier.
     * @returns {IBL} this
     */
    setIntensity(value: number): IBL;
    /** @type {number} Approximate GPU memory held by the environment, in bytes. */
    get memoryBytes(): number;
    /** Releases every GL resource owned by this instance. */
    dispose(): void;
}
import { StateCache } from "./StateCache.js";
import { ShaderLib } from "./ShaderLib.js";
import { Texture } from "./Texture.js";
