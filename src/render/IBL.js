/**
 * Image based lighting: everything the `ibl` GLSL chunk consumes is generated
 * here, entirely on the GPU, once.
 *
 * Products (the units are the ones fixed by the architecture contract):
 *   unit 11  irradianceMap   samplerCube 32^2, cosine convolved, stores E / PI
 *   unit 12  prefilteredMap  samplerCube 128^2 with 6 mips, GGX prefiltered
 *   unit 13  brdfLUT         sampler2D 256^2 RG16F, split sum DFG term
 *   plus     uIBLParams      (intensity, maxMipLevel, horizonOcclusion, 0)
 *
 * Sources:
 *   `fromProceduralSky(params)`  renders an analytic sky into a 256^2 cube
 *   `fromEquirectangular(tex)`   projects a panorama into a 256^2 cube
 *   `fromCubeTexture(cube)`      uses an existing cube map as is
 *
 * Every pass draws one full screen triangle into one face (and mip) of a cube
 * map; the fragment direction is rebuilt from the per face basis matrix, which
 * follows the OpenGL cube map face table exactly.
 */

import { Texture } from './Texture.js';
import { GLBuffer } from './Buffer.js';
import { VertexArray } from './VertexArray.js';
import { StateCache, getStateCache } from './StateCache.js';
import { ShaderLib } from './ShaderLib.js';
import { registerIBLShaders } from './shaders/ibl.js';
import { Logger } from '../core/Logger.js';

const GL_FRAMEBUFFER = 0x8d40;
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_TEXTURE_2D = 0x0de1;
const GL_TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;
const GL_FRAMEBUFFER_COMPLETE = 0x8cd5;
const GL_TRIANGLES = 0x0004;
const GL_FLOAT = 0x1406;

/** Texture units the `ibl` chunk samples from. */
export const IBL_TEXTURE_UNITS = Object.freeze({
  IRRADIANCE: 11,
  PREFILTERED: 12,
  BRDF_LUT: 13
});

/** Geometry of the full screen triangle: clip position (xyz) + uv, interleaved. */
const FULLSCREEN_TRIANGLE = new Float32Array([
  -1, -1, 0, 0, 0,
  3, -1, 0, 2, 0,
  -1, 3, 0, 0, 2
]);

/**
 * Per face basis, columns are (right, up, forward) so that
 * `direction = basis * vec3(s, t, 1)` reproduces the OpenGL face table:
 *   +X (1,-t,-s)  -X (-1,-t,s)  +Y (s,1,t)  -Y (s,-1,-t)  +Z (s,-t,1)  -Z (-s,-t,-1)
 * @type {Float32Array[]}
 */
const CUBE_FACE_BASIS = [
  new Float32Array([0, 0, -1, 0, -1, 0, 1, 0, 0]),   // +X
  new Float32Array([0, 0, 1, 0, -1, 0, -1, 0, 0]),   // -X
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 1, 0]),     // +Y
  new Float32Array([1, 0, 0, 0, 0, -1, 0, -1, 0]),   // -Y
  new Float32Array([1, 0, 0, 0, -1, 0, 0, 0, 1]),    // +Z
  new Float32Array([-1, 0, 0, 0, -1, 0, 0, 0, -1])   // -Z
];

// --- module scope scratch ----------------------------------------------------
const _sunDirection = new Float32Array(3);
const _skyParams = new Float32Array(4);
const _skyParams2 = new Float32Array(4);
const _groundColor = new Float32Array(4);
const _cloudParams = new Float32Array(4);
const _equirectParams = new Float32Array(4);
const _convolveParams = new Float32Array(4);
const _prefilterParams = new Float32Array(4);
const _prefilterParams2 = new Float32Array(2);
const _brdfParams = new Float32Array(2);

/**
 * Reads three components out of a Vec3, an array or a {x,y,z} literal.
 * @param {*} value
 * @param {Float32Array} out
 * @param {number} dx default x
 * @param {number} dy default y
 * @param {number} dz default z
 */
