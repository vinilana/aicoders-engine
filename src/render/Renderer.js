/**
 * Renderer - the frame pipeline.
 *
 * One frame, in order:
 *   1. scene.updateMatrices() + scene.updateBVH(), camera view/frustum refresh
 *   2. LOD selection, broadphase culling (DynamicBVH, linear fallback), layer and
 *      visibility filtering
 *   3. light collection and clustered assignment
 *   4. cascaded shadow maps
 *   5. uniform block upload (Camera / Lights / Shadows / Fog)
 *   6. optional depth prepass (colour masked, main pass then runs depthFunc EQUAL)
 *   7. opaque front to back, skybox, transparent back to front
 *   8. post processing chain to the screen
 *
 * Hot path rules honoured here: no allocation per frame or per draw, every GL
 * state change goes through the StateCache, every permutation lookup is cached on
 * the Material, and the sort keys are precomputed uint32 values.
 *
 * Optional subsystems (shadows, clustered lighting, post processing, IBL) are
 * constructed defensively: when one of them is disabled by the options - or fails
 * to build on a limited driver - the corresponding step is skipped and the frame
 * still renders.
 */

import { StateCache, getStateCache } from './StateCache.js';
import { ShaderLib } from './ShaderLib.js';
import { UniformBuffers } from './UniformBuffers.js';
import { RenderList } from './RenderList.js';
import { RenderTarget } from './RenderTarget.js';
import { Texture } from './Texture.js';
import { GLBuffer } from './Buffer.js';
import { VertexArray } from './VertexArray.js';
import { Material } from './Material.js';
import { ATTRIB_NAME_TO_LOC, drawModeToGL, glTypeBytes, GL_TYPE } from './Geometry.js';
import { Mat3 } from '../math/Mat3.js';
import { Logger } from '../core/Logger.js';
import { createSkyboxCube } from '../geometry/Primitives.js';

import * as ShaderSources from './shaders/index.js';
import { ShadowMapper } from './ShadowMapper.js';
import { ClusteredLighting } from './ClusteredLighting.js';
import { LightManager } from './LightManager.js';
import { PostProcessing } from './PostProcessing.js';
import { IBL } from './IBL.js';

/** GL primitive mode used when a material asks for wireframe. */
const GL_LINES = 0x0001;
/** Element array buffer target. */
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
/** Default framebuffer target. */
const GL_FRAMEBUFFER = 0x8d40;
/** Largest vertex index for which the 53 bit edge key stays exact. */
const MAX_EXACT_EDGE_INDEX = 2097151;

/** Tone mapping name -> the numeric code understood by `chunks/tonemap.glsl.js`. */
const TONEMAP_CODES = {
  none: 0,
  linear: 1,
  reinhard: 2,
  aces: 3,
  'aces-fit': 4,
  acesfit: 4,
  filmic: 4,
  uncharted2: 5,
  agx: 6
};

/** Module scope scratch - never allocate inside the frame. */
const _normalMatrix = new Mat3();
const _iblParams = new Float32Array(4);

/**
 * Reads `performance.now()` when it exists, `Date.now()` otherwise. Resolved
 * inside the call so the module has no environment dependency at import time.
 * @returns {number} milliseconds
 */
function now() {
  const perf = globalThis.performance;
  return (perf !== undefined && perf !== null && typeof perf.now === 'function')
    ? perf.now()
    : Date.now();
}

/**
 * Normalises an exported shader name into a ShaderLib key:
 * `standardShader` / `STANDARD_SHADER` / `StandardShader` all become `standard`.
 * @param {string} name
 * @returns {string}
 */
function shaderKeyFromExport(name) {
  let key = name.replace(/[_-]?(shaders?|programs?|source)$/i, '');
  if (key.length === 0) key = name;
  if (/^[A-Z0-9_]+$/.test(key)) return key.toLowerCase().replace(/_/g, '-');
  return key.charAt(0).toLowerCase() + key.slice(1);
}

/**
 * Is this value a `{vertex, fragment}` shader source pair?
 * @param {*} value
 * @returns {boolean}
 */
function isShaderPair(value) {
  return value !== null && typeof value === 'object' &&
    typeof value.vertex === 'string' && typeof value.fragment === 'string';
}

/**
 * Walks up the parent chain looking for a hidden ancestor. LOD levels rely on
 * this: the LOD node flips `visible` on its level roots, and the meshes below
 * them must disappear even though the broadphase still reports them.
 * @param {Object} node
 * @returns {boolean}
 */
function isBranchVisible(node) {
  let current = node;
  while (current !== null && current !== undefined) {
    if (current.visible === false) return false;
    current = current.parent;
  }
  return true;
}

