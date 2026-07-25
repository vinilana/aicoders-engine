/**
 * HDR post processing chain.
 *
 * The renderer draws the scene into a floating point target and hands it over to
 * `render(inputRT, outputFBO)`. From there:
 *
 *   1. SSAO (optional)   depth buffer -> 16 sample hemisphere AO -> bilateral blur
 *   2. bloom (optional)  soft knee threshold -> 6 level 13 tap downsample chain ->
 *                        tent upsample accumulated additively back up the chain
 *   3. composite         exposure -> AO/bloom mix -> tone curve -> sRGB encode
 *   4. final (optional)  FXAA 3.11 -> vignette -> chromatic aberration -> grain
 *
 * Every stage is a single full screen triangle. A disabled stage allocates
 * nothing, binds nothing and compiles no permutation of the composite shader, so
 * turning an effect off really is free. When every LDR effect is disabled the
 * composite writes straight into the output framebuffer and the chain is a single
 * pass.
 *
 * The internal buffers are `rgba16f` whenever `EXT_color_buffer_float` is
 * available and fall back to `rgba8` otherwise (bloom still works, it just clips
 * above 1.0).
 */

import { RenderTarget } from './RenderTarget.js';
import { Texture } from './Texture.js';
import { GLBuffer } from './Buffer.js';
import { VertexArray } from './VertexArray.js';
import { StateCache, getStateCache } from './StateCache.js';
import { ShaderLib } from './ShaderLib.js';
import { registerPostShaders } from './shaders/post.js';
import { Logger } from '../core/Logger.js';
import { seededRandom } from '../math/MathUtils.js';

const GL_FRAMEBUFFER = 0x8d40;
const GL_TRIANGLES = 0x0004;
const GL_FLOAT = 0x1406;
const GL_ONE = 1;
const GL_FUNC_ADD = 0x8006;

/** Tone mapping operators, mirroring the constants in the `tonemap` chunk. */
export const ToneMapping = Object.freeze({
  NONE: 0,
  LINEAR: 1,
  REINHARD: 2,
  ACES: 3,
  ACES_FITTED: 4,
  UNCHARTED2: 5,
  AGX: 6
});

/** Accepted string spellings for {@link ToneMapping}. */
const TONEMAP_NAMES = {
  none: ToneMapping.NONE,
  off: ToneMapping.NONE,
  linear: ToneMapping.LINEAR,
  clamp: ToneMapping.LINEAR,
  reinhard: ToneMapping.REINHARD,
  'reinhard-extended': ToneMapping.REINHARD,
  aces: ToneMapping.ACES,
  'aces-narkowicz': ToneMapping.ACES,
  'aces-fitted': ToneMapping.ACES_FITTED,
  acesfitted: ToneMapping.ACES_FITTED,
  'aces-hill': ToneMapping.ACES_FITTED,
  uncharted2: ToneMapping.UNCHARTED2,
  filmic: ToneMapping.UNCHARTED2,
  agx: ToneMapping.AGX
};

/** Geometry of the full screen triangle: clip position (xyz) + uv, interleaved. */
const FULLSCREEN_TRIANGLE = new Float32Array([
  -1, -1, 0, 0, 0,
  3, -1, 0, 2, 0,
  -1, 3, 0, 0, 2
]);

// --- module scope scratch, so the hot path never allocates --------------------
const _texel = new Float32Array(2);
const _texel2 = new Float32Array(2);
const _bloomFilter = new Float32Array(4);
const _bloomParams = new Float32Array(4);
const _compositeParams = new Float32Array(4);
const _ssaoParams = new Float32Array(4);
const _noiseScale = new Float32Array(2);
const _fxaaParams = new Float32Array(4);
const _vignetteParams = new Float32Array(4);
const _grainParams = new Float32Array(4);
const _blurDirection = new Float32Array(2);
const _blurParams = new Float32Array(2);
const _copyScale = new Float32Array(4);

/**
 * Full HDR post processing chain.
 */
export class PostProcessing {
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
  constructor(gl, renderer = null, options = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} */
    this.renderer = renderer || null;

    /** @type {StateCache} */
    this.state = (renderer && renderer.state) || getStateCache(gl) || new StateCache(gl);

    /** @private True when this instance owns (and must dispose) the ShaderLib. */
    this._ownsShaderLib = false;
    if (renderer && renderer.shaderLib) {
      /** @type {ShaderLib} */
      this.shaderLib = renderer.shaderLib;
    } else {
      this.shaderLib = new ShaderLib(gl);
      this._ownsShaderLib = true;
    }
    registerPostShaders(this.shaderLib);

    /** @type {Object|null} Renderer capabilities, when available. */
    this.caps = (renderer && (renderer.caps || renderer.capabilities)) || null;

    /** @type {number} Width in device pixels. */
    this.width = Math.max(1, (options.width || 1) | 0);
    /** @type {number} Height in device pixels. */
    this.height = Math.max(1, (options.height || 1) | 0);

    /** @type {boolean} Master switch; when false `render` degrades to a blit. */
    this.enabled = options.enabled !== false;