function readXYZ(value, out, dx, dy, dz) {
  if (!value) {
    out[0] = dx; out[1] = dy; out[2] = dz;
    return;
  }
  if (value.x !== undefined) {
    out[0] = value.x; out[1] = value.y; out[2] = value.z;
  } else if (value.r !== undefined) {
    out[0] = value.r; out[1] = value.g; out[2] = value.b;
  } else if (value.length >= 3) {
    out[0] = value[0]; out[1] = value[1]; out[2] = value[2];
  } else {
    out[0] = dx; out[1] = dy; out[2] = dz;
  }
}

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
  constructor(gl, renderer = null, options = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} */
    this.renderer = renderer || null;

    /** @type {StateCache} */
    this.state = (renderer && renderer.state) || getStateCache(gl) || new StateCache(gl);

    /** @private */
    this._ownsShaderLib = false;
    if (renderer && renderer.shaderLib) {
      /** @type {ShaderLib} */
      this.shaderLib = renderer.shaderLib;
    } else {
      this.shaderLib = new ShaderLib(gl);
      this._ownsShaderLib = true;
    }
    registerIBLShaders(this.shaderLib);

    /** @type {Object|null} */
    this.caps = (renderer && (renderer.caps || renderer.capabilities)) || null;

    /** @type {boolean} True when float color attachments are renderable. */
    this.floatTargets = this._detectFloatSupport();
    /** @type {string} Internal format of the generated cube maps. */
    this.hdrFormat = this.floatTargets ? 'rgba16f' : 'rgba8';
    /** @type {string} Internal format of the BRDF LUT. */
    this.lutFormat = this.floatTargets ? 'rg16f' : 'rgba8';
    if (!this.floatTargets) {
      Logger.warn('IBL: EXT_color_buffer_float ausente, o ambiente sera gerado em rgba8 (sem HDR).');
    }

    /** Generation sizes and sample counts. */
    this.options = {
      irradianceSize: options.irradianceSize || 32,
      prefilterSize: options.prefilterSize || 128,
      prefilterMips: options.prefilterMips || 6,
      brdfSize: options.brdfSize || 256,
      skySize: options.skySize || 256,
      equirectSize: options.equirectSize || 256,
      irradianceSamples: options.irradianceSamples || 512,
      prefilterBaseSamples: options.prefilterBaseSamples || 64,
      prefilterMaxSamples: options.prefilterMaxSamples || 256,
      brdfSamples: options.brdfSamples || 1024
    };

    /** @type {Texture|null} Diffuse irradiance cube (stores E / PI). */
    this.irradianceMap = null;
    /** @type {Texture|null} GGX prefiltered radiance cube. */
    this.prefilteredMap = null;
    /** @type {Texture|null} Split sum DFG LUT. */
    this.brdfLUT = null;
    /** @type {Texture|null} Environment the maps were generated from. */
    this.sourceCube = null;

    /** @type {number} Highest valid mip of `prefilteredMap`. */
    this.maxMipLevel = Math.max(0, this.options.prefilterMips - 1);
    /** @type {number} Global multiplier applied to every environment lookup. */
    this.intensity = options.intensity !== undefined ? options.intensity : 1.0;
    /** @type {number} Strength of the geometric horizon fade (0..1). */
    this.horizonOcclusion = options.horizonOcclusion !== undefined ? options.horizonOcclusion : 1.0;
    /** @type {boolean} True once the three maps are valid. */
    this.ready = false;

    /** @type {Float32Array} Value of `uIBLParams` for the shading pass. */
    this.params = new Float32Array(4);
    this.updateParams();

    /** @private True when `sourceCube` was created here and must be disposed. */
    this._ownsSource = false;
    /** @private */
    this._brdfReady = false;
    /** @private */
    this._fbo = null;
    /** @private @type {Int32Array|null} Viewport saved across a generation. */
    this._savedViewport = null;
    /** @private */
    this._quadBuffer = null;
    /** @private */
    this._quadVAO = null;

    this._buildQuad();
  }

  /**
   * @returns {boolean}
   * @private
   */
  _detectFloatSupport() {
    if (this.caps && typeof this.caps.colorBufferFloat === 'boolean') return this.caps.colorBufferFloat;
    const gl = this.gl;
    if (typeof gl.getExtension !== 'function') return false;
    return !!gl.getExtension('EXT_color_buffer_float');
  }

  /**
   * Creates the shared full screen triangle used by every generation pass.
   * @private
   */
  _buildQuad() {
    const gl = this.gl;
    this._quadBuffer = new GLBuffer(gl, 'array', 'static');
    this._quadBuffer.setData(FULLSCREEN_TRIANGLE, this.state);

    this._quadVAO = new VertexArray(gl, this.state);
    this._quadVAO.setAttribute(0, this._quadBuffer, 3, GL_FLOAT, false, 20, 0, 0, false);
    this._quadVAO.setAttribute(2, this._quadBuffer, 2, GL_FLOAT, false, 20, 12, 0, false);
    this.state.bindVAO(null);
  }

  // =======================================================================
  // Sources
  // =======================================================================

  /**
   * Uses an existing cube map as the environment and regenerates every product.
   * The texture is not taken ownership of and is never disposed by this class.
   * @param {Texture} cube
   * @returns {IBL} this
   */
  fromCubeTexture(cube) {
    if (!cube || !cube.isCube) {
      throw new Error('IBL.fromCubeTexture: uma Texture com target "cube" e obrigatoria.');
    }
    this._setSource(cube, false);
    return this.generate();
  }

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
  fromProceduralSky(params = {}) {
    const size = Math.max(8, (params.size || this.options.skySize) | 0);
    const program = this.shaderLib.get('ibl_sky', null);
    if (!program.isLinked()) {
      Logger.error('IBL.fromProceduralSky: o shader "ibl_sky" nao compilou.');
      return this;
    }

    readXYZ(params.sunDirection, _sunDirection, 0.3, 0.5, -0.8);
    const len = Math.hypot(_sunDirection[0], _sunDirection[1], _sunDirection[2]) || 1;
    _sunDirection[0] /= len;
    _sunDirection[1] /= len;
    _sunDirection[2] /= len;

    _skyParams[0] = params.turbidity !== undefined ? params.turbidity : 3.0;
    _skyParams[1] = params.rayleigh !== undefined ? params.rayleigh : 2.0;
    _skyParams[2] = params.mieCoefficient !== undefined ? params.mieCoefficient : 0.005;
    _skyParams[3] = params.mieDirectionalG !== undefined ? params.mieDirectionalG : 0.8;

    _skyParams2[0] = params.luminance !== undefined ? params.luminance : 1.0;
    _skyParams2[1] = params.sunDiskIntensity !== undefined ? params.sunDiskIntensity : 1.0;
    _skyParams2[2] = params.maxRadiance !== undefined ? params.maxRadiance : 500.0;
    _skyParams2[3] = params.horizonBlend !== undefined ? params.horizonBlend : 0.03;

    readXYZ(params.groundColor, _groundColor, 0.12, 0.11, 0.1);
    _groundColor[3] = params.groundAlbedo !== undefined ? params.groundAlbedo : 1.0;

    _cloudParams[0] = params.cloudCoverage !== undefined ? params.cloudCoverage : 0.0;
    _cloudParams[1] = params.cloudScale !== undefined ? params.cloudScale : 2.0;
    _cloudParams[2] = params.cloudFade !== undefined ? params.cloudFade : 0.15;
    _cloudParams[3] = params.cloudTime !== undefined ? params.cloudTime : 0.0;

    const cube = this._createCube(size, true, 'ibl.sky');

    this._beginPasses();
    program.use(this.state);
    program.setUniform('uSunDirection', _sunDirection);
    program.setUniform('uSkyParams', _skyParams);
    program.setUniform('uSkyParams2', _skyParams2);
    program.setUniform('uGroundColor', _groundColor);
    program.setUniform('uCloudParams', _cloudParams);

    for (let face = 0; face < 6; face++) {
      this._bindCubeFace(cube, face, 0, size);
      program.setUniform('uCubeBasis', CUBE_FACE_BASIS[face]);
      this._draw();
    }
    this._endPasses();

    cube.generateMipmaps();
    this._setSource(cube, true);
    return this.generate();
  }

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
  fromEquirectangular(texture, params = {}) {
    if (!texture) {
      throw new Error('IBL.fromEquirectangular: uma Texture 2D e obrigatoria.');
    }
    const size = Math.max(8, (params.size || this.options.equirectSize) | 0);
    const program = this.shaderLib.get('ibl_equirect_to_cube', null);
    if (!program.isLinked()) {
      Logger.error('IBL.fromEquirectangular: o shader "ibl_equirect_to_cube" nao compilou.');
      return this;
    }

    _equirectParams[0] = params.flipV ? 1.0 : 0.0;
    _equirectParams[1] = params.rotation || 0.0;
    _equirectParams[2] = params.intensity !== undefined ? params.intensity : 1.0;
    _equirectParams[3] = params.srgb ? 1.0 : 0.0;

    const cube = this._createCube(size, true, 'ibl.equirect');

    this._beginPasses();
    program.use(this.state);
    program.setTexture('uEquirectMap', texture, 0, this.state);
    program.setUniform('uEquirectParams', _equirectParams);

    for (let face = 0; face < 6; face++) {
      this._bindCubeFace(cube, face, 0, size);
      program.setUniform('uCubeBasis', CUBE_FACE_BASIS[face]);
      this._draw();
    }
    this._endPasses();

    cube.generateMipmaps();
    this._setSource(cube, true);
    return this.generate();
  }

  /**
   * Replaces the environment source.
   * @param {Texture} cube
   * @param {boolean} owned
   * @private
   */
  _setSource(cube, owned) {
    if (this.sourceCube && this.sourceCube !== cube && this._ownsSource) {
      this.sourceCube.dispose(this.state);
    }
    this.sourceCube = cube;
    this._ownsSource = owned;
  }

  // =======================================================================
  // Generation
  // =======================================================================

  /**
   * Regenerates irradiance, prefiltered radiance and (once) the BRDF LUT from the
   * current source cube.
   * @returns {IBL} this
   */
  generate() {
    if (!this.sourceCube) {
      throw new Error('IBL.generate: nenhum ambiente definido (use fromCubeTexture/fromProceduralSky/fromEquirectangular).');
    }
    this._ensureOutputs();

    this._beginPasses();
    this._generateIrradiance();
    this._generatePrefiltered();
    if (!this._brdfReady) this._generateBRDF();
    this._endPasses();

    this.updateParams();
    this.ready = true;
    return this;
  }

  /**
   * Generates only the BRDF LUT, which does not depend on the environment.
   * @returns {IBL} this
   */
  generateBRDFLUT() {
    this._ensureBRDF();
    this._beginPasses();
    this._generateBRDF();
    this._endPasses();
    return this;
  }

  /**
   * Creates the output textures the first time they are needed.
   * @private
   */
  _ensureOutputs() {
    if (!this.irradianceMap) {
      this.irradianceMap = this._createCube(this.options.irradianceSize, false, 'ibl.irradiance');
    }
    if (!this.prefilteredMap) {
      const mips = Math.max(1, Math.min(
        this.options.prefilterMips,
        Math.floor(Math.log2(this.options.prefilterSize)) + 1
      ));
      this.prefilteredMap = new Texture(this.gl, {
        target: 'cube',
        width: this.options.prefilterSize,
        height: this.options.prefilterSize,
        internalFormat: this.hdrFormat,
        minFilter: 'linear-mipmap-linear',
        magFilter: 'linear',
        wrapS: 'clamp',
        wrapT: 'clamp',
        levels: mips,
        generateMipmaps: false,
        state: this.state,
        name: 'ibl.prefiltered'
      });
      this.maxMipLevel = mips - 1;
    }
    this._ensureBRDF();
  }

  /** @private */
  _ensureBRDF() {
    if (this.brdfLUT) return;
    this.brdfLUT = new Texture(this.gl, {
      target: '2d',
      width: this.options.brdfSize,
      height: this.options.brdfSize,
      internalFormat: this.lutFormat,
      minFilter: 'linear',
      magFilter: 'linear',
      wrapS: 'clamp',
      wrapT: 'clamp',
      generateMipmaps: false,
      state: this.state,
      name: 'ibl.brdfLUT'
    });
  }

  /**
   * Creates a cube map in the environment format.
   * @param {number} size
   * @param {boolean} mipmaps
   * @param {string} name
   * @returns {Texture}
   * @private
   */
  _createCube(size, mipmaps, name) {
    return new Texture(this.gl, {
      target: 'cube',
      width: size,
      height: size,
      internalFormat: this.hdrFormat,
      minFilter: mipmaps ? 'linear-mipmap-linear' : 'linear',
      magFilter: 'linear',
      wrapS: 'clamp',
      wrapT: 'clamp',
      generateMipmaps: mipmaps,
      state: this.state,
      name
    });
  }

  /**
   * Diffuse irradiance: cosine importance sampling of the source cube, read from
   * a low mip so a few hundred samples are already noise free.
   * @private
   */
  _generateIrradiance() {
    const program = this.shaderLib.get('ibl_irradiance', null);
    if (!program.use(this.state)) return;

    const size = this.irradianceMap.width;
    const sourceMaxLod = this._sourceMaxLod();
    // Aim at a ~32 texel effective resolution: high frequency detail is
    // irrelevant for a cosine lobe and only adds variance.
    const lod = Math.max(0, Math.min(sourceMaxLod, Math.log2(Math.max(this.sourceCube.width, 1) / 32)));

    _convolveParams[0] = this.options.irradianceSamples;
    _convolveParams[1] = lod;
    _convolveParams[2] = 1.0;
    _convolveParams[3] = 0.0;

    program.setTexture('uEnvMap', this.sourceCube, 0, this.state);
    program.setUniform('uConvolveParams', _convolveParams);

    for (let face = 0; face < 6; face++) {
      this._bindCubeFace(this.irradianceMap, face, 0, size);
      program.setUniform('uCubeBasis', CUBE_FACE_BASIS[face]);
      this._draw();
    }
  }

  /**
   * Specular radiance: one GGX integration per (face, mip). The sample count
   * grows with roughness and every fetch picks a source mip from the sample solid
   * angle, which is what keeps the rough levels clean.
   * @private
   */
  _generatePrefiltered() {
    const program = this.shaderLib.get('ibl_prefilter', null);
    if (!program.use(this.state)) return;

    const mips = this.maxMipLevel + 1;
    const sourceSize = this.sourceCube.width;
    const sourceMaxLod = this._sourceMaxLod();

    program.setTexture('uEnvMap', this.sourceCube, 0, this.state);

    for (let mip = 0; mip < mips; mip++) {
      const size = Math.max(1, this.prefilteredMap.width >> mip);
      const roughness = mips > 1 ? mip / (mips - 1) : 0.0;

      let samples = this.options.prefilterBaseSamples;
      for (let i = 1; i < mip; i++) samples *= 2;
      if (samples > this.options.prefilterMaxSamples) samples = this.options.prefilterMaxSamples;

      _prefilterParams[0] = roughness;
      _prefilterParams[1] = samples;
      _prefilterParams[2] = sourceSize;
      _prefilterParams[3] = sourceMaxLod;
      // Mirror level: sample the source mip whose resolution matches this face.
      _prefilterParams2[0] = Math.max(0, Math.min(sourceMaxLod, Math.log2(Math.max(sourceSize / size, 1))));
      _prefilterParams2[1] = 1.0;

      program.setUniform('uPrefilterParams', _prefilterParams);
      program.setUniform('uPrefilterParams2', _prefilterParams2);

      for (let face = 0; face < 6; face++) {
        this._bindCubeFace(this.prefilteredMap, face, mip, size);
        program.setUniform('uCubeBasis', CUBE_FACE_BASIS[face]);
        this._draw();
      }
    }
  }

  /**
   * Split sum DFG term. Environment independent, so it is only ever built once.
   * @private
   */
  _generateBRDF() {
    const program = this.shaderLib.get('ibl_brdf', null);
    if (!program.use(this.state)) return;

    _brdfParams[0] = this.options.brdfSamples;
    _brdfParams[1] = 0.0;
    program.setUniform('uBRDFParams', _brdfParams);

    this._bindTexture2D(this.brdfLUT);
    this._draw();
    this._brdfReady = true;
  }

  /**
   * Highest mip index available on the source cube.
   * @returns {number}
   * @private
   */
  _sourceMaxLod() {
    const levels = this.sourceCube && this.sourceCube.levels ? this.sourceCube.levels : 1;
    return Math.max(0, levels - 1);
  }

  // =======================================================================
  // Pass plumbing
  // =======================================================================

  /**
   * Sets the render state every generation pass needs and binds the triangle.
   * @private
   */
  _beginPasses() {
    const state = this.state;
    if (!this._fbo) this._fbo = this.gl.createFramebuffer();

    // Generation happens outside of the frame loop and repoints the viewport at
    // every face, so the caller's viewport is saved and put back afterwards.
    this._savedViewport = this.gl.getParameter(this.gl.VIEWPORT);

    state.setScissorTest(false);
    state.setDepthTest(false);
    state.setDepthWrite(false);
    state.setCullFace('none');
    state.setBlending('none');
    state.setColorMask(true, true, true, true);
    state.setPolygonOffset(false, 0, 0);
    this._quadVAO.bind(state);
  }

  /**
   * Restores a sane state for the frame that follows the generation.
   * @private
   */
  _endPasses() {
    const state = this.state;
    state.bindFramebuffer(GL_FRAMEBUFFER, null);
    state.bindVAO(null);
    state.setDepthTest(true);
    state.setDepthWrite(true);

    const saved = this._savedViewport;
    if (saved && saved.length === 4) {
      state.viewport(saved[0] | 0, saved[1] | 0, saved[2] | 0, saved[3] | 0);
    }
    this._savedViewport = null;
  }

  /**
   * Attaches one cube face (and mip) of a texture as the color target.
   * @param {Texture} texture
   * @param {number} face 0..5
   * @param {number} level
   * @param {number} size Face size at this level.
   * @private
   */
  _bindCubeFace(texture, face, level, size) {
    const gl = this.gl;
    this.state.bindFramebuffer(GL_FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(
      GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
      GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, texture.id, level
    );
    this.state.viewport(0, 0, size, size);
    this._checkFramebuffer(texture.name + ' face ' + face + ' mip ' + level);
  }

  /**
   * Attaches a 2D texture as the color target.
   * @param {Texture} texture
   * @private
   */
  _bindTexture2D(texture) {
    const gl = this.gl;
    this.state.bindFramebuffer(GL_FRAMEBUFFER, this._fbo);
    gl.framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture.id, 0);
    this.state.viewport(0, 0, texture.width, texture.height);
    this._checkFramebuffer(texture.name);
  }

  /**
   * Validates the generation framebuffer once per unique failure.
   * @param {string} label
   * @private
   */
  _checkFramebuffer(label) {
    const status = this.gl.checkFramebufferStatus(GL_FRAMEBUFFER);
    if (status === GL_FRAMEBUFFER_COMPLETE) return;
    Logger.error('IBL: framebuffer incompleto ao renderizar "' + label +
      '" (status 0x' + status.toString(16) + '). Formato: ' + this.hdrFormat + '.');
  }

  /**
   * Draws the full screen triangle.
   * @private
   */
  _draw() {
    this.state.drawArrays(GL_TRIANGLES, 0, 3);
  }

  // =======================================================================
  // Consumption
  // =======================================================================

  /**
   * Refreshes `params`, the value of the `uIBLParams` uniform.
   * @returns {Float32Array} the same array
   */
  updateParams() {
    this.params[0] = this.intensity;
    this.params[1] = this.maxMipLevel;
    this.params[2] = this.horizonOcclusion;
    this.params[3] = 0.0;
    return this.params;
  }

  /**
   * Binds the three maps to their fixed units and uploads `uIBLParams`.
   * Safe to call on a program that does not use IBL: unknown uniforms are
   * silently ignored.
   * @param {StateCache} state
   * @param {Object} program Program instance.
   * @returns {boolean} true when the environment was bound
   */
  bind(state, program) {
    if (!this.ready || !program) return false;
    const st = state || this.state;
    program.setTexture('uIrradianceMap', this.irradianceMap, IBL_TEXTURE_UNITS.IRRADIANCE, st);
    program.setTexture('uPrefilteredMap', this.prefilteredMap, IBL_TEXTURE_UNITS.PREFILTERED, st);
    program.setTexture('uBRDFLUT', this.brdfLUT, IBL_TEXTURE_UNITS.BRDF_LUT, st);
    program.setUniform('uIBLParams', this.updateParams());
    return true;
  }

  /**
   * @param {number} value Global environment multiplier.
   * @returns {IBL} this
   */
  setIntensity(value) {
    this.intensity = value;
    this.updateParams();
    return this;
  }

  /** @type {number} Approximate GPU memory held by the environment, in bytes. */
  get memoryBytes() {
    let bytes = 0;
    if (this.irradianceMap) bytes += this.irradianceMap.memoryBytes;
    if (this.prefilteredMap) bytes += this.prefilteredMap.memoryBytes;
    if (this.brdfLUT) bytes += this.brdfLUT.memoryBytes;
    if (this.sourceCube && this._ownsSource) bytes += this.sourceCube.memoryBytes;
    return bytes;
  }

  /** Releases every GL resource owned by this instance. */
  dispose() {
    const state = this.state;

    if (this.irradianceMap) {
      this.irradianceMap.dispose(state);
      this.irradianceMap = null;
    }
    if (this.prefilteredMap) {
      this.prefilteredMap.dispose(state);
      this.prefilteredMap = null;
    }
    if (this.brdfLUT) {
      this.brdfLUT.dispose(state);
      this.brdfLUT = null;
    }
    if (this.sourceCube && this._ownsSource) {
      this.sourceCube.dispose(state);
    }
    this.sourceCube = null;
    this._ownsSource = false;
    this._brdfReady = false;
    this.ready = false;

    if (this._fbo) {
      state.invalidateFramebuffer(this._fbo);
      this.gl.deleteFramebuffer(this._fbo);
      this._fbo = null;
    }
    if (this._quadVAO) {
      this._quadVAO.dispose(state);
      this._quadVAO = null;
    }
    if (this._quadBuffer) {
      this._quadBuffer.dispose(state);
      this._quadBuffer = null;
    }

    if (this._ownsShaderLib && this.shaderLib) this.shaderLib.dispose();
    this.shaderLib = null;
  }
}
