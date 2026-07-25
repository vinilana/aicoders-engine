/**
 * Engine - high level entry point tying the whole runtime together.
 *
 * Creates the WebGL2 context, the renderer, a default scene and camera, the
 * input layer and the frame loop. Nothing in this module touches the DOM at
 * import time: every `window`/`document` access happens inside the constructor
 * or inside methods, so the file can be imported headless.
 *
 * @module core/Engine
 */

import { createGLContext } from '../render/GLContext.js';
import { Renderer } from '../render/Renderer.js';
import { Scene } from '../scene/Scene.js';
import { PerspectiveCamera } from '../scene/PerspectiveCamera.js';
import { Input } from '../input/Input.js';
import { Stats } from '../util/Stats.js';
import { EventBus } from './EventBus.js';
import { Time } from './Time.js';
import { Logger } from './Logger.js';

/** Maximum number of fixed steps simulated in a single frame. */
const MAX_SUBSTEPS = 5;
/** Default cap applied to devicePixelRatio. */
const DEFAULT_MAX_PIXEL_RATIO = 2;
/** Fallback frame interval, milliseconds, when requestAnimationFrame is absent. */
const FALLBACK_FRAME_MS = 16;

/**
 * Marks every GPU-backed attribute of a geometry as needing a re-upload.
 * Used after a context restore; kept at module scope so no closure is built.
 * @private
 * @param {Object} attribute Geometry attribute descriptor.
 */
function markAttributeDirty(attribute) {
  if (attribute === null || attribute === undefined) return;
  attribute.needsUpdate = true;
  attribute.buffer = null;
}

/**
 * Invalidates every GPU resource referenced by a node after a context loss.
 * @private
 * @param {Object} node Scene node.
 */
function markNodeDirty(node) {
  const geometry = node.geometry;
  if (geometry !== undefined && geometry !== null) {
    const attributes = geometry.attributes;
    if (attributes !== undefined && attributes !== null && typeof attributes.forEach === 'function') {
      attributes.forEach(markAttributeDirty);
    }
    const index = geometry.index;
    if (index !== undefined && index !== null) {
      index.needsUpdate = true;
      index.buffer = null;
    }
    // The cached VAO belongs to the lost context; drop whichever field holds it.
    if ('_vao' in geometry) geometry._vao = null;
    if ('vao' in geometry) geometry.vao = null;
  }

  const material = node.material;
  if (material === undefined || material === null) return;
  if (Array.isArray(material)) {
    for (let i = 0, n = material.length; i < n; i++) {
      if (material[i] !== null && material[i] !== undefined) material[i].needsUpdate = true;
    }
  } else {
    material.needsUpdate = true;
  }
}

/**
 * A registered fixed-timestep callback with its own accumulator.
 * @private
 */
class FixedStep {
  /**
   * @param {Function} fn Callback invoked as `fn(step, time)`.
   * @param {number} hz Simulation frequency in hertz.
   */
  constructor(fn, hz) {
    this.fn = fn;
    this.hz = hz;
    this.step = 1 / hz;
    this.accumulator = 0;
    /** @type {number} Interpolation factor towards the next step, 0..1. */
    this.alpha = 0;
  }
}

export class Engine {
  /**
   * @param {Object} [options] Configuration.
   * @param {HTMLCanvasElement|string} [options.canvas] Existing canvas or a
   *   selector/id. When omitted a canvas is created and appended.
   * @param {HTMLElement} [options.container] Parent for a created canvas.
   * @param {number} [options.width] Fixed CSS width; omit to follow layout.
   * @param {number} [options.height] Fixed CSS height; omit to follow layout.
   * @param {number} [options.pixelRatio] Forced pixel ratio.
   * @param {number} [options.maxPixelRatio=2] Cap applied to devicePixelRatio.
   * @param {boolean} [options.antialias=true] Request MSAA on the default FBO.
   * @param {boolean} [options.shadows=true] Enable the shadow mapper.
   * @param {boolean} [options.hdr=true] Render through an HDR target.
   * @param {boolean} [options.clustered=true] Enable clustered lighting.
   * @param {boolean|Object|Stats} [options.stats=false] Performance overlay.
   * @param {boolean} [options.autoResize=true] Track layout size changes.
   * @param {boolean} [options.pauseWhenHidden=true] Pause while the tab is hidden.
   */
  constructor(options = {}) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (doc === null) {
      throw new Error('Engine: ambiente sem DOM. A Engine precisa de um documento com um <canvas>.');
    }
    const win = typeof window !== 'undefined' ? window : null;

