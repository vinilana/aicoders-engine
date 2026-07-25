export class Stats {
    /**
     * @param {Object} engineOrOptions Either an Engine instance (its `gl` and
     *   `canvas` are picked up automatically) or an options object:
     *   `{ gl, container, visible, position, maxPixelRatio }`.
     */
    constructor(engineOrOptions: any);
    /** @type {WebGL2RenderingContext|null} */
    gl: WebGL2RenderingContext | null;
    /** @private */
    private _document;
    /** @private @type {Function} Monotonic clock in milliseconds. */
    private _now;
    /** @private @type {number} */
    private _dpr;
    /** @private @type {GPUTimer} */
    private _gpuTimer;
    /** @type {Panel[]} Graph panels in draw order. */
    panels: Panel[];
    /** @private */
    private _fpsPanel;
    /** @private */
    private _cpuPanel;
    /** @private */
    private _gpuPanel;
    /** @private */
    private _drawsPanel;
    /** @private */
    private _triPanel;
    /** @private @type {number} */
    private _width;
    /** @private @type {number} */
    private _height;
    /** @type {HTMLElement|null} Overlay root element. */
    dom: HTMLElement | null;
    /** @private @type {HTMLCanvasElement|null} */
    private _canvas;
    /** @private @type {CanvasRenderingContext2D|null} */
    private _ctx;
    /** @private @type {number} Timestamp captured by `begin`. */
    private _beginTime;
    /** @private @type {number} Timestamp of the previous `update`. */
    private _lastFrameTime;
    /** @private @type {number} Frames counted in the current fps window. */
    private _frames;
    /** @private @type {number} Start of the current fps window. */
    private _fpsStart;
    /** @private @type {number} Exponentially smoothed frames per second. */
    private _smoothFps;
    /** @private @type {number} Last label rebuild timestamp. */
    private _lastTextTime;
    /** @private @type {string} Cached footer string. */
    private _footerText;
    /** @type {number} Last measured CPU frame time in milliseconds. */
    cpuMs: number;
    /** @type {number} Last resolved GPU frame time in milliseconds. */
    gpuMs: number;
    /** @type {number} Frames per second over the last window. */
    fps: number;
    /** @type {boolean} */
    visible: boolean;
    /**
     * Builds the overlay DOM. Only called when a document exists.
     * @private
     * @param {Document} doc Owner document.
     * @param {Object} options Constructor options.
     * @param {Object|null} engine Engine instance when one was supplied.
     */
    private _createDom;
    /** Marks the beginning of the measured region (CPU timer + GPU query). */
    begin(): void;
    /**
     * Marks the end of the measured region.
     * @returns {number} CPU milliseconds spent since `begin`.
     */
    end(): number;
    /**
     * Pushes a new sample set and repaints the overlay.
     * @param {Object} [renderer] Renderer whose `info` block feeds the counters.
     * @returns {Stats} this
     */
    update(renderer?: any): Stats;
    /**
     * Builds the textual footer summarising resource counters.
     * @private
     * @param {Object|null} info Renderer info block.
     * @returns {string} Footer string.
     */
    private _buildFooter;
    /**
     * Repaints the whole overlay. Cheap: a handful of small paths and up to six
     * cached text runs.
     * @private
     */
    private _draw;
    /**
     * Draws one graph panel.
     * @private
     * @param {CanvasRenderingContext2D} ctx Target context.
     * @param {Panel} panel Panel to draw.
     * @param {number} y Panel top in CSS pixels.
     * @param {number} w Overlay width in CSS pixels.
     */
    private _drawGraph;
    /**
     * Shows the overlay.
     * @returns {Stats} this
     */
    show(): Stats;
    /**
     * Hides the overlay (sampling keeps running, drawing stops).
     * @returns {Stats} this
     */
    hide(): Stats;
    /**
     * Toggles overlay visibility.
     * @returns {Stats} this
     */
    toggle(): Stats;
    /**
     * True when GPU timing is available on this context.
     * @returns {boolean} Support flag.
     */
    hasGPUTiming(): boolean;
    /** Releases the GL queries and detaches the overlay from the document. */
    dispose(): void;
}
/**
 * A single graph: ring buffer of samples plus cached label.
 * @private
 */
declare class Panel {
    /**
     * @param {string} label Short caption.
     * @param {string} unit Unit suffix appended to the current value.
     * @param {string} color Stroke/text color.
     * @param {string} fill Fill color under the curve.
     * @param {number} decimals Digits shown after the decimal point.
     * @param {number} minRange Lower bound for the graph vertical scale.
     */
    constructor(label: string, unit: string, color: string, fill: string, decimals: number, minRange: number);
    label: string;
    unit: string;
    color: string;
    fill: string;
    decimals: number;
    minRange: number;
    values: Float32Array;
    head: number;
    count: number;
    value: number;
    min: number;
    max: number;
    text: string;
    /**
     * Appends a sample to the ring buffer.
     * @param {number} value Sample value.
     */
    push(value: number): void;
    /** Recomputes min/max over the retained window. */
    computeRange(): void;
    /** Rebuilds the cached label string. */
    refreshText(): void;
}
export {};
