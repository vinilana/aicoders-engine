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
    constructor(target?: any, canvas?: HTMLCanvasElement, options?: {
        preventContextMenu?: boolean;
        preventSelection?: boolean;
        preventTouchScroll?: boolean;
        ignoreWhenTyping?: boolean;
        gamepadDeadzone?: number;
        preventDefaultKeys?: string[];
    });
    /** @type {*} Root event target (usually `window`). */
    target: any;
    /** @type {HTMLCanvasElement|null} */
    canvas: HTMLCanvasElement | null;
    /** @type {*} Window reference or null when headless. */
    window: any;
    /** @type {*} Document reference or null when headless. */
    document: any;
    /** @type {*} Element that receives pointer/touch/wheel events. */
    element: any;
    /** @type {*} Element that receives keyboard events. */
    keyTarget: any;
    /** @type {boolean} When false all events are ignored (state is frozen). */
    enabled: boolean;
    /** @type {boolean} */
    preventContextMenu: boolean;
    /** @type {boolean} */
    preventSelection: boolean;
    /** @type {boolean} */
    preventTouchScroll: boolean;
    /** @type {boolean} */
    ignoreWhenTyping: boolean;
    /** @type {number} Radial deadzone for gamepad sticks. */
    gamepadDeadzone: number;
    /** @type {Set<string>} Key codes whose browser default is prevented. */
    preventDefaultKeys: Set<string>;
    /**
     * When the engine swallows keys that the browser would otherwise act on.
     *
     *   `'pointerlock'` (default) only while the pointer is captured — the safe
     *     choice, because the page behaves completely normally until the player
     *     clicks into the game;
     *   `'focus'` whenever the canvas has focus;
     *   `'always'` unconditionally;
     *   `'off'` never.
     *
     * @type {string}
     */
    captureMode: string;
    /** @type {Set<string>} Bare key codes to swallow while capturing. */
    capturedKeys: Set<string>;
    /** @type {Set<string>} Modifier combos to swallow, e.g. `'ctrl+KeyS'`. */
    capturedCombos: Set<string>;
    /** @type {Set<string>} Never swallowed, whatever the above say. */
    neverCaptured: Set<string>;
    /** @type {number} Keys swallowed since the last reset; for debugging. */
    capturedCount: number;
    /**
     * @type {boolean} Swallow every modifier combination while capturing,
     * instead of only the listed ones. Still never touches `neverCaptured`.
     */
    captureAllShortcuts: boolean;
    /** @type {boolean} True while the Keyboard Lock API is held. */
    keyboardLocked: boolean;
    /** @type {Set<string>} Keys currently held. */
    _keysDown: Set<string>;
    /** @type {Set<string>} Keys that went down this frame. */
    _keysPressed: Set<string>;
    /** @type {Set<string>} Keys that went up this frame. */
    _keysReleased: Set<string>;
    /**
     * Mouse state. `x`/`y` are canvas CSS pixels (origin top-left), `ndcX`/`ndcY`
     * are normalized device coordinates in [-1,1] with Y up, `dx`/`dy` are the
     * movement accumulated during the current frame and `wheel` is the wheel
     * movement in logical notches (positive = scroll down / away from user).
     * @type {{x:number,y:number,ndcX:number,ndcY:number,dx:number,dy:number,
     *   wheel:number,wheelX:number,wheelPixels:number,buttons:number,
     *   clientX:number,clientY:number,inside:boolean,moved:boolean}}
     */
    mouse: {
        x: number;
        y: number;
        ndcX: number;
        ndcY: number;
        dx: number;
        dy: number;
        wheel: number;
        wheelX: number;
        wheelPixels: number;
        buttons: number;
        clientX: number;
        clientY: number;
        inside: boolean;
        moved: boolean;
    };
    /** @type {Uint8Array} */
    _mouseDown: Uint8Array;
    /** @type {Uint8Array} */
    _mousePressed: Uint8Array;
    /** @type {Uint8Array} */
    _mouseReleased: Uint8Array;
    /** @type {TouchPoint[]} Active touches, in the order they began. */
    touches: TouchPoint[];
    /** @type {TouchPoint[]} */
    _touchPool: TouchPoint[];
    /** @type {Map<number, TouchPoint>} */
    _touchMap: Map<number, TouchPoint>;
    /**
     * Multi-touch gesture state (valid while at least two fingers are down).
     * @type {{active:boolean,distance:number,startDistance:number,delta:number,
     *   scale:number,centerX:number,centerY:number,panDx:number,panDy:number,
     *   rotation:number,touchCount:number}}
     */
    pinch: {
        active: boolean;
        distance: number;
        startDistance: number;
        delta: number;
        scale: number;
        centerX: number;
        centerY: number;
        panDx: number;
        panDy: number;
        rotation: number;
        touchCount: number;
    };
    /** @type {number} Centroid X of the previous frame (internal). */
    _prevCenterX: number;
    /** @type {number} Centroid Y of the previous frame (internal). */
    _prevCenterY: number;
    /** @type {number} Two-finger angle of the previous frame (internal). */
    _prevAngle: number;
    /** @type {GamepadState[]} */
    gamepads: GamepadState[];
    /** @type {Array<*>} Raw gamepad objects, kept for the vibration actuator. */
    _rawPads: Array<any>;
    /** @type {Map<string, Object>} Virtual axes. */
    _axes: Map<string, any>;
    /** @type {Map<string, Object>} Virtual actions. */
    _actions: Map<string, any>;
    /** @type {boolean} True while the pointer is locked to the canvas. */
    pointerLocked: boolean;
    /** @type {boolean} True while the document is hidden. */
    hidden: boolean;
    /** @type {{left:number, top:number, width:number, height:number}} Cached client rect. */
    _rect: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
    /** @type {boolean} */
    _rectDirty: boolean;
    /** @type {Array<*>} Registered listeners, for dispose(). */
    _listeners: Array<any>;
    /**
     * Creates the bound handler closures once (never per frame).
     * @private
     */
    private _bindHandlers;
    _onKeyDown: (e: any) => void;
    _onKeyUp: (e: any) => void;
    _onBlur: () => void;
    _onMouseDown: (e: any) => void;
    _onMouseMove: (e: any) => void;
    _onMouseUp: (e: any) => void;
    _onMouseEnter: () => void;
    _onMouseLeave: () => void;
    _onWheel: (e: any) => void;
    _onContextMenu: (e: any) => void;
    _onTouchStart: (e: any) => void;
    _onTouchMove: (e: any) => void;
    _onTouchEnd: (e: any) => void;
    _onPointerLockChange: () => void;
    _onPointerLockError: () => void;
    _onVisibility: () => void;
    _onGamepadConnected: (e: any) => void;
    _onGamepadDisconnected: (e: any) => void;
    _onLayoutChange: () => void;
    /**
     * Registers a removable listener.
     * @param {*} el Event target.
     * @param {string} type Event name.
     * @param {Function} fn Handler.
     * @param {Object|boolean} [opts] addEventListener options.
     * @private
     */
    private _addListener;
    /**
     * Attaches every DOM listener. No-op when running headless.
     * @private
     */
    private _attach;
    /**
     * Refreshes the cached bounding rect at most once per frame.
     * @private
     */
    private _refreshRect;
    /**
     * Converts client coordinates into the cached element space.
     * @param {number} clientX Client X.
     * @param {number} clientY Client Y.
     * @param {{x:number,y:number,ndcX:number,ndcY:number}} out Destination object.
     * @private
     */
    private _toLocal;
    /**
     * True when the event originated from a text entry widget.
     * @param {*} node Event target.
     * @returns {boolean} Whether keyboard input should be ignored.
     * @private
     */
    private _isTextEntry;
    /**
     * Canonical token for a key event: `'ctrl+shift+KeyS'`, or just `'KeyS'`.
     * Modifiers are always in the same order so lookups are a plain Set hit.
     * @param {KeyboardEvent} e Event.
     * @param {string} code Resolved key code.
     * @returns {string}
     * @private
     */
    private _comboToken;
    /**
     * Whether the game currently owns the keyboard.
     * @returns {boolean}
     */
    isCapturing(): boolean;
    /**
     * Decides whether a key event's browser default should be suppressed.
     * @param {KeyboardEvent} e Event.
     * @param {string} code Resolved key code.
     * @returns {boolean}
     * @private
     */
    private _shouldCapture;
    /**
     * Adds key codes or combos to the captured set.
     * @param {string|string[]} keys `'KeyR'`, `'ctrl+KeyS'`, or an array of them.
     * @returns {Input} this
     */
    captureKeys(keys: string | string[]): Input;
    /**
     * Removes key codes or combos from the captured set.
     * @param {string|string[]} keys
     * @returns {Input} this
     */
    releaseKeys(keys: string | string[]): Input;
    /**
     * @param {string} mode `'pointerlock'`, `'focus'`, `'always'` or `'off'`.
     * @returns {Input} this
     */
    setCaptureMode(mode: string): Input;
    /**
     * Resolves the navigator, matching how the gamepad poll finds it so the two
     * behave the same headless.
     * @returns {*}
     * @private
     */
    private _nav;
    /**
     * Whether the Keyboard Lock API exists in this browser.
     *
     * It is the only way a page can receive Ctrl+W, Ctrl+T, Ctrl+N or F11 —
     * `preventDefault` does nothing on those, by design, so that a page cannot
     * trap the user. Chromium based browsers implement it; Firefox and Safari do
     * not, and there they simply stay reserved.
     *
     * @returns {boolean}
     */
    canLockKeyboard(): boolean;
    /**
     * Requests the reserved key combinations from the browser.
     *
     * Only works while the document is in fullscreen — that is the browser's
     * condition, not ours, and the request silently does nothing otherwise.
     * Escape held for two seconds still exits; that cannot be removed and is what
     * keeps this from being a way to trap someone in a page.
     *
     * @param {string[]} [codes] Key codes to claim; a sensible game set by default.
     * @returns {Promise<boolean>} true once the lock is held
     */
    lockKeyboard(codes?: string[]): Promise<boolean>;
    /**
     * Releases the keyboard lock.
     * @returns {Input} this
     */
    unlockKeyboard(): Input;
    /**
     * Everything a game wants when the player clicks "play": fullscreen, pointer
     * lock and the keyboard lock, in the order the browser requires.
     *
     * Fullscreen has to come first because the keyboard lock depends on it, and
     * all three need a user gesture, so call this from a click handler.
     *
     * @param {HTMLElement} [element] Element to make fullscreen; the canvas by default.
     * @returns {Promise<{fullscreen: boolean, pointer: boolean, keyboard: boolean}>}
     */
    enterGameMode(element?: HTMLElement): Promise<{
        fullscreen: boolean;
        pointer: boolean;
        keyboard: boolean;
    }>;
    /**
     * Reverses {@link enterGameMode}.
     * @returns {Promise<void>}
     */
    exitGameMode(): Promise<void>;
    /**
     * What the current environment can actually suppress, so a game can tell the
     * player the truth instead of guessing.
     * @returns {{pointerLock: boolean, keyboardLock: boolean, locked: boolean,
     *   fullscreen: boolean, reserved: string[]}}
     */
    shortcutStatus(): {
        pointerLock: boolean;
        keyboardLock: boolean;
        locked: boolean;
        fullscreen: boolean;
        reserved: string[];
    };
    /**
     * @param {KeyboardEvent} e Event.
     * @private
     */
    private _handleKeyDown;
    /**
     * @param {KeyboardEvent} e Event.
     * @private
     */
    private _handleKeyUp;
    /**
     * Returns true while the key is held.
     * @param {string} code KeyboardEvent.code value.
     * @returns {boolean} Held state.
     */
    isKeyDown(code: string): boolean;
    /**
     * Returns true only during the frame the key went down.
     * @param {string} code KeyboardEvent.code value.
     * @returns {boolean} Pressed state.
     */
    isKeyPressed(code: string): boolean;
    /**
     * Returns true only during the frame the key went up.
     * @param {string} code KeyboardEvent.code value.
     * @returns {boolean} Released state.
     */
    isKeyReleased(code: string): boolean;
    /**
     * True while any key is held.
     * @returns {boolean} Whether at least one key is down.
     */
    isAnyKeyDown(): boolean;
    /**
     * @param {MouseEvent} e Event.
     * @private
     */
    private _handleMouseDown;
    /**
     * @param {MouseEvent} e Event.
     * @private
     */
    private _handleMouseMove;
    /**
     * @param {MouseEvent} e Event.
     * @private
     */
    private _handleMouseUp;
    /**
     * Writes client coordinates into the mouse state.
     * @param {MouseEvent} e Event.
     * @private
     */
    private _updateMousePosition;
    /**
     * @param {WheelEvent} e Event.
     * @private
     */
    private _handleWheel;
    /**
     * True while the mouse button is held.
     * @param {number} button Button index (0 left, 1 middle, 2 right).
     * @returns {boolean} Held state.
     */
    isMouseDown(button: number): boolean;
    /**
     * True only during the frame the button went down.
     * @param {number} button Button index.
     * @returns {boolean} Pressed state.
     */
    isMousePressed(button: number): boolean;
    /**
     * True only during the frame the button went up.
     * @param {number} button Button index.
     * @returns {boolean} Released state.
     */
    isMouseReleased(button: number): boolean;
    /**
     * Requests pointer lock on the canvas (must be called from a user gesture).
     * @returns {boolean} Whether the request could be issued.
     */
    requestPointerLock(): boolean;
    /**
     * Releases pointer lock if held.
     * @returns {boolean} Whether the request could be issued.
     */
    exitPointerLock(): boolean;
    /**
     * Fetches a pooled touch point.
     * @returns {TouchPoint} Recycled or fresh instance.
     * @private
     */
    private _acquireTouch;
    /**
     * @param {TouchEvent} e Event.
     * @private
     */
    private _handleTouchStart;
    /**
     * @param {TouchEvent} e Event.
     * @private
     */
    private _handleTouchMove;
    /**
     * @param {TouchEvent} e Event.
     * @private
     */
    private _handleTouchEnd;
    /**
     * Recomputes centroid, pinch distance and rotation from the active touches.
     * @param {boolean} rebase When true the gesture reference frame is reset.
     * @private
     */
    private _refreshGesture;
    /**
     * Number of fingers currently on the surface.
     * @returns {number} Active touch count.
     */
    get touchCount(): number;
    /**
     * Returns an active touch by slot.
     * @param {number} index Slot index.
     * @returns {TouchPoint|null} Touch state or null.
     */
    getTouch(index: number): TouchPoint | null;
    /**
     * Polls `navigator.getGamepads()` and rolls per-button transitions.
     * @private
     */
    private _pollGamepads;
    /**
     * Reads a gamepad axis with the configured deadzone applied and rescaled so
     * the usable range still spans [-1,1].
     * @param {number} padIndex Gamepad slot.
     * @param {number} axisIndex Axis index.
     * @returns {number} Filtered axis value.
     */
    getGamepadAxis(padIndex: number, axisIndex: number): number;
    /**
     * Analog value of a gamepad button in [0,1].
     * @param {number} padIndex Gamepad slot.
     * @param {number} buttonIndex Button index.
     * @returns {number} Button value.
     */
    getGamepadButton(padIndex: number, buttonIndex: number): number;
    /**
     * True while a gamepad button is held.
     * @param {number} padIndex Gamepad slot.
     * @param {number} buttonIndex Button index.
     * @returns {boolean} Held state.
     */
    isGamepadButtonDown(padIndex: number, buttonIndex: number): boolean;
    /**
     * True only during the frame the gamepad button went down.
     * @param {number} padIndex Gamepad slot.
     * @param {number} buttonIndex Button index.
     * @returns {boolean} Pressed state.
     */
    isGamepadButtonPressed(padIndex: number, buttonIndex: number): boolean;
    /**
     * True only during the frame the gamepad button went up.
     * @param {number} padIndex Gamepad slot.
     * @param {number} buttonIndex Button index.
     * @returns {boolean} Released state.
     */
    isGamepadButtonReleased(padIndex: number, buttonIndex: number): boolean;
    /**
     * Triggers a dual-rumble effect when the browser exposes one.
     * @param {number} padIndex Gamepad slot.
     * @param {number} durationMs Duration in milliseconds.
     * @param {number} [strong=1] Strong (low frequency) magnitude 0..1.
     * @param {number} [weak=0.5] Weak (high frequency) magnitude 0..1.
     * @returns {boolean} Whether the effect could be started.
     */
    vibrate(padIndex: number, durationMs: number, strong?: number, weak?: number): boolean;
    /**
     * Resolves whether a parsed token is currently held.
     * @param {{kind:number,a:number,code:string}} token Parsed token.
     * @returns {boolean} Held state.
     * @private
     */
    private _tokenDown;
    /**
     * Resolves whether a parsed token went down this frame.
     * @param {{kind:number,a:number,code:string}} token Parsed token.
     * @returns {boolean} Pressed state.
     * @private
     */
    private _tokenPressed;
    /**
     * Resolves whether a parsed token went up this frame.
     * @param {{kind:number,a:number,code:string}} token Parsed token.
     * @returns {boolean} Released state.
     * @private
     */
    private _tokenReleased;
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
    bindAxis(name: string, config: {
        positive?: string | string[];
        negative?: string | string[];
        gamepadIndex?: number;
        gamepadAxis?: number;
        gamepadInvert?: boolean;
        scale?: number;
    }): Input;
    /**
     * Removes a virtual axis.
     * @param {string} name Axis name.
     * @returns {boolean} Whether the axis existed.
     */
    unbindAxis(name: string): boolean;
    /**
     * Evaluates a virtual axis. Built-in names 'MouseX', 'MouseY' and 'MouseWheel'
     * are available without an explicit binding.
     * @param {string} name Axis name.
     * @returns {number} Axis value, digital sources clamped to [-1,1].
     */
    getAxis(name: string): number;
    /**
     * Declares a virtual action from a token list.
     * @param {string} name Action name.
     * @param {string|string[]} keys Tokens ('KeyE', 'Mouse0', 'Pad0B0').
     * @returns {Input} This instance, for chaining.
     */
    bindAction(name: string, keys: string | string[]): Input;
    /**
     * Removes a virtual action.
     * @param {string} name Action name.
     * @returns {boolean} Whether the action existed.
     */
    unbindAction(name: string): boolean;
    /**
     * True while any token bound to the action is held.
     * @param {string} name Action name.
     * @returns {boolean} Held state.
     */
    isActionDown(name: string): boolean;
    /**
     * True only during the frame an action token went down.
     * @param {string} name Action name.
     * @returns {boolean} Pressed state.
     */
    isActionPressed(name: string): boolean;
    /**
     * True only during the frame an action token went up.
     * @param {string} name Action name.
     * @returns {boolean} Released state.
     */
    isActionReleased(name: string): boolean;
    /**
     * Marks every held control as released and clears held state. Used on window
     * blur and tab hide so keys do not get stuck.
     * @private
     */
    private _releaseAll;
    /**
     * Rolls all one-frame states and polls gamepads. Call once at the END of every
     * frame, after all gameplay code has read the input.
     */
    update(): void;
    /**
     * Clears every state without touching the listeners.
     */
    reset(): void;
    /**
     * Removes every DOM listener and drops all state.
     */
    dispose(): void;
}
/**
 * Per-touch state. Instances are pooled and reused; never allocated per frame.
 */
