/**
 * Capsule character controller driven by `move(desiredVelocity, dt)`.
 */
export class CharacterController {
    /**
     * @param {import('./CollisionWorld.js').CollisionWorld} world Collision world.
     * @param {Object} [options] Configuration.
     * @param {number} [options.radius=0.35] Capsule radius.
     * @param {number} [options.height=1.8] Total capsule height, caps included.
     * @param {number} [options.crouchHeight] Height used while crouching.
     * @param {number} [options.stepOffset=0.35] Tallest step that can be climbed.
     * @param {number} [options.slopeLimit=50] Walkable slope limit, in degrees.
     * @param {number} [options.contactOffset=0.02] Skin width kept around the capsule.
     * @param {number} [options.maxIterations=5] Collide-and-slide iterations.
     * @param {number} [options.gravity] Acceleration along `-up`; taken from the
     *   world when omitted.
     * @param {Vec3} [options.up] Up axis, defaults to (0, 1, 0).
     * @param {Vec3} [options.position] Initial feet position.
     * @param {number} [options.mask=0xffffffff] Collision layer mask.
     * @param {boolean} [options.applyGravity=true] Let the controller own the
     *   vertical velocity.
     */
    constructor(world: import('./CollisionWorld.js').CollisionWorld, options?: {
        radius?: number;
        height?: number;
        crouchHeight?: number;
        stepOffset?: number;
        slopeLimit?: number;
        contactOffset?: number;
        maxIterations?: number;
        gravity?: number;
        up?: Vec3;
        position?: Vec3;
        mask?: number;
        applyGravity?: boolean;
    });
    /** @type {import('./CollisionWorld.js').CollisionWorld} */
    world: import('./CollisionWorld.js').CollisionWorld;
    /** @type {boolean} True marker for duck typing. */
    isCharacterController: boolean;
    /** @type {Vec3} Up axis of the capsule. */
    up: Vec3;
    /** @type {Vec3} Feet position (base of the capsule). */
    position: Vec3;
    /** @type {Vec3} Current world velocity. */
    velocity: Vec3;
    /** @type {Vec3} Velocity requested by `update(dt)`. */
    desiredVelocity: Vec3;
    /** @type {number} */
    radius: number;
    /** @type {number} Total height, hemispherical caps included. */
    height: number;
    /** @type {number} */
    standHeight: number;
    /** @type {number} */
    crouchHeight: number;
    /** @type {boolean} */
    crouching: boolean;
    /** @type {number} Tallest step the character can climb. */
    stepOffset: number;
    /** @type {number} Walkable slope limit, in degrees. */
    slopeLimit: number;
    /** @type {number} Skin width kept between the capsule and every surface. */
    contactOffset: number;
    /** @type {number} Collide-and-slide iterations per phase. */
    maxIterations: number;
    /** @type {number} Depenetration passes run before each move. */
    depenetrationIterations: number;
    /** @type {number} Extra downward probe used to stay glued to the floor. */
    groundSnapDistance: number;
    /**
     * Downward speed kept while grounded. The default 0 relies purely on the
     * ground snap of `_probeGround`, which is what keeps the capsule from
     * sinking back into a step it has just climbed.
     * @type {number}
     */
    groundStickSpeed: number;
    /** @type {number} Acceleration applied while sliding down a steep slope. */
    slideAcceleration: number;
    /** @type {number} Terminal fall speed. */
    maxFallSpeed: number;
    /** @type {number} Collision layer mask. */
    mask: number;
    /** @type {boolean} The controller integrates gravity itself. */
    applyGravity: boolean;
    /** @type {boolean} */
    enabled: boolean;
    /** @type {boolean} Whether fluid volumes affect this character at all. */
    swimEnabled: boolean;
    /**
     * @type {number} Buoyancy relative to gravity.
     *
     * The character settles where `submersion * buoyancy === 1`, so this value
     * directly picks the waterline: 1.35 leaves roughly a quarter of the capsule
     * above the surface — head and shoulders out, which is what swimming looks
     * like. It also sets how fast a diver returns: the net upward acceleration
     * while fully under is `g * (buoyancy - 1)`.
     *
     * A real human is close to neutral (~0.98), and simulating that faithfully
     * gives a swimmer who rises at 18 cm/s and drowns waiting. This is one of
     * the places where the honest number is the wrong one.
     */
    buoyancy: number;
    /** @type {number} Exponential velocity damping while fully submerged. */
    swimDrag: number;
    /** @type {number} Horizontal speed multiplier when fully submerged. */
    swimSpeedScale: number;
    /** @type {number} Terminal sink speed, far below the in-air one. */
    maxSinkSpeed: number;
    /** @type {number} Submersion above which the character counts as swimming. */
    swimThreshold: number;
    /** @type {number} Fraction of the capsule below a fluid surface, 0..1. */
    submersion: number;
    /** @type {boolean} True while any part of the capsule is in a fluid. */
    inWater: boolean;
    /** @type {boolean} True while deep enough to swim rather than wade. */
    swimming: boolean;
    /** @type {import('./WaterVolume.js').WaterVolume|null} Fluid in contact. */
    water: import('./WaterVolume.js').WaterVolume | null;
    /** @type {number} Gravity along `-up`, negative. */
    gravity: number;
    /** @type {boolean} True while standing on a walkable surface. */
    isGrounded: boolean;
    /** @type {Vec3} Normal of the surface the character stands on. */
    groundNormal: Vec3;
    /** @type {Object|null} Collider the character stands on. */
    groundCollider: any | null;
    /** @type {boolean} True when a steep, non walkable surface was hit below. */
    onSteepSlope: boolean;
    /** @type {Vec3} Normal of that steep surface. */
    steepNormal: Vec3;
    /** @type {boolean} True when the last move bumped into a ceiling. */
    hitCeiling: boolean;
    /** @type {boolean} True when the last move was blocked by a wall. */
    hitWall: boolean;
    /** @type {Vec3} Normal of that wall. */
    wallNormal: Vec3;
    /** @type {Vec3} Displacement actually applied by the last move. */
    lastDisplacement: Vec3;
    /** @type {Object|null} Node3D kept in sync by `syncNode()`. */
    node: any | null;
    /** @type {number} Vertical offset applied when writing to `node`. */
    nodeOffset: number;
    /** @private Cosine of the slope limit. */
    private _minGroundDot;
    /** @private True on the frame a jump was requested. */
    private _jumped;
    /** @private Set by `_slideMove` when a non walkable surface blocked it. */
    private _blockedByWall;
    /** @private Distance covered by the last `_moveAxis` call. */
    private _axisDistance;
    /** @private True when the last move mounted a step. */
    private _steppedUp;
    /** @private Scratch - the move path never allocates. */
    private _p0;
    _p1: Vec3;
    _dir: Vec3;
    _disp: Vec3;
    _tmp: Vec3;
    _tmp2: Vec3;
    _start: Vec3;
    _flatEnd: Vec3;
    _stepSave: Vec3;
    _plane1: Vec3;
    _plane2: Vec3;
    _down: Vec3;
    _hit: any;
    _probeHit: any;
    _contacts: any[];
    /**
     * Writes the endpoints of the capsule's inner segment for a given feet
     * position.
     * @param {Vec3} feet Feet position.
     * @param {Vec3} out0 Receives the lower sphere centre.
     * @param {Vec3} out1 Receives the upper sphere centre.
     * @returns {void}
     */
    getSegmentAt(feet: Vec3, out0: Vec3, out1: Vec3): void;
    /**
     * Writes the endpoints of the capsule's inner segment at the current position.
     * @param {Vec3} out0 Receives the lower sphere centre.
     * @param {Vec3} out1 Receives the upper sphere centre.
     * @returns {void}
     */
    getSegment(out0: Vec3, out1: Vec3): void;
    /**
     * Refreshes `submersion`, `inWater`, `swimming` and `water` from the fluid
     * volumes registered in the collision world.
     *
     * The capsule's submerged fraction is used rather than a simple "is the head
     * underwater" test, so wading, swimming at the surface and diving are one
     * continuous quantity instead of three special cases.
     *
     * @returns {number} the submerged fraction, 0..1
     */
    updateSubmersion(): number;
    /**
     * Centre of the capsule in world space.
     * @param {Vec3} out Receives the centre.
     * @returns {Vec3} out
     */
    getCenter(out: Vec3): Vec3;
    /**
     * Sets the walkable slope limit.
     * @param {number} degrees Slope limit in degrees.
     * @returns {CharacterController} this
     */
    setSlopeLimit(degrees: number): CharacterController;
    /**
     * Changes the capsule height, keeping the feet in place.
     * @param {number} height New total height.
     * @returns {CharacterController} this
     */
    setHeight(height: number): CharacterController;
    /**
     * True when the surface normal is shallow enough to stand on.
     * @param {number} nx Normal x.
     * @param {number} ny Normal y.
     * @param {number} nz Normal z.
     * @returns {boolean} Walkability.
     */
    isWalkable(nx: number, ny: number, nz: number): boolean;
    /**
     * Requests a jump. Ignored when the character is not grounded.
     * @param {number} speed Initial upward speed, in m/s.
     * @param {boolean} [force=false] Jump even when airborne.
     * @returns {boolean} True when the jump was accepted.
     */
    jump(speed: number, force?: boolean): boolean;
    /**
     * Crouches or stands up. Standing up is refused when the headroom is blocked.
     * @param {boolean} enable True to crouch.
     * @returns {boolean} True when the state changed.
     */
    crouch(enable: boolean): boolean;
    /**
     * Checks whether the character has enough headroom to stand up.
     * @returns {boolean} True when standing up is possible.
     */
    canStandUp(): boolean;
    /**
     * Teleports the character, clearing its velocity and ground state.
     * @param {Vec3} position New feet position.
     * @returns {CharacterController} this
     */
    teleport(position: Vec3): CharacterController;
    /**
     * Copies the character position into a scene node.
     * @param {Object} [node] Target node; `this.node` when omitted.
     * @returns {CharacterController} this
     */
    syncNode(node?: any): CharacterController;
    /**
     * Engine friendly entry point: moves with `desiredVelocity`.
     * @param {number} dt Frame time in seconds.
     * @returns {CharacterController} this
     */
    update(dt: number): CharacterController;
    /**
     * Main entry point. Moves the capsule by `desiredVelocity * dt`, resolving
     * every collision along the way.
     *
     * With `applyGravity` enabled (the default) only the horizontal part of
     * `desiredVelocity` is honoured; the vertical component is owned by the
     * controller (gravity + {@link CharacterController#jump}). With it disabled
     * the vector is used verbatim, which is what a flying or swimming character
     * wants.
     *
     * @param {Vec3} desiredVelocity Requested world velocity, in m/s.
     * @param {number} dt Frame time in seconds.
     * @returns {CharacterController} this
     */
    move(desiredVelocity: Vec3, dt: number): CharacterController;
    /**
     * Step-up retry, run only when the lateral slide was stopped by a wall while
     * the character was grounded.
     *
     * The capsule is raised by `stepOffset`, pushed forward and dropped back
     * down. The forward probe travels at least one radius, because a per frame
     * displacement smaller than the capsule radius would leave the capsule
     * hanging on the convex edge of the step and the landing would be rejected as
     * "too steep". Once the landing is validated the horizontal advance is
     * clamped back to what the caller actually asked for, so mounting a step
     * never teleports the character forward.
     *
     * @private
     * @param {number} hx Requested displacement x.
     * @param {number} hy Requested displacement y.
     * @param {number} hz Requested displacement z.
     * @param {number} reqLen Length of the requested displacement.
     * @param {number} flatProgress Squared horizontal progress of the flat slide.
     * @returns {boolean} True when the stepped result was kept.
     */
    private _tryStepUp;
    /**
     * Squared distance between two points, ignoring the up axis.
     * @private
     * @param {Vec3} a First point.
     * @param {Vec3} b Second point.
     * @returns {number} Squared horizontal distance.
     */
    private _horizontalDistanceSq;
    /**
     * Pushes the capsule out of anything it currently overlaps.
     * @private
     * @returns {void}
     */
    private _depenetrate;
    /**
     * Sweeps the capsule along a fixed axis without sliding.
     * @private
     * @param {number} dx Axis x (unit length).
     * @param {number} dy Axis y.
     * @param {number} dz Axis z.
     * @param {number} distance Distance to travel.
     * @returns {Object|null} The blocking hit, or null when the move completed.
     */
    private _moveAxis;
    /**
     * {@link CharacterController#_moveAxis} returning the travelled distance.
     * @private
     * @param {number} dx Axis x.
     * @param {number} dy Axis y.
     * @param {number} dz Axis z.
     * @param {number} distance Distance to travel.
     * @returns {number} Distance actually covered.
     */
    private _moveAxisDistance;
    /**
     * Collide-and-slide. The displacement is consumed over several sweeps, each
     * one projecting the remainder onto the plane it just hit. Two planes are
     * remembered so a corner produces a crease slide instead of a dead stop.
     *
     * @private
     * @param {number} dx Displacement x.
     * @param {number} dy Displacement y.
     * @param {number} dz Displacement z.
     * @param {boolean} allowVertical Keep the up component produced by a slide;
     *   false makes walls unclimbable (used for the lateral phase).
     * @returns {void}
     */
    private _slideMove;
    /**
     * Probes downwards to detect the floor and, when the character was already
     * grounded, snaps to it. The snap is what keeps a character glued to stairs
     * and ramps instead of taking off at every crest.
     * @private
     * @param {boolean} wasGrounded Ground state before the move.
     * @returns {void}
     */
    private _probeGround;
    /**
     * Drops the references held by the controller.
     * @returns {void}
     */
    dispose(): void;
}
import { Vec3 } from "../math/Vec3.js";