    const wantsHDR = options.hdr !== false;
    /** @type {boolean} True when float render targets are usable. */
    this.floatTargets = wantsHDR && this._detectFloatSupport();
    /** @type {string} Internal format of the HDR intermediates. */
    this.hdrFormat = this.floatTargets ? 'rgba16f' : 'rgba8';
    if (wantsHDR && !this.floatTargets) {
      Logger.warn('PostProcessing: EXT_color_buffer_float ausente, usando rgba8 (bloom sem HDR).');
    }

    /** Bloom settings. */
    this.bloom = {
      enabled: options.bloom !== false,
      intensity: options.bloomIntensity !== undefined ? options.bloomIntensity : 0.6,
      threshold: options.bloomThreshold !== undefined ? options.bloomThreshold : 1.1,
      knee: options.bloomKnee !== undefined ? options.bloomKnee : 0.5,
      radius: options.bloomRadius !== undefined ? options.bloomRadius : 1.0,
      levels: options.bloomLevels !== undefined ? Math.max(1, options.bloomLevels | 0) : 6,
      clampMax: options.bloomClamp !== undefined ? options.bloomClamp : 64.0
    };

    /** Screen space ambient occlusion settings. */
    this.ssao = {
      enabled: !!options.ssao,
      radius: options.ssaoRadius !== undefined ? options.ssaoRadius : 0.5,
      intensity: options.ssaoIntensity !== undefined ? options.ssaoIntensity : 1.0,
      bias: options.ssaoBias !== undefined ? options.ssaoBias : 0.025,
      power: options.ssaoPower !== undefined ? options.ssaoPower : 1.5,
      strength: options.ssaoStrength !== undefined ? options.ssaoStrength : 1.0,
      samples: 16,
      blur: options.ssaoBlur !== false,
      blurSharpness: options.ssaoBlurSharpness !== undefined ? options.ssaoBlurSharpness : 8.0,
      scale: options.ssaoScale !== undefined ? Math.min(1, Math.max(0.25, options.ssaoScale)) : 1.0
    };

    /** FXAA settings (quality preset of FXAA 3.11). */
    this.fxaa = {
      enabled: options.fxaa !== false,
      subpixel: options.fxaaSubpixel !== undefined ? options.fxaaSubpixel : 0.75,
      edgeThreshold: options.fxaaEdgeThreshold !== undefined ? options.fxaaEdgeThreshold : 0.166,
      edgeThresholdMin: options.fxaaEdgeThresholdMin !== undefined ? options.fxaaEdgeThresholdMin : 0.0833
    };

    /** Vignette settings. */
    this.vignette = {
      enabled: !!options.vignette,
      intensity: options.vignetteIntensity !== undefined ? options.vignetteIntensity : 0.35,
      smoothness: options.vignetteSmoothness !== undefined ? options.vignetteSmoothness : 0.4,
      roundness: options.vignetteRoundness !== undefined ? options.vignetteRoundness : 1.0
    };

    /** Chromatic aberration settings. */
    this.chromaticAberration = {
      enabled: !!options.chromaticAberration,
      amount: options.chromaticAberrationAmount !== undefined ? options.chromaticAberrationAmount : 0.5
    };

    /** Film grain settings. */
    this.grain = {
      enabled: !!options.grain,
      intensity: options.grainIntensity !== undefined ? options.grainIntensity : 0.04,
      response: options.grainResponse !== undefined ? options.grainResponse : 0.8,
      animated: options.grainAnimated !== false
    };

    /** @type {number} Tone mapping operator, see {@link ToneMapping}. */
    this.toneMapping = PostProcessing.resolveToneMapping(
      options.toneMapping !== undefined ? options.toneMapping : ToneMapping.ACES_FITTED
    );
    /** @type {number} Linear exposure multiplier applied before the tone curve. */
    this.exposure = options.exposure !== undefined ? options.exposure : 1.0;
    /** @type {number} White point of the extended Reinhard operator. */
    this.whitePoint = options.whitePoint !== undefined ? options.whitePoint : 4.0;
    /** @type {number} Post tone map saturation (1 = untouched). */
    this.saturation = options.saturation !== undefined ? options.saturation : 1.0;

    /** @type {number} Frame counter, drives the animated grain. */
    this.frame = 0;

    // --- resources -------------------------------------------------------
    /** @type {RenderTarget|null} Optional HDR scene target owned by this chain. */
    this.sceneTarget = null;
    /** @type {RenderTarget|null} LDR buffer between the composite and the final pass. */
    this.ldrTarget = null;
    /** @type {RenderTarget[]} Bloom mip chain, index 0 is half resolution. */
    this.bloomTargets = [];
    /** @type {RenderTarget|null} */
    this.aoTarget = null;
    /** @type {RenderTarget|null} */
    this.aoBlurTarget = null;
    /** @type {Texture|null} 4x4 rotation noise for the SSAO kernel. */
    this.noiseTexture = null;
    /** @type {Float32Array} 16 hemisphere samples, tangent space. */
    this.ssaoKernel = new Float32Array(this.ssao.samples * 3);

    /** @private */
    this._quadBuffer = null;
    /** @private */
    this._quadVAO = null;

