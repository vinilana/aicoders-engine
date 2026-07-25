/**
 * @fileoverview Unified input system: keyboard (by KeyboardEvent.code), mouse
 * (canvas pixels + NDC + deltas + normalized wheel), pointer lock, multi touch
 * with pinch/pan gestures, gamepads with deadzone, and a virtual axis/action
 * binding layer. All transient (pressed/released) states live exactly one frame
 * and are rolled by `update()`, which must be called at the END of the frame.
 *
 * The class performs no work at module scope and degrades gracefully to a pure
 * state container when no DOM is present (headless/Node).
 */

/** Number of mouse buttons tracked. */
const MOUSE_BUTTONS = 8;
/** Number of gamepad slots tracked. */
const MAX_GAMEPADS = 4;
/** Number of axes tracked per gamepad. */
const MAX_PAD_AXES = 8;
/** Number of buttons tracked per gamepad. */
const MAX_PAD_BUTTONS = 20;
/** Pixels assumed for one wheel "line" (deltaMode 1). */
const WHEEL_LINE_PX = 16;
/** Pixels assumed for one wheel "page" (deltaMode 2). */
const WHEEL_PAGE_PX = 400;
/** Pixels that make up one logical wheel notch. */
const WHEEL_NOTCH_PX = 100;
/** Maximum notches accepted from a single wheel event (spike guard). */
const WHEEL_NOTCH_CLAMP = 8;

/** Control token kinds. */
const TOKEN_KEY = 0;
const TOKEN_MOUSE = 1;
const TOKEN_PAD = 2;

/** Keys prevented by default so the page does not scroll while playing. */
const DEFAULT_PREVENT_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** Matches gamepad button tokens: 'PadB0', 'Pad1B7'. */
const PAD_TOKEN_RE = /^Pad(\d*)B(\d+)$/;
/** Matches mouse button tokens: 'Mouse0'. */
const MOUSE_TOKEN_RE = /^Mouse(\d+)$/;

/**
 * Per-touch state. Instances are pooled and reused; never allocated per frame.
 */
class TouchPoint {
  constructor() {
    /** @type {number} Browser touch identifier. */
    this.id = -1;
    /** @type {number} X in canvas CSS pixels. */
    this.x = 0;
    /** @type {number} Y in canvas CSS pixels. */
    this.y = 0;
    /** @type {number} Normalized device X in [-1,1]. */
    this.ndcX = 0;
    /** @type {number} Normalized device Y in [-1,1] (up positive). */
    this.ndcY = 0;
    /** @type {number} Movement on X since last frame. */
    this.dx = 0;
    /** @type {number} Movement on Y since last frame. */
    this.dy = 0;
    /** @type {number} X where the touch began. */
    this.startX = 0;
    /** @type {number} Y where the touch began. */
    this.startY = 0;
    /** @type {boolean} True during the frame the touch began. */
    this.pressed = false;
    /** @type {boolean} True during the frame the touch ended. */
    this.released = false;
    /** @type {boolean} True while the finger is on the surface. */
    this.active = false;
    /** @type {number} Pressure, 0..1 when reported. */
    this.force = 0;
  }
}

/**
 * Snapshot of a single gamepad, stored in TypedArrays to avoid per-frame
 * allocation.
 */
class GamepadState {
  /** @param {number} index Slot index. */
  constructor(index) {
    /** @type {number} */
    this.index = index;
    /** @type {boolean} */
    this.connected = false;
    /** @type {string} */
    this.id = '';
    /** @type {string} */
    this.mapping = '';
    /** @type {number} */
    this.axisCount = 0;
    /** @type {number} */
    this.buttonCount = 0;
    /** @type {Float32Array} */
    this.axes = new Float32Array(MAX_PAD_AXES);
    /** @type {Float32Array} */
    this.values = new Float32Array(MAX_PAD_BUTTONS);
    /** @type {Uint8Array} */
    this.down = new Uint8Array(MAX_PAD_BUTTONS);
    /** @type {Uint8Array} */
    this.pressed = new Uint8Array(MAX_PAD_BUTTONS);
    /** @type {Uint8Array} */
    this.released = new Uint8Array(MAX_PAD_BUTTONS);
  }

  /** Clears every tracked value (used on disconnect). */
  reset() {
    this.connected = false;
    this.id = '';
    this.mapping = '';
    this.axisCount = 0;
    this.buttonCount = 0;
    this.axes.fill(0);
    this.values.fill(0);
    for (let i = 0; i < MAX_PAD_BUTTONS; i++) {
      this.released[i] = this.down[i];
      this.down[i] = 0;
      this.pressed[i] = 0;
    }
  }
}

/**
 * Parsed binding token.
 * @param {string} token Raw token such as 'KeyW', 'Mouse0' or 'Pad0B5'.
 * @returns {{kind:number, a:number, code:string}} Parsed descriptor.
 */
function parseToken(token) {
  let m = MOUSE_TOKEN_RE.exec(token);
  if (m !== null) return { kind: TOKEN_MOUSE, a: (parseInt(m[1], 10) | 0) % MOUSE_BUTTONS, code: token };
  m = PAD_TOKEN_RE.exec(token);
  if (m !== null) {
    const pad = m[1] === '' ? 0 : parseInt(m[1], 10) | 0;
    const btn = parseInt(m[2], 10) | 0;
    return { kind: TOKEN_PAD, a: (pad % MAX_GAMEPADS) * MAX_PAD_BUTTONS + (btn % MAX_PAD_BUTTONS), code: token };
  }
  return { kind: TOKEN_KEY, a: 0, code: token };
}