declare class TouchPoint {
    /** @type {number} Browser touch identifier. */
    id: number;
    /** @type {number} X in canvas CSS pixels. */
    x: number;
    /** @type {number} Y in canvas CSS pixels. */
    y: number;
    /** @type {number} Normalized device X in [-1,1]. */
    ndcX: number;
    /** @type {number} Normalized device Y in [-1,1] (up positive). */
    ndcY: number;
    /** @type {number} Movement on X since last frame. */
    dx: number;
    /** @type {number} Movement on Y since last frame. */
    dy: number;
    /** @type {number} X where the touch began. */
    startX: number;
    /** @type {number} Y where the touch began. */
    startY: number;
    /** @type {boolean} True during the frame the touch began. */
    pressed: boolean;
    /** @type {boolean} True during the frame the touch ended. */
    released: boolean;
    /** @type {boolean} True while the finger is on the surface. */
    active: boolean;
    /** @type {number} Pressure, 0..1 when reported. */
    force: number;
}
/**
 * Snapshot of a single gamepad, stored in TypedArrays to avoid per-frame
 * allocation.
 */
declare class GamepadState {
    /** @param {number} index Slot index. */
    constructor(index: number);
    /** @type {number} */
    index: number;
    /** @type {boolean} */
    connected: boolean;
    /** @type {string} */
    id: string;
    /** @type {string} */
    mapping: string;
    /** @type {number} */
    axisCount: number;
    /** @type {number} */
    buttonCount: number;
    /** @type {Float32Array} */
    axes: Float32Array;
    /** @type {Float32Array} */
    values: Float32Array;
    /** @type {Uint8Array} */
    down: Uint8Array;
    /** @type {Uint8Array} */
    pressed: Uint8Array;
    /** @type {Uint8Array} */
    released: Uint8Array;
    /** Clears every tracked value (used on disconnect). */
    reset(): void;
}
export {};
