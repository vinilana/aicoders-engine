/**
 * Stats - self contained performance overlay drawn on a 2D canvas.
 *
 * No third party code and no DOM access at module scope. GPU timings come from
 * EXT_disjoint_timer_query_webgl2 through a pool of asynchronous queries: the
 * result of a frame is read back several frames later, so the CPU never stalls
 * waiting for the GPU.
 *
 * @module util/Stats
 */

/** Number of history samples kept per graph. */
const SAMPLES = 120;
/** Overlay width in CSS pixels. */
const PANEL_W = 188;
/** Height of a single graph panel in CSS pixels. */
const PANEL_H = 34;
/** Height of the textual footer in CSS pixels. */
const FOOTER_H = 16;
/** Inner padding in CSS pixels. */
const PAD = 3;
/** Overlay font. */
const FONT = 'bold 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** Interval between label string rebuilds, milliseconds. */
const TEXT_INTERVAL = 200;
/** Maximum GPU queries kept in flight before new ones are skipped. */
const MAX_PENDING_QUERIES = 6;

/**
 * A single graph: ring buffer of samples plus cached label.
 * @private
 */
class Panel {
  /**
   * @param {string} label Short caption.
   * @param {string} unit Unit suffix appended to the current value.
   * @param {string} color Stroke/text color.
   * @param {string} fill Fill color under the curve.
   * @param {number} decimals Digits shown after the decimal point.
   * @param {number} minRange Lower bound for the graph vertical scale.
   */
  constructor(label, unit, color, fill, decimals, minRange) {
    this.label = label;
    this.unit = unit;
    this.color = color;
    this.fill = fill;
    this.decimals = decimals;
    this.minRange = minRange;
    this.values = new Float32Array(SAMPLES);
    this.head = 0;
    this.count = 0;
    this.value = 0;
    this.min = 0;
    this.max = 0;
    this.text = label;
  }

  /**
   * Appends a sample to the ring buffer.
   * @param {number} value Sample value.
   */
  push(value) {
    const v = value === value ? value : 0; // NaN guard
    this.value = v;
    this.values[this.head] = v;
    this.head = this.head + 1 === SAMPLES ? 0 : this.head + 1;
    if (this.count < SAMPLES) this.count++;
  }

  /** Recomputes min/max over the retained window. */
  computeRange() {
    const n = this.count;
    if (n === 0) {
      this.min = 0;
      this.max = this.minRange;
      return;
    }
    let min = Infinity;
    let max = -Infinity;
    const values = this.values;
    let index = this.head - n;
    if (index < 0) index += SAMPLES;
    for (let i = 0; i < n; i++) {
      const v = values[index];
      if (v < min) min = v;
      if (v > max) max = v;
      index = index + 1 === SAMPLES ? 0 : index + 1;
    }
    this.min = min;
    this.max = max;
  }

  /** Rebuilds the cached label string. */
  refreshText() {
    const d = this.decimals;
    this.text = this.label + ' ' + this.value.toFixed(d) + this.unit +
      ' (' + this.min.toFixed(d) + '-' + this.max.toFixed(d) + ')';
  }
}

/**
 * Asynchronous GPU timer built on EXT_disjoint_timer_query_webgl2.
 * @private
 */
class GPUTimer {
  /**
   * @param {WebGL2RenderingContext} gl GL context.
   */
  constructor(gl) {
    this.gl = gl;
    this.ext = null;
    if (gl !== null && gl !== undefined && typeof gl.getExtension === 'function') {
      this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    }
    /** @type {boolean} True when GPU timing is usable. */
    this.supported = this.ext !== null && this.ext !== undefined &&
      typeof gl.createQuery === 'function';
    /** @type {number} Last resolved GPU time in milliseconds. */
    this.timeMs = 0;
    /** @private @type {WebGLQuery[]} Recycled query objects. */
    this._freeQueries = [];
    /** @private @type {WebGLQuery[]} Queries awaiting their result. */
    this._pending = [];
    /** @private @type {number} Read cursor into `_pending`. */
    this._pendingHead = 0;
    /** @private @type {WebGLQuery|null} Query currently recording. */
    this._active = null;
  }

