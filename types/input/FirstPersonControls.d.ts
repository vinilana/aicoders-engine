/**
 * Free-look first person controller.
 */
export class FirstPersonControls {
    /**
     * @param {import('../scene/Camera.js').Camera} camera Camera to drive.
     * @param {import('./Input.js').Input} input Shared input state.
     * @param {Object} [options] Behaviour options.
     * @param {*} [options.controller] Optional CharacterController to drive.
     * @param {number} [options.moveSpeed=6] Walk speed in units per second.
     * @param {number} [options.sprintMultiplier=2.2] Speed factor while sprinting.
     * @param {number} [options.crouchMultiplier=0.45] Speed factor while crouching.
     * @param {number} [options.lookSensitivity=0.0022] Radians per mouse pixel.
     * @param {number} [options.acceleration=48] Velocity response while accelerating.
     * @param {number} [options.deceleration=32] Velocity response while stopping.
     * @param {boolean} [options.fly] Free flight (defaults to true without a controller).
     * @param {number} [options.eyeHeight=1.7] Camera height above the controller origin.
     * @param {number} [options.gravity=-24] Gravity applied in walk mode without a controller.
     * @param {number} [options.jumpSpeed=7] Vertical launch speed.
     * @param {number} [options.groundHeight=0] Floor height used in walk mode without a controller.
     * @param {boolean} [options.requirePointerLock=true] Only look while locked or dragging.
     * @param {boolean} [options.dragToLook=true] Allow looking while holding the left button.
     * @param {Object} [options.keys] Key map overrides.
     */
    constructor(camera: import('../scene/Camera.js').Camera, input: import('./Input.js').Input, options?: {
        controller?: any;
        moveSpeed?: number;
        sprintMultiplier?: number;
        crouchMultiplier?: number;
        lookSensitivity?: number;
        acceleration?: number;
        deceleration?: number;
        fly?: boolean;
        eyeHeight?: number;
        gravity?: number;
        jumpSpeed?: number;
        groundHeight?: number;
        requirePointerLock?: boolean;
        dragToLook?: boolean;
        keys?: any;
    });
    /** @type {*} Controlled camera. */
    camera: any;
    /** @type {*} Input source. */
    input: any;
    /** @type {*} Optional CharacterController receiving the desired velocity. */
    controller: any;
    /** @type {boolean} Master switch. */
    enabled: boolean;
    /** @type {number} Walk speed in units per second. */
    moveSpeed: number;
    /** @type {number} Sprint speed factor. */
    sprintMultiplier: number;
    /** @type {number} Crouch speed factor. */
    crouchMultiplier: number;
    /** @type {number} Radians of yaw/pitch per mouse pixel. */
    lookSensitivity: number;
    /** @type {number} Radians per second for gamepad look. */
    gamepadLookSpeed: number;
    /** @type {number} Velocity response while accelerating. */
    acceleration: number;
    /** @type {number} Velocity response while stopping. */
    deceleration: number;
    /** @type {number} Response factor applied while airborne. */
    airControl: number;
    /** @type {boolean} Free flight mode (no gravity, pitch affects movement). */
    fly: boolean;
    /** @type {number} Camera offset above the controller origin. */
    eyeHeight: number;
    /** @type {number} Gravity used only in the built-in walk integrator. */
    gravity: number;
    /** @type {number} Vertical launch speed. */
    jumpSpeed: number;
    /**
     * @type {number} Vertical speed requested while swimming, in m/s. Applied
     * only when the attached controller reports `swimming`.
     */
    swimVerticalSpeed: number;
    /** @type {number} Floor height for the built-in walk integrator. */
    groundHeight: number;
    /** @type {number} Lowest pitch in radians. */
    minPitch: number;
    /** @type {number} Highest pitch in radians. */
    maxPitch: number;
    /** @type {boolean} Invert the vertical look axis. */
    invertY: boolean;
    /** @type {boolean} Only look while pointer locked (or dragging). */
    requirePointerLock: boolean;
    /** @type {boolean} Allow looking while the left mouse button is held. */
    dragToLook: boolean;
    /** @type {Object} Key map. */
    keys: any;
    /** @type {number} Current yaw in radians. */
    yaw: number;
    /** @type {number} Current pitch in radians. */
    pitch: number;
    /** @type {Vec3} Smoothed world velocity. */
    velocity: Vec3;
    /** @type {boolean} Ground state (mirrors the controller when present). */
    isGrounded: boolean;
    /** @type {boolean} True while the sprint key is held and moving. */
    isSprinting: boolean;
    /** @type {boolean} True while the crouch key is held. */
    isCrouching: boolean;
    /** @type {number} Gamepad slot used for movement and look. */
    gamepadIndex: number;
    /**
     * Reads yaw and pitch back from the camera's current orientation.
     */
    syncFromCamera(): void;
    /**
     * Sets the look angles directly.
     * @param {number} yaw Yaw in radians.
     * @param {number} pitch Pitch in radians.
     */
    setRotation(yaw: number, pitch: number): void;
    /**
     * Writes the yaw/pitch quaternion to the camera.
     * @private
     */
    private _applyRotation;
    /**
     * Writes the camera forward vector.
     * @param {Vec3} out Destination vector.
     * @returns {Vec3} The destination vector.
     */
    getDirection(out: Vec3): Vec3;
    /**
     * Reads the look delta from mouse and gamepad and updates yaw/pitch.
     * @param {number} dt Frame time in seconds.
     * @private
     */
    private _updateLook;
    /**
     * Builds the normalized movement intent in local space (x = strafe,
     * y = vertical, z = forward).
     * @param {Vec3} out Destination vector.
     * @private
     */
    private _readMoveIntent;
    /**
     * True while the sprint key or gamepad button is held.
     * @returns {boolean} Sprint state.
     * @private
     */
    private _readSprint;
    /**
     * True during the frame the jump control was activated.
     * @returns {boolean} Jump request.
     * @private
     */
    private _readJump;
    /**
     * Advances the controller.
     * @param {number} dt Frame time in seconds.
     */
    update(dt: number): void;
    /**
     * Stops all motion without changing the orientation.
     */
    stop(): void;
    /**
     * Releases references. The controller owns no listeners of its own.
     */
    dispose(): void;
}
import { Vec3 } from "../math/Vec3.js";