    /** @private @type {Document} */
    this._document = doc;
    /** @private @type {Window|null} */
    this._window = win;
    /** @private @type {Object} Frozen copy of the user options. */
    this.options = options;

    /** @type {HTMLCanvasElement} Canvas the engine renders into. */
    this.canvas = this._resolveCanvas(doc, options);

    /** @type {number} Cap applied to devicePixelRatio. */
    this.maxPixelRatio = options.maxPixelRatio !== undefined
      ? options.maxPixelRatio
      : DEFAULT_MAX_PIXEL_RATIO;
    /** @private @type {number|undefined} User forced pixel ratio, if any. */
    this._forcedPixelRatio = options.pixelRatio;
    /** @private @type {number} Fixed CSS width, 0 = follow layout. */
    this._fixedWidth = options.width > 0 ? Math.floor(options.width) : 0;
    /** @private @type {number} Fixed CSS height, 0 = follow layout. */
    this._fixedHeight = options.height > 0 ? Math.floor(options.height) : 0;

    /** @type {number} Current CSS width in pixels. */
    this.width = 1;
    /** @type {number} Current CSS height in pixels. */
    this.height = 1;
    /** @type {number} Current device pixel ratio in use. */
    this.pixelRatio = this._resolvePixelRatio();

    /** @type {EventBus} Engine wide event bus. */
    this.events = new EventBus();
    /** @type {Time} Frame clock. */
    this.time = new Time();

    const context = createGLContext(this.canvas, {
      antialias: options.antialias !== false,
      alpha: options.alpha === true,
      depth: true,
      stencil: options.stencil === true,
      premultipliedAlpha: options.premultipliedAlpha !== false,
      preserveDrawingBuffer: options.preserveDrawingBuffer === true,
      powerPreference: options.powerPreference || 'high-performance',
      desynchronized: options.desynchronized === true,
      failIfMajorPerformanceCaveat: options.failIfMajorPerformanceCaveat === true
    });

    /** @type {WebGL2RenderingContext} Raw GL context. */
    this.gl = context.gl;
    /** @type {Object} Detected device capabilities. */
    this.caps = context.caps;
    /** @private @type {Function} Forces a context loss (debug helper). */
    this._loseContext = typeof context.lose === 'function' ? context.lose : null;

    /** @private @type {Object} Options forwarded to the renderer. */
    this._rendererOptions = {
      shadows: options.shadows !== false,
      clustered: options.clustered !== false,
      hdr: options.hdr !== false,
      postprocessing: options.postprocessing !== false,
      msaa: options.msaa !== undefined ? options.msaa : 0,
      toneMapping: options.toneMapping !== undefined ? options.toneMapping : 'aces',
      exposure: options.exposure !== undefined ? options.exposure : 1,
      shadowMapSize: options.shadowMapSize !== undefined ? options.shadowMapSize : 2048,
      cascades: options.cascades !== undefined ? options.cascades : 4,
      maxLights: options.maxLights !== undefined ? options.maxLights : 1024,
      pixelRatio: this.pixelRatio
    };