/**
 * Normalizes a token list argument into an array of parsed descriptors.
 * @param {string|string[]|null|undefined} tokens Tokens.
 * @returns {Array<{kind:number,a:number,code:string}>} Parsed list.
 */
function parseTokenList(tokens) {
  const out = [];
  if (tokens === null || tokens === undefined) return out;
  if (typeof tokens === 'string') {
    out.push(parseToken(tokens));
    return out;
  }
  for (let i = 0, n = tokens.length; i < n; i++) {
    if (typeof tokens[i] === 'string') out.push(parseToken(tokens[i]));
  }
  return out;
}

/**
 * Aggregated, frame-coherent input state.
 */
export class Input {
  /**
   * @param {*} [target] Event target for keyboard/global events (defaults to `window`).
   * @param {HTMLCanvasElement} [canvas] Canvas used for pointer coordinates and pointer lock.
   * @param {Object} [options] Behaviour options.
   * @param {boolean} [options.preventContextMenu=true] Swallow the right-click menu.
   * @param {boolean} [options.preventSelection=true] Swallow selection drag on mousedown.
   * @param {boolean} [options.preventTouchScroll=true] Swallow page scroll on touch.
   * @param {boolean} [options.ignoreWhenTyping=true] Ignore keys while a text field is focused.
   * @param {number} [options.gamepadDeadzone=0.15] Radial deadzone applied to sticks.
   * @param {string[]} [options.preventDefaultKeys] Key codes whose default is prevented.
   */
  constructor(target, canvas, options) {
    const opts = options || {};
    const g = globalThis;

    /** @type {*} Root event target (usually `window`). */
    this.target = target || (g && g.window) || null;
    /** @type {HTMLCanvasElement|null} */
    this.canvas = canvas || null;
    /** @type {*} Window reference or null when headless. */
    this.window = (this.target && this.target.window) || (g && g.window) || null;
    /** @type {*} Document reference or null when headless. */
    this.document = (this.canvas && this.canvas.ownerDocument) ||
      (this.window && this.window.document) ||
      (this.target && this.target.ownerDocument) || null;

    const targetIsElement = !!(this.target && this.target.nodeType === 1);
    /** @type {*} Element that receives pointer/touch/wheel events. */
    this.element = this.canvas || (targetIsElement ? this.target : null) || this.window;
    /** @type {*} Element that receives keyboard events. */
    this.keyTarget = this.window || this.element;

    /** @type {boolean} When false all events are ignored (state is frozen). */
    this.enabled = true;
    /** @type {boolean} */
    this.preventContextMenu = opts.preventContextMenu !== false;
    /** @type {boolean} */
    this.preventSelection = opts.preventSelection !== false;
    /** @type {boolean} */
    this.preventTouchScroll = opts.preventTouchScroll !== false;
    /** @type {boolean} */
    this.ignoreWhenTyping = opts.ignoreWhenTyping !== false;
    /** @type {number} Radial deadzone for gamepad sticks. */
    this.gamepadDeadzone = opts.gamepadDeadzone !== undefined ? opts.gamepadDeadzone : 0.15;
    /** @type {Set<string>} Key codes whose browser default is prevented. */
    this.preventDefaultKeys = new Set(opts.preventDefaultKeys || DEFAULT_PREVENT_KEYS);

    /** @type {Set<string>} Keys currently held. */
    this._keysDown = new Set();
    /** @type {Set<string>} Keys that went down this frame. */
    this._keysPressed = new Set();
    /** @type {Set<string>} Keys that went up this frame. */
    this._keysReleased = new Set();

    /**
     * Mouse state. `x`/`y` are canvas CSS pixels (origin top-left), `ndcX`/`ndcY`
     * are normalized device coordinates in [-1,1] with Y up, `dx`/`dy` are the
     * movement accumulated during the current frame and `wheel` is the wheel
     * movement in logical notches (positive = scroll down / away from user).
     * @type {{x:number,y:number,ndcX:number,ndcY:number,dx:number,dy:number,
     *   wheel:number,wheelX:number,wheelPixels:number,buttons:number,
     *   clientX:number,clientY:number,inside:boolean,moved:boolean}}
     */
    this.mouse = {
      x: 0, y: 0, ndcX: 0, ndcY: 0, dx: 0, dy: 0,
      wheel: 0, wheelX: 0, wheelPixels: 0, buttons: 0,
      clientX: 0, clientY: 0, inside: false, moved: false
    };
    /** @type {Uint8Array} */
    this._mouseDown = new Uint8Array(MOUSE_BUTTONS);
    /** @type {Uint8Array} */
    this._mousePressed = new Uint8Array(MOUSE_BUTTONS);
    /** @type {Uint8Array} */
    this._mouseReleased = new Uint8Array(MOUSE_BUTTONS);

    /** @type {TouchPoint[]} Active touches, in the order they began. */
    this.touches = [];
    /** @type {TouchPoint[]} */
    this._touchPool = [];
    /** @type {Map<number, TouchPoint>} */
    this._touchMap = new Map();
    /**
     * Multi-touch gesture state (valid while at least two fingers are down).
     * @type {{active:boolean,distance:number,startDistance:number,delta:number,
     *   scale:number,centerX:number,centerY:number,panDx:number,panDy:number,
     *   rotation:number,touchCount:number}}
     */
    this.pinch = {
      active: false, distance: 0, startDistance: 0, delta: 0, scale: 1,
      centerX: 0, centerY: 0, panDx: 0, panDy: 0, rotation: 0, touchCount: 0
    };
    /** @type {number} Centroid X of the previous frame (internal). */
    this._prevCenterX = 0;
    /** @type {number} Centroid Y of the previous frame (internal). */
    this._prevCenterY = 0;
    /** @type {number} Two-finger angle of the previous frame (internal). */
    this._prevAngle = 0;

    /** @type {GamepadState[]} */
    this.gamepads = [];
    for (let i = 0; i < MAX_GAMEPADS; i++) this.gamepads.push(new GamepadState(i));
    /** @type {Array<*>} Raw gamepad objects, kept for the vibration actuator. */
    this._rawPads = [null, null, null, null];

    /** @type {Map<string, Object>} Virtual axes. */
    this._axes = new Map();
    /** @type {Map<string, Object>} Virtual actions. */
    this._actions = new Map();

    /** @type {boolean} True while the pointer is locked to the canvas. */
    this.pointerLocked = false;
    /** @type {boolean} True while the document is hidden. */
    this.hidden = false;

    /** @type {{left:number, top:number, width:number, height:number}} Cached client rect. */
    this._rect = { left: 0, top: 0, width: 1, height: 1 };
    /** @type {boolean} */
    this._rectDirty = true;
    /** @type {Array<*>} Registered listeners, for dispose(). */
    this._listeners = [];

    this._bindHandlers();
    this._attach();
  }

