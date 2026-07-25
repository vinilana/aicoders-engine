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
    constructor(options?: {
        canvas?: HTMLCanvasElement | string;
        container?: HTMLElement;
        width?: number;
        height?: number;
        pixelRatio?: number;
        maxPixelRatio?: number;
        antialias?: boolean;
        shadows?: boolean;
        hdr?: boolean;
        clustered?: boolean;
        stats?: boolean | any | Stats;
        autoResize?: boolean;
        pauseWhenHidden?: boolean;
    });
    /** @private @type {Document} */
    private _document;
    /** @private @type {Window|null} */
    private _window;
    /** @private @type {Object} Frozen copy of the user options. */
    private options;
    /** @type {HTMLCanvasElement} Canvas the engine renders into. */
    canvas: HTMLCanvasElement;
    /** @type {number} Cap applied to devicePixelRatio. */
    maxPixelRatio: number;
    /** @private @type {number|undefined} User forced pixel ratio, if any. */
    private _forcedPixelRatio;
    /** @private @type {number} Fixed CSS width, 0 = follow layout. */
    private _fixedWidth;
    /** @private @type {number} Fixed CSS height, 0 = follow layout. */
    private _fixedHeight;
    /** @type {number} Current CSS width in pixels. */
    width: number;
    /** @type {number} Current CSS height in pixels. */
    height: number;
    /** @type {number} Current device pixel ratio in use. */
    pixelRatio: number;
    /** @type {EventBus} Engine wide event bus. */
    events: EventBus;
    /** @type {Time} Frame clock. */
    time: Time;
    /** @type {WebGL2RenderingContext} Raw GL context. */
    gl: WebGL2RenderingContext;
    /** @type {Object} Detected device capabilities. */
    caps: any;
    /** @private @type {Function} Forces a context loss (debug helper). */
    private _loseContext;
    /** @private @type {Object} Options forwarded to the renderer. */
    private _rendererOptions;
    /** @type {Renderer} Rendering backend. */
    renderer: Renderer;
    /** @type {Scene} Active scene. */
    scene: Scene;
    /** @type {PerspectiveCamera} Active camera. */
    camera: PerspectiveCamera;
    /** @type {Input} Keyboard/mouse/touch/gamepad state. */
    input: Input;
    /** @type {Stats|null} Performance overlay, when enabled. */
    stats: Stats | null;
    /** @type {boolean} True between `start()` and `stop()`. */
    running: boolean;
    /** @type {Array<Object>} Animation mixers updated every frame. */
    mixers: Array<any>;
    /** @type {Array<Object>} Objects with an `update(dt, time)` method. */
    updatables: Array<any>;
    /** @private @type {Function[]} */
    private _updateCallbacks;
    /** @private @type {FixedStep[]} */
    private _fixedSteps;
    /** @private @type {Function[]} */
    private _renderCallbacks;
    /** @private @type {number} requestAnimationFrame handle, 0 when idle. */
    private _rafId;
    /** @private @type {boolean} True while paused by the visibility handler. */
    private _paused;
    /** @private @type {boolean} True between contextlost and contextrestored. */
    private _contextLost;
    /** @private @type {boolean} Set when the layout size must be re-read. */
    private _resizeDirty;
    /** @private @type {boolean} True once a size has been applied. */
    private _sized;
    /** @private @type {ResizeObserver|null} */
    private _resizeObserver;
    /** @private @type {boolean} Whether the engine drives the canvas CSS size. */
    private _ownsCanvasStyle;
    /** @private @type {boolean} */
    private _disposed;
    /** @private */
    private _boundFrame;
    /** @private */
    private _boundResize;
    /** @private */
    private _boundVisibility;
    /** @private */
    private _boundContextLost;
    /** @private */
    private _boundContextRestored;
    /** @private @type {Function} */
    private _raf;
    /** @private @type {Function} */
    private _caf;
    /**
     * Finds or creates the canvas element.
     * @private
     * @param {Document} doc Owner document.
     * @param {Object} options Engine options.
     * @returns {HTMLCanvasElement} The canvas to render into.
     */
    private _resolveCanvas;
    /**
     * Computes the pixel ratio currently in effect.
     * @private
     * @returns {number} Device pixel ratio, clamped.
     */
    private _resolvePixelRatio;
    /**
     * Builds the default perspective camera. Fields are assigned explicitly so
     * the engine does not depend on the camera constructor signature.
     * @private
     * @param {Object} options Engine options.
     * @returns {PerspectiveCamera} The camera.
     */
    private _createDefaultCamera;
    /**
     * Instantiates the stats overlay when requested.
     * @private
     * @param {Object} options Engine options.
     * @returns {Stats|null} The overlay or null.
     */
    private _createStats;
    /**
     * Attaches every DOM listener the engine needs.
     * @private
     * @param {Object} options Engine options.
     */
    private _installListeners;
    /** @private */
    private _visibilityInstalled;
    _autoResize: boolean;
    /** @private */
    private _windowResizeInstalled;
    /**
     * Reads the CSS size that the canvas should have and applies it.
     * @private
     */
    private _applyLayoutSize;
    /**
     * Defers the resize to the next frame to avoid layout thrashing (and the
     * classic "ResizeObserver loop" warning). Applies immediately when idle.
     * @private
     */
    private _requestResize;
    /**
     * Resizes the drawing buffer, the renderer and the camera projection.
     * @param {number} width New CSS width in pixels.
     * @param {number} height New CSS height in pixels.
     * @param {number} [pixelRatio] Optional pixel ratio override.
     * @returns {Engine} this
     */
    resize(width: number, height: number, pixelRatio?: number): Engine;
    /**
     * Forces a pixel ratio (pass 0 to go back to automatic tracking).
     * @param {number} value Pixel ratio, or 0 for automatic.
     * @returns {Engine} this
     */
    setPixelRatio(value: number): Engine;
    /**
     * Registers a variable timestep callback, invoked before rendering.
     * @param {Function} fn `fn(dt, time)`.
     * @returns {Function} The same callback, for later removal.
     */
    onUpdate(fn: Function): Function;
    /**
     * Unregisters a variable timestep callback.
     * @param {Function} fn Callback previously registered.
     * @returns {Engine} this
     */
    offUpdate(fn: Function): Engine;
    /**
     * Registers a fixed timestep callback driven by its own accumulator.
     * At most {@link MAX_SUBSTEPS} steps run per frame; any remaining backlog is
     * dropped so a stall cannot spiral into an ever growing catch-up.
     * @param {Function} fn `fn(step, time)` where `step` is `1 / hz`.
     * @param {number} [hz=60] Simulation frequency.
     * @returns {Function} The same callback, for later removal.
     */
    onFixedUpdate(fn: Function, hz?: number): Function;
    /**
     * Unregisters a fixed timestep callback.
     * @param {Function} fn Callback previously registered.
     * @returns {Engine} this
     */
    offFixedUpdate(fn: Function): Engine;
    /**
     * Registers a callback invoked right after `renderer.render()`, useful for
     * debug overlays drawn on top of the frame.
     * @param {Function} fn `fn(renderer, camera, dt)`.
     * @returns {Function} The same callback, for later removal.
     */
    onRender(fn: Function): Function;
    /**
     * Unregisters a render callback.
     * @param {Function} fn Callback previously registered.
     * @returns {Engine} this
     */
    offRender(fn: Function): Engine;
    /**
     * Registers an animation mixer updated every frame with the scaled delta.
     * @param {Object} mixer Object exposing `update(dt)`.
     * @returns {Object} The mixer.
     */
    addMixer(mixer: any): any;
    /**
     * Removes a previously registered animation mixer.
     * @param {Object} mixer Mixer to remove.
     * @returns {Engine} this
     */
    removeMixer(mixer: any): Engine;
    /**
     * Registers an object updated every frame (controls, character controllers,
     * physics worlds, ...). Anything exposing `update(dt, time)` works.
     * @param {Object} object Object to update.
     * @returns {Object} The object.
     */
    addUpdatable(object: any): any;
    /**
     * Removes a previously registered updatable.
     * @param {Object} object Object to remove.
     * @returns {Engine} this
     */
    removeUpdatable(object: any): Engine;
    /**
     * Replaces the active scene.
     * @param {Scene} scene New scene.
     * @returns {Engine} this
     */
    setScene(scene: Scene): Engine;
    /**
     * Replaces the active camera and refreshes its projection for the current
     * viewport aspect ratio.
     * @param {Camera} camera New camera.
     * @returns {Engine} this
     */
    setCamera(camera: Camera): Engine;
    /**
     * Starts the frame loop.
     * @returns {Engine} this
     */
    start(): Engine;
    /**
     * Stops the frame loop. State is preserved, `start()` resumes cleanly.
     * @returns {Engine} this
     */
    stop(): Engine;
    /**
     * Runs a single frame manually. Useful for tests and for step-by-step
     * debugging while the loop is stopped.
     * @param {number} [nowMs] Timestamp in milliseconds.
     * @returns {Engine} this
     */
    tick(nowMs?: number): Engine;
    /**
     * Current timestamp in milliseconds.
     * @private
     * @returns {number} Monotonic time.
     */
    private _nowMs;
    /** Schedules the next animation frame if none is pending. @private */
    _scheduleFrame(): void;
    /** Cancels a pending animation frame. @private */
    _cancelFrame(): void;
    /**
     * requestAnimationFrame entry point.
     * @private
     * @param {number} nowMs Timestamp provided by the browser.
     */
    private _frame;
    /**
     * Executes one full frame: fixed steps, variable update, animation, render.
     * Deliberately free of allocations and of try/catch.
     * @private
     * @param {number} nowMs Frame timestamp in milliseconds.
     */
    private _runFrame;
    /**
     * Pauses while the document is hidden and resumes without a time jump.
     * @private
     */
    private _onVisibilityChange;
    /**
     * WebGL context loss: freeze the loop and let the application know.
     * @private
     * @param {Event} event The contextlost event.
     */
    private _onContextLost;
    /**
     * WebGL context restore: rebuild the renderer and invalidate every GPU
     * resource referenced by the scene so it is re-uploaded on the next frame.
     * @private
     * @param {Event} event The contextrestored event.
     */
    private _onContextRestored;
    /**
     * Walks the scene invalidating buffers, VAOs and programs.
     * @private
     */
    private _markSceneResourcesDirty;
    /**
     * Forces a context loss through WEBGL_lose_context. Debug helper.
     * @returns {Engine} this
     */
    loseContext(): Engine;
    /**
     * Stops the loop, detaches every listener and releases GPU resources.
     * The instance must not be used afterwards.
     */
    dispose(): void;
}
import { EventBus } from "./EventBus.js";
import { Time } from "./Time.js";
import { Renderer } from "../render/Renderer.js";
import { Scene } from "../scene/Scene.js";
import { PerspectiveCamera } from "../scene/PerspectiveCamera.js";
import { Input } from "../input/Input.js";
import { Stats } from "../util/Stats.js";
