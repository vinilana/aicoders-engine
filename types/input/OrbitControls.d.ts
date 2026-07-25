/**
 * Damping-based orbit camera controller.
 */
export class OrbitControls {
    /**
     * @param {import('../scene/Camera.js').Camera} camera Camera to drive.
     * @param {HTMLElement} domElement Element listened to for pointer events.
     */
    constructor(camera: import('../scene/Camera.js').Camera, domElement: HTMLElement);
    /** @type {*} Controlled camera. */
    camera: any;
    /** @type {*} Element the controller listens to. */
    domElement: any;
    /** @type {boolean} Master switch. */
    enabled: boolean;
    /** @type {Vec3} Orbit centre (goal, freely writable by the user). */
    target: Vec3;
    /** @type {boolean} Smooth follow of the goal values. */
    enableDamping: boolean;
    /** @type {number} Fraction of the remaining error closed per 60Hz frame. */
    dampingFactor: number;
    /** @type {number} Minimum orbit distance. */
    minDistance: number;
    /** @type {number} Maximum orbit distance. */
    maxDistance: number;
    /** @type {number} Minimum polar angle in radians (0 = straight above). */
    minPolarAngle: number;
    /** @type {number} Maximum polar angle in radians (PI = straight below). */
    maxPolarAngle: number;
    /** @type {number} Minimum azimuth angle in radians (-Infinity for free). */
    minAzimuthAngle: number;
    /** @type {number} Maximum azimuth angle in radians (Infinity for free). */
    maxAzimuthAngle: number;
    /** @type {boolean} */
    enableRotate: boolean;
    /** @type {boolean} */
    enablePan: boolean;
    /** @type {boolean} */
    enableZoom: boolean;
    /** @type {number} Radians of rotation per element height dragged. */
    rotateSpeed: number;
    /** @type {number} Dolly multiplier per wheel notch. */
    zoomSpeed: number;
    /** @type {number} Pan multiplier. */
    panSpeed: number;
    /** @type {boolean} Pan along the camera plane instead of the ground plane. */
    screenSpacePanning: boolean;
    /** @type {boolean} Continuous azimuth rotation. */
    autoRotate: boolean;
    /** @type {number} Auto rotation speed in radians per second. */
    autoRotateSpeed: number;
    /**
     * Mouse button roles. Values: 'rotate' | 'dolly' | 'pan' | 'none'.
     * @type {{left:string, middle:string, right:string}}
     */
    mouseButtons: {
        left: string;
        middle: string;
        right: string;
    };
    /** @type {number} Current (damped) azimuth angle. */
    _theta: number;
    /** @type {number} Current (damped) polar angle. */
    _phi: number;
    /** @type {number} Current (damped) radius. */
    _radius: number;
    /** @type {number} Goal azimuth angle. */
    _goalTheta: number;
    /** @type {number} Goal polar angle. */
    _goalPhi: number;
    /** @type {number} Goal radius. */
    _goalRadius: number;
    /** @type {Vec3} Damped orbit centre actually used by the camera. */
    _smoothTarget: Vec3;
    /** @type {number} Active interaction state. */
    _state: number;
    /** @type {OrbitPointer[]} Active pointers. */
    _pointers: OrbitPointer[];
    /** @type {OrbitPointer[]} Pointer pool. */
    _pointerPool: OrbitPointer[];
    /** @type {number} Previous pinch distance. */
    _prevPinch: number;
    /** @type {number} Previous centroid X. */
    _prevCenterX: number;
    /** @type {number} Previous centroid Y. */
    _prevCenterY: number;
    /** @type {Vec3} Saved target for reset(). */
    _savedTarget: Vec3;
    /** @type {number} Saved azimuth for reset(). */
    _savedTheta: number;
    /** @type {number} Saved polar for reset(). */
    _savedPhi: number;
    /** @type {number} Saved radius for reset(). */
    _savedRadius: number;
    /** @type {Array<*>} Registered listeners, for dispose(). */
    _listeners: Array<any>;
    /**
     * Derives the spherical coordinates from the camera's current position.
     * @private
     */
    private _syncFromCamera;
    /**
     * Creates the bound handler closures once.
     * @private
     */
    private _bindHandlers;
    _onPointerDown: (e: any) => void;
    _onPointerMove: (e: any) => void;
    _onPointerUp: (e: any) => void;
    _onWheel: (e: any) => void;
    _onContextMenu: (e: any) => void;
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
     * Attaches the pointer listeners. No-op when headless.
     * @private
     */
    private _attach;
    /**
     * @param {number} id Pointer identifier.
     * @returns {OrbitPointer|null} Tracked pointer or null.
     * @private
     */
    private _findPointer;
    /**
     * @param {PointerEvent} e Event.
     * @private
     */
    private _handlePointerDown;
    /**
     * Rebases the two-pointer gesture reference values.
     * @private
     */
    private _resetGestureReference;
    /**
     * @param {PointerEvent} e Event.
     * @private
     */
    private _handlePointerMove;
    /**
     * @param {PointerEvent} e Event.
     * @private
     */
    private _handlePointerUp;
    /**
     * @param {WheelEvent} e Event.
     * @private
     */
    private _handleWheel;
    /**
     * Height in CSS pixels of the controlled element (used to normalize drags).
     * @returns {number} Element height, never zero.
     * @private
     */
    private _elementHeight;
    /**
     * Width in CSS pixels of the controlled element.
     * @returns {number} Element width, never zero.
     * @private
     */
    private _elementWidth;
    /**
     * Rotates the orbit goal by a pixel drag.
     * @param {number} dxPixels Horizontal drag in pixels.
     * @param {number} dyPixels Vertical drag in pixels.
     */
    rotate(dxPixels: number, dyPixels: number): void;
    /**
     * Pans the orbit centre by a pixel drag along the camera plane.
     * @param {number} dxPixels Horizontal drag in pixels.
     * @param {number} dyPixels Vertical drag in pixels.
     */
    pan(dxPixels: number, dyPixels: number): void;
    /**
     * Multiplies the goal orbit distance.
     * @param {number} factor Values below 1 move the camera closer.
     */
    dolly(factor: number): void;
    /**
     * Clamps the goal spherical coordinates against the configured limits.
     * @private
     */
    private _clampGoals;
    /**
     * Stores the current configuration so `reset()` can restore it.
     */
    saveState(): void;
    /**
     * Restores the configuration captured by `saveState()`.
     */
    reset(): void;
    /**
     * Current distance between camera and orbit centre.
     * @returns {number} Distance in world units.
     */
    getDistance(): number;
    /**
     * Sets the goal orbit distance.
     * @param {number} distance Distance in world units.
     */
    setDistance(distance: number): void;
    /**
     * Current polar angle in radians.
     * @returns {number} Polar angle.
     */
    getPolarAngle(): number;
    /**
     * Current azimuth angle in radians.
     * @returns {number} Azimuth angle.
     */
    getAzimuthalAngle(): number;
    /**
     * Sets both spherical goal angles at once.
     * @param {number} azimuth Azimuth in radians.
     * @param {number} polar Polar angle in radians.
     */
    setAngles(azimuth: number, polar: number): void;
    /**
     * Advances damping and writes the resulting transform to the camera.
     * @param {number} [dt=1/60] Frame time in seconds.
     * @returns {boolean} Whether the camera transform changed this frame.
     */
    update(dt?: number): boolean;
    /**
     * Writes position and orientation to the camera from the current spherical
     * state. The orientation is built analytically (Qy(theta) * Qx(phi - PI/2)),
     * which stays stable at the poles where a look-at basis degenerates.
     */
    updateCameraTransform(): void;
    /**
     * Removes every listener and clears pointer tracking.
     */
    dispose(): void;
}
import { Vec3 } from "../math/Vec3.js";
/**
 * Tracked pointer used by the controller.
 */
declare class OrbitPointer {
    /** @type {number} */
    id: number;
    /** @type {number} */
    x: number;
    /** @type {number} */
    y: number;
    /** @type {string} */
    type: string;
}
export {};
