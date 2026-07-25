/** Body simulation modes. */
export const BodyType: Readonly<{
    /** Moved by forces and impulses. */
    DYNAMIC: "dynamic";
    /** Moved by the user, pushes dynamic bodies but is never pushed back. */
    KINEMATIC: "kinematic";
    /** Never moves; infinite mass. */
    STATIC: "static";
}>;
/** Supported collision shapes. */
export const BodyShape: Readonly<{
    SPHERE: "sphere";
    BOX: "box";
    CAPSULE: "capsule";
}>;
/**
 * Dynamic body with mass, inertia and a primitive collision shape.
 */
export class RigidBody {
    /** @type {number} Monotonic id source. */
    static _nextId: number;
    /**
     * @param {Object} [options] Configuration.
     * @param {number} [options.mass=1] Mass in kilograms; 0 makes the body static.
     * @param {string} [options.shape='sphere'] `'sphere'`, `'box'` or `'capsule'`.
     * @param {number} [options.radius=0.5] Sphere / capsule radius.
     * @param {number} [options.height=1] Capsule cylindrical section length.
     * @param {Vec3|{x:number,y:number,z:number}} [options.halfExtents] Box half size.
     * @param {Vec3} [options.position] Initial world position.
     * @param {Quat} [options.quaternion] Initial world orientation.
     * @param {Vec3} [options.velocity] Initial linear velocity.
     * @param {number} [options.restitution=0.2] Bounciness, 0..1.
     * @param {number} [options.friction=0.5] Coulomb friction coefficient.
     * @param {number} [options.linearDamping=0.01] Linear velocity decay rate.
     * @param {number} [options.angularDamping=0.05] Angular velocity decay rate.
     * @param {number} [options.gravityScale=1] Per body gravity multiplier.
     * @param {string} [options.type='dynamic'] See {@link BodyType}.
     * @param {boolean} [options.allowSleep=true] Let the body fall asleep.
     * @param {Object} [options.node] Node3D kept in sync by `syncNode()`.
     * @param {number} [options.layer=1] Collision layer bit.
     * @param {number} [options.mask=0xffffffff] Layers this body collides with.
     */
    constructor(options?: {
        mass?: number;
        shape?: string;
        radius?: number;
        height?: number;
        halfExtents?: Vec3 | {
            x: number;
            y: number;
            z: number;
        };
        position?: Vec3;
        quaternion?: Quat;
        velocity?: Vec3;
        restitution?: number;
        friction?: number;
        linearDamping?: number;
        angularDamping?: number;
        gravityScale?: number;
        type?: string;
        allowSleep?: boolean;
        node?: any;
        layer?: number;
        mask?: number;
    });
    /** @type {number} */
    id: number;
    /** @type {string} */
    name: string;
    /** @type {boolean} True marker for duck typing. */
    isRigidBody: boolean;
    /** @type {string} See {@link BodyType}. */
    type: string;
    /** @type {string} See {@link BodyShape}. */
    shape: string;
    /** @type {number} Sphere / capsule radius. */
    radius: number;
    /** @type {number} Length of the capsule's cylindrical section. */
    height: number;
    /** @type {Vec3} Box half extents. */
    halfExtents: Vec3;
    /** @type {Vec3} World position of the centre of mass. */
    position: Vec3;
    /** @type {Quat} World orientation. */
    quaternion: Quat;
    /** @type {Vec3} Linear velocity, world space, m/s. */
    velocity: Vec3;
    /** @type {Vec3} Angular velocity, world space, rad/s. */
    angularVelocity: Vec3;
    /** @type {Vec3} Force accumulator, cleared by `integratePosition`. */
    force: Vec3;
    /** @type {Vec3} Torque accumulator, cleared by `integratePosition`. */
    torque: Vec3;
    /** @type {number} */
    mass: number;
    /** @type {number} 1 / mass, 0 for static and kinematic bodies. */
    invMass: number;
    /** @type {Vec3} Diagonal inertia tensor in body space. */
    inertia: Vec3;
    /** @type {Vec3} Component wise inverse of `inertia`. */
    invInertia: Vec3;
    /** @type {Mat3} R * diag(invInertia) * R^T, refreshed every step. */
    invInertiaWorld: Mat3;
    /** @type {number} Bounciness, 0 (dead) .. 1 (elastic). */
    restitution: number;
    /** @type {number} Coulomb friction coefficient. */
    friction: number;
    /** @type {number} Linear damping rate (1 / seconds). */
    linearDamping: number;
    /** @type {number} Angular damping rate (1 / seconds). */
    angularDamping: number;
    /** @type {number} Per body gravity multiplier. */
    gravityScale: number;
    /** @type {boolean} Locks the orientation (useful for characters and pickups). */
    fixedRotation: boolean;
    /** @type {boolean} */
    allowSleep: boolean;
    /** @type {boolean} */
    sleeping: boolean;
    /** @type {number} Seconds spent below the sleep thresholds. */
    sleepTimer: number;
    /**
     * @type {number} Fraction of the body below a fluid surface, 0..1. Written
     * by {@link CollisionWorld} every step; read it to drive splash effects,
     * swim states or muffled audio.
     */
    submersion: number;
    /** @type {boolean} True while any part of the body is inside a fluid. */
    inWater: boolean;
    /** @type {number} m/s below which the body counts as still. */
    sleepLinearThreshold: number;
    /** @type {number} rad/s below which the body counts as still. */
    sleepAngularThreshold: number;
    /** @type {number} Seconds of stillness before falling asleep. */
    sleepDelay: number;
    /** @type {boolean} Excluded from the simulation while false. */
    enabled: boolean;
    /** @type {number} Collision layer bit. */
    layer: number;
    /** @type {number} Layers this body collides with. */
    mask: number;
    /** @type {Object|null} Node3D whose transform mirrors this body. */
    node: any | null;
    /** @type {Object} Free-form user storage. */
    userData: any;
    /** @type {AABB} World bounds, refreshed by `updateAABB()`. */
    aabb: AABB;
    /** @type {number} Broad phase proxy id inside the world, -1 when detached. */
    proxyId: number;
    /** @type {Object|null} Owning CollisionWorld. */
    world: any | null;
    /**
     * Sets the mass and recomputes the inertia tensor for the current shape.
     * A mass of 0 (or a non dynamic type) yields an immovable body.
     * @param {number} mass Mass in kilograms.
     * @returns {RigidBody} this
     */
    setMass(mass: number): RigidBody;
    /**
     * Recomputes `inertia` / `invInertia` from the shape and the current mass.
     * Called automatically by `setMass` and the shape setters.
     * @returns {RigidBody} this
     */
    computeInertia(): RigidBody;
    /**
     * Rebuilds `invInertiaWorld` = R * diag(invInertia) * R^T.
     * The result is symmetric, so its storage order does not matter.
     * @returns {RigidBody} this
     */
    updateInertiaWorld(): RigidBody;
    /**
     * Switches the collision shape and refreshes the mass properties.
     * @param {string} shape See {@link BodyShape}.
     * @param {Object} [dims] `{radius, height, halfExtents}`.
     * @returns {RigidBody} this
     */
    setShape(shape: string, dims?: any): RigidBody;
    /**
     * Radius of the sphere that fully contains the shape, centred on the body.
     * @returns {number} Bounding radius.
     */
    getBoundingRadius(): number;
    /**
     * Writes the world space endpoints of a capsule's inner segment. For a sphere
     * both endpoints collapse onto the centre; for a box the segment spans the
     * local Y axis of the box (used only by the broad phase).
     * @param {Vec3} out0 Receives the lower endpoint.
     * @param {Vec3} out1 Receives the upper endpoint.
     * @returns {void}
     */
    getWorldSegment(out0: Vec3, out1: Vec3): void;
    /**
     * Accumulates a force (N) for the next integration step.
     * @param {Vec3} f Force in world space.
     * @param {Vec3} [worldPoint] Application point; the centre of mass when omitted.
     * @returns {RigidBody} this
     */
    applyForce(f: Vec3, worldPoint?: Vec3): RigidBody;
    /**
     * Accumulates a torque (N*m).
     * @param {Vec3} t Torque in world space.
     * @returns {RigidBody} this
     */
    applyTorque(t: Vec3): RigidBody;
    /**
     * Applies an instantaneous impulse (N*s): the velocity changes immediately.
     * @param {Vec3} j Impulse in world space.
     * @param {Vec3} [at] World space application point; the centre of mass when omitted.
     * @returns {RigidBody} this
     */
    applyImpulse(j: Vec3, at?: Vec3): RigidBody;
    /**
     * Applies an angular impulse (N*m*s).
     * @param {Vec3} t Angular impulse in world space.
     * @returns {RigidBody} this
     */
    applyTorqueImpulse(t: Vec3): RigidBody;
    /**
     * Velocity of a world space point rigidly attached to the body.
     * @param {Vec3} worldPoint Point in world space.
     * @param {Vec3} out Receives the velocity.
     * @returns {Vec3} out
     */
    getPointVelocity(worldPoint: Vec3, out: Vec3): Vec3;
    /**
     * Full semi-implicit Euler step (velocity then position). `CollisionWorld`
     * calls the two halves separately so the contact solver can run in between.
     * @param {number} dt Time step in seconds.
     * @param {Vec3} [gravity] World gravity; none is applied when omitted.
     * @returns {RigidBody} this
     */
    integrate(dt: number, gravity?: Vec3): RigidBody;
    /**
     * First half of the step: applies gravity, the accumulated force / torque and
     * the damping, then clears the accumulators.
     *
     * Damping uses the unconditionally stable implicit form `v /= 1 + k * dt`,
     * which behaves like an exponential decay without ever flipping the sign at
     * large time steps.
     *
     * @param {number} dt Time step in seconds.
     * @param {Vec3} [gravity] World gravity.
     * @returns {RigidBody} this
     */
    integrateVelocity(dt: number, gravity?: Vec3): RigidBody;
    /**
     * Second half of the step: advances the transform with the solved velocities.
     * Kinematic bodies are advanced too, so scripted platforms keep moving.
     * @param {number} dt Time step in seconds.
     * @returns {RigidBody} this
     */
    integratePosition(dt: number): RigidBody;
    /**
     * Rebuilds the world space AABB of the shape.
     * @returns {AABB} The refreshed bounds.
     */
    updateAABB(): AABB;
    /**
     * Wakes the body up and restarts its sleep timer.
     * @returns {RigidBody} this
     */
    wake(): RigidBody;
    /**
     * Puts the body to sleep, zeroing its velocities.
     * @returns {RigidBody} this
     */
    sleep(): RigidBody;
    /**
     * Advances the sleep timer and puts the body to sleep once it has been below
     * the motion thresholds for `sleepDelay` seconds.
     * @param {number} dt Time step in seconds.
     * @returns {boolean} True when the body is asleep after the update.
     */
    updateSleep(dt: number): boolean;
    /**
     * Copies the body transform into a scene node.
     * @param {Object} [node] Target node; `this.node` when omitted.
     * @returns {RigidBody} this
     */
    syncNode(node?: any): RigidBody;
    /**
     * Reads the transform back from a scene node (useful for kinematic bodies
     * driven by animation).
     * @param {Object} [node] Source node; `this.node` when omitted.
     * @returns {RigidBody} this
     */
    readNode(node?: any): RigidBody;
    /**
     * Teleports the body, clearing the accumulated forces.
     * @param {Vec3} position New world position.
     * @param {Quat} [quaternion] New world orientation.
     * @returns {RigidBody} this
     */
    teleport(position: Vec3, quaternion?: Quat): RigidBody;
    /**
     * Replaces the linear velocity.
     * @param {number} x Velocity x.
     * @param {number} y Velocity y.
     * @param {number} z Velocity z.
     * @returns {RigidBody} this
     */
    setVelocity(x: number, y: number, z: number): RigidBody;
    /**
     * Replaces the angular velocity.
     * @param {number} x Angular velocity x.
     * @param {number} y Angular velocity y.
     * @param {number} z Angular velocity z.
     * @returns {RigidBody} this
     */
    setAngularVelocity(x: number, y: number, z: number): RigidBody;
}
import { Vec3 } from "../math/Vec3.js";
import { Quat } from "../math/Quat.js";
import { Mat3 } from "../math/Mat3.js";
import { AABB } from "../math/AABB.js";