    /** @type {Renderer} Rendering backend. */
    this.renderer = new Renderer(this.gl, this.caps, this._rendererOptions);
    /** @type {Scene} Active scene. */
    this.scene = new Scene();
    /** @type {PerspectiveCamera} Active camera. */
    this.camera = this._createDefaultCamera(options);
    /** @type {Input} Keyboard/mouse/touch/gamepad state. */
    this.input = new Input(options.inputTarget || win || this.canvas, this.canvas);

    /** @type {Stats|null} Performance overlay, when enabled. */
    this.stats = this._createStats(options);

    /** @type {boolean} True between `start()` and `stop()`. */
    this.running = false;
    /** @type {Array<Object>} Animation mixers updated every frame. */
    this.mixers = [];
    /** @type {Array<Object>} Objects with an `update(dt, time)` method. */
    this.updatables = [];

    /** @private @type {Function[]} */
    this._updateCallbacks = [];
    /** @private @type {FixedStep[]} */
    this._fixedSteps = [];
    /** @private @type {Function[]} */
    this._renderCallbacks = [];

    /** @private @type {number} requestAnimationFrame handle, 0 when idle. */
    this._rafId = 0;
    /** @private @type {boolean} True while paused by the visibility handler. */
    this._paused = false;
    /** @private @type {boolean} True between contextlost and contextrestored. */
    this._contextLost = false;
    /** @private @type {boolean} Set when the layout size must be re-read. */
    this._resizeDirty = false;
    /** @private @type {boolean} True once a size has been applied. */
    this._sized = false;
    /** @private @type {ResizeObserver|null} */
    this._resizeObserver = null;
    /** @private @type {boolean} Whether the engine drives the canvas CSS size. */
    this._ownsCanvasStyle = this._fixedWidth > 0 && this._fixedHeight > 0;
    /** @private @type {boolean} */
    this._disposed = false;

    // Bound handlers, created once so they can be removed later.
    /** @private */
    this._boundFrame = (now) => this._frame(now);
    /** @private */
    this._boundResize = () => this._requestResize();
    /** @private */
    this._boundVisibility = () => this._onVisibilityChange();
    /** @private */
    this._boundContextLost = (event) => this._onContextLost(event);
    /** @private */
    this._boundContextRestored = (event) => this._onContextRestored(event);

    /** @private @type {Function} */
    this._raf = (win !== null && typeof win.requestAnimationFrame === 'function')
      ? win.requestAnimationFrame.bind(win)
      : (cb) => setTimeout(() => cb(Date.now()), FALLBACK_FRAME_MS);
    /** @private @type {Function} */
    this._caf = (win !== null && typeof win.cancelAnimationFrame === 'function')
      ? win.cancelAnimationFrame.bind(win)
      : clearTimeout;

    this._installListeners(options);
    this._applyLayoutSize();