    /** @private Cached programs, refreshed whenever the defines change. */
    this._programs = {
      copy: null,
      prefilter: null,
      down: null,
      up: null,
      ssao: null,
      blur: null,
      composite: null,
      final: null
    };
    /** @private */
    this._compositeDefines = { USE_BLOOM: false, USE_SSAO: false };
    /** @private */
    this._finalDefines = {
      USE_FXAA: false,
      USE_VIGNETTE: false,
      USE_CHROMATIC_ABERRATION: false,
      USE_GRAIN: false
    };
    /** @private */
    this._ssaoDefines = { SSAO_SAMPLES: this.ssao.samples };
    /** @private */
    this._programsDirty = true;
    /** @private */
    this._targetsDirty = true;
    /** @private */
    this._warnedMissingDepth = false;

    /** Statistics of the last `render` call. */
    this.info = { passes: 0, drawCalls: 0 };

    this._buildQuad();
    this._buildSSAOKernel();
  }

  // =======================================================================
  // Setup
  // =======================================================================

  /**
   * Maps a tone mapping name to its numeric operator id.
   * @param {string|number} mode
   * @returns {number}
   */
  static resolveToneMapping(mode) {
    if (typeof mode === 'number') return mode | 0;
    if (typeof mode === 'string') {
      const value = TONEMAP_NAMES[mode.toLowerCase()];
      if (value !== undefined) return value;
    }
    return ToneMapping.ACES_FITTED;
  }

  /**
   * @returns {boolean} true when float color attachments are renderable
   * @private
   */
  _detectFloatSupport() {
    if (this.caps && typeof this.caps.colorBufferFloat === 'boolean') return this.caps.colorBufferFloat;
    const gl = this.gl;
    if (typeof gl.getExtension !== 'function') return false;
    return !!gl.getExtension('EXT_color_buffer_float');
  }

  /**
   * Creates the shared full screen triangle. Positions are already in clip space,
   * so no matrix is involved anywhere in the chain.
   * @private
   */
  _buildQuad() {
    const gl = this.gl;
    this._quadBuffer = new GLBuffer(gl, 'array', 'static');
    this._quadBuffer.setData(FULLSCREEN_TRIANGLE, this.state);

    this._quadVAO = new VertexArray(gl, this.state);
    // location 0 = aPosition (vec3), location 2 = aUV0 (vec2), stride 20 bytes.
    this._quadVAO.setAttribute(0, this._quadBuffer, 3, GL_FLOAT, false, 20, 0, 0, false);
    this._quadVAO.setAttribute(2, this._quadBuffer, 2, GL_FLOAT, false, 20, 12, 0, false);
    this.state.bindVAO(null);
  }

  /**
   * Builds the deterministic SSAO hemisphere kernel and its 4x4 rotation noise.
   * Samples are pushed towards the origin with a quadratic fall off so the near
   * field is sampled more densely, which is where contact shadows matter.
   * @private
   */
  _buildSSAOKernel() {
    const rand = seededRandom(0x5eed1b1);
    const kernel = this.ssaoKernel;
    const count = this.ssao.samples;

    for (let i = 0; i < count; i++) {
      let x = rand() * 2.0 - 1.0;
      let y = rand() * 2.0 - 1.0;
      let z = rand();
      let len = Math.sqrt(x * x + y * y + z * z);
      if (len < 1e-5) {
        x = 0; y = 0; z = 1; len = 1;
      }
      x /= len; y /= len; z /= len;

      // Cluster the samples near the origin: scale = lerp(0.1, 1, t^2).
      const t = i / count;
      const scale = 0.1 + 0.9 * t * t;
      // A little jitter on the radius avoids visible sample banding.
      const radius = scale * (0.6 + 0.4 * rand());

      kernel[i * 3 + 0] = x * radius;
      kernel[i * 3 + 1] = y * radius;
      kernel[i * 3 + 2] = z * radius;
    }

    const noiseData = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      const angle = rand() * Math.PI * 2.0;
      noiseData[i * 4 + 0] = Math.round((Math.cos(angle) * 0.5 + 0.5) * 255);
      noiseData[i * 4 + 1] = Math.round((Math.sin(angle) * 0.5 + 0.5) * 255);
      noiseData[i * 4 + 2] = 128;
      noiseData[i * 4 + 3] = 255;
    }

    this.noiseTexture = new Texture(this.gl, {
      target: '2d',
      width: 4,
      height: 4,
      internalFormat: 'rgba8',
      minFilter: 'nearest',
      magFilter: 'nearest',
      wrapS: 'repeat',
      wrapT: 'repeat',
      data: noiseData,
      state: this.state,
      name: 'post.ssaoNoise'
    });
  }

  // =======================================================================
  // Settings
  // =======================================================================

  /**
   * @param {boolean} enabled
   * @param {number} [intensity]
   * @param {number} [threshold]
   * @param {number} [radius]
   * @returns {PostProcessing} this
   */
  setBloom(enabled, intensity, threshold, radius) {
    const wasEnabled = this.bloom.enabled;
    this.bloom.enabled = !!enabled;
    if (intensity !== undefined) this.bloom.intensity = intensity;
    if (threshold !== undefined) this.bloom.threshold = threshold;
    if (radius !== undefined) this.bloom.radius = radius;
    if (wasEnabled !== this.bloom.enabled) {
      this._programsDirty = true;
      this._targetsDirty = true;
      if (!this.bloom.enabled) this._disposeBloomTargets();
    }
    return this;
  }

  /**
   * @param {number} [knee] Soft knee width below the threshold.
   * @param {number} [levels] Number of mips in the chain (1..8).
   * @param {number} [clampMax] Firefly clamp applied while prefiltering.
   * @returns {PostProcessing} this
   */
  setBloomAdvanced(knee, levels, clampMax) {
    if (knee !== undefined) this.bloom.knee = knee;
    if (clampMax !== undefined) this.bloom.clampMax = clampMax;
    if (levels !== undefined) {
      const value = Math.max(1, Math.min(8, levels | 0));
      if (value !== this.bloom.levels) {
        this.bloom.levels = value;
        this._targetsDirty = true;
        this._disposeBloomTargets();
      }
    }
    return this;
  }

  /**
   * @param {string|number} mode
   * @param {number} [exposure]
   * @returns {PostProcessing} this
   */
  setToneMapping(mode, exposure) {
    this.toneMapping = PostProcessing.resolveToneMapping(mode);
    if (exposure !== undefined) this.exposure = exposure;
    return this;
  }

  /**
   * @param {number} exposure
   * @returns {PostProcessing} this
   */
  setExposure(exposure) {
    this.exposure = exposure;
    return this;
  }

  /**
   * @param {boolean} enabled
   * @returns {PostProcessing} this
   */
  setFXAA(enabled) {
    const value = !!enabled;
    if (value !== this.fxaa.enabled) {
      this.fxaa.enabled = value;
      this._programsDirty = true;
      this._targetsDirty = true;
    }
    return this;
  }

  /**
   * @param {boolean} enabled
   * @param {number} [radius] World space sampling radius.
   * @param {number} [intensity] Occlusion strength of the raw AO term.
   * @returns {PostProcessing} this
   */
  setSSAO(enabled, radius, intensity) {
    const value = !!enabled;
    if (radius !== undefined) this.ssao.radius = radius;
    if (intensity !== undefined) this.ssao.intensity = intensity;
    if (value !== this.ssao.enabled) {
      this.ssao.enabled = value;
      this._programsDirty = true;
      this._targetsDirty = true;
      if (!value) this._disposeSSAOTargets();
    }
    return this;
  }

  /**
   * @param {boolean} enabled
   * @param {number} [intensity]
   * @param {number} [smoothness]
   * @param {number} [roundness]
   * @returns {PostProcessing} this
   */
  setVignette(enabled, intensity, smoothness, roundness) {
    const value = !!enabled;
    if (intensity !== undefined) this.vignette.intensity = intensity;
    if (smoothness !== undefined) this.vignette.smoothness = smoothness;
    if (roundness !== undefined) this.vignette.roundness = roundness;
    if (value !== this.vignette.enabled) {
      this.vignette.enabled = value;
      this._programsDirty = true;
      this._targetsDirty = true;
    }
    return this;
  }

  /**
   * @param {boolean} enabled
   * @param {number} [amount]
   * @returns {PostProcessing} this
   */
  setChromaticAberration(enabled, amount) {
    const value = !!enabled;
    if (amount !== undefined) this.chromaticAberration.amount = amount;
    if (value !== this.chromaticAberration.enabled) {
      this.chromaticAberration.enabled = value;
      this._programsDirty = true;
      this._targetsDirty = true;
    }
    return this;
  }

  /**
   * @param {boolean} enabled
   * @param {number} [intensity]
   * @param {number} [response] How much the mid tones are favoured (0..1).
   * @returns {PostProcessing} this
   */
  setGrain(enabled, intensity, response) {
    const value = !!enabled;
    if (intensity !== undefined) this.grain.intensity = intensity;
    if (response !== undefined) this.grain.response = response;
    if (value !== this.grain.enabled) {
      this.grain.enabled = value;
      this._programsDirty = true;
      this._targetsDirty = true;
    }
    return this;
  }

  /**
   * True when the chain needs a sampleable depth buffer on the input target.
   * The renderer should create its scene target with `depthTexture: true`.
   * @type {boolean}
   */
  get needsDepthTexture() {
    return this.enabled && this.ssao.enabled;
  }

  /**
   * True when an extra LDR pass runs after the composite.
   * @type {boolean}
   * @private
   */
  get _needsFinalPass() {
    return this.fxaa.enabled || this.vignette.enabled ||
      this.chromaticAberration.enabled || this.grain.enabled;
  }

  // =======================================================================
  // Resources
  // =======================================================================

  /**
   * Resizes every internal buffer. Contents are discarded.
   * @param {number} width
   * @param {number} height
   * @returns {PostProcessing} this
   */
  resize(width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    if (w === this.width && h === this.height) return this;
    this.width = w;
    this.height = h;

    if (this.sceneTarget) this.sceneTarget.resize(w, h);
    this._disposeBloomTargets();
    this._disposeSSAOTargets();
    if (this.ldrTarget) {
      this.ldrTarget.dispose(this.state);
      this.ldrTarget = null;
    }
    this._targetsDirty = true;
    return this;
  }

  /**
   * Lazily creates (and returns) an HDR scene target owned by this chain, sized
   * to the current resolution. Handy for a renderer that does not want to manage
   * the float buffer itself.
   * @param {Object} [options] `samples` for MSAA, `depthTexture` to force a
   *        sampleable depth attachment (implied when SSAO is on).
   * @returns {RenderTarget}
   */
  getSceneTarget(options = {}) {
    const wantsDepthTexture = options.depthTexture !== undefined
      ? !!options.depthTexture
      : this.needsDepthTexture;
    const samples = options.samples || 0;

    if (this.sceneTarget) {
      const matches = this.sceneTarget.useDepthTexture === wantsDepthTexture &&
        this.sceneTarget.samples === samples;
      if (matches) {
        if (this.sceneTarget.width !== this.width || this.sceneTarget.height !== this.height) {
          this.sceneTarget.resize(this.width, this.height);
        }
        return this.sceneTarget;
      }
      this.sceneTarget.dispose(this.state);
      this.sceneTarget = null;
    }

    this.sceneTarget = new RenderTarget(this.gl, this.width, this.height, {
      colorAttachments: 1,
      colorFormat: this.hdrFormat,
      depth: true,
      depthTexture: wantsDepthTexture,
      depthFormat: wantsDepthTexture ? 'depth32f' : 'depth24',
      samples,
      wrap: 'clamp',
      filter: 'linear',
      state: this.state,
      name: 'post.scene'
    });
    return this.sceneTarget;
  }

  /**
   * Creates the intermediates the currently enabled effects need.
   * @private
   */
  _ensureTargets() {
    if (!this._targetsDirty) return;
    this._targetsDirty = false;

    if (this.bloom.enabled) this._ensureBloomTargets();
    if (this.ssao.enabled) this._ensureSSAOTargets();

    if (this._needsFinalPass) {
      if (!this.ldrTarget) {
        this.ldrTarget = new RenderTarget(this.gl, this.width, this.height, {
          colorAttachments: 1,
          colorFormat: 'rgba8',
          depth: false,
          wrap: 'clamp',
          filter: 'linear',
          state: this.state,
          name: 'post.ldr'
        });
      }
    } else if (this.ldrTarget) {
      this.ldrTarget.dispose(this.state);
      this.ldrTarget = null;
    }
  }

  /**
   * Allocates the bloom mip chain, halving the resolution at every level.
   * @private
   */
  _ensureBloomTargets() {
    const maxByResolution = Math.max(1, Math.floor(Math.log2(Math.max(2, Math.min(this.width, this.height)))) - 1);
    const levels = Math.max(1, Math.min(this.bloom.levels, maxByResolution));

    if (this.bloomTargets.length === levels &&
      this.bloomTargets[0].width === Math.max(1, this.width >> 1)) {
      return;
    }
    this._disposeBloomTargets();

    for (let i = 0; i < levels; i++) {
      const w = Math.max(1, this.width >> (i + 1));
      const h = Math.max(1, this.height >> (i + 1));
      this.bloomTargets.push(new RenderTarget(this.gl, w, h, {
        colorAttachments: 1,
        colorFormat: this.hdrFormat,
        depth: false,
        wrap: 'clamp',
        filter: 'linear',
        state: this.state,
        name: 'post.bloom' + i
      }));
    }
  }

  /**
   * Allocates the AO buffer and its blur ping pong.
   * @private
   */
  _ensureSSAOTargets() {
    const w = Math.max(1, Math.round(this.width * this.ssao.scale));
    const h = Math.max(1, Math.round(this.height * this.ssao.scale));

    if (this.aoTarget && this.aoTarget.width === w && this.aoTarget.height === h) return;
    this._disposeSSAOTargets();

    this.aoTarget = new RenderTarget(this.gl, w, h, {
      colorAttachments: 1,
      colorFormat: 'r8',
      depth: false,
      wrap: 'clamp',
      filter: 'linear',
      state: this.state,
      name: 'post.ao'
    });
    if (this.ssao.blur) {
      this.aoBlurTarget = new RenderTarget(this.gl, w, h, {
        colorAttachments: 1,
        colorFormat: 'r8',
        depth: false,
        wrap: 'clamp',
        filter: 'linear',
        state: this.state,
        name: 'post.aoBlur'
      });
    }
  }

  /** @private */
  _disposeBloomTargets() {
    for (let i = 0, n = this.bloomTargets.length; i < n; i++) {
      this.bloomTargets[i].dispose(this.state);
    }
    this.bloomTargets.length = 0;
  }

  /** @private */
  _disposeSSAOTargets() {
    if (this.aoTarget) {
      this.aoTarget.dispose(this.state);
      this.aoTarget = null;
    }
    if (this.aoBlurTarget) {
      this.aoBlurTarget.dispose(this.state);
      this.aoBlurTarget = null;
    }
  }

  /**
   * Refreshes the cached programs whenever the enabled effects changed.
   * @private
   */
  _updatePrograms() {
    if (!this._programsDirty) return;
    this._programsDirty = false;

    const lib = this.shaderLib;
    const programs = this._programs;

    // `post_copy` is only ever needed when the chain is disabled, so it is
    // compiled lazily by `_copyPass` instead of on every settings change.
    if (this.bloom.enabled) {
      programs.prefilter = lib.get('post_bloom_prefilter', null);
      programs.down = lib.get('post_bloom_down', null);
      programs.up = lib.get('post_bloom_up', null);
    }

    if (this.ssao.enabled) {
      this._ssaoDefines.SSAO_SAMPLES = this.ssao.samples;
      programs.ssao = lib.get('post_ssao', this._ssaoDefines);
      programs.blur = this.ssao.blur ? lib.get('post_blur', null) : null;
    }

    this._compositeDefines.USE_BLOOM = this.bloom.enabled;
    this._compositeDefines.USE_SSAO = this.ssao.enabled;
    programs.composite = lib.get('post_composite', this._compositeDefines);

    if (this._needsFinalPass) {
      this._finalDefines.USE_FXAA = this.fxaa.enabled;
      this._finalDefines.USE_VIGNETTE = this.vignette.enabled;
      this._finalDefines.USE_CHROMATIC_ABERRATION = this.chromaticAberration.enabled;
      this._finalDefines.USE_GRAIN = this.grain.enabled;
      programs.final = lib.get('post_fxaa', this._finalDefines);
    } else {
      programs.final = null;
    }
  }

  /**
   * Precompiles every permutation the current settings can reach, so no frame
   * ever pays for a shader compile.
   * @returns {PostProcessing} this
   */
  compile() {
    this._programsDirty = true;
    this._updatePrograms();
    const programs = this._programs;
    if (!programs.copy) programs.copy = this.shaderLib.get('post_copy', null);
    for (const key in programs) {
      const program = programs[key];
      if (program) program.isLinked();
    }
    return this;
  }

  // =======================================================================
  // Rendering
  // =======================================================================

  /**
   * Binds a destination: a RenderTarget, a raw WebGLFramebuffer or null for the
   * default framebuffer.
   * @param {RenderTarget|WebGLFramebuffer|null} target
   * @private
   */
  _bindOutput(target) {
    const state = this.state;
    if (!target) {
      state.bindFramebuffer(GL_FRAMEBUFFER, null);
      state.viewport(0, 0, this.width, this.height);
      return;
    }
    if (typeof target.bind === 'function' && target.framebuffer !== undefined) {
      target.bind(state);
      return;
    }
    state.bindFramebuffer(GL_FRAMEBUFFER, target);
    state.viewport(0, 0, this.width, this.height);
  }

  /**
   * Issues the full screen triangle.
   * @private
   */
  _draw() {
    this.state.drawArrays(GL_TRIANGLES, 0, 3);
    this.info.passes++;
    this.info.drawCalls++;
  }

  /**
   * Extracts the color (and depth) texture of whatever the renderer passed in.
   * @param {RenderTarget|Texture} input
   * @returns {Texture|null}
   * @private
   */
  _inputTexture(input) {
    if (!input) return null;
    if (input.textures !== undefined) {
      if (input.samples > 0 && typeof input.resolve === 'function') input.resolve();
      return input.textures.length > 0 ? input.textures[0] : null;
    }
    return input;
  }

  /**
   * @param {RenderTarget|Texture} input
   * @returns {Texture|null}
   * @private
   */
  _inputDepthTexture(input) {
    if (!input) return null;
    return input.depthTexture || null;
  }

  /**
   * Runs the chain.
   *
   * @param {RenderTarget|Texture} inputRT HDR scene buffer (color, plus a depth
   *        texture when SSAO is enabled).
   * @param {RenderTarget|WebGLFramebuffer|null} [outputFBO] Destination, null for
   *        the default framebuffer.
   * @returns {PostProcessing} this
   */
  render(inputRT, outputFBO = null) {
    const state = this.state;
    const sourceTexture = this._inputTexture(inputRT);
    if (!sourceTexture) return this;

    this.info.passes = 0;
    this.info.drawCalls = 0;
    this.frame++;

    this._ensureTargets();
    this._updatePrograms();

    // Common state for every full screen pass.
    state.setScissorTest(false);
    state.setDepthTest(false);
    state.setDepthWrite(false);
    state.setCullFace('none');
    state.setBlending('none');
    state.setColorMask(true, true, true, true);
    state.setPolygonOffset(false, 0, 0);
    this._quadVAO.bind(state);

    if (!this.enabled) {
      this._copyPass(sourceTexture, outputFBO, 1.0);
      this._restoreState();
      return this;
    }

    if (this.ssao.enabled) this._renderSSAO(inputRT);
    if (this.bloom.enabled) this._renderBloom(sourceTexture);

    // The composite writes straight to the destination unless an LDR pass has to
    // run afterwards (and its buffer really exists).
    const runsFinalPass = this._programs.final !== null && this.ldrTarget !== null;
    this._renderComposite(sourceTexture, runsFinalPass ? this.ldrTarget : outputFBO);

    if (runsFinalPass) {
      this._renderFinal(this.ldrTarget.textures[0], outputFBO);
    }

    this._restoreState();
    return this;
  }

  /**
   * Convenience wrapper matching the renderer naming.
   * @param {RenderTarget|Texture} inputRT
   * @param {RenderTarget|WebGLFramebuffer|null} [outputFBO]
   * @returns {PostProcessing} this
   */
  renderToScreen(inputRT, outputFBO = null) {
    return this.render(inputRT, outputFBO);
  }

  /**
   * Leaves the pipeline in a sane state for the next frame's geometry passes.
   * @private
   */
  _restoreState() {
    const state = this.state;
    state.bindVAO(null);
    state.setDepthTest(true);
    state.setDepthWrite(true);
    state.setBlending('none');
  }

  /**
   * Straight blit (used when the chain is disabled).
   * @param {Texture} source
   * @param {RenderTarget|WebGLFramebuffer|null} target
   * @param {number} scale
   * @private
   */
  _copyPass(source, target, scale) {
    let program = this._programs.copy;
    if (!program) {
      program = this.shaderLib.get('post_copy', null);
      this._programs.copy = program;
    }
    if (!program || !program.use(this.state)) return;
    this._bindOutput(target);
    _copyScale[0] = scale;
    _copyScale[1] = scale;
    _copyScale[2] = scale;
    _copyScale[3] = 1.0;
    program.setTexture('uSource', source, 0, this.state);
    program.setUniform('uCopyScale', _copyScale);
    this._draw();
  }

  /**
   * Ambient occlusion: one SSAO pass plus, optionally, two bilateral blur passes.
   * @param {RenderTarget|Texture} inputRT
   * @private
   */
  _renderSSAO(inputRT) {
    const depthTexture = this._inputDepthTexture(inputRT);
    if (!depthTexture || !this.aoTarget) {
      if (!this._warnedMissingDepth) {
        this._warnedMissingDepth = true;
        Logger.warn('PostProcessing: SSAO ligado mas o alvo de entrada nao tem depthTexture; ' +
          'crie o RenderTarget com { depthTexture: true }.');
      }
      return;
    }

    const state = this.state;
    const program = this._programs.ssao;
    if (!program || !program.use(state)) return;

    this.aoTarget.bind(state);

    _ssaoParams[0] = this.ssao.radius;
    _ssaoParams[1] = this.ssao.intensity;
    _ssaoParams[2] = this.ssao.bias;
    _ssaoParams[3] = this.ssao.power;
    _noiseScale[0] = this.aoTarget.width * 0.25;
    _noiseScale[1] = this.aoTarget.height * 0.25;

    program.setTexture('uDepthTexture', depthTexture, 3, state);
    program.setTexture('uNoiseTexture', this.noiseTexture, 4, state);
    program.setUniform('uSSAOKernel', this.ssaoKernel);
    program.setUniform('uSSAOParams', _ssaoParams);
    program.setUniform('uNoiseScale', _noiseScale);
    this._draw();

    const blur = this._programs.blur;
    if (!blur || !this.aoBlurTarget || !blur.use(state)) return;

    _blurParams[0] = this.ssao.blurSharpness;
    _blurParams[1] = 0.0;

    // Horizontal.
    this.aoBlurTarget.bind(state);
    _blurDirection[0] = 1.0 / this.aoTarget.width;
    _blurDirection[1] = 0.0;
    blur.setTexture('uSource', this.aoTarget.textures[0], 0, state);
    blur.setTexture('uDepthTexture', depthTexture, 3, state);
    blur.setUniform('uBlurDirection', _blurDirection);
    blur.setUniform('uBlurParams', _blurParams);
    this._draw();

    // Vertical, back into the AO buffer the composite samples.
    this.aoTarget.bind(state);
    _blurDirection[0] = 0.0;
    _blurDirection[1] = 1.0 / this.aoBlurTarget.height;
    blur.setTexture('uSource', this.aoBlurTarget.textures[0], 0, state);
    blur.setTexture('uDepthTexture', depthTexture, 3, state);
    blur.setUniform('uBlurDirection', _blurDirection);
    blur.setUniform('uBlurParams', _blurParams);
    this._draw();
  }

  /**
   * Bloom: threshold + downsample chain, then a tent upsample accumulated
   * additively from the smallest mip back up to the largest.
   * @param {Texture} sourceTexture
   * @private
   */
  _renderBloom(sourceTexture) {
    const targets = this.bloomTargets;
    if (targets.length === 0) return;

    const state = this.state;
    const prefilter = this._programs.prefilter;
    if (!prefilter || !prefilter.use(state)) return;

    const knee = Math.max(this.bloom.knee, 1e-4);
    _bloomFilter[0] = this.bloom.threshold;
    _bloomFilter[1] = this.bloom.threshold - knee;
    _bloomFilter[2] = knee * 2.0;
    _bloomFilter[3] = 0.25 / knee;

    targets[0].bind(state);
    _texel[0] = 1.0 / this.width;
    _texel[1] = 1.0 / this.height;
    prefilter.setTexture('uSource', sourceTexture, 0, state);
    prefilter.setUniform('uTexelSize', _texel);
    prefilter.setUniform('uBloomFilter', _bloomFilter);
    prefilter.setUniform('uClampMax', this.bloom.clampMax);
    this._draw();

    // ---- downsample ----------------------------------------------------
    const down = this._programs.down;
    if (down && down.use(state)) {
      for (let i = 1, n = targets.length; i < n; i++) {
        const src = targets[i - 1];
        targets[i].bind(state);
        _texel[0] = 1.0 / src.width;
        _texel[1] = 1.0 / src.height;
        down.setTexture('uSource', src.textures[0], 0, state);
        down.setUniform('uTexelSize', _texel);
        this._draw();
      }
    }

    // ---- upsample, additively accumulated ------------------------------
    const up = this._programs.up;
    if (up && targets.length > 1 && up.use(state)) {
      state.setBlendFuncSeparate(GL_ONE, GL_ONE, GL_ONE, GL_ONE, GL_FUNC_ADD, GL_FUNC_ADD);
      for (let i = targets.length - 1; i >= 1; i--) {
        const src = targets[i];
        targets[i - 1].bind(state);
        _texel2[0] = 1.0 / src.width;
        _texel2[1] = 1.0 / src.height;
        up.setTexture('uSource', src.textures[0], 0, state);
        up.setUniform('uTexelSize', _texel2);
        up.setUniform('uRadius', this.bloom.radius);
        up.setUniform('uScale', 1.0);
        this._draw();
      }
      state.setBlending('none');
    }
  }

  /**
   * Exposure, effect mixing, tone curve and sRGB encode.
   * @param {Texture} sourceTexture
   * @param {RenderTarget|WebGLFramebuffer|null} target
   * @private
   */
  _renderComposite(sourceTexture, target) {
    const state = this.state;
    const program = this._programs.composite;
    if (!program || !program.use(state)) return;

    this._bindOutput(target);

    _compositeParams[0] = this.exposure;
    _compositeParams[1] = this.toneMapping;
    _compositeParams[2] = this.whitePoint;
    _compositeParams[3] = this.saturation;

    program.setTexture('uSource', sourceTexture, 0, state);
    program.setUniform('uCompositeParams', _compositeParams);

    if (this.bloom.enabled && this.bloomTargets.length > 0) {
      _bloomParams[0] = this.bloom.intensity;
      _bloomParams[1] = 0.0;
      _bloomParams[2] = 0.0;
      _bloomParams[3] = 0.0;
      program.setTexture('uBloomTexture', this.bloomTargets[0].textures[0], 1, state);
      program.setUniform('uBloomParams', _bloomParams);
    }

    if (this.ssao.enabled && this.aoTarget) {
      program.setTexture('uAOTexture', this.aoTarget.textures[0], 2, state);
      program.setUniform('uAOStrength', this.ssao.strength);
    }

    this._draw();
  }

  /**
   * FXAA plus the display effects that must come after antialiasing.
   * @param {Texture} sourceTexture
   * @param {RenderTarget|WebGLFramebuffer|null} target
   * @private
   */
  _renderFinal(sourceTexture, target) {
    const state = this.state;
    const program = this._programs.final;
    if (!program || !program.use(state)) return;

    this._bindOutput(target);

    _texel[0] = 1.0 / this.width;
    _texel[1] = 1.0 / this.height;
    _fxaaParams[0] = this.fxaa.subpixel;
    _fxaaParams[1] = this.fxaa.edgeThreshold;
    _fxaaParams[2] = this.fxaa.edgeThresholdMin;
    _fxaaParams[3] = 0.0;

    _vignetteParams[0] = this.vignette.intensity;
    _vignetteParams[1] = this.vignette.smoothness;
    _vignetteParams[2] = this.vignette.roundness;
    _vignetteParams[3] = this.width / Math.max(this.height, 1);

    _grainParams[0] = this.grain.intensity;
    _grainParams[1] = this.grain.response;
    _grainParams[2] = this.grain.animated ? (this.frame % 1024) : 0.0;
    _grainParams[3] = 0.0;

    program.setTexture('uSource', sourceTexture, 0, state);
    program.setUniform('uTexelSize', _texel);
    program.setUniform('uFXAAParams', _fxaaParams);
    program.setUniform('uVignetteParams', _vignetteParams);
    program.setUniform('uGrainParams', _grainParams);
    program.setUniform('uChromaticAmount', this.chromaticAberration.amount);
    this._draw();
  }

  // =======================================================================
  // Lifecycle
  // =======================================================================

  /** @type {number} Approximate GPU memory held by the chain, in bytes. */
  get memoryBytes() {
    let bytes = 0;
    if (this.sceneTarget) bytes += this.sceneTarget.memoryBytes;
    if (this.ldrTarget) bytes += this.ldrTarget.memoryBytes;
    if (this.aoTarget) bytes += this.aoTarget.memoryBytes;
    if (this.aoBlurTarget) bytes += this.aoBlurTarget.memoryBytes;
    for (let i = 0, n = this.bloomTargets.length; i < n; i++) bytes += this.bloomTargets[i].memoryBytes;
    if (this.noiseTexture) bytes += this.noiseTexture.memoryBytes;
    return bytes;
  }

  /** Releases every GL resource owned by the chain. */
  dispose() {
    const state = this.state;

    this._disposeBloomTargets();
    this._disposeSSAOTargets();

    if (this.ldrTarget) {
      this.ldrTarget.dispose(state);
      this.ldrTarget = null;
    }
    if (this.sceneTarget) {
      this.sceneTarget.dispose(state);
      this.sceneTarget = null;
    }
    if (this.noiseTexture) {
      this.noiseTexture.dispose(state);
      this.noiseTexture = null;
    }
    if (this._quadVAO) {
      this._quadVAO.dispose(state);
      this._quadVAO = null;
    }
    if (this._quadBuffer) {
      this._quadBuffer.dispose(state);
      this._quadBuffer = null;
    }

    const programs = this._programs;
    for (const key in programs) programs[key] = null;

    // Programs live in the ShaderLib and are shared; only dispose the library
    // when this instance created it.
    if (this._ownsShaderLib && this.shaderLib) this.shaderLib.dispose();
    this.shaderLib = null;
  }
}