export class Renderer {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object|null} [caps] Capabilities from `createGLContext`.
   * @param {Object} [options]
   * @param {boolean} [options.shadows=true]
   * @param {boolean} [options.clustered=true]
   * @param {boolean} [options.hdr=true]
   * @param {boolean} [options.postprocessing=true]
   * @param {number}  [options.msaa=0] Sample count of the HDR target.
   * @param {string}  [options.toneMapping='aces']
   * @param {number}  [options.exposure=1]
   * @param {number}  [options.shadowMapSize=2048]
   * @param {number}  [options.cascades=4]
   * @param {number}  [options.maxLights=1024]
   * @param {number}  [options.pixelRatio=1]
   * @param {boolean} [options.depthPrepass=false]
   * @param {boolean} [options.sortObjects=true]
   * @param {boolean} [options.autoClear=true]
   * @param {Object}  [options.shaders] Extra shader sources, or a registration function.
   */
  constructor(gl, caps, options) {
    // Tolerate `new Renderer(gl, options)`: capabilities always expose
    // maxTextureSize, an options bag never does.
    let capabilities = caps || null;
    let opts = options || {};
    if (capabilities !== null && capabilities.maxTextureSize === undefined) {
      if (options === undefined) opts = capabilities;
      capabilities = null;
    }

    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} */
    this.caps = capabilities;
    /** @type {Object} Frozen copy of the construction options. */
    this.options = opts;

    /** @type {StateCache} Every GL state change funnels through this. */
    this.state = getStateCache(gl) || new StateCache(gl);
    /** @type {ShaderLib} */
    this.shaderLib = new ShaderLib(gl);
    /** @type {UniformBuffers} */
    this.ubo = new UniformBuffers(gl, this.state);
    /** @type {RenderList} */
    this.renderList = new RenderList();

    // --- configuration ---------------------------------------------------
    /** @type {boolean} */
    this.shadowsEnabled = opts.shadows !== false;
    /** @type {boolean} */
    this.clusteredEnabled = opts.clustered !== false;
    /** @type {boolean} */
    this.hdrEnabled = opts.hdr !== false;
    /** @type {boolean} */
    this.postEnabled = opts.postprocessing !== false;
    /** @type {number} */
    this.msaa = opts.msaa !== undefined ? (opts.msaa | 0) : 0;
    /** @type {string} */
    this.toneMapping = opts.toneMapping !== undefined ? opts.toneMapping : 'aces';
    /** @type {number} */
    this.exposure = opts.exposure !== undefined ? opts.exposure : 1;
    /** @type {number} */
    this.shadowMapSize = opts.shadowMapSize !== undefined ? (opts.shadowMapSize | 0) : 2048;
    /** @type {number} */
    this.cascades = opts.cascades !== undefined ? Math.max(1, Math.min(4, opts.cascades | 0)) : 4;
    /** @type {number} */
    this.maxLights = opts.maxLights !== undefined ? (opts.maxLights | 0) : 1024;
    /** @type {boolean} Depth prepass, worth it on heavy overdraw scenes. */
    this.depthPrepass = opts.depthPrepass === true;
    /** @type {boolean} */
    this.sortObjects = opts.sortObjects !== false;
    /** @type {boolean} */
    this.autoClear = opts.autoClear !== false;
    /** @type {number} Cluster grid dimensions. */
    this.clusterX = opts.clusterX !== undefined ? (opts.clusterX | 0) : 16;
    this.clusterY = opts.clusterY !== undefined ? (opts.clusterY | 0) : 9;
    this.clusterZ = opts.clusterZ !== undefined ? (opts.clusterZ | 0) : 24;

    /** @type {number} CSS width. */
    this.width = 1;
    /** @type {number} CSS height. */
    this.height = 1;
    /** @type {number} */
    this.pixelRatio = opts.pixelRatio > 0 ? opts.pixelRatio : 1;
    /** @type {number} Drawing buffer width in device pixels. */
    this.drawingBufferWidth = 1;
    /** @type {number} */
    this.drawingBufferHeight = 1;

    /** @private Clear colour, linear. */
    this._clearR = 0;
    this._clearG = 0;
    this._clearB = 0;
    this._clearA = 1;

    /** @private Numeric tone mapping code pushed to the object shaders. */
    this._toneMappingCode = TONEMAP_CODES[this.toneMapping] !== undefined
      ? TONEMAP_CODES[this.toneMapping] : 3;

    /**
     * Per frame statistics. Read by Stats and by the demo overlay.
     * `textures` counts the texture binds issued this frame and `geometries` the
     * draw items queued: the engine has no live registry of either resource, and
     * a per frame number is the useful one for a profiler anyway.
     */
    this.info = {
      frame: 0,
      calls: 0,
      drawCalls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      programs: 0,
      textures: 0,
      geometries: 0,
      gpuTimeMs: 0,
      cullTimeMs: 0,
      cpuTimeMs: 0,
      visibleMeshes: 0,
      culledMeshes: 0,
      shadowDrawCalls: 0,
      memoryBytes: 0,
      memory: { buffers: 0, textures: 0 }
    };

    // --- shader sources ---------------------------------------------------
    this._registerBuiltinShaders();
    if (opts.shaders) this.registerShaders(opts.shaders);

    // --- optional subsystems ---------------------------------------------
    /** @type {Object|null} */
    this.lightManager = this._build('LightManager', () => new LightManager(this));
    /** @type {Object|null} */
    this.shadowMapper = this.shadowsEnabled
      ? this._build('ShadowMapper', () => new ShadowMapper(gl, this, {
        mapSize: this.shadowMapSize,
        size: this.shadowMapSize,
        cascades: this.cascades,
        lambda: opts.shadowLambda !== undefined ? opts.shadowLambda : 0.6,
        softness: opts.shadowSoftness !== undefined ? opts.shadowSoftness : 1,
        state: this.state
      }))
      : null;
    /** @type {Object|null} */
    this.clustered = this.clusteredEnabled
      ? this._build('ClusteredLighting', () => new ClusteredLighting(gl, {
        x: this.clusterX,
        y: this.clusterY,
        z: this.clusterZ,
        clusterX: this.clusterX,
        clusterY: this.clusterY,
        clusterZ: this.clusterZ,
        maxLights: this.maxLights,
        state: this.state
      }))
      : null;
    /** @type {Object|null} */
    this.post = (this.postEnabled && this.hdrEnabled)
      ? this._build('PostProcessing', () => new PostProcessing(gl, this, {
        toneMapping: this.toneMapping,
        exposure: this.exposure,
        bloom: opts.bloom !== false,
        fxaa: opts.fxaa !== false,
        ssao: opts.ssao === true,
        state: this.state
      }))
      : null;
    /** @type {Object|null} Environment probe used when the scene has none. */
    this.ibl = null;

    if (this.shadowsEnabled && this.shadowMapper === null) this.shadowsEnabled = false;
    if (this.clusteredEnabled && this.clustered === null) this.clusteredEnabled = false;
    if (this.postEnabled && this.post === null) this.postEnabled = false;

    // --- internal per frame state ----------------------------------------
    /** @private @type {Object[]} Meshes surviving the broadphase. */
    this._visible = [];
    /** @private @type {Object[]} Cached LOD nodes of the current scene. */
    this._lodNodes = [];
    /** @private */
    this._lodScene = null;
    /** @private */
    this._lodMeshCount = -1;
    /** @private @type {Object|null} */
    this._activeIBL = null;
    /** @private @type {Object|null} */
    this._shadowTexture = null;
    /** @private @type {boolean} Clustered permutation compiled in / textures bound. */
    this._clusterActive = false;
    /**
     * @private @type {boolean} Whether the froxel grid built this frame is usable.
     * `ClusteredLighting.update()` returns false when it cannot build the grid
     * (non perspective camera): the grid is zeroed and the shader is expected to
     * fall back to the flat punctual loop, which only happens when the
     * `clusterEnabled` flag of the Lights block is 0.
     */
    this._clusterReady = false;
    /** @private Program whose renderer owned samplers are already bound. */
    this._globalsProgram = null;
    /** @private */
    this._lastMaterial = null;
    /** @private */
    this._lastMaterialProgram = null;
    /** @private */
    this._lastMaterialVersion = -1;
    /** @private Geometry of the previous draw, used to skip a redundant upload. */
    this._lastGeometry = null;
    /** @private VAO handle that goes with `_lastGeometry`. */
    this._lastVAO = null;
    /** @private Depth function forced by the depth prepass, null when free. */
    this._depthFuncOverride = null;
    /** @private */
    this._depthWriteOverride = null;
    /** @private @type {RenderTarget|null} */
    this._hdrTarget = null;
    /** @private @type {RenderTarget|null} Target the frame is being drawn into. */
    this._currentTarget = null;
    /** @private @type {Map<number, Object>} geometry id -> wireframe VAO record */
    this._wireframeCache = new Map();
    /** @private @type {Map<Object, number>} skeleton -> frame of its last upload */
    this._boneUploadFrame = new Map();
    /** @private @type {Object|null} lazily built skybox geometry */
    this._skyGeometry = null;
    /** @private @type {Material|null} lazily built material for a cube background */
    this._skyMaterial = null;
    /** @private Model matrix of the skybox draw, rebuilt in place every frame. */
    this._skyMatrix = new Float32Array(16);
    /** @private Callback reused by every LOD rescan (never created per frame). */
    this._collectLOD = (node) => {
      if (node.isLOD === true || (node.levels !== undefined && typeof node.addLevel === 'function')) {
        this._lodNodes.push(node);
      }
    };
    /** @private @type {Set<string>} shader names already reported as missing */
    this._missingShaders = new Set();
    /**
     * Defines object -> Program, for the material's own shader.
     * `Material.getDefines` returns a cached object whose identity is stable for
     * a given (material, permutation) pair, which makes it a perfect key: it
     * turns the per draw program lookup into one WeakMap hit and keeps
     * `ShaderLib.get` - which builds a key string - out of the frame loop.
     * @private @type {WeakMap<Object, Object>}
     */
    this._programCache = new WeakMap();
    /**
     * shaderName -> (defines object -> Program), for the depth and shadow passes
     * which reuse the material defines under a different shader name.
     * @private @type {Map<string, WeakMap<Object, Object>>}
     */
    this._namedProgramCaches = new Map();
    /** @private */
    this._fallbackDirLights = [];
    /** @private */
    this._fallbackPunctualLights = [];
    /** @private */
    this._fallbackLights = {
      dirLights: this._fallbackDirLights,
      punctualLights: this._fallbackPunctualLights,
      visibleCount: 0
    };

    /**
     * Shared permutation context handed to `Material.getDefines`. It is mutated
     * once per frame and read many times, never copied.
     * @private
     */
    this._ctx = {
      shadows: false,
      shadowCascades: this.cascades,
      clustered: false,
      clusterX: this.clusterX,
      clusterY: this.clusterY,
      clusterZ: this.clusterZ,
      ibl: false,
      fog: false,
      toneMapping: false,
      motionVectors: false,
      depthOnly: false,
      instancing: false,
      instanceColor: false,
      skinning: false,
      maxDirLights: 4,
      maxPunctualLights: Math.max(1, Math.min(4096, this.maxLights))
    };
    /** @private Permutation context of the depth only passes. */
    this._depthCtx = {
      shadows: false,
      shadowCascades: 0,
      clustered: false,
      clusterX: this.clusterX,
      clusterY: this.clusterY,
      clusterZ: this.clusterZ,
      ibl: false,
      fog: false,
      toneMapping: false,
      motionVectors: false,
      depthOnly: true,
      instancing: false,
      instanceColor: false,
      skinning: false,
      maxDirLights: 1,
      maxPunctualLights: 1
    };

    // --- GPU timing -------------------------------------------------------
    /** @private */
    this._timerExt = (capabilities && capabilities.timerQuery) ||
      (typeof gl.getExtension === 'function' ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null) || null;
    /** @private @type {Array<Object|null>} */
    this._timerQueries = [null, null];
    /** @private @type {boolean[]} slot has an un-read result */
    this._timerPending = [false, false];
    /** @private */
    this._timerSlot = 0;
    /** @private */
    this._timerActive = false;

    this.setSize(
      opts.width !== undefined ? opts.width : (gl.canvas && gl.canvas.width ? gl.canvas.width / this.pixelRatio : 1),
      opts.height !== undefined ? opts.height : (gl.canvas && gl.canvas.height ? gl.canvas.height / this.pixelRatio : 1),
      this.pixelRatio
    );
  }

  /* ===================================================================== *
   * Construction helpers                                                   *
   * ===================================================================== */

  /**
   * Builds an optional subsystem, degrading to `null` when it throws. The
   * constructors of these classes touch the driver (targets, textures), which is
   * exactly the kind of thing a limited or software context refuses.
   * @param {string} label
   * @param {Function} factory
   * @returns {Object|null}
   * @private
   */
  _build(label, factory) {
    try {
      const instance = factory();
      return instance === undefined ? null : instance;
    } catch (error) {
      Logger.warn('Renderer: subsistema "' + label + '" indisponivel - ' +
        (error && error.message ? error.message : error));
      return null;
    }
  }

  /**
   * Registers every shader exported by `src/render/shaders/index.js`.
   *
   * The barrel shape is discovered at runtime so the shader author is free to
   * expose `registerAllShaders(shaderLib)`, a `SHADERS` map, or one
   * `{vertex, fragment}` object per shader.
   * @private
   */
  _registerBuiltinShaders() {
    // Construction time, not the hot path: a shader module that throws must
    // degrade to "that program is unavailable", never to a dead renderer. The two
    // steps are guarded independently so a broken entry point still lets the raw
    // `{vertex, fragment}` exports through.
    this._build('shaders/index.js', () => this.registerShaders(ShaderSources));
    this._build('shaders (exports)', () => this._registerShaderPairs(ShaderSources));
    if (this.shaderLib.shaderNames.length === 0) {
      Logger.error('Renderer: nenhum shader foi registrado - verifique src/render/shaders/index.js.');
    }
  }

  /**
   * Adds shader sources to the library.
   * @param {Object|Function} sources A registration function, a `{name: {vertex,
   *        fragment}}` map, or a module namespace exporting either of those.
   * @returns {number} how many shaders are registered afterwards
   */
  registerShaders(sources) {
    if (!sources) return 0;
    const lib = this.shaderLib;

    if (typeof sources === 'function') {
      sources(lib);
      return lib.shaderNames.length;
    }
    if (typeof sources.registerAllShaders === 'function') {
      sources.registerAllShaders(lib);
      return lib.shaderNames.length;
    }
    if (typeof sources.registerShaders === 'function') {
      sources.registerShaders(lib);
      return lib.shaderNames.length;
    }
    return this._registerShaderPairs(sources);
  }

  /**
   * Registers every `{vertex, fragment}` pair reachable from an object: the
   * entries of a `SHADERS` table first, then the module level exports, whose
   * names are normalised (`standardShader` -> `standard`). Names already known to
   * the library are left alone.
   * @param {Object} sources
   * @returns {number} how many shaders are registered afterwards
   * @private
   */
  _registerShaderPairs(sources) {
    const lib = this.shaderLib;
    const table = sources.SHADERS || sources.shaders || null;
    if (table !== null && typeof table === 'object') {
      for (const name in table) {
        if (isShaderPair(table[name]) && !lib.has(name)) lib.register(name, table[name]);
      }
    }
    for (const name in sources) {
      const value = sources[name];
      if (!isShaderPair(value)) continue;
      const key = shaderKeyFromExport(name);
      if (lib.has(key)) continue;
      lib.register(key, value);
    }
    return lib.shaderNames.length;
  }

  /* ===================================================================== *
   * Sizing and viewport                                                    *
   * ===================================================================== */

  /**
   * Sets the CSS size and the device pixel ratio, resizing every owned target.
   * @param {number} width CSS pixels.
   * @param {number} height CSS pixels.
   * @param {number} [pixelRatio]
   * @returns {Renderer} this
   */
  setSize(width, height, pixelRatio) {
    const w = width > 1 ? Math.floor(width) : 1;
    const h = height > 1 ? Math.floor(height) : 1;
    const pr = pixelRatio > 0 ? pixelRatio : this.pixelRatio;

    this.width = w;
    this.height = h;
    this.pixelRatio = pr;
    this.drawingBufferWidth = Math.max(1, Math.round(w * pr));
    this.drawingBufferHeight = Math.max(1, Math.round(h * pr));

    const canvas = this.gl.canvas;
    if (canvas !== undefined && canvas !== null && this.options.autoResizeCanvas !== false) {
      if (canvas.width !== this.drawingBufferWidth) canvas.width = this.drawingBufferWidth;
      if (canvas.height !== this.drawingBufferHeight) canvas.height = this.drawingBufferHeight;
    }

    if (this._hdrTarget !== null) {
      this._hdrTarget.resize(this.drawingBufferWidth, this.drawingBufferHeight);
    }
    if (this.post !== null && typeof this.post.resize === 'function') {
      this.post.resize(this.drawingBufferWidth, this.drawingBufferHeight);
    }
    return this;
  }

  /**
   * Sets the device pixel ratio, keeping the CSS size.
   * @param {number} value
   * @returns {Renderer} this
   */
  setPixelRatio(value) {
    return this.setSize(this.width, this.height, value);
  }

  /**
   * Overrides the viewport (device pixels).
   * @param {number} x @param {number} y @param {number} width @param {number} height
   * @returns {Renderer} this
   */
  setViewport(x, y, width, height) {
    this.state.viewport(x | 0, y | 0, Math.max(1, width | 0), Math.max(1, height | 0));
    return this;
  }

  /**
   * Enables and sets the scissor rectangle (device pixels).
   * @param {number} x @param {number} y @param {number} width @param {number} height
   * @returns {Renderer} this
   */
  setScissor(x, y, width, height) {
    this.state.scissor(x | 0, y | 0, Math.max(0, width | 0), Math.max(0, height | 0));
    return this;
  }

  /**
   * @param {boolean} enabled
   * @returns {Renderer} this
   */
  setScissorTest(enabled) {
    this.state.setScissorTest(enabled);
    return this;
  }

  /**
   * Sets the clear colour. Values are linear, exactly like every Color in the engine.
   * @param {Object|number} color Color instance, `{r,g,b}` or a 0xRRGGBB integer.
   * @param {number} [alpha=1]
   * @returns {Renderer} this
   */
  setClearColor(color, alpha = 1) {
    if (typeof color === 'number') {
      this._clearR = ((color >> 16) & 0xff) / 255;
      this._clearG = ((color >> 8) & 0xff) / 255;
      this._clearB = (color & 0xff) / 255;
    } else if (color !== null && color !== undefined) {
      this._clearR = color.r !== undefined ? color.r : 0;
      this._clearG = color.g !== undefined ? color.g : 0;
      this._clearB = color.b !== undefined ? color.b : 0;
    }
    this._clearA = alpha;
    return this;
  }

  /**
   * Sets the tone mapping operator applied by the last pass of the frame.
   * @param {string} mode 'none'|'linear'|'reinhard'|'aces'|'aces-fit'|'uncharted2'|'agx'
   * @param {number} [exposure]
   * @returns {Renderer} this
   */
  setToneMapping(mode, exposure) {
    if (typeof mode === 'string') {
      this.toneMapping = mode;
      this._toneMappingCode = TONEMAP_CODES[mode] !== undefined ? TONEMAP_CODES[mode] : 3;
    }
    if (typeof exposure === 'number') this.exposure = exposure;
    if (this.post !== null && typeof this.post.setToneMapping === 'function') {
      this.post.setToneMapping(this.toneMapping, this.exposure);
    }
    this._globalsProgram = null;
    return this;
  }

  /* ===================================================================== *
   * Frame                                                                  *
   * ===================================================================== */

  /**
   * Renders a scene through a camera into the default framebuffer.
   * @param {Object} scene
   * @param {Object} camera
   * @returns {Renderer} this
   */
  render(scene, camera) {
    return this._renderFrame(scene, camera, null);
  }

  /**
   * Renders a scene through a camera into an off-screen target.
   * Post processing is skipped: the caller owns the contents of the target.
   * @param {Object} scene
   * @param {Object} camera
   * @param {RenderTarget} renderTarget
   * @returns {Renderer} this
   */
  renderToTarget(scene, camera, renderTarget) {
    return this._renderFrame(scene, camera, renderTarget || null);
  }

  /**
   * The whole pipeline.
   * @param {Object} scene
   * @param {Object} camera
   * @param {RenderTarget|null} target
   * @returns {Renderer} this
   * @private
   */
  _renderFrame(scene, camera, target) {
    const cpuStart = now();
    const state = this.state;
    const info = this.info;

    info.frame++;
    info.shadowDrawCalls = 0;
    state.resetStats();
    this._globalsProgram = null;
    this._lastMaterial = null;
    this._lastMaterialProgram = null;
    this._lastGeometry = null;
    this._depthFuncOverride = null;
    this._depthWriteOverride = null;
    this.shaderLib.poll();
    this._beginGPUTimer();

    // 1 - transforms and camera --------------------------------------------
    if (typeof scene.updateMatrices === 'function') scene.updateMatrices();
    else if (typeof scene.updateWorldMatrix === 'function') scene.updateWorldMatrix(true);
    if (typeof scene.updateBVH === 'function') scene.updateBVH();

    this._updateCameraTransform(scene, camera);
    if (typeof camera.updateProjectionIfNeeded === 'function') camera.updateProjectionIfNeeded();
    camera.updateViewMatrix();
    camera.updateFrustum();

    // 2 - LOD selection and culling ----------------------------------------
    this._updateLODs(scene, camera);
    const cullStart = now();
    const visibleCount = this._cull(scene, camera);
    info.cullTimeMs = now() - cullStart;
    info.visibleMeshes = visibleCount;
    const totalMeshes = scene.meshes ? scene.meshes.length : visibleCount;
    info.culledMeshes = totalMeshes > visibleCount ? totalMeshes - visibleCount : 0;

    // 3 - lights ------------------------------------------------------------
    const lights = this._collectLights(scene, camera);
    const dirLights = lights.dirLights;
    let shadowLight = null;
    if (this.shadowMapper !== null && dirLights !== null) {
      for (let i = 0, n = dirLights.length; i < n; i++) {
        if (dirLights[i].castShadow === true) {
          shadowLight = dirLights[i];
          break;
        }
      }
    }

    this._clusterActive = false;
    this._clusterReady = false;
    if (this.clustered !== null && lights.punctualLights && lights.punctualLights.length > 0) {
      this._clusterReady = this.clustered.update(
        camera, lights.punctualLights,
        this.drawingBufferWidth, this.drawingBufferHeight
      ) !== false;
      this._clusterActive = true;
    }

    // 4 - permutation context ------------------------------------------------
    // The destination is resolved this early because it decides who owns the
    // display transform, which is a shader permutation input.
    const sceneTarget = target !== null ? target : this._acquireFrameTarget();
    const environment = this._resolveEnvironment(scene);
    this._activeIBL = environment;
    const ctx = this._ctx;
    ctx.shadows = shadowLight !== null;
    ctx.shadowCascades = this.cascades;
    ctx.clustered = this._clusterActive;
    ctx.ibl = environment !== null;
    ctx.fog = scene.fog !== null && scene.fog !== undefined;
    // Exactly one tone map per frame: the post chain owns it when the frame goes
    // through the HDR buffer, the object shaders own it otherwise.
    ctx.toneMapping = sceneTarget === null || sceneTarget === target;

    // 5 - render list --------------------------------------------------------
    this._buildRenderList(camera);
    if (this.sortObjects) {
      this.renderList.sortOpaque();
      this.renderList.sortTransparent();
    }

    // 6 - shadow maps --------------------------------------------------------
    this._shadowTexture = null;
    if (shadowLight !== null) this._renderShadows(scene, camera, lights, shadowLight);

    // 7 - uniform blocks -----------------------------------------------------
    const viewportW = target !== null ? target.width : this.drawingBufferWidth;
    const viewportH = target !== null ? target.height : this.drawingBufferHeight;
    this.ubo.updateCamera(camera, viewportW, viewportH, this._sceneTime(scene));
    this.ubo.updateLights(lights, scene, this._clusterReady);
    if (shadowLight !== null) this.ubo.updateShadows(this.shadowMapper);
    else this.ubo.disableShadows();
    this.ubo.updateFog(scene);
    this.ubo.bindAll(state);

    // 8 - bind the destination ------------------------------------------------
    if (sceneTarget !== null) {
      sceneTarget.bind(state);
    } else {
      state.bindFramebuffer(GL_FRAMEBUFFER, null);
      state.viewport(0, 0, this.drawingBufferWidth, this.drawingBufferHeight);
    }
    this._currentTarget = sceneTarget;

    // 9 - clear ---------------------------------------------------------------
    if (this.autoClear) {
      const background = scene.background;
      if (background !== null && background !== undefined &&
          background.r !== undefined && background.isTexture !== true &&
          background.shaderName === undefined) {
        state.setClearColor(background.r, background.g, background.b, 1);
      } else {
        state.setClearColor(this._clearR, this._clearG, this._clearB, this._clearA);
      }
      state.setColorMask(true, true, true, true);
      state.setDepthWrite(true);
      state.clear(true, true, false);
    }

    // 10 - depth prepass -------------------------------------------------------
    const prepass = this.depthPrepass && this.shaderLib.has('depth') && this.renderList.opaque.length > 0;
    if (prepass) this._renderDepthPrepass(camera);

    // 11 - opaque, sky, transparent -------------------------------------------
    if (prepass) {
      this._depthFuncOverride = 'equal';
      this._depthWriteOverride = false;
    }
    this._renderItems(this.renderList.opaque, camera);
    this._depthFuncOverride = null;
    this._depthWriteOverride = null;

    this._renderBackground(scene, camera);
    this._renderItems(this.renderList.transparent, camera);

    // 12 - resolve and post processing ----------------------------------------
    if (sceneTarget !== null && typeof sceneTarget.resolve === 'function') sceneTarget.resolve();
    if (sceneTarget !== null && sceneTarget !== target) {
      if (this.post !== null) this.post.render(sceneTarget, null);
      state.bindFramebuffer(GL_FRAMEBUFFER, null);
      state.viewport(0, 0, this.drawingBufferWidth, this.drawingBufferHeight);
    } else if (sceneTarget !== null) {
      state.bindFramebuffer(GL_FRAMEBUFFER, null);
    }
    this._currentTarget = null;

    this._endGPUTimer();
    this._collectStats();
    info.cpuTimeMs = now() - cpuStart;
    return this;
  }

  /**
   * Makes sure the camera world matrix is fresh.
   *
   * `scene.updateMatrices()` only walks the scene graph, and a camera very often
   * lives outside of it (or under a rig that does). Walking up to the root and
   * refreshing that sub tree covers both cases and costs nothing when the camera
   * is already a scene child - the root is then the scene itself, which was just
   * updated.
   *
   * @param {Object} scene
   * @param {Object} camera
   * @private
   */
  _updateCameraTransform(scene, camera) {
    let root = camera;
    while (root.parent !== null && root.parent !== undefined) root = root.parent;
    if (root !== scene && typeof root.updateWorldMatrix === 'function') root.updateWorldMatrix();
  }

  /**
   * Reads a time-ish value out of the scene for the Camera uniform block.
   * @param {Object} scene
   * @returns {Object|number|null}
   * @private
   */
  _sceneTime(scene) {
    if (scene.time !== undefined && scene.time !== null) return scene.time;
    if (scene.userData !== undefined && scene.userData !== null && scene.userData.time !== undefined) {
      return scene.userData.time;
    }
    return this.info.frame * (1 / 60);
  }

  /* ===================================================================== *
   * Culling                                                                *
   * ===================================================================== */

  /**
   * Refreshes the cached list of LOD nodes and lets every one of them pick its
   * level. The cache is rebuilt when the scene changes identity or when the mesh
   * count moves, which is what adding or removing an LOD always does.
   * @param {Object} scene
   * @param {Object} camera
   * @private
   */
  _updateLODs(scene, camera) {
    const meshCount = scene.meshes ? scene.meshes.length : -1;
    if (scene !== this._lodScene || meshCount !== this._lodMeshCount) {
      this._lodScene = scene;
      this._lodMeshCount = meshCount;
      const list = this._lodNodes;
      list.length = 0;
      if (typeof scene.traverse === 'function') scene.traverse(this._collectLOD);
    }

    const nodes = this._lodNodes;
    for (let i = 0, n = nodes.length; i < n; i++) nodes[i].update(camera);
  }

  /**
   * Fills `_visible` with the meshes that survive the broadphase, the layer mask
   * and the visibility flags.
   * @param {Object} scene
   * @param {Object} camera
   * @returns {number} number of visible meshes
   * @private
   */
  _cull(scene, camera) {
    const out = this._visible;
    out.length = 0;

    const bvh = scene.bvh;
    const layerMask = camera.layers !== undefined ? camera.layers : 0xffffffff;

    if (bvh !== undefined && bvh !== null && typeof bvh.query === 'function' && bvh.nodeCount > 0) {
      bvh.query(camera.frustum, out);
      let write = 0;
      for (let i = 0, n = out.length; i < n; i++) {
        const mesh = out[i];
        if (mesh === null || mesh === undefined) continue;
        if (mesh.visible === false) continue;
        if ((mesh.layers & layerMask) === 0) continue;
        if (mesh.geometry === null || mesh.geometry === undefined) continue;
        if (mesh.material === null || mesh.material === undefined) continue;
        if (!isBranchVisible(mesh.parent)) continue;
        out[write++] = mesh;
      }
      out.length = write;
      return write;
    }

    // Linear fallback: no broadphase (empty scene, or a Scene replacement that
    // does not build one). Exactly the same acceptance rules.
    const meshes = scene.meshes;
    if (!meshes) return 0;
    const frustum = camera.frustum;
    let write = 0;
    for (let i = 0, n = meshes.length; i < n; i++) {
      const mesh = meshes[i];
      if (mesh.visible === false) continue;
      if ((mesh.layers & layerMask) === 0) continue;
      if (mesh.geometry === null || mesh.geometry === undefined) continue;
      if (mesh.material === null || mesh.material === undefined) continue;
      if (!isBranchVisible(mesh.parent)) continue;
      if (mesh.frustumCulled === true) {
        mesh.updateWorldBounds();
        const sphere = mesh.boundingSphereWorld;
        if (sphere !== undefined && sphere.radius >= 0 && !frustum.intersectsSphere(sphere)) continue;
      }
      out[write++] = mesh;
    }
    out.length = write;
    return write;
  }

  /* ===================================================================== *
   * Lights                                                                 *
   * ===================================================================== */

  /**
   * Runs the light manager, falling back to an internal split when it is
   * unavailable or returns an unusable shape.
   * @param {Object} scene
   * @param {Object} camera
   * @returns {{dirLights: Object[], punctualLights: Object[]}}
   * @private
   */
  _collectLights(scene, camera) {
    const manager = this.lightManager;
    if (manager !== null && typeof manager.collect === 'function') {
      manager.collect(scene, camera);
      if (Array.isArray(manager.dirLights) && Array.isArray(manager.punctualLights)) {
        if (typeof manager.sortByImportance === 'function' && manager.punctualLights.length > this.maxLights) {
          manager.sortByImportance(camera);
        }
        return manager;
      }
    }

    const dir = this._fallbackDirLights;
    const punctual = this._fallbackPunctualLights;
    dir.length = 0;
    punctual.length = 0;
    const lights = scene.lights;
    if (lights) {
      for (let i = 0, n = lights.length; i < n; i++) {
        const light = lights[i];
        if (light.visible === false) continue;
        if (light.intensity === 0) continue;
        if (light.type === 'directional') {
          if (dir.length < 4) dir.push(light);
        } else if (punctual.length < this.maxLights) {
          punctual.push(light);
        }
      }
    }
    this._fallbackLights.visibleCount = dir.length + punctual.length;
    return this._fallbackLights;
  }

  /**
   * Picks the environment probe for this frame.
   * @param {Object} scene
   * @returns {Object|null}
   * @private
   */
  _resolveEnvironment(scene) {
    const env = scene.environment;
    if (env !== null && env !== undefined &&
        (env.irradianceMap !== undefined || env.prefilteredMap !== undefined)) {
      return env;
    }
    return this.ibl;
  }

  /* ===================================================================== *
   * Render list                                                            *
   * ===================================================================== */

  /**
   * Turns the visible mesh list into pooled draw items, resolving each program
   * once so both the sort key and the draw path can use it.
   * @param {Object} camera
   * @private
   */
  _buildRenderList(camera) {
    const list = this.renderList;
    list.reset();

    const visible = this._visible;
    const view = camera.viewMatrix.elements;

    for (let i = 0, n = visible.length; i < n; i++) {
      const mesh = visible[i];
      const geometry = mesh.geometry;
      const material = mesh.material;

      mesh.updateWorldBounds();
      const center = mesh.boundingSphereWorld.center;
      // Distance to the camera plane = -(view-space z).
      const depth = -(view[2] * center.x + view[6] * center.y + view[10] * center.z + view[14]);

      if (Array.isArray(material)) {
        const groups = geometry.groups;
        if (groups !== undefined && groups.length > 0) {
          for (let g = 0, gn = groups.length; g < gn; g++) {
            const slot = groups[g].materialIndex | 0;
            const sub = material[slot] !== undefined ? material[slot] : material[0];
            if (sub === null || sub === undefined) continue;
            const program = this._resolveProgram(sub, geometry);
            if (program === null) continue;
            list.push(mesh, geometry, sub, g, depth, program);
          }
        } else if (material.length > 0 && material[0]) {
          const program = this._resolveProgram(material[0], geometry);
          if (program !== null) list.push(mesh, geometry, material[0], -1, depth, program);
        }
      } else {
        const program = this._resolveProgram(material, geometry);
        if (program !== null) list.push(mesh, geometry, material, -1, depth, program);
      }
    }
  }

  /**
   * Resolves (and caches on the material) the program for the current frame
   * context. Returns null - never throws - when the shader is not registered.
   * @param {Object} material
   * @param {Object} geometry
   * @param {Object} [context] Permutation context, defaults to the frame one.
   * @returns {Object|null}
   * @private
   */
  _resolveProgram(material, geometry, context) {
    const ctx = context !== undefined ? context : this._ctx;
    const defines = material.getDefines(geometry, ctx);
    const cached = this._programCache.get(defines);
    if (cached !== undefined) return cached.failed ? null : cached;

    const name = material.shaderName;
    // A material carrying its own sources (ShaderMaterial and friends) has to be
    // given the chance to publish them before we decide the shader is missing.
    if (!this.shaderLib.has(name) && typeof material.ensureRegistered === 'function') {
      material.ensureRegistered(this.shaderLib);
    }
    if (!this.shaderLib.has(name)) {
      if (!this._missingShaders.has(name)) {
        this._missingShaders.add(name);
        Logger.error('Renderer: shader "' + name + '" nao registrado na ShaderLib - objetos que o usam serao ignorados.');
      }
      return null;
    }
    const program = material.getProgram(this.shaderLib, defines);
    if (program === null || program === undefined) return null;
    this._programCache.set(defines, program);
    return program.failed ? null : program;
  }

  /* ===================================================================== *
   * Passes                                                                 *
   * ===================================================================== */

  /**
   * Colour masked depth only pass over the opaque list, so the shading pass runs
   * with depthFunc EQUAL and shades every pixel exactly once.
   * @param {Object} camera
   * @private
   */
  _renderDepthPrepass(camera) {
    const state = this.state;
    const list = this.renderList.opaque;

    state.setColorMask(false, false, false, false);
    state.setDepthTest(true);
    this._lastMaterial = null;
    this._lastGeometry = null;
    this._depthFuncOverride = 'less';
    this._depthWriteOverride = true;

    for (let i = 0, n = list.length; i < n; i++) {
      const item = list[i];
      const material = item.material;
      if (material.depthWrite === false || material.colorWrite === false) continue;
      const program = this._resolveNamedProgram('depth', material, item.geometry, this._depthCtx);
      if (program === null) continue;
      this._drawItem(item, program, camera, true);
    }

    this._depthFuncOverride = null;
    this._depthWriteOverride = null;
    state.setColorMask(true, true, true, true);
    this._lastMaterial = null;
    this._lastGeometry = null;
    this._globalsProgram = null;
  }

  /**
   * Resolves a program for an explicit shader name (depth prepass, shadow pass),
   * reusing the material defines so alpha masking, skinning and instancing keep
   * working in the depth only permutation.
   * @param {string} shaderName
   * @param {Object} material
   * @param {Object} geometry
   * @param {Object} context
   * @returns {Object|null}
   * @private
   */
  _resolveNamedProgram(shaderName, material, geometry, context) {
    const defines = material.getDefines(geometry, context);
    let cache = this._namedProgramCaches.get(shaderName);
    if (cache === undefined) {
      cache = new WeakMap();
      this._namedProgramCaches.set(shaderName, cache);
    }
    const cached = cache.get(defines);
    if (cached !== undefined) return cached.failed ? null : cached;

    if (!this.shaderLib.has(shaderName)) return null;
    const program = this.shaderLib.get(shaderName, defines);
    if (program === null || program === undefined) return null;
    cache.set(defines, program);
    return program.failed ? null : program;
  }

  /**
   * Draws a whole list of pooled items.
   * @param {Array} list
   * @param {Object} camera
   * @private
   */
  _renderItems(list, camera) {
    const n = list.length;
    if (n === 0) return;
    this._lastMaterial = null;
    this._lastGeometry = null;
    for (let i = 0; i < n; i++) {
      const item = list[i];
      const program = item.program;
      if (program === null) continue;
      this._drawItem(item, program, camera, false);
    }
  }

  /**
   * Renders the shadow maps and captures the resulting texture.
   * @param {Object} scene
   * @param {Object} camera
   * @param {Object} lights
   * @param {Object} shadowLight
   * @private
   */
  _renderShadows(scene, camera, lights, shadowLight) {
    const mapper = this.shadowMapper;
    if (mapper === null) return;

    const before = this.state.stats.drawCalls;
    if (typeof mapper.update === 'function') {
      mapper.update(scene, camera, lights.dirLights !== undefined ? lights.dirLights : lights);
    } else if (typeof mapper.renderCascades === 'function') {
      mapper.renderCascades(scene, camera, shadowLight);
    }
    this.info.shadowDrawCalls = this.state.stats.drawCalls - before;
    this._shadowTexture = mapper.texture !== undefined ? mapper.texture : null;
    this._globalsProgram = null;
    this._lastMaterial = null;
    this._lastGeometry = null;
  }

  /**
   * Draws `scene.background`: a Color is handled by the clear, a Material (a
   * SkyMaterial for instance) or a cube texture is drawn as a camera centred box
   * with depthFunc LEQUAL, between the opaque and the transparent passes.
   * @param {Object} scene
   * @param {Object} camera
   * @private
   */
  _renderBackground(scene, camera) {
    const background = scene.background;
    if (background === null || background === undefined) return;

    let material = null;
    if (background.shaderName !== undefined) {
      material = background;
    } else if (background.isTexture === true ||
      (background.target !== undefined && typeof background.bind === 'function')) {
      material = this._getSkyMaterial(background);
    } else {
      return; // A plain Color: already consumed by the clear.
    }
    if (material === null) return;

    const geometry = this._getSkyGeometry();
    const program = this._resolveProgram(material, geometry);
    if (program === null) return;

    const state = this.state;
    this._lastMaterial = null;

    if (!program.use(state)) return;
    this._bindGlobalUniforms(program);

    // The box is centred on the camera and scaled so that it always sits between
    // the near and the far plane, whatever the shader does with the position.
    const size = camera.far > 0 ? camera.far * 0.5 : 1000;
    const world = camera.worldMatrix.elements;
    const m = this._skyMatrix;
    m[0] = size; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = size; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = size; m[11] = 0;
    m[12] = world[12]; m[13] = world[13]; m[14] = world[14]; m[15] = 1;
    program.setUniform('uModelMatrix', m);

    if (typeof material.updateUniforms === 'function') material.updateUniforms(program, state, this);
    material.applyUniforms(program, state);

    state.setDepthTest(true);
    state.setDepthWrite(false);
    state.setDepthFunc('lequal');
    state.setCullFace(material.side === 'front' ? 'back' : 'none');
    state.setBlending('none');
    state.setColorMask(true, true, true, true);
    state.setPolygonOffset(false, 0, 0);

    const vao = geometry.getVAO(this.gl, state);
    state.bindVAO(vao.id);
    this._lastGeometry = null;
    const mode = drawModeToGL(geometry.drawMode);
    if (geometry.index !== null) {
      state.drawElements(mode, geometry.getDrawCount(), geometry.index.type,
        geometry.getDrawStart() * glTypeBytes(geometry.index.type));
    } else {
      state.drawArrays(mode, geometry.getDrawStart(), geometry.getDrawCount());
    }

    this._lastMaterial = null;
  }

  /** @returns {Object} the lazily created skybox geometry @private */
  _getSkyGeometry() {
    if (this._skyGeometry === null) this._skyGeometry = createSkyboxCube(1);
    return this._skyGeometry;
  }

  /**
   * Material used to draw a cube texture background.
   * @param {Object} texture
   * @returns {Material}
   * @private
   */
  _getSkyMaterial(texture) {
    if (this._skyMaterial === null) {
      this._skyMaterial = new Material({
        name: 'BackgroundCube',
        shaderName: this.shaderLib.has('sky') ? 'sky' : 'unlit',
        depthWrite: false,
        depthFunc: 'lequal',
        side: 'double',
        castShadow: false,
        receiveShadow: false,
        receiveIBL: false,
        defines: { USE_BACKGROUND_MAP: 1, USE_ENV_MAP: 1 }
      });
    }
    const material = this._skyMaterial;
    if (material.uniforms.uEnvMap !== texture) {
      material.setUniform('uEnvMap', texture);
      material.setUniform('uBackgroundMap', texture);
      material.setUniform('uSkyMap', texture);
    }
    return material;
  }

  /* ===================================================================== *
   * Draw path                                                              *
   * ===================================================================== */

  /**
   * Public single draw entry point: resolves the program itself and draws the
   * whole geometry. Used by tools (DebugRenderer, ShadowMapper) that submit one
   * object at a time; the frame pipeline uses the pooled item variant instead.
   *
   * @param {Object} mesh
   * @param {Object} geometry
   * @param {Object} material
   * @param {Object} camera
   * @returns {boolean} true when a draw call was issued
   */
  renderMesh(mesh, geometry, material, camera) {
    const program = this._resolveProgram(material, geometry);
    if (program === null) return false;
    return this.drawMesh(mesh, geometry, material, program, null, camera);
  }

  /**
   * Low level draw: the program and the group are already resolved.
   * Allocation free.
   *
   * @param {Object} mesh
   * @param {Object} geometry
   * @param {Object} material
   * @param {Object} program
   * @param {Object|null} group `{start, count}` or null for the whole geometry.
   * @param {Object} [camera]
   * @param {boolean} [depthOnly=false] Skip the material uniforms / global maps.
   * @returns {boolean}
   */
  drawMesh(mesh, geometry, material, program, group, camera, depthOnly = false) {
    const gl = this.gl;
    const state = this.state;

    if (!program.use(state)) return false;

    // Instance count first: an empty InstancedMesh must not touch anything.
    let instanceCount = -1;
    if (mesh.isInstancedMesh === true) instanceCount = mesh.count;
    else if (geometry.instanceCount >= 0) instanceCount = geometry.instanceCount;
    if (instanceCount === 0) return false;

    if (mesh.onBeforeRender !== null && mesh.onBeforeRender !== undefined) {
      // The hook may touch the geometry, so the "same geometry as last draw"
      // shortcut below has to be given up for this draw.
      this._lastGeometry = null;
      mesh.onBeforeRender(this, mesh, camera, geometry, material);
    }

    if (!depthOnly) this._bindGlobalUniforms(program);

    // --- per object uniforms ---------------------------------------------
    program.setUniform('uModelMatrix', mesh.worldMatrix);
    if (program.hasUniform('uNormalMatrix')) {
      _normalMatrix.getNormalMatrix(mesh.worldMatrix);
      program.setUniform('uNormalMatrix', _normalMatrix);
    }
    if (mesh.isSkinnedMesh === true) this._bindSkeleton(mesh, program);

    // --- material uniforms -------------------------------------------------
    if (material !== this._lastMaterial || program !== this._lastMaterialProgram ||
        material.version !== this._lastMaterialVersion) {
      if (typeof material.updateUniforms === 'function') material.updateUniforms(program, state, this);
      material.applyUniforms(program, state);
      this._lastMaterial = material;
      this._lastMaterialProgram = program;
      this._lastMaterialVersion = material.version;
    }

    // --- render state ------------------------------------------------------
    state.applyMaterialState(material);
    if (this._depthFuncOverride !== null) state.setDepthFunc(this._depthFuncOverride);
    if (this._depthWriteOverride !== null) state.setDepthWrite(this._depthWriteOverride);
    if (depthOnly) state.setColorMask(false, false, false, false);

    // --- geometry ----------------------------------------------------------
    if (mesh.isInstancedMesh === true && typeof mesh.upload === 'function') {
      // Uploading may republish the instance attributes and bump the geometry
      // version, so the cached VAO must be re-fetched.
      this._lastGeometry = null;
      mesh.upload(gl, state);
      if (instanceCount > mesh.capacity) instanceCount = mesh.capacity;
    }

    const wireframe = material.wireframe === true && geometry.drawMode === 'triangles';
    let mode;
    let indexType = 0;
    let start;
    let count;

    if (wireframe) {
      const record = this._getWireframe(geometry);
      if (record === null) return false;
      this._lastGeometry = null;
      state.bindVAO(record.vao.id);
      mode = GL_LINES;
      indexType = record.type;
      start = 0;
      count = record.count;
    } else {
      // Consecutive draws that share a geometry - which the state sort makes the
      // common case - skip `getVAO()` entirely, and with it the dirty-attribute
      // sweep it performs. The VAO itself is still bound through the cache.
      if (geometry === this._lastGeometry) {
        state.bindVAO(this._lastVAO);
      } else {
        const vao = geometry.getVAO(gl, state);
        this._lastGeometry = geometry;
        this._lastVAO = vao.id;
        state.bindVAO(vao.id);
      }
      mode = drawModeToGL(geometry.drawMode);
      const index = geometry.index;
      indexType = index !== null && index !== undefined ? index.type : 0;
      if (group !== null && group !== undefined) {
        start = group.start | 0;
        count = group.count | 0;
      } else {
        start = geometry.getDrawStart();
        count = geometry.getDrawCount();
      }
    }

    if (count <= 0) return false;

    if (indexType !== 0) {
      const byteOffset = start * glTypeBytes(indexType);
      if (instanceCount > 0) state.drawElementsInstanced(mode, count, indexType, byteOffset, instanceCount);
      else state.drawElements(mode, count, indexType, byteOffset);
    } else if (instanceCount > 0) {
      state.drawArraysInstanced(mode, start, count, instanceCount);
    } else {
      state.drawArrays(mode, start, count);
    }

    if (mesh.onAfterRender !== null && mesh.onAfterRender !== undefined) {
      mesh.onAfterRender(this, mesh, camera, geometry, material);
    }
    return true;
  }

  /**
   * Draws one pooled render item.
   * @param {Object} item
   * @param {Object} program
   * @param {Object} camera
   * @param {boolean} depthOnly
   * @returns {boolean}
   * @private
   */
  _drawItem(item, program, camera, depthOnly) {
    return this.drawMesh(item.mesh, item.geometry, item.material, program, item.group, camera, depthOnly);
  }

  /**
   * Binds the samplers and uniforms the renderer owns (shadow atlas, cluster
   * textures, IBL probes, exposure). Because those never change inside a frame
   * and sampler values are per program, doing it once per program switch is
   * enough - and free for the long runs of draws that share a program.
   * @param {Object} program
   * @private
   */
  _bindGlobalUniforms(program) {
    if (program === this._globalsProgram) return;
    this._globalsProgram = program;
    const state = this.state;

    if (this._shadowTexture !== null && this._shadowTexture !== undefined) {
      program.setTexture('uShadowMap', this._shadowTexture, 8, state);
    }
    if (this._clusterActive && this.clustered !== null && typeof this.clustered.bind === 'function') {
      this.clustered.bind(state, program);
    }

    const ibl = this._activeIBL;
    if (ibl !== null && ibl !== undefined) {
      if (ibl.irradianceMap) program.setTexture('uIrradianceMap', ibl.irradianceMap, 11, state);
      if (ibl.prefilteredMap) program.setTexture('uPrefilteredMap', ibl.prefilteredMap, 12, state);
      if (ibl.brdfLUT) program.setTexture('uBRDFLUT', ibl.brdfLUT, 13, state);
      _iblParams[0] = typeof ibl.intensity === 'number' ? ibl.intensity : 1;
      _iblParams[1] = typeof ibl.maxMipLevel === 'number' ? ibl.maxMipLevel : 0;
      _iblParams[2] = 1;
      _iblParams[3] = 0;
      program.setUniform('uIBLParams', _iblParams);
    }

    program.setUniform('uExposure', this.exposure);
    program.setUniform('uToneMapping', this._toneMappingCode);
    program.setUniform('uToneMappingMode', this._toneMappingCode);
  }

  /**
   * Uploads and binds the bone texture of a skinned mesh, at most once per frame
   * per skeleton even when the mesh is drawn in several passes.
   * @param {Object} mesh
   * @param {Object} program
   * @private
   */
  _bindSkeleton(mesh, program) {
    const skeleton = mesh.skeleton;
    if (skeleton === null || skeleton === undefined) return;

    let texture = skeleton.boneTexture;
    if (this._boneUploadFrame.get(skeleton) !== this.info.frame) {
      if (typeof skeleton.computeBoneTexture === 'function') {
        texture = skeleton.computeBoneTexture(this.gl) || skeleton.boneTexture;
      }
      this._boneUploadFrame.set(skeleton, this.info.frame);
    }
    if (texture) program.setTexture('uBoneTexture', texture, 6, this.state);
    program.setUniform('uBindMatrix', mesh.bindMatrix);
    program.setUniform('uBindMatrixInverse', mesh.bindMatrixInverse);
  }

  /* ===================================================================== *
   * Wireframe                                                              *
   * ===================================================================== */

  /**
   * Builds (and caches) a line-list VAO for a triangle geometry, so
   * `material.wireframe` draws real edges instead of an approximation. The cache
   * is owned by the renderer, never by the shared geometry.
   *
   * @param {Object} geometry
   * @returns {{vao: VertexArray, count: number, type: number}|null}
   * @private
   */
  _getWireframe(geometry) {
    const gl = this.gl;
    const state = this.state;
    const version = geometry._version !== undefined ? geometry._version : 0;
    const cached = this._wireframeCache.get(geometry.id);
    if (cached !== undefined && cached.version === version) return cached;
    if (cached !== undefined) {
      cached.vao.dispose(state);
      cached.buffer.dispose(state);
      this._wireframeCache.delete(geometry.id);
    }

    geometry.upload(gl, state);
    const position = geometry.attributes.get('aPosition');
    if (position === undefined || position === null || !position.buffer) return null;

    const indices = this._buildWireframeIndices(geometry);
    if (indices === null) return null;

    const buffer = new GLBuffer(gl, 'element', 'static');
    buffer.setData(indices, state);

    const vao = new VertexArray(gl, state);
    const it = geometry.attributes.entries();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      const name = entry.value[0];
      const attr = entry.value[1];
      if (!attr.buffer) continue;
      let location = attr.location;
      if (location === undefined || location < 0) {
        const mapped = ATTRIB_NAME_TO_LOC[name];
        if (mapped === undefined) continue;
        location = mapped;
      }
      if (attr.size === 16 || (name === 'aInstanceMatrix' && attr.size === 4 && attr.stride >= 64)) {
        vao.setMatrixAttribute(location, attr.buffer, attr.stride || 64, attr.offset, attr.divisor || 1);
      } else {
        vao.setAttribute(location, attr.buffer, attr.size, attr.type, attr.normalized,
          attr.stride, attr.offset, attr.divisor, attr.integer);
      }
    }
    vao.setIndexBuffer(buffer);
    // The index buffer is recorded inside the VAO; leave the global binding clean.
    state.invalidateBuffer(GL_ELEMENT_ARRAY_BUFFER);

    const record = {
      vao,
      buffer,
      count: indices.length,
      type: indices instanceof Uint32Array ? GL_TYPE.UNSIGNED_INT : GL_TYPE.UNSIGNED_SHORT,
      version
    };
    this._wireframeCache.set(geometry.id, record);
    return record;
  }

  /**
   * Builds the deduplicated edge index list of a triangle geometry.
   * Runs once per geometry, never inside the frame loop.
   * @param {Object} geometry
   * @returns {Uint16Array|Uint32Array|null}
   * @private
   */
  _buildWireframeIndices(geometry) {
    const index = geometry.index;
    const vertexCount = geometry.vertexCount;
    const triangleSource = index !== null && index !== undefined ? index.data : null;
    const triangleCount = triangleSource !== null
      ? Math.floor(triangleSource.length / 3)
      : Math.floor(vertexCount / 3);
    if (triangleCount <= 0) return null;

    // The 53 bit edge key is only exact while the vertex ids stay small; above
    // that the duplicates are simply kept (twice the indices, identical picture).
    const dedup = vertexCount <= MAX_EXACT_EDGE_INDEX;
    const seen = dedup ? new Set() : null;
    const edges = [];
    const pairs = [0, 0, 0, 0, 0, 0];
    for (let t = 0; t < triangleCount; t++) {
      const base = t * 3;
      const a = triangleSource !== null ? triangleSource[base] : base;
      const b = triangleSource !== null ? triangleSource[base + 1] : base + 1;
      const c = triangleSource !== null ? triangleSource[base + 2] : base + 2;
      pairs[0] = a; pairs[1] = b;
      pairs[2] = b; pairs[3] = c;
      pairs[4] = c; pairs[5] = a;
      for (let e = 0; e < 6; e += 2) {
        const i0 = pairs[e];
        const i1 = pairs[e + 1];
        const lo = i0 < i1 ? i0 : i1;
        const hi = i0 < i1 ? i1 : i0;
        if (dedup) {
          const key = lo * 4294967296 + hi;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        edges.push(lo, hi);
      }
    }

    const max = vertexCount > 0 ? vertexCount : 65536;
    const out = max > 65535 ? new Uint32Array(edges.length) : new Uint16Array(edges.length);
    for (let i = 0, n = edges.length; i < n; i++) out[i] = edges[i];
    return out;
  }

  /* ===================================================================== *
   * Targets, statistics, timing                                            *
   * ===================================================================== */

  /**
   * Returns the off-screen target the frame should be drawn into, creating it on
   * demand. Returns null when the frame goes straight to the default framebuffer.
   * @returns {RenderTarget|null}
   * @private
   */
  _acquireFrameTarget() {
    if (!this.hdrEnabled || this.post === null) return null;
    if (this._hdrTarget !== null) {
      if (this._hdrTarget.width !== this.drawingBufferWidth ||
          this._hdrTarget.height !== this.drawingBufferHeight) {
        this._hdrTarget.resize(this.drawingBufferWidth, this.drawingBufferHeight);
      }
      return this._hdrTarget;
    }

    const canFloat = this.caps === null || this.caps.colorBufferFloat !== false;
    this._hdrTarget = this._build('HDR RenderTarget', () => new RenderTarget(
      this.gl, this.drawingBufferWidth, this.drawingBufferHeight, {
        colorAttachments: 1,
        colorFormat: canFloat ? 'rgba16f' : 'rgba8',
        depth: true,
        depthTexture: true,
        depthFormat: 'depth24',
        samples: this.msaa,
        filter: 'linear',
        wrap: 'clamp',
        state: this.state,
        name: 'SceneHDR'
      }
    ));
    if (this._hdrTarget === null) {
      // Without an HDR buffer there is nothing for the post chain to read.
      this.post = null;
      this.postEnabled = false;
      this._ctx.toneMapping = true;
    }
    return this._hdrTarget;
  }

  /**
   * Copies the driver counters into `info`.
   * @private
   */
  _collectStats() {
    const info = this.info;
    const stats = this.state.stats;
    info.calls = stats.drawCalls;
    info.drawCalls = stats.drawCalls;
    info.triangles = stats.triangles;
    info.points = stats.points;
    info.lines = stats.lines;
    info.programs = this.shaderLib.programCount;
    info.textures = stats.textureBinds;
    info.geometries = this.renderList.count;
    info.memory.buffers = GLBuffer.totalBytes;
    info.memory.textures = Texture.totalBytes;
    info.memoryBytes = info.memory.buffers + info.memory.textures;
  }

  /**
   * Starts the GPU timer query of this frame, when the extension is available.
   * @private
   */
  _beginGPUTimer() {
    const ext = this._timerExt;
    const gl = this.gl;
    if (ext === null || typeof gl.createQuery !== 'function') return;
    const target = ext.TIME_ELAPSED_EXT !== undefined ? ext.TIME_ELAPSED_EXT : 0x88bf;
    const slot = this._timerSlot;

    // Two query objects are created once and then recycled forever: by the time
    // the ring comes back to a slot a full frame has elapsed, so its result is
    // ready and reading it costs no pipeline stall.
    let query = this._timerQueries[slot];
    if (query === null) {
      query = gl.createQuery();
      if (!query) return;
      this._timerQueries[slot] = query;
    } else if (this._timerPending[slot] === true) {
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
      this._timerPending[slot] = false;
      const disjoint = ext.GPU_DISJOINT_EXT !== undefined ? gl.getParameter(ext.GPU_DISJOINT_EXT) : false;
      if (!disjoint) this.info.gpuTimeMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
    }

    gl.beginQuery(target, query);
    this._timerActive = true;
  }

  /**
   * Ends the GPU timer query of this frame.
   * @private
   */
  _endGPUTimer() {
    if (!this._timerActive) return;
    this._timerActive = false;
    const ext = this._timerExt;
    const gl = this.gl;
    const target = ext.TIME_ELAPSED_EXT !== undefined ? ext.TIME_ELAPSED_EXT : 0x88bf;
    gl.endQuery(target);
    this._timerPending[this._timerSlot] = true;
    this._timerSlot = this._timerSlot === 0 ? 1 : 0;
  }

  /* ===================================================================== *
   * Warm up and lifecycle                                                  *
   * ===================================================================== */

  /**
   * Compiles every program the scene needs, so the first frame does not hitch.
   * @param {Object} scene
   * @param {Object} camera
   * @returns {number} number of programs in the library afterwards
   */
  compile(scene, camera) {
    // updateMatrices() consumes the dirty mesh list, so updateBVH() has to run in
    // the same breath: skipping it here would leave the broadphase empty until
    // something moves again.
    if (typeof scene.updateMatrices === 'function') scene.updateMatrices();
    if (typeof scene.updateBVH === 'function') scene.updateBVH();
    if (camera !== null && camera !== undefined) {
      this._updateCameraTransform(scene, camera);
      if (typeof camera.updateProjectionIfNeeded === 'function') camera.updateProjectionIfNeeded();
      if (typeof camera.updateViewMatrix === 'function') camera.updateViewMatrix();
      if (typeof camera.updateFrustum === 'function') camera.updateFrustum();
    }

    // The permutation context has to match what the frame will really use, or the
    // warm up compiles programs nobody draws with.
    const lights = this._collectLights(scene, camera);
    let hasShadow = false;
    const dirLights = lights.dirLights;
    if (this.shadowMapper !== null && dirLights) {
      for (let i = 0, n = dirLights.length; i < n; i++) {
        if (dirLights[i].castShadow === true) { hasShadow = true; break; }
      }
    }
    const ctx = this._ctx;
    ctx.shadows = hasShadow;
    ctx.clustered = this.clustered !== null && lights.punctualLights && lights.punctualLights.length > 0;
    ctx.ibl = this._resolveEnvironment(scene) !== null;
    ctx.fog = scene.fog !== null && scene.fog !== undefined;
    ctx.toneMapping = this.post === null;

    const meshes = scene.meshes;
    if (meshes) {
      for (let i = 0, n = meshes.length; i < n; i++) {
        const mesh = meshes[i];
        const geometry = mesh.geometry;
        const material = mesh.material;
        if (!geometry || !material) continue;
        if (Array.isArray(material)) {
          for (let m = 0, mn = material.length; m < mn; m++) {
            if (material[m]) this._compileOne(mesh, geometry, material[m]);
          }
        } else {
          this._compileOne(mesh, geometry, material);
        }
      }
    }

    if (scene.background !== null && scene.background !== undefined &&
        scene.background.shaderName !== undefined) {
      this._resolveProgram(scene.background, this._getSkyGeometry());
    }

    this.shaderLib.finishAll();
    this.info.programs = this.shaderLib.programCount;
    return this.info.programs;
  }

  /**
   * Compiles the shading, depth and shadow permutations of one material.
   * @param {Object} mesh
   * @param {Object} geometry
   * @param {Object} material
   * @private
   */
  _compileOne(mesh, geometry, material) {
    this._resolveProgram(material, geometry);
    if (this.depthPrepass) this._resolveNamedProgram('depth', material, geometry, this._depthCtx);
    if (this.shadowMapper !== null && mesh.castShadow === true) {
      this._resolveNamedProgram('shadow', material, geometry, this._depthCtx);
    }
  }

  /**
   * Drops every cached GPU-side object after a context loss/restore cycle.
   * The GL objects themselves are already gone, so nothing is deleted here: the
   * caches are simply forgotten and rebuilt lazily.
   * @returns {Renderer} this
   */
  onContextRestored() {
    const gl = this.gl;
    const state = getStateCache(gl) || new StateCache(gl);
    this.state = state;
    state.reset();
    state.resetStats();

    this.shaderLib.clearCache();
    this._missingShaders.clear();
    this._programCache = new WeakMap();
    this._namedProgramCaches.clear();

    this.ubo = new UniformBuffers(gl, state);
    this.renderList.reset();
    this._wireframeCache.clear();
    this._boneUploadFrame.clear();
    this._hdrTarget = null;
    this._skyGeometry = null;
    this._skyMaterial = null;
    this._globalsProgram = null;
    this._lastMaterial = null;
    this._lastMaterialProgram = null;
    this._lastMaterialVersion = -1;
    this._lastGeometry = null;
    this._lastVAO = null;
    this._shadowTexture = null;
    this._activeIBL = null;
    this._timerQueries[0] = null;
    this._timerQueries[1] = null;
    this._timerPending[0] = false;
    this._timerPending[1] = false;
    this._timerActive = false;
    this._lodScene = null;
    this._lodMeshCount = -1;

    if (this.shadowsEnabled) {
      this.shadowMapper = this._build('ShadowMapper', () => new ShadowMapper(gl, this, {
        mapSize: this.shadowMapSize,
        size: this.shadowMapSize,
        cascades: this.cascades,
        state
      }));
    }
    if (this.clusteredEnabled) {
      this.clustered = this._build('ClusteredLighting', () => new ClusteredLighting(gl, {
        x: this.clusterX, y: this.clusterY, z: this.clusterZ,
        clusterX: this.clusterX, clusterY: this.clusterY, clusterZ: this.clusterZ,
        maxLights: this.maxLights, state
      }));
    }
    if (this.postEnabled) {
      this.post = this._build('PostProcessing', () => new PostProcessing(gl, this, {
        toneMapping: this.toneMapping, exposure: this.exposure, state
      }));
      if (this.post !== null && typeof this.post.resize === 'function') {
        this.post.resize(this.drawingBufferWidth, this.drawingBufferHeight);
      }
    }
    this.ibl = null;
    return this;
  }

  /**
   * Creates (and keeps) an environment probe generator bound to this renderer.
   * @returns {Object|null}
   */
  createIBL() {
    if (this.ibl === null) this.ibl = this._build('IBL', () => new IBL(this.gl, this));
    return this.ibl;
  }

  /**
   * Releases every GPU resource the renderer owns. Scene resources (geometries,
   * textures, materials) belong to the application and are left untouched.
   */
  dispose() {
    const state = this.state;

    for (const record of this._wireframeCache.values()) {
      record.vao.dispose(state);
      record.buffer.dispose(state);
    }
    this._wireframeCache.clear();
    this._boneUploadFrame.clear();

    if (this._hdrTarget !== null) {
      this._hdrTarget.dispose(state);
      this._hdrTarget = null;
    }
    if (this._skyGeometry !== null && typeof this._skyGeometry.dispose === 'function') {
      this._skyGeometry.dispose(this.gl, state);
      this._skyGeometry = null;
    }
    if (this._skyMaterial !== null) {
      this._skyMaterial.dispose();
      this._skyMaterial = null;
    }

    const subsystems = [this.post, this.shadowMapper, this.clustered, this.ibl, this.lightManager];
    for (let i = 0; i < subsystems.length; i++) {
      const sub = subsystems[i];
      if (sub !== null && sub !== undefined && typeof sub.dispose === 'function') sub.dispose();
    }
    this.post = null;
    this.shadowMapper = null;
    this.clustered = null;
    this.ibl = null;

    const gl = this.gl;
    if (typeof gl.deleteQuery === 'function') {
      for (let i = 0; i < 2; i++) {
        if (this._timerQueries[i] !== null) {
          gl.deleteQuery(this._timerQueries[i]);
          this._timerQueries[i] = null;
        }
      }
    }

    this.ubo.dispose(state);
    this.shaderLib.dispose();
    this.renderList.dispose();
    this._visible.length = 0;
    this._lodNodes.length = 0;
  }
}