  /** Starts recording GPU time for the current frame. */
  begin() {
    if (!this.supported || this._active !== null) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this._pending.length - this._pendingHead >= MAX_PENDING_QUERIES) return;
    const query = this._freeQueries.length > 0 ? this._freeQueries.pop() : gl.createQuery();
    if (query === null) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this._active = query;
  }

  /** Stops recording and queues the query for a later, non blocking read. */
  end() {
    if (this._active === null) return;
    const gl = this.gl;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._pending.push(this._active);
    this._active = null;
  }

  /**
   * Drains every query whose result is already available.
   * @returns {number} The most recent GPU time in milliseconds.
   */
  poll() {
    if (!this.supported) return 0;
    const gl = this.gl;
    if (gl.isContextLost()) return this.timeMs;
    const pending = this._pending;
    while (this._pendingHead < pending.length) {
      const query = pending[this._pendingHead];
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      if (!available) break;
      this._pendingHead++;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        this.timeMs = gl.getQueryParameter(query, gl.QUERY_RESULT) * 1e-6;
      }
      this._freeQueries.push(query);
    }
    if (this._pendingHead > 0 && this._pendingHead === pending.length) {
      pending.length = 0;
      this._pendingHead = 0;
    }
    return this.timeMs;
  }

  /** Deletes every GL query owned by the timer. */
  dispose() {
    const gl = this.gl;
    if (gl === null || gl === undefined || typeof gl.deleteQuery !== 'function') return;
    if (!gl.isContextLost()) {
      if (this._active !== null) {
        gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        gl.deleteQuery(this._active);
      }
      const pending = this._pending;
      for (let i = this._pendingHead, n = pending.length; i < n; i++) gl.deleteQuery(pending[i]);
      const free = this._freeQueries;
      for (let i = 0, n = free.length; i < n; i++) gl.deleteQuery(free[i]);
    }
    this._active = null;
    this._pending.length = 0;
    this._pendingHead = 0;
    this._freeQueries.length = 0;
    this.supported = false;
  }
}

export class Stats {
  /**
   * @param {Object} engineOrOptions Either an Engine instance (its `gl` and
   *   `canvas` are picked up automatically) or an options object:
   *   `{ gl, container, visible, position, maxPixelRatio }`.
   */
  constructor(engineOrOptions) {
    const source = engineOrOptions || {};
    const isEngine = source.gl !== undefined && source.canvas !== undefined;
    const options = isEngine ? {} : source;

    /** @type {WebGL2RenderingContext|null} */
    this.gl = source.gl !== undefined ? source.gl : (options.gl || null);

    const doc = typeof document !== 'undefined' ? document : null;
    const win = typeof window !== 'undefined' ? window : null;

    /** @private */
    this._document = doc;
    /** @private @type {Function} Monotonic clock in milliseconds. */
    this._now = (win !== null && win.performance && typeof win.performance.now === 'function')
      ? win.performance.now.bind(win.performance)
      : Date.now;

    const maxPixelRatio = options.maxPixelRatio !== undefined ? options.maxPixelRatio : 2;
    /** @private @type {number} */
    this._dpr = win !== null && win.devicePixelRatio
      ? Math.min(win.devicePixelRatio, maxPixelRatio)
      : 1;

    /** @private @type {GPUTimer} */
    this._gpuTimer = new GPUTimer(this.gl);

    /** @type {Panel[]} Graph panels in draw order. */
    this.panels = [];
    /** @private */
    this._fpsPanel = new Panel('FPS', '', '#4ade80', 'rgba(74,222,128,0.22)', 0, 60);
    /** @private */
    this._cpuPanel = new Panel('CPU', 'ms', '#60a5fa', 'rgba(96,165,250,0.22)', 2, 4);
    /** @private */
    this._gpuPanel = new Panel('GPU', 'ms', '#f472b6', 'rgba(244,114,182,0.22)', 2, 4);
    /** @private */
    this._drawsPanel = new Panel('DRAW', '', '#fbbf24', 'rgba(251,191,36,0.22)', 0, 32);
    /** @private */
    this._triPanel = new Panel('TRIS', 'k', '#a78bfa', 'rgba(167,139,250,0.22)', 1, 32);

    this.panels.push(this._fpsPanel, this._cpuPanel);
    if (this._gpuTimer.supported) this.panels.push(this._gpuPanel);
    this.panels.push(this._drawsPanel, this._triPanel);

    /** @private @type {number} */
    this._width = PANEL_W;
    /** @private @type {number} */
    this._height = this.panels.length * PANEL_H + FOOTER_H;

    /** @type {HTMLElement|null} Overlay root element. */
    this.dom = null;
    /** @private @type {HTMLCanvasElement|null} */
    this._canvas = null;
    /** @private @type {CanvasRenderingContext2D|null} */
    this._ctx = null;

    /** @private @type {number} Timestamp captured by `begin`. */
    this._beginTime = 0;
    /** @private @type {number} Timestamp of the previous `update`. */
    this._lastFrameTime = 0;
    /** @private @type {number} Frames counted in the current fps window. */
    this._frames = 0;
    /** @private @type {number} Start of the current fps window. */
    this._fpsStart = 0;
    /** @private @type {number} Exponentially smoothed frames per second. */
    this._smoothFps = 60;
    /** @private @type {number} Last label rebuild timestamp. */
    this._lastTextTime = 0;
    /** @private @type {string} Cached footer string. */
    this._footerText = '';

    /** @type {number} Last measured CPU frame time in milliseconds. */
    this.cpuMs = 0;
    /** @type {number} Last resolved GPU frame time in milliseconds. */
    this.gpuMs = 0;
    /** @type {number} Frames per second over the last window. */
    this.fps = 0;
    /** @type {boolean} */
    this.visible = options.visible !== false;

    if (doc !== null) {
      this._createDom(doc, options, isEngine ? source : null);
    }
  }

