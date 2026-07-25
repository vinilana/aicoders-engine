/** Tone mapping operators, mirroring the constants in the `tonemap` chunk. */
export const ToneMapping: Readonly<{
    NONE: 0;
    LINEAR: 1;
    REINHARD: 2;
    ACES: 3;
    ACES_FITTED: 4;
    UNCHARTED2: 5;
    AGX: 6;
}>;
/**
 * Full HDR post processing chain.
 */
export class PostProcessing {
    /**
     * Maps a tone mapping name to its numeric operator id.
     * @param {string|number} mode
     * @returns {number}
     */
    static resolveToneMapping(mode: string | number): number;
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} [renderer] Owning Renderer; `state`, `shaderLib` and `caps`
     *        are taken from it when present.
     * @param {Object} [options]
     * @param {number} [options.width=1] Initial width in device pixels.
     * @param {number} [options.height=1] Initial height in device pixels.
     * @param {boolean} [options.hdr=true] Use a float internal format when supported.
     * @param {boolean} [options.bloom=true]
     * @param {number} [options.bloomIntensity=0.6]
     * @param {number} [options.bloomThreshold=1.1]
     * @param {number} [options.bloomKnee=0.5]
     * @param {number} [options.bloomRadius=1]
     * @param {number} [options.bloomLevels=6]
     * @param {boolean} [options.ssao=false]
     * @param {number} [options.ssaoRadius=0.5]
     * @param {number} [options.ssaoIntensity=1]
     * @param {number} [options.ssaoBias=0.025]
     * @param {number} [options.ssaoPower=1.5]
     * @param {number} [options.ssaoScale=1] Resolution factor of the AO buffer.
     * @param {boolean} [options.fxaa=true]
     * @param {string|number} [options.toneMapping='aces-fitted']
     * @param {number} [options.exposure=1]
     * @param {number} [options.whitePoint=4]
     * @param {number} [options.saturation=1]
     * @param {boolean} [options.vignette=false]
     * @param {boolean} [options.chromaticAberration=false]
     * @param {boolean} [options.grain=false]
     */
    constructor(gl: WebGL2RenderingContext, renderer?: any, options?: {
        width?: number;
        height?: number;
        hdr?: boolean;
        bloom?: boolean;
        bloomIntensity?: number;
        bloomThreshold?: number;
        bloomKnee?: number;
        bloomRadius?: number;
        bloomLevels?: number;
        ssao?: boolean;
        ssaoRadius?: number;
        ssaoIntensity?: number;
        ssaoBias?: number;
        ssaoPower?: number;
        ssaoScale?: number;
        fxaa?: boolean;
        toneMapping?: string | number;
        exposure?: number;
        whitePoint?: number;
        saturation?: number;
        vignette?: boolean;
        chromaticAberration?: boolean;
        grain?: boolean;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object|null} */
    renderer: any | null;
    /** @type {StateCache} */
    state: StateCache;
    /** @private True when this instance owns (and must dispose) the ShaderLib. */
    private _ownsShaderLib;
    /** @type {ShaderLib} */
    shaderLib: ShaderLib;
    /** @type {Object|null} Renderer capabilities, when available. */
    caps: any | null;
    /** @type {number} Width in device pixels. */
    width: number;
    /** @type {number} Height in device pixels. */
    height: number;
    /** @type {boolean} Master switch; when false `render` degrades to a blit. */
    enabled: boolean;
    /** @type {boolean} True when float render targets are usable. */
    floatTargets: boolean;
    /** @type {string} Internal format of the HDR intermediates. */
    hdrFormat: string;
    /** Bloom settings. */
    bloom: {
        enabled: boolean;
        intensity: number;
        threshold: number;
        knee: number;
        radius: number;
        levels: number;
        clampMax: any;
    };
    /** Screen space ambient occlusion settings. */
    ssao: {
        enabled: boolean;
        radius: number;
        intensity: number;
        bias: number;
        power: number;
        strength: any;
        samples: number;
        blur: boolean;
        blurSharpness: any;
        scale: number;
    };
    /** FXAA settings (quality preset of FXAA 3.11). */
    fxaa: {
        enabled: boolean;
        subpixel: any;
        edgeThreshold: any;
        edgeThresholdMin: any;
    };
    /** Vignette settings. */
    vignette: {
        enabled: boolean;
        intensity: any;
        smoothness: any;
        roundness: any;
    };
    /** Chromatic aberration settings. */
    chromaticAberration: {
        enabled: boolean;
        amount: any;
    };
    /** Film grain settings. */
    grain: {
        enabled: boolean;
        intensity: any;
        response: any;
        animated: boolean;
    };
    /** @type {number} Tone mapping operator, see {@link ToneMapping}. */
    toneMapping: number;
    /** @type {number} Linear exposure multiplier applied before the tone curve. */
    exposure: number;
    /** @type {number} White point of the extended Reinhard operator. */
    whitePoint: number;
    /** @type {number} Post tone map saturation (1 = untouched). */
    saturation: number;
    /** @type {number} Frame counter, drives the animated grain. */
    frame: number;
    /** @type {RenderTarget|null} Optional HDR scene target owned by this chain. */
    sceneTarget: RenderTarget | null;
    /** @type {RenderTarget|null} LDR buffer between the composite and the final pass. */
    ldrTarget: RenderTarget | null;
    /** @type {RenderTarget[]} Bloom mip chain, index 0 is half resolution. */
    bloomTargets: RenderTarget[];
    /** @type {RenderTarget|null} */
    aoTarget: RenderTarget | null;
    /** @type {RenderTarget|null} */
    aoBlurTarget: RenderTarget | null;
    /** @type {Texture|null} 4x4 rotation noise for the SSAO kernel. */
    noiseTexture: Texture | null;
    /** @type {Float32Array} 16 hemisphere samples, tangent space. */
    ssaoKernel: Float32Array;
    /** @private */
    private _quadBuffer;
    /** @private */
    private _quadVAO;
    /** @private Cached programs, refreshed whenever the defines change. */
    private _programs;
    /** @private */
    private _compositeDefines;
    /** @private */
    private _finalDefines;
    /** @private */
    private _ssaoDefines;
    /** @private */
    private _programsDirty;
    /** @private */
    private _targetsDirty;
    /** @private */
    private _warnedMissingDepth;
    /** Statistics of the last `render` call. */
    info: {
        passes: number;
        drawCalls: number;
    };
    /**
     * @returns {boolean} true when float color attachments are renderable
     * @private
     */
    private _detectFloatSupport;
    /**
     * Creates the shared full screen triangle. Positions are already in clip space,
     * so no matrix is involved anywhere in the chain.
     * @private
     */
    private _buildQuad;
    /**
     * Builds the deterministic SSAO hemisphere kernel and its 4x4 rotation noise.
     * Samples are pushed towards the origin with a quadratic fall off so the near
     * field is sampled more densely, which is where contact shadows matter.
     * @private
     */
    private _buildSSAOKernel;
    /**
     * @param {boolean} enabled
     * @param {number} [intensity]
     * @param {number} [threshold]
     * @param {number} [radius]
     * @returns {PostProcessing} this
     */
    setBloom(enabled: boolean, intensity?: number, threshold?: number, radius?: number): PostProcessing;
    /**
     * @param {number} [knee] Soft knee width below the threshold.
     * @param {number} [levels] Number of mips in the chain (1..8).
     * @param {number} [clampMax] Firefly clamp applied while prefiltering.
     * @returns {PostProcessing} this
     */
    setBloomAdvanced(knee?: number, levels?: number, clampMax?: number): PostProcessing;
    /**
     * @param {string|number} mode
     * @param {number} [exposure]
     * @returns {PostProcessing} this
     */
    setToneMapping(mode: string | number, exposure?: number): PostProcessing;
    /**
     * @param {number} exposure
     * @returns {PostProcessing} this
     */
    setExposure(exposure: number): PostProcessing;
    /**
     * @param {boolean} enabled
     * @returns {PostProcessing} this
     */
    setFXAA(enabled: boolean): PostProcessing;
    /**
     * @param {boolean} enabled
     * @param {number} [radius] World space sampling radius.
     * @param {number} [intensity] Occlusion strength of the raw AO term.
     * @returns {PostProcessing} this
     */
    setSSAO(enabled: boolean, radius?: number, intensity?: number): PostProcessing;
    /**
     * @param {boolean} enabled
     * @param {number} [intensity]
     * @param {number} [smoothness]
     * @param {number} [roundness]
     * @returns {PostProcessing} this
     */
    setVignette(enabled: boolean, intensity?: number, smoothness?: number, roundness?: number): PostProcessing;
    /**
     * @param {boolean} enabled
     * @param {number} [amount]
     * @returns {PostProcessing} this
     */
    setChromaticAberration(enabled: boolean, amount?: number): PostProcessing;
    /**
     * @param {boolean} enabled
     * @param {number} [intensity]
     * @param {number} [response] How much the mid tones are favoured (0..1).
     * @returns {PostProcessing} this
     */
    setGrain(enabled: boolean, intensity?: number, response?: number): PostProcessing;
    /**
     * True when the chain needs a sampleable depth buffer on the input target.
     * The renderer should create its scene target with `depthTexture: true`.
     * @type {boolean}
     */
    get needsDepthTexture(): boolean;
    /**
     * True when an extra LDR pass runs after the composite.
     * @type {boolean}
     * @private
     */
    private get _needsFinalPass();
    /**
     * Resizes every internal buffer. Contents are discarded.
     * @param {number} width
     * @param {number} height
     * @returns {PostProcessing} this
     */
    resize(width: number, height: number): PostProcessing;
    /**
     * Lazily creates (and returns) an HDR scene target owned by this chain, sized
     * to the current resolution. Handy for a renderer that does not want to manage
     * the float buffer itself.
     * @param {Object} [options] `samples` for MSAA, `depthTexture` to force a
     *        sampleable depth attachment (implied when SSAO is on).
     * @returns {RenderTarget}
     */
    getSceneTarget(options?: any): RenderTarget;
    /**
     * Creates the intermediates the currently enabled effects need.
     * @private
     */
    private _ensureTargets;
    /**
     * Allocates the bloom mip chain, halving the resolution at every level.
     * @private
     */
    private _ensureBloomTargets;
    /**
     * Allocates the AO buffer and its blur ping pong.
     * @private
     */
    private _ensureSSAOTargets;
    /** @private */
    private _disposeBloomTargets;
    /** @private */
    private _disposeSSAOTargets;
    /**
     * Refreshes the cached programs whenever the enabled effects changed.
     * @private
     */
    private _updatePrograms;
    /**
     * Precompiles every permutation the current settings can reach, so no frame
     * ever pays for a shader compile.
     * @returns {PostProcessing} this
     */
    compile(): PostProcessing;
    /**
     * Binds a destination: a RenderTarget, a raw WebGLFramebuffer or null for the
     * default framebuffer.
     * @param {RenderTarget|WebGLFramebuffer|null} target
     * @private
     */
    private _bindOutput;
    /**
     * Issues the full screen triangle.
     * @private
     */
    private _draw;
    /**
     * Extracts the color (and depth) texture of whatever the renderer passed in.
     * @param {RenderTarget|Texture} input
     * @returns {Texture|null}
     * @private
     */
    private _inputTexture;
    /**
     * @param {RenderTarget|Texture} input
     * @returns {Texture|null}
     * @private
     */
    private _inputDepthTexture;
    /**
     * Runs the chain.
     *
     * @param {RenderTarget|Texture} inputRT HDR scene buffer (color, plus a depth
     *        texture when SSAO is enabled).
     * @param {RenderTarget|WebGLFramebuffer|null} [outputFBO] Destination, null for
     *        the default framebuffer.
     * @returns {PostProcessing} this
     */
    render(inputRT: RenderTarget | Texture, outputFBO?: RenderTarget | WebGLFramebuffer | null): PostProcessing;
    /**
     * Convenience wrapper matching the renderer naming.
     * @param {RenderTarget|Texture} inputRT
     * @param {RenderTarget|WebGLFramebuffer|null} [outputFBO]
     * @returns {PostProcessing} this
     */
    renderToScreen(inputRT: RenderTarget | Texture, outputFBO?: RenderTarget | WebGLFramebuffer | null): PostProcessing;
    /**
     * Leaves the pipeline in a sane state for the next frame's geometry passes.
     * @private
     */
    private _restoreState;
    /**
     * Straight blit (used when the chain is disabled).
     * @param {Texture} source
     * @param {RenderTarget|WebGLFramebuffer|null} target
     * @param {number} scale
     * @private
     */
    private _copyPass;
    /**
     * Ambient occlusion: one SSAO pass plus, optionally, two bilateral blur passes.
     * @param {RenderTarget|Texture} inputRT
     * @private
     */
    private _renderSSAO;
    /**
     * Bloom: threshold + downsample chain, then a tent upsample accumulated
     * additively from the smallest mip back up to the largest.
     * @param {Texture} sourceTexture
     * @private
     */
    private _renderBloom;
    /**
     * Exposure, effect mixing, tone curve and sRGB encode.
     * @param {Texture} sourceTexture
     * @param {RenderTarget|WebGLFramebuffer|null} target
     * @private
     */
    private _renderComposite;
    /**
     * FXAA plus the display effects that must come after antialiasing.
     * @param {Texture} sourceTexture
     * @param {RenderTarget|WebGLFramebuffer|null} target
     * @private
     */
    private _renderFinal;
    /** @type {number} Approximate GPU memory held by the chain, in bytes. */
    get memoryBytes(): number;
    /** Releases every GL resource owned by the chain. */
    dispose(): void;
}
import { StateCache } from "./StateCache.js";
import { ShaderLib } from "./ShaderLib.js";
import { RenderTarget } from "./RenderTarget.js";
import { Texture } from "./Texture.js";