  // ---------------------------------------------------------------------------
  // Listener plumbing
  // ---------------------------------------------------------------------------

  /**
   * Creates the bound handler closures once (never per frame).
   * @private
   */
  _bindHandlers() {
    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp = (e) => this._handleKeyUp(e);
    this._onBlur = () => this._releaseAll();
    this._onMouseDown = (e) => this._handleMouseDown(e);
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onMouseUp = (e) => this._handleMouseUp(e);
    this._onMouseEnter = () => { this.mouse.inside = true; };
    this._onMouseLeave = () => { this.mouse.inside = false; };
    this._onWheel = (e) => this._handleWheel(e);
    this._onContextMenu = (e) => { if (this.preventContextMenu) e.preventDefault(); };
    this._onTouchStart = (e) => this._handleTouchStart(e);
    this._onTouchMove = (e) => this._handleTouchMove(e);
    this._onTouchEnd = (e) => this._handleTouchEnd(e);
    this._onPointerLockChange = () => {
      const d = this.document;
      this.pointerLocked = !!(d && this.canvas && d.pointerLockElement === this.canvas);
    };
    this._onPointerLockError = () => { this.pointerLocked = false; };
    this._onVisibility = () => {
      const d = this.document;
      this.hidden = !!(d && d.hidden);
      if (this.hidden) this._releaseAll();
    };
    this._onGamepadConnected = (e) => {
      const gp = e && e.gamepad;
      if (gp && gp.index < MAX_GAMEPADS) this.gamepads[gp.index].connected = true;
    };
    this._onGamepadDisconnected = (e) => {
      const gp = e && e.gamepad;
      if (gp && gp.index < MAX_GAMEPADS) {
        this.gamepads[gp.index].reset();
        this._rawPads[gp.index] = null;
      }
    };
    this._onLayoutChange = () => { this._rectDirty = true; };
  }