  /**
   * Builds the overlay DOM. Only called when a document exists.
   * @private
   * @param {Document} doc Owner document.
   * @param {Object} options Constructor options.
   * @param {Object|null} engine Engine instance when one was supplied.
   */
  _createDom(doc, options, engine) {
    const root = doc.createElement('div');
    const position = options.position || 'top-left';
    let anchor = 'top:0;left:0;';
    if (position === 'top-right') anchor = 'top:0;right:0;';
    else if (position === 'bottom-left') anchor = 'bottom:0;left:0;';
    else if (position === 'bottom-right') anchor = 'bottom:0;right:0;';
    root.style.cssText = 'position:fixed;' + anchor +
      'z-index:100000;pointer-events:none;user-select:none;' +
      'width:' + this._width + 'px;height:' + this._height + 'px;';

    const canvas = doc.createElement('canvas');
    canvas.width = Math.round(this._width * this._dpr);
    canvas.height = Math.round(this._height * this._dpr);
    canvas.style.cssText = 'display:block;width:' + this._width + 'px;height:' + this._height + 'px;';
    root.appendChild(canvas);

    this.dom = root;
    this._canvas = canvas;
    this._ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;

    let container = options.container;
    if (container === undefined || container === null) {
      if (engine !== null && engine.canvas && engine.canvas.parentNode) {
        container = engine.canvas.parentNode;
      } else {
        container = doc.body;
      }
    }
    if (container && typeof container.appendChild === 'function') container.appendChild(root);
    if (!this.visible) root.style.display = 'none';
  }

  /** Marks the beginning of the measured region (CPU timer + GPU query). */
  begin() {
    this._beginTime = this._now();
    this._gpuTimer.begin();
  }

  /**
   * Marks the end of the measured region.
   * @returns {number} CPU milliseconds spent since `begin`.
   */
  end() {
    this.cpuMs = this._now() - this._beginTime;
    this._gpuTimer.end();
    return this.cpuMs;
  }

  /**
   * Pushes a new sample set and repaints the overlay.
   * @param {Object} [renderer] Renderer whose `info` block feeds the counters.
   * @returns {Stats} this
   */
  update(renderer) {
    const now = this._now();
    if (this._fpsStart === 0) this._fpsStart = now;

    // Per frame instantaneous fps, exponentially smoothed so the graph reads
    // well without hiding real spikes.
    const frameMs = this._lastFrameTime > 0 ? now - this._lastFrameTime : 0;
    this._lastFrameTime = now;
    if (frameMs > 0) {
      const instant = 1000 / frameMs;
      this._smoothFps += (instant - this._smoothFps) * 0.1;
    }
    this._fpsPanel.push(this._smoothFps);

    // Rolling window average exposed to the outside world.
    this._frames++;
    const windowMs = now - this._fpsStart;
    if (windowMs >= 500) {
      this.fps = (this._frames * 1000) / windowMs;
      this._fpsStart = now;
      this._frames = 0;
    }

    this.gpuMs = this._gpuTimer.poll();

    this._cpuPanel.push(this.cpuMs);
    if (this._gpuTimer.supported) this._gpuPanel.push(this.gpuMs);

    const info = renderer !== undefined && renderer !== null ? renderer.info : null;
    let calls = 0;
    let triangles = 0;
    if (info !== null && info !== undefined) {
      calls = info.calls || 0;
      triangles = info.triangles || 0;
    }
    this._drawsPanel.push(calls);
    this._triPanel.push(triangles * 0.001);

    if (now - this._lastTextTime >= TEXT_INTERVAL) {
      this._lastTextTime = now;
      const panels = this.panels;
      for (let i = 0, n = panels.length; i < n; i++) {
        panels[i].computeRange();
        panels[i].refreshText();
      }
      this._footerText = this._buildFooter(info);
    }

    if (this.visible) this._draw();
    return this;
  }