    if (options.autoStart === true) this.start();
  }

  /* -------------------------------------------------------------------- */
  /* Construction helpers                                                  */
  /* -------------------------------------------------------------------- */

  /**
   * Finds or creates the canvas element.
   * @private
   * @param {Document} doc Owner document.
   * @param {Object} options Engine options.
   * @returns {HTMLCanvasElement} The canvas to render into.
   */
  _resolveCanvas(doc, options) {
    let canvas = options.canvas;

    if (typeof canvas === 'string') {
      const found = doc.getElementById(canvas) || doc.querySelector(canvas);
      if (found === null || found === undefined) {
        throw new Error('Engine: nenhum elemento encontrado para o seletor "' + canvas + '".');
      }
      canvas = found;
    }

    if (canvas === undefined || canvas === null) {
      canvas = doc.createElement('canvas');
      canvas.style.cssText = 'display:block;width:100%;height:100%;';
      const container = options.container || doc.body;
      if (container === null || container === undefined) {
        throw new Error('Engine: nao ha um container valido para anexar o canvas.');
      }
      container.appendChild(canvas);
      return canvas;
    }

    if (typeof canvas.getContext !== 'function') {
      throw new Error('Engine: a opcao "canvas" nao aponta para um elemento <canvas>.');
    }
    return canvas;
  }

  /**
   * Computes the pixel ratio currently in effect.
   * @private
   * @returns {number} Device pixel ratio, clamped.
   */
  _resolvePixelRatio() {
    if (this._forcedPixelRatio > 0) return this._forcedPixelRatio;
    const win = this._window;
    const dpr = win !== null && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
    return dpr > this.maxPixelRatio ? this.maxPixelRatio : dpr;
  }

  /**
   * Builds the default perspective camera. Fields are assigned explicitly so
   * the engine does not depend on the camera constructor signature.
   * @private
   * @param {Object} options Engine options.
   * @returns {PerspectiveCamera} The camera.
   */
  _createDefaultCamera(options) {
    const fov = options.fov !== undefined ? options.fov : 60;
    const near = options.near !== undefined ? options.near : 0.1;
    const far = options.far !== undefined ? options.far : 1000;
    const camera = new PerspectiveCamera(fov, 1, near, far);
    camera.fov = fov;
    camera.aspect = 1;
    camera.near = near;
    camera.far = far;
    camera.name = camera.name || 'MainCamera';
    if (typeof camera.updateProjection === 'function') camera.updateProjection();
    return camera;
  }

  /**
   * Instantiates the stats overlay when requested.
   * @private
   * @param {Object} options Engine options.
   * @returns {Stats|null} The overlay or null.
   */
  _createStats(options) {
    const requested = options.stats;
    if (!requested) return null;
    if (typeof requested === 'object' && typeof requested.begin === 'function') {
      return requested;
    }
    if (typeof requested === 'object') {
      const config = {
        gl: this.gl,
        container: requested.container,
        position: requested.position,
        visible: requested.visible,
        maxPixelRatio: this.maxPixelRatio
      };
      return new Stats(config);
    }
    return new Stats(this);
  }

  /**
   * Attaches every DOM listener the engine needs.
   * @private
   * @param {Object} options Engine options.
   */
  _installListeners(options) {
    const doc = this._document;
    const win = this._window;
    const canvas = this.canvas;

    canvas.addEventListener('webglcontextlost', this._boundContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._boundContextRestored, false);

    if (options.pauseWhenHidden !== false && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', this._boundVisibility, false);
      /** @private */
      this._visibilityInstalled = true;
    } else {
      this._visibilityInstalled = false;
    }

    if (options.autoResize === false) {
      this._autoResize = false;
      return;
    }
    /** @private @type {boolean} */
    this._autoResize = true;

    if (win !== null && typeof win.ResizeObserver === 'function') {
      this._resizeObserver = new win.ResizeObserver(this._boundResize);
      const observed = canvas.parentNode && canvas.parentNode.nodeType === 1
        ? canvas.parentNode
        : canvas;
      this._resizeObserver.observe(observed);
    }
    if (win !== null && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', this._boundResize, { passive: true });
      /** @private */
      this._windowResizeInstalled = true;
    } else {
      this._windowResizeInstalled = false;
    }
  }

  /* -------------------------------------------------------------------- */
  /* Sizing                                                                */
  /* -------------------------------------------------------------------- */

  /**
   * Reads the CSS size that the canvas should have and applies it.
   * @private
   */
  _applyLayoutSize() {
    let w = this._fixedWidth;
    let h = this._fixedHeight;

    if (w === 0 || h === 0) {
      const canvas = this.canvas;
      const parent = canvas.parentNode;
      let cw = canvas.clientWidth;
      let ch = canvas.clientHeight;
      if ((cw === 0 || ch === 0) && parent !== null && parent !== undefined) {
        cw = parent.clientWidth || cw;
        ch = parent.clientHeight || ch;
      }
      const win = this._window;
      if (cw === 0 && win !== null) cw = win.innerWidth || 800;
      if (ch === 0 && win !== null) ch = win.innerHeight || 600;
      w = w === 0 ? (cw || 800) : w;
      h = h === 0 ? (ch || 600) : h;
    }

    this.resize(w, h, this._resolvePixelRatio());
  }

  /**
   * Defers the resize to the next frame to avoid layout thrashing (and the
   * classic "ResizeObserver loop" warning). Applies immediately when idle.
   * @private
   */
  _requestResize() {
    if (this._disposed) return;
    if (this.running && !this._paused) {
      this._resizeDirty = true;
      return;
    }
    this._applyLayoutSize();
  }

  /**
   * Resizes the drawing buffer, the renderer and the camera projection.
   * @param {number} width New CSS width in pixels.
   * @param {number} height New CSS height in pixels.
   * @param {number} [pixelRatio] Optional pixel ratio override.
   * @returns {Engine} this
   */
  resize(width, height, pixelRatio) {
    const w = width > 1 ? Math.floor(width) : 1;
    const h = height > 1 ? Math.floor(height) : 1;
    const pr = pixelRatio > 0 ? pixelRatio : this.pixelRatio;

    if (this._sized && w === this.width && h === this.height && pr === this.pixelRatio) {
      return this;
    }

    this.width = w;
    this.height = h;
    this.pixelRatio = pr;
    this._rendererOptions.pixelRatio = pr;
    this._sized = true;

    const canvas = this.canvas;
    const bufferW = Math.max(1, Math.round(w * pr));
    const bufferH = Math.max(1, Math.round(h * pr));
    if (canvas.width !== bufferW) canvas.width = bufferW;
    if (canvas.height !== bufferH) canvas.height = bufferH;
    if (this._ownsCanvasStyle && canvas.style !== undefined) {
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }

    const renderer = this.renderer;
    if (renderer !== null && renderer !== undefined && typeof renderer.setSize === 'function') {
      renderer.setSize(w, h, pr);
    }

    const camera = this.camera;
    if (camera !== null && camera !== undefined) {
      if (camera.aspect !== undefined) camera.aspect = w / h;
      if (typeof camera.updateProjection === 'function') camera.updateProjection();
    }

    this.events.emit('resize', w, h);
    return this;
  }

  /**
   * Forces a pixel ratio (pass 0 to go back to automatic tracking).
   * @param {number} value Pixel ratio, or 0 for automatic.
   * @returns {Engine} this
   */
  setPixelRatio(value) {
    this._forcedPixelRatio = value > 0 ? value : undefined;
    return this.resize(this.width, this.height, this._resolvePixelRatio());
  }

  /* -------------------------------------------------------------------- */
  /* Callback registration                                                 */
  /* -------------------------------------------------------------------- */

  /**
   * Registers a variable timestep callback, invoked before rendering.
   * @param {Function} fn `fn(dt, time)`.
   * @returns {Function} The same callback, for later removal.
   */
  onUpdate(fn) {
    if (typeof fn === 'function') this._updateCallbacks.push(fn);
    return fn;
  }

  /**
   * Unregisters a variable timestep callback.
   * @param {Function} fn Callback previously registered.
   * @returns {Engine} this
   */
  offUpdate(fn) {
    const list = this._updateCallbacks;
    for (let i = 0, n = list.length; i < n; i++) {
      if (list[i] === fn) {
        list.splice(i, 1);
        break;
      }
    }
    return this;
  }

  /**
   * Registers a fixed timestep callback driven by its own accumulator.
   * At most {@link MAX_SUBSTEPS} steps run per frame; any remaining backlog is
   * dropped so a stall cannot spiral into an ever growing catch-up.
   * @param {Function} fn `fn(step, time)` where `step` is `1 / hz`.
   * @param {number} [hz=60] Simulation frequency.
   * @returns {Function} The same callback, for later removal.
   */
  onFixedUpdate(fn, hz = 60) {
    if (typeof fn !== 'function') return fn;
    const rate = hz > 0 ? hz : 60;
    this._fixedSteps.push(new FixedStep(fn, rate));
    return fn;
  }

  /**
   * Unregisters a fixed timestep callback.
   * @param {Function} fn Callback previously registered.
   * @returns {Engine} this
   */
  offFixedUpdate(fn) {
    const list = this._fixedSteps;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === fn) list.splice(i, 1);
    }
    return this;
  }

  /**
   * Registers a callback invoked right after `renderer.render()`, useful for
   * debug overlays drawn on top of the frame.
   * @param {Function} fn `fn(renderer, camera, dt)`.
   * @returns {Function} The same callback, for later removal.
   */
  onRender(fn) {
    if (typeof fn === 'function') this._renderCallbacks.push(fn);
    return fn;
  }

  /**
   * Unregisters a render callback.
   * @param {Function} fn Callback previously registered.
   * @returns {Engine} this
   */
  offRender(fn) {
    const list = this._renderCallbacks;
    for (let i = 0, n = list.length; i < n; i++) {
      if (list[i] === fn) {
        list.splice(i, 1);
        break;
      }
    }
    return this;
  }

  /**
   * Registers an animation mixer updated every frame with the scaled delta.
   * @param {Object} mixer Object exposing `update(dt)`.
   * @returns {Object} The mixer.
   */
  addMixer(mixer) {
    if (mixer !== null && mixer !== undefined && this.mixers.indexOf(mixer) === -1) {
      this.mixers.push(mixer);
    }
    return mixer;
  }

  /**
   * Removes a previously registered animation mixer.
   * @param {Object} mixer Mixer to remove.
   * @returns {Engine} this
   */
  removeMixer(mixer) {
    const index = this.mixers.indexOf(mixer);
    if (index !== -1) this.mixers.splice(index, 1);
    return this;
  }

  /**
   * Registers an object updated every frame (controls, character controllers,
   * physics worlds, ...). Anything exposing `update(dt, time)` works.
   * @param {Object} object Object to update.
   * @returns {Object} The object.
   */
  addUpdatable(object) {
    if (object !== null && object !== undefined && typeof object.update === 'function' &&
        this.updatables.indexOf(object) === -1) {
      this.updatables.push(object);
    }
    return object;
  }

  /**
   * Removes a previously registered updatable.
   * @param {Object} object Object to remove.
   * @returns {Engine} this
   */
  removeUpdatable(object) {
    const index = this.updatables.indexOf(object);
    if (index !== -1) this.updatables.splice(index, 1);
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Scene / camera                                                        */
  /* -------------------------------------------------------------------- */

  /**
   * Replaces the active scene.
   * @param {Scene} scene New scene.
   * @returns {Engine} this
   */
  setScene(scene) {
    if (scene === null || scene === undefined) return this;
    this.scene = scene;
    this.events.emit('scenechange', scene);
    return this;
  }

  /**
   * Replaces the active camera and refreshes its projection for the current
   * viewport aspect ratio.
   * @param {Camera} camera New camera.
   * @returns {Engine} this
   */
  setCamera(camera) {
    if (camera === null || camera === undefined) return this;
    this.camera = camera;
    if (camera.aspect !== undefined) camera.aspect = this.width / this.height;
    if (typeof camera.updateProjection === 'function') camera.updateProjection();
    this.events.emit('camerachange', camera);
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Loop                                                                  */
  /* -------------------------------------------------------------------- */

  /**
   * Starts the frame loop.
   * @returns {Engine} this
   */
  start() {
    if (this._disposed) {
      throw new Error('Engine: start() chamado apos dispose().');
    }
    if (this.running) return this;
    this.running = true;
    this._paused = this._visibilityInstalled === true && this._document.hidden === true;
    this.time.resync();
    this.events.emit('start', this);
    if (!this._paused && !this._contextLost) this._scheduleFrame();
    return this;
  }

  /**
   * Stops the frame loop. State is preserved, `start()` resumes cleanly.
   * @returns {Engine} this
   */
  stop() {
    if (!this.running) return this;
    this.running = false;
    this._cancelFrame();
    this.events.emit('stop', this);
    return this;
  }

  /**
   * Runs a single frame manually. Useful for tests and for step-by-step
   * debugging while the loop is stopped.
   * @param {number} [nowMs] Timestamp in milliseconds.
   * @returns {Engine} this
   */
  tick(nowMs) {
    const now = nowMs !== undefined ? nowMs : this._nowMs();
    this._runFrame(now);
    return this;
  }

  /**
   * Current timestamp in milliseconds.
   * @private
   * @returns {number} Monotonic time.
   */
  _nowMs() {
    const win = this._window;
    if (win !== null && win.performance && typeof win.performance.now === 'function') {
      return win.performance.now();
    }
    return Date.now();
  }

  /** Schedules the next animation frame if none is pending. @private */
  _scheduleFrame() {
    if (this._rafId === 0) this._rafId = this._raf(this._boundFrame);
  }

  /** Cancels a pending animation frame. @private */
  _cancelFrame() {
    if (this._rafId !== 0) {
      this._caf(this._rafId);
      this._rafId = 0;
    }
  }

  /**
   * requestAnimationFrame entry point.
   * @private
   * @param {number} nowMs Timestamp provided by the browser.
   */
  _frame(nowMs) {
    this._rafId = 0;
    if (!this.running || this._paused || this._contextLost || this._disposed) return;
    this._scheduleFrame();
    this._runFrame(nowMs);
  }

  /**
   * Executes one full frame: fixed steps, variable update, animation, render.
   * Deliberately free of allocations and of try/catch.
   * @private
   * @param {number} nowMs Frame timestamp in milliseconds.
   */
  _runFrame(nowMs) {
    const stats = this.stats;
    if (stats !== null) stats.begin();

    if (this._resizeDirty) {
      this._resizeDirty = false;
      this._applyLayoutSize();
    }

    const time = this.time;
    time.update(nowMs);
    const dt = time.delta;

    // 1. Fixed timestep callbacks (physics and anything deterministic).
    const fixedSteps = this._fixedSteps;
    for (let i = 0, n = fixedSteps.length; i < n; i++) {
      const entry = fixedSteps[i];
      const step = entry.step;
      entry.accumulator += dt;
      let steps = 0;
      while (entry.accumulator >= step && steps < MAX_SUBSTEPS) {
        entry.fn(step, time);
        entry.accumulator -= step;
        steps++;
      }
      if (entry.accumulator >= step) entry.accumulator = 0; // drop the backlog
      entry.alpha = entry.accumulator / step;
    }

    // 2. Variable timestep logic.
    const updates = this._updateCallbacks;
    for (let i = 0, n = updates.length; i < n; i++) updates[i](dt, time);

    const updatables = this.updatables;
    for (let i = 0, n = updatables.length; i < n; i++) updatables[i].update(dt, time);

    this.events.emit('update', dt, time);

    // 3. Skeletal / property animation.
    const mixers = this.mixers;
    for (let i = 0, n = mixers.length; i < n; i++) mixers[i].update(dt);

    // 4. Render. The renderer owns matrix updates, culling, LOD selection,
    //    shadows, lighting and post processing (see Renderer.render).
    const renderer = this.renderer;
    const camera = this.camera;
    renderer.render(this.scene, camera);

    const renderCallbacks = this._renderCallbacks;
    for (let i = 0, n = renderCallbacks.length; i < n; i++) {
      renderCallbacks[i](renderer, camera, dt);
    }

    this.events.emit('render', renderer, camera);

    // 5. Roll input edge states for the next frame.
    const input = this.input;
    if (input !== null && input !== undefined && typeof input.update === 'function') {
      input.update();
    }

    if (stats !== null) {
      stats.end();
      stats.update(renderer);
    }
  }

  /* -------------------------------------------------------------------- */
  /* Browser events                                                        */
  /* -------------------------------------------------------------------- */

  /**
   * Pauses while the document is hidden and resumes without a time jump.
   * @private
   */
  _onVisibilityChange() {
    const hidden = this._document.hidden === true;
    if (hidden) {
      if (!this._paused) {
        this._paused = true;
        this._cancelFrame();
        this.events.emit('pause', this);
      }
      return;
    }
    if (this._paused) {
      this._paused = false;
      this.time.resync();
      this.events.emit('resume', this);
      if (this.running && !this._contextLost && !this._disposed) this._scheduleFrame();
    }
  }

  /**
   * WebGL context loss: freeze the loop and let the application know.
   * @private
   * @param {Event} event The contextlost event.
   */
  _onContextLost(event) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    this._contextLost = true;
    this._cancelFrame();
    Logger.warn('Engine: contexto WebGL perdido; aguardando restauracao.');
    this.events.emit('contextlost', event);
  }

  /**
   * WebGL context restore: rebuild the renderer and invalidate every GPU
   * resource referenced by the scene so it is re-uploaded on the next frame.
   * @private
   * @param {Event} event The contextrestored event.
   */
  _onContextRestored(event) {
    this._contextLost = false;
    Logger.info('Engine: contexto WebGL restaurado; recriando recursos.');

    const previous = this.renderer;
    this.renderer = null;
    if (previous !== null && previous !== undefined && typeof previous.dispose === 'function') {
      try {
        previous.dispose();
      } catch (error) {
        Logger.warn('Engine: falha ao descartar o renderer antigo.', error);
      }
    }

    this.renderer = new Renderer(this.gl, this.caps, this._rendererOptions);
    this._markSceneResourcesDirty();
    this._sized = false;
    this.resize(this.width, this.height, this.pixelRatio);

    this.events.emit('contextrestored', event);

    this.time.resync();
    if (this.running && !this._paused && !this._disposed) this._scheduleFrame();
  }

  /**
   * Walks the scene invalidating buffers, VAOs and programs.
   * @private
   */
  _markSceneResourcesDirty() {
    const scene = this.scene;
    if (scene === null || scene === undefined || typeof scene.traverse !== 'function') return;
    scene.traverse(markNodeDirty);
  }

  /**
   * Forces a context loss through WEBGL_lose_context. Debug helper.
   * @returns {Engine} this
   */
  loseContext() {
    if (this._loseContext !== null) this._loseContext();
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Teardown                                                              */
  /* -------------------------------------------------------------------- */

  /**
   * Stops the loop, detaches every listener and releases GPU resources.
   * The instance must not be used afterwards.
   */
  dispose() {
    if (this._disposed) return;
    this.stop();
    this._disposed = true;

    const canvas = this.canvas;
    canvas.removeEventListener('webglcontextlost', this._boundContextLost, false);
    canvas.removeEventListener('webglcontextrestored', this._boundContextRestored, false);

    if (this._visibilityInstalled === true) {
      this._document.removeEventListener('visibilitychange', this._boundVisibility, false);
      this._visibilityInstalled = false;
    }
    if (this._windowResizeInstalled === true && this._window !== null) {
      this._window.removeEventListener('resize', this._boundResize);
      this._windowResizeInstalled = false;
    }
    if (this._resizeObserver !== null) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this.stats !== null && typeof this.stats.dispose === 'function') this.stats.dispose();
    this.stats = null;

    if (this.input !== null && typeof this.input.dispose === 'function') this.input.dispose();

    if (this.scene !== null && typeof this.scene.dispose === 'function') this.scene.dispose();

    if (this.renderer !== null && typeof this.renderer.dispose === 'function') {
      this.renderer.dispose();
    }

    this._updateCallbacks.length = 0;
    this._fixedSteps.length = 0;
    this._renderCallbacks.length = 0;
    this.mixers.length = 0;
    this.updatables.length = 0;

    this.events.clear();
  }
}