  /**
   * Registers a removable listener.
   * @param {*} el Event target.
   * @param {string} type Event name.
   * @param {Function} fn Handler.
   * @param {Object|boolean} [opts] addEventListener options.
   * @private
   */
  _addListener(el, type, fn, opts) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener(type, fn, opts);
    this._listeners.push(el, type, fn, opts);
  }

  /**
   * Attaches every DOM listener. No-op when running headless.
   * @private
   */
  _attach() {
    const passive = { passive: true };
    const active = { passive: false };

    this._addListener(this.keyTarget, 'keydown', this._onKeyDown, active);
    this._addListener(this.keyTarget, 'keyup', this._onKeyUp, passive);
    this._addListener(this.window, 'blur', this._onBlur, passive);

    this._addListener(this.element, 'mousedown', this._onMouseDown, active);
    this._addListener(this.window || this.element, 'mousemove', this._onMouseMove, passive);
    this._addListener(this.window || this.element, 'mouseup', this._onMouseUp, passive);
    this._addListener(this.element, 'mouseenter', this._onMouseEnter, passive);
    this._addListener(this.element, 'mouseleave', this._onMouseLeave, passive);
    this._addListener(this.element, 'wheel', this._onWheel, active);
    this._addListener(this.element, 'contextmenu', this._onContextMenu, active);

    this._addListener(this.element, 'touchstart', this._onTouchStart, active);
    this._addListener(this.element, 'touchmove', this._onTouchMove, active);
    this._addListener(this.window || this.element, 'touchend', this._onTouchEnd, passive);
    this._addListener(this.window || this.element, 'touchcancel', this._onTouchEnd, passive);

    this._addListener(this.document, 'pointerlockchange', this._onPointerLockChange, passive);
    this._addListener(this.document, 'pointerlockerror', this._onPointerLockError, passive);
    this._addListener(this.document, 'visibilitychange', this._onVisibility, passive);

    this._addListener(this.window, 'gamepadconnected', this._onGamepadConnected, passive);
    this._addListener(this.window, 'gamepaddisconnected', this._onGamepadDisconnected, passive);

    this._addListener(this.window, 'resize', this._onLayoutChange, passive);
    this._addListener(this.window, 'scroll', this._onLayoutChange, passive);
  }

  // ---------------------------------------------------------------------------
  // Coordinate helpers
  // ---------------------------------------------------------------------------

  /**
   * Refreshes the cached bounding rect at most once per frame.
   * @private
   */
  _refreshRect() {
    if (!this._rectDirty) return;
    this._rectDirty = false;
    const el = this.canvas || (this.element && this.element.nodeType === 1 ? this.element : null);
    if (el && typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      this._rect.left = r.left;
      this._rect.top = r.top;
      this._rect.width = r.width > 0 ? r.width : 1;
      this._rect.height = r.height > 0 ? r.height : 1;
    } else if (this.window && typeof this.window.innerWidth === 'number') {
      this._rect.left = 0;
      this._rect.top = 0;
      this._rect.width = this.window.innerWidth || 1;
      this._rect.height = this.window.innerHeight || 1;
    }
  }

  /**
   * Converts client coordinates into the cached element space.
   * @param {number} clientX Client X.
   * @param {number} clientY Client Y.
   * @param {{x:number,y:number,ndcX:number,ndcY:number}} out Destination object.
   * @private
   */
  _toLocal(clientX, clientY, out) {
    this._refreshRect();
    const r = this._rect;
    const x = clientX - r.left;
    const y = clientY - r.top;
    out.x = x;
    out.y = y;
    out.ndcX = (x / r.width) * 2 - 1;
    out.ndcY = 1 - (y / r.height) * 2;
  }

  /**
   * True when the event originated from a text entry widget.
   * @param {*} node Event target.
   * @returns {boolean} Whether keyboard input should be ignored.
   * @private
   */
  _isTextEntry(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  /**
   * @param {KeyboardEvent} e Event.
   * @private
   */
  _handleKeyDown(e) {
    if (!this.enabled) return;
    if (this.ignoreWhenTyping && this._isTextEntry(e.target)) return;
    const code = e.code || e.key;
    if (!code) return;
    if (this.preventDefaultKeys.has(code) && typeof e.preventDefault === 'function') e.preventDefault();
    if (e.repeat === true || this._keysDown.has(code)) return;
    this._keysDown.add(code);
    this._keysPressed.add(code);
  }

  /**
   * @param {KeyboardEvent} e Event.
   * @private
   */
  _handleKeyUp(e) {
    if (!this.enabled) return;
    const code = e.code || e.key;
    if (!code) return;
    if (this._keysDown.delete(code)) this._keysReleased.add(code);
  }

  /**
   * Returns true while the key is held.
   * @param {string} code KeyboardEvent.code value.
   * @returns {boolean} Held state.
   */
  isKeyDown(code) {
    return this._keysDown.has(code);
  }

  /**
   * Returns true only during the frame the key went down.
   * @param {string} code KeyboardEvent.code value.
   * @returns {boolean} Pressed state.
   */
  isKeyPressed(code) {
    return this._keysPressed.has(code);
  }

  /**
   * Returns true only during the frame the key went up.
   * @param {string} code KeyboardEvent.code value.
   * @returns {boolean} Released state.
   */
  isKeyReleased(code) {
    return this._keysReleased.has(code);
  }

  /**
   * True while any key is held.
   * @returns {boolean} Whether at least one key is down.
   */
  isAnyKeyDown() {
    return this._keysDown.size > 0;
  }

  // ---------------------------------------------------------------------------
  // Mouse
  // ---------------------------------------------------------------------------

  /**
   * @param {MouseEvent} e Event.
   * @private
   */
  _handleMouseDown(e) {
    if (!this.enabled) return;
    const b = e.button | 0;
    if (b < MOUSE_BUTTONS) {
      if (this._mouseDown[b] === 0) this._mousePressed[b] = 1;
      this._mouseDown[b] = 1;
    }
    this.mouse.buttons = e.buttons | 0;
    this.mouse.inside = true;
    this._updateMousePosition(e);
    if (this.preventSelection && typeof e.preventDefault === 'function') {
      // Suppress text selection drag and middle-click autoscroll. Because the
      // default is prevented the element never gets focus on its own, so give it
      // focus explicitly when it is focusable.
      e.preventDefault();
      const el = this.canvas;
      if (el && typeof el.focus === 'function' && el.tabIndex >= 0) el.focus();
    }
  }

  /**
   * @param {MouseEvent} e Event.
   * @private
   */
  _handleMouseMove(e) {
    if (!this.enabled) return;
    const m = this.mouse;
    if (typeof e.movementX === 'number') {
      m.dx += e.movementX;
      m.dy += e.movementY;
    } else {
      m.dx += e.clientX - m.clientX;
      m.dy += e.clientY - m.clientY;
    }
    m.moved = true;
    m.buttons = e.buttons | 0;
    this._updateMousePosition(e);
  }

  /**
   * @param {MouseEvent} e Event.
   * @private
   */
  _handleMouseUp(e) {
    if (!this.enabled) return;
    const b = e.button | 0;
    if (b < MOUSE_BUTTONS && this._mouseDown[b] === 1) {
      this._mouseDown[b] = 0;
      this._mouseReleased[b] = 1;
    }
    this.mouse.buttons = e.buttons | 0;
    this._updateMousePosition(e);
  }

  /**
   * Writes client coordinates into the mouse state.
   * @param {MouseEvent} e Event.
   * @private
   */
  _updateMousePosition(e) {
    const m = this.mouse;
    m.clientX = e.clientX;
    m.clientY = e.clientY;
    this._toLocal(e.clientX, e.clientY, m);
  }

  /**
   * @param {WheelEvent} e Event.
   * @private
   */
  _handleWheel(e) {
    if (!this.enabled) return;
    const scale = e.deltaMode === 1 ? WHEEL_LINE_PX : (e.deltaMode === 2 ? WHEEL_PAGE_PX : 1);
    const px = e.deltaY * scale;
    const pxX = e.deltaX * scale;
    let notches = px / WHEEL_NOTCH_PX;
    if (notches > WHEEL_NOTCH_CLAMP) notches = WHEEL_NOTCH_CLAMP;
    else if (notches < -WHEEL_NOTCH_CLAMP) notches = -WHEEL_NOTCH_CLAMP;
    const m = this.mouse;
    m.wheel += notches;
    m.wheelPixels += px;
    m.wheelX += pxX / WHEEL_NOTCH_PX;
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  /**
   * True while the mouse button is held.
   * @param {number} button Button index (0 left, 1 middle, 2 right).
   * @returns {boolean} Held state.
   */
  isMouseDown(button) {
    return this._mouseDown[button | 0] === 1;
  }

  /**
   * True only during the frame the button went down.
   * @param {number} button Button index.
   * @returns {boolean} Pressed state.
   */
  isMousePressed(button) {
    return this._mousePressed[button | 0] === 1;
  }

  /**
   * True only during the frame the button went up.
   * @param {number} button Button index.
   * @returns {boolean} Released state.
   */
  isMouseReleased(button) {
    return this._mouseReleased[button | 0] === 1;
  }

  // ---------------------------------------------------------------------------
  // Pointer lock
  // ---------------------------------------------------------------------------

  /**
   * Requests pointer lock on the canvas (must be called from a user gesture).
   * @returns {boolean} Whether the request could be issued.
   */
  requestPointerLock() {
    const el = this.canvas || (this.element && this.element.nodeType === 1 ? this.element : null);
    if (!el || typeof el.requestPointerLock !== 'function') return false;
    const r = el.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => { this.pointerLocked = false; });
    return true;
  }

  /**
   * Releases pointer lock if held.
   * @returns {boolean} Whether the request could be issued.
   */
  exitPointerLock() {
    const d = this.document;
    if (!d || typeof d.exitPointerLock !== 'function') return false;
    d.exitPointerLock();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Touch
  // ---------------------------------------------------------------------------

  /**
   * Fetches a pooled touch point.
   * @returns {TouchPoint} Recycled or fresh instance.
   * @private
   */
  _acquireTouch() {
    const p = this._touchPool;
    return p.length > 0 ? p.pop() : new TouchPoint();
  }

  /**
   * @param {TouchEvent} e Event.
   * @private
   */
  _handleTouchStart(e) {
    if (!this.enabled) return;
    const list = e.changedTouches;
    for (let i = 0, n = list.length; i < n; i++) {
      const t = list[i];
      if (this._touchMap.has(t.identifier)) continue;
      const tp = this._acquireTouch();
      tp.id = t.identifier;
      this._toLocal(t.clientX, t.clientY, tp);
      tp.startX = tp.x;
      tp.startY = tp.y;
      tp.dx = 0;
      tp.dy = 0;
      tp.pressed = true;
      tp.released = false;
      tp.active = true;
      tp.force = typeof t.force === 'number' ? t.force : 0;
      this._touchMap.set(t.identifier, tp);
      this.touches.push(tp);
    }
    this._refreshGesture(true);
    if (this.preventTouchScroll && typeof e.preventDefault === 'function') e.preventDefault();
  }

  /**
   * @param {TouchEvent} e Event.
   * @private
   */
  _handleTouchMove(e) {
    if (!this.enabled) return;
    const list = e.changedTouches;
    for (let i = 0, n = list.length; i < n; i++) {
      const t = list[i];
      const tp = this._touchMap.get(t.identifier);
      if (tp === undefined) continue;
      const px = tp.x;
      const py = tp.y;
      this._toLocal(t.clientX, t.clientY, tp);
      tp.dx += tp.x - px;
      tp.dy += tp.y - py;
      tp.force = typeof t.force === 'number' ? t.force : 0;
    }
    this._refreshGesture(false);
    if (this.preventTouchScroll && typeof e.preventDefault === 'function') e.preventDefault();
  }

  /**
   * @param {TouchEvent} e Event.
   * @private
   */
  _handleTouchEnd(e) {
    if (!this.enabled) return;
    const list = e.changedTouches;
    for (let i = 0, n = list.length; i < n; i++) {
      const t = list[i];
      const tp = this._touchMap.get(t.identifier);
      if (tp === undefined) continue;
      tp.active = false;
      tp.released = true;
      this._touchMap.delete(t.identifier);
    }
    this._refreshGesture(true);
  }

  /**
   * Recomputes centroid, pinch distance and rotation from the active touches.
   * @param {boolean} rebase When true the gesture reference frame is reset.
   * @private
   */
  _refreshGesture(rebase) {
    const touches = this.touches;
    let count = 0;
    let cx = 0;
    let cy = 0;
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    for (let i = 0, n = touches.length; i < n; i++) {
      const t = touches[i];
      if (!t.active) continue;
      if (count === 0) { ax = t.x; ay = t.y; }
      else if (count === 1) { bx = t.x; by = t.y; }
      cx += t.x;
      cy += t.y;
      count++;
    }
    const p = this.pinch;
    p.touchCount = count;
    if (count === 0) {
      p.active = false;
      p.distance = 0;
      p.startDistance = 0;
      p.delta = 0;
      p.scale = 1;
      return;
    }
    cx /= count;
    cy /= count;
    p.centerX = cx;
    p.centerY = cy;

    if (count >= 2) {
      const ddx = bx - ax;
      const ddy = by - ay;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy);
      const angle = Math.atan2(ddy, ddx);
      if (!p.active || rebase) {
        p.active = true;
        p.startDistance = dist > 0 ? dist : 1;
        p.distance = dist;
        p.delta = 0;
        p.scale = 1;
        this._prevAngle = angle;
      } else {
        p.delta += dist - p.distance;
        p.distance = dist;
        p.scale = dist / p.startDistance;
        let da = angle - this._prevAngle;
        if (da > Math.PI) da -= Math.PI * 2;
        else if (da < -Math.PI) da += Math.PI * 2;
        p.rotation += da;
        this._prevAngle = angle;
      }
    } else {
      p.active = false;
      p.distance = 0;
      p.scale = 1;
    }

    if (rebase) {
      this._prevCenterX = cx;
      this._prevCenterY = cy;
    } else {
      p.panDx += cx - this._prevCenterX;
      p.panDy += cy - this._prevCenterY;
      this._prevCenterX = cx;
      this._prevCenterY = cy;
    }
  }

  /**
   * Number of fingers currently on the surface.
   * @returns {number} Active touch count.
   */
  get touchCount() {
    return this.pinch.touchCount;
  }

  /**
   * Returns an active touch by slot.
   * @param {number} index Slot index.
   * @returns {TouchPoint|null} Touch state or null.
   */
  getTouch(index) {
    const t = this.touches[index | 0];
    return t !== undefined ? t : null;
  }

  // ---------------------------------------------------------------------------
  // Gamepads
  // ---------------------------------------------------------------------------

  /**
   * Polls `navigator.getGamepads()` and rolls per-button transitions.
   * @private
   */
  _pollGamepads() {
    const nav = (this.window && this.window.navigator) ||
      (typeof globalThis !== 'undefined' ? globalThis.navigator : null);
    if (!nav || typeof nav.getGamepads !== 'function') return;
    const pads = nav.getGamepads();
    if (!pads) return;
    const n = pads.length < MAX_GAMEPADS ? pads.length : MAX_GAMEPADS;
    for (let i = 0; i < MAX_GAMEPADS; i++) {
      const state = this.gamepads[i];
      const pad = i < n ? pads[i] : null;
      this._rawPads[i] = pad;
      if (!pad || pad.connected === false) {
        if (state.connected) state.reset();
        continue;
      }
      state.connected = true;
      state.id = pad.id || '';
      state.mapping = pad.mapping || '';
      const axes = pad.axes;
      const axisCount = axes ? (axes.length < MAX_PAD_AXES ? axes.length : MAX_PAD_AXES) : 0;
      state.axisCount = axisCount;
      for (let a = 0; a < axisCount; a++) {
        const v = axes[a];
        state.axes[a] = typeof v === 'number' ? v : 0;
      }
      for (let a = axisCount; a < MAX_PAD_AXES; a++) state.axes[a] = 0;

      const buttons = pad.buttons;
      const btnCount = buttons ? (buttons.length < MAX_PAD_BUTTONS ? buttons.length : MAX_PAD_BUTTONS) : 0;
      state.buttonCount = btnCount;
      for (let b = 0; b < btnCount; b++) {
        const raw = buttons[b];
        let value;
        let down;
        if (typeof raw === 'number') {
          value = raw;
          down = raw > 0.5 ? 1 : 0;
        } else {
          value = typeof raw.value === 'number' ? raw.value : 0;
          down = raw.pressed ? 1 : 0;
        }
        state.values[b] = value;
        if (down === 1 && state.down[b] === 0) state.pressed[b] = 1;
        else if (down === 0 && state.down[b] === 1) state.released[b] = 1;
        state.down[b] = down;
      }
      for (let b = btnCount; b < MAX_PAD_BUTTONS; b++) {
        state.values[b] = 0;
        if (state.down[b] === 1) state.released[b] = 1;
        state.down[b] = 0;
      }
    }
  }

  /**
   * Reads a gamepad axis with the configured deadzone applied and rescaled so
   * the usable range still spans [-1,1].
   * @param {number} padIndex Gamepad slot.
   * @param {number} axisIndex Axis index.
   * @returns {number} Filtered axis value.
   */
  getGamepadAxis(padIndex, axisIndex) {
    const state = this.gamepads[padIndex | 0];
    if (state === undefined || !state.connected) return 0;
    const v = state.axes[axisIndex | 0];
    const dz = this.gamepadDeadzone;
    const av = v < 0 ? -v : v;
    if (av <= dz) return 0;
    const scaled = (av - dz) / (1 - dz);
    return v < 0 ? -scaled : scaled;
  }

  /**
   * Analog value of a gamepad button in [0,1].
   * @param {number} padIndex Gamepad slot.
   * @param {number} buttonIndex Button index.
   * @returns {number} Button value.
   */
  getGamepadButton(padIndex, buttonIndex) {
    const state = this.gamepads[padIndex | 0];
    if (state === undefined || !state.connected) return 0;
    return state.values[buttonIndex | 0];
  }

  /**
   * True while a gamepad button is held.
   * @param {number} padIndex Gamepad slot.
   * @param {number} buttonIndex Button index.
   * @returns {boolean} Held state.
   */
  isGamepadButtonDown(padIndex, buttonIndex) {
    const state = this.gamepads[padIndex | 0];
    return state !== undefined && state.connected && state.down[buttonIndex | 0] === 1;
  }

  /**
   * True only during the frame the gamepad button went down.
   * @param {number} padIndex Gamepad slot.
   * @param {number} buttonIndex Button index.
   * @returns {boolean} Pressed state.
   */
  isGamepadButtonPressed(padIndex, buttonIndex) {
    const state = this.gamepads[padIndex | 0];
    return state !== undefined && state.connected && state.pressed[buttonIndex | 0] === 1;
  }

  /**
   * True only during the frame the gamepad button went up.
   * @param {number} padIndex Gamepad slot.
   * @param {number} buttonIndex Button index.
   * @returns {boolean} Released state.
   */
  isGamepadButtonReleased(padIndex, buttonIndex) {
    const state = this.gamepads[padIndex | 0];
    return state !== undefined && state.connected && state.released[buttonIndex | 0] === 1;
  }

  /**
   * Triggers a dual-rumble effect when the browser exposes one.
   * @param {number} padIndex Gamepad slot.
   * @param {number} durationMs Duration in milliseconds.
   * @param {number} [strong=1] Strong (low frequency) magnitude 0..1.
   * @param {number} [weak=0.5] Weak (high frequency) magnitude 0..1.
   * @returns {boolean} Whether the effect could be started.
   */
  vibrate(padIndex, durationMs, strong, weak) {
    const pad = this._rawPads[padIndex | 0];
    if (!pad) return false;
    const act = pad.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return false;
    const r = act.playEffect('dual-rumble', {
      duration: durationMs,
      strongMagnitude: strong !== undefined ? strong : 1,
      weakMagnitude: weak !== undefined ? weak : 0.5
    });
    if (r && typeof r.catch === 'function') r.catch(() => {});
    return true;
  }

  // ---------------------------------------------------------------------------
  // Axis / action bindings
  // ---------------------------------------------------------------------------

  /**
   * Resolves whether a parsed token is currently held.
   * @param {{kind:number,a:number,code:string}} token Parsed token.
   * @returns {boolean} Held state.
   * @private
   */
  _tokenDown(token) {
    if (token.kind === TOKEN_KEY) return this._keysDown.has(token.code);
    if (token.kind === TOKEN_MOUSE) return this._mouseDown[token.a] === 1;
    const pad = (token.a / MAX_PAD_BUTTONS) | 0;
    return this.isGamepadButtonDown(pad, token.a - pad * MAX_PAD_BUTTONS);
  }

  /**
   * Resolves whether a parsed token went down this frame.
   * @param {{kind:number,a:number,code:string}} token Parsed token.
   * @returns {boolean} Pressed state.
   * @private
   */
  _tokenPressed(token) {
    if (token.kind === TOKEN_KEY) return this._keysPressed.has(token.code);
    if (token.kind === TOKEN_MOUSE) return this._mousePressed[token.a] === 1;
    const pad = (token.a / MAX_PAD_BUTTONS) | 0;
    return this.isGamepadButtonPressed(pad, token.a - pad * MAX_PAD_BUTTONS);
  }

  /**
   * Resolves whether a parsed token went up this frame.
   * @param {{kind:number,a:number,code:string}} token Parsed token.
   * @returns {boolean} Released state.
   * @private
   */
  _tokenReleased(token) {
    if (token.kind === TOKEN_KEY) return this._keysReleased.has(token.code);
    if (token.kind === TOKEN_MOUSE) return this._mouseReleased[token.a] === 1;
    const pad = (token.a / MAX_PAD_BUTTONS) | 0;
    return this.isGamepadButtonReleased(pad, token.a - pad * MAX_PAD_BUTTONS);
  }

  /**
   * Declares a virtual axis.
   * @param {string} name Axis name.
   * @param {Object} config Axis configuration.
   * @param {string|string[]} [config.positive] Tokens driving +1.
   * @param {string|string[]} [config.negative] Tokens driving -1.
   * @param {number} [config.gamepadIndex=0] Gamepad slot used for the analog source.
   * @param {number} [config.gamepadAxis=-1] Analog axis index, -1 to disable.
   * @param {boolean} [config.gamepadInvert=false] Invert the analog source.
   * @param {number} [config.scale=1] Output multiplier.
   * @returns {Input} This instance, for chaining.
   */
  bindAxis(name, config) {
    const cfg = config || {};
    this._axes.set(name, {
      positive: parseTokenList(cfg.positive),
      negative: parseTokenList(cfg.negative),
      gamepadIndex: cfg.gamepadIndex !== undefined ? cfg.gamepadIndex | 0 : 0,
      gamepadAxis: cfg.gamepadAxis !== undefined ? cfg.gamepadAxis | 0 : -1,
      gamepadInvert: cfg.gamepadInvert === true,
      scale: cfg.scale !== undefined ? cfg.scale : 1
    });
    return this;
  }

  /**
   * Removes a virtual axis.
   * @param {string} name Axis name.
   * @returns {boolean} Whether the axis existed.
   */
  unbindAxis(name) {
    return this._axes.delete(name);
  }

  /**
   * Evaluates a virtual axis. Built-in names 'MouseX', 'MouseY' and 'MouseWheel'
   * are available without an explicit binding.
   * @param {string} name Axis name.
   * @returns {number} Axis value, digital sources clamped to [-1,1].
   */
  getAxis(name) {
    const axis = this._axes.get(name);
    if (axis === undefined) {
      if (name === 'MouseX') return this.mouse.dx;
      if (name === 'MouseY') return this.mouse.dy;
      if (name === 'MouseWheel') return this.mouse.wheel;
      return 0;
    }
    let value = 0;
    const pos = axis.positive;
    for (let i = 0, n = pos.length; i < n; i++) {
      if (this._tokenDown(pos[i])) { value += 1; break; }
    }
    const neg = axis.negative;
    for (let i = 0, n = neg.length; i < n; i++) {
      if (this._tokenDown(neg[i])) { value -= 1; break; }
    }
    if (axis.gamepadAxis >= 0) {
      let g = this.getGamepadAxis(axis.gamepadIndex, axis.gamepadAxis);
      if (axis.gamepadInvert) g = -g;
      if ((g < 0 ? -g : g) > (value < 0 ? -value : value)) value = g;
    }
    return value * axis.scale;
  }

  /**
   * Declares a virtual action from a token list.
   * @param {string} name Action name.
   * @param {string|string[]} keys Tokens ('KeyE', 'Mouse0', 'Pad0B0').
   * @returns {Input} This instance, for chaining.
   */
  bindAction(name, keys) {
    this._actions.set(name, parseTokenList(keys));
    return this;
  }

  /**
   * Removes a virtual action.
   * @param {string} name Action name.
   * @returns {boolean} Whether the action existed.
   */
  unbindAction(name) {
    return this._actions.delete(name);
  }

  /**
   * True while any token bound to the action is held.
   * @param {string} name Action name.
   * @returns {boolean} Held state.
   */
  isActionDown(name) {
    const tokens = this._actions.get(name);
    if (tokens === undefined) return false;
    for (let i = 0, n = tokens.length; i < n; i++) {
      if (this._tokenDown(tokens[i])) return true;
    }
    return false;
  }

  /**
   * True only during the frame an action token went down.
   * @param {string} name Action name.
   * @returns {boolean} Pressed state.
   */
  isActionPressed(name) {
    const tokens = this._actions.get(name);
    if (tokens === undefined) return false;
    for (let i = 0, n = tokens.length; i < n; i++) {
      if (this._tokenPressed(tokens[i])) return true;
    }
    return false;
  }

  /**
   * True only during the frame an action token went up.
   * @param {string} name Action name.
   * @returns {boolean} Released state.
   */
  isActionReleased(name) {
    const tokens = this._actions.get(name);
    if (tokens === undefined) return false;
    for (let i = 0, n = tokens.length; i < n; i++) {
      if (this._tokenReleased(tokens[i])) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Frame management
  // ---------------------------------------------------------------------------

  /**
   * Marks every held control as released and clears held state. Used on window
   * blur and tab hide so keys do not get stuck.
   * @private
   */
  _releaseAll() {
    for (const code of this._keysDown) this._keysReleased.add(code);
    this._keysDown.clear();
    for (let i = 0; i < MOUSE_BUTTONS; i++) {
      if (this._mouseDown[i] === 1) this._mouseReleased[i] = 1;
      this._mouseDown[i] = 0;
    }
    this.mouse.buttons = 0;
    const touches = this.touches;
    for (let i = 0, n = touches.length; i < n; i++) {
      if (touches[i].active) {
        touches[i].active = false;
        touches[i].released = true;
      }
    }
    this._touchMap.clear();
    for (let i = 0; i < MAX_GAMEPADS; i++) {
      const s = this.gamepads[i];
      for (let b = 0; b < MAX_PAD_BUTTONS; b++) {
        if (s.down[b] === 1) s.released[b] = 1;
        s.down[b] = 0;
      }
    }
  }

  /**
   * Rolls all one-frame states and polls gamepads. Call once at the END of every
   * frame, after all gameplay code has read the input.
   */
  update() {
    this._keysPressed.clear();
    this._keysReleased.clear();

    const m = this.mouse;
    m.dx = 0;
    m.dy = 0;
    m.wheel = 0;
    m.wheelX = 0;
    m.wheelPixels = 0;
    m.moved = false;
    for (let i = 0; i < MOUSE_BUTTONS; i++) {
      this._mousePressed[i] = 0;
      this._mouseReleased[i] = 0;
    }

    const touches = this.touches;
    for (let i = touches.length - 1; i >= 0; i--) {
      const t = touches[i];
      t.pressed = false;
      t.dx = 0;
      t.dy = 0;
      if (t.released) {
        t.released = false;
        touches.splice(i, 1);
        this._touchPool.push(t);
      }
    }
    const p = this.pinch;
    p.delta = 0;
    p.panDx = 0;
    p.panDy = 0;
    p.rotation = 0;

    for (let i = 0; i < MAX_GAMEPADS; i++) {
      const s = this.gamepads[i];
      s.pressed.fill(0);
      s.released.fill(0);
    }

    this._rectDirty = true;
    this._pollGamepads();
  }

  /**
   * Clears every state without touching the listeners.
   */
  reset() {
    this._releaseAll();
    this.update();
  }

  /**
   * Removes every DOM listener and drops all state.
   */
  dispose() {
    const l = this._listeners;
    for (let i = 0; i < l.length; i += 4) {
      const el = l[i];
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener(l[i + 1], l[i + 2], l[i + 3]);
      }
    }
    l.length = 0;
    this._keysDown.clear();
    this._keysPressed.clear();
    this._keysReleased.clear();
    this._touchMap.clear();
    this.touches.length = 0;
    this._touchPool.length = 0;
    this._axes.clear();
    this._actions.clear();
    for (let i = 0; i < MAX_GAMEPADS; i++) {
      this.gamepads[i].reset();
      this._rawPads[i] = null;
    }
    this.pointerLocked = false;
    this.enabled = false;
  }
}