  /**
   * Builds the textual footer summarising resource counters.
   * @private
   * @param {Object|null} info Renderer info block.
   * @returns {string} Footer string.
   */
  _buildFooter(info) {
    if (info === null || info === undefined) return 'P:0 T:0 G:0';
    const programs = info.programs || 0;
    const textures = info.textures || 0;
    const geometries = info.geometries || 0;
    let text = 'P:' + programs + ' T:' + textures + ' G:' + geometries;
    const bytes = info.memoryBytes !== undefined
      ? info.memoryBytes
      : (info.memory && info.memory.buffers !== undefined ? info.memory.buffers : -1);
    if (bytes >= 0) text += ' ' + (bytes / 1048576).toFixed(1) + 'MB';
    if (info.visibleMeshes !== undefined) text += ' V:' + info.visibleMeshes;
    return text;
  }

  /**
   * Repaints the whole overlay. Cheap: a handful of small paths and up to six
   * cached text runs.
   * @private
   */
  _draw() {
    const ctx = this._ctx;
    if (ctx === null) return;
    const w = this._width;
    const h = this._height;

    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10,12,17,0.82)';
    ctx.fillRect(0, 0, w, h);

    ctx.font = FONT;
    ctx.textBaseline = 'top';

    const panels = this.panels;
    let y = 0;
    for (let i = 0, n = panels.length; i < n; i++) {
      this._drawGraph(ctx, panels[i], y, w);
      y += PANEL_H;
    }

    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(PAD, y + 1, w - PAD * 2, FOOTER_H - 3);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(this._footerText, PAD + 2, y + 3);
  }

  /**
   * Draws one graph panel.
   * @private
   * @param {CanvasRenderingContext2D} ctx Target context.
   * @param {Panel} panel Panel to draw.
   * @param {number} y Panel top in CSS pixels.
   * @param {number} w Overlay width in CSS pixels.
   */
  _drawGraph(ctx, panel, y, w) {
    const gx = PAD;
    const gy = y + 12;
    const gw = w - PAD * 2;
    const gh = PANEL_H - 14;

    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(gx, gy, gw, gh);

    const n = panel.count;
    if (n > 1) {
      let max = panel.minRange;
      const values = panel.values;
      let index = panel.head - n;
      if (index < 0) index += SAMPLES;
      const startIndex = index;
      for (let i = 0; i < n; i++) {
        const v = values[index];
        if (v > max) max = v;
        index = index + 1 === SAMPLES ? 0 : index + 1;
      }
      const invMax = max > 0 ? 1 / max : 0;
      const stepX = gw / (SAMPLES - 1);
      const x0 = gx + (SAMPLES - n) * stepX;
      const bottom = gy + gh;

      index = startIndex;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = values[index];
        let t = v * invMax;
        if (t > 1) t = 1;
        else if (t < 0) t = 0;
        const px = x0 + i * stepX;
        const py = bottom - t * gh;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        index = index + 1 === SAMPLES ? 0 : index + 1;
      }
      ctx.strokeStyle = panel.color;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.lineTo(x0 + (n - 1) * stepX, bottom);
      ctx.lineTo(x0, bottom);
      ctx.closePath();
      ctx.fillStyle = panel.fill;
      ctx.fill();
    }

    ctx.fillStyle = panel.color;
    ctx.fillText(panel.text, PAD + 2, y + 1);
  }

  /**
   * Shows the overlay.
   * @returns {Stats} this
   */
  show() {
    this.visible = true;
    if (this.dom !== null) this.dom.style.display = 'block';
    return this;
  }

  /**
   * Hides the overlay (sampling keeps running, drawing stops).
   * @returns {Stats} this
   */
  hide() {
    this.visible = false;
    if (this.dom !== null) this.dom.style.display = 'none';
    return this;
  }

  /**
   * Toggles overlay visibility.
   * @returns {Stats} this
   */
  toggle() {
    return this.visible ? this.hide() : this.show();
  }

  /**
   * True when GPU timing is available on this context.
   * @returns {boolean} Support flag.
   */
  hasGPUTiming() {
    return this._gpuTimer.supported;
  }

  /** Releases the GL queries and detaches the overlay from the document. */
  dispose() {
    this._gpuTimer.dispose();
    if (this.dom !== null && this.dom.parentNode !== null && this.dom.parentNode !== undefined) {
      this.dom.parentNode.removeChild(this.dom);
    }
    this.dom = null;
    this._canvas = null;
    this._ctx = null;
    this.panels.length = 0;
  }
}
