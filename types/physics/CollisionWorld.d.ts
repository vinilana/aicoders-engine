/**
 * Creates a reusable shape cast result.
 * @returns {Object} A blank sweep hit record.
 */
export function createSweepHit(): any;
/**
 * Static triangle mesh registered in a {@link CollisionWorld}.
 *
 * Two storage modes exist:
 * - *shared*: the collider reuses the geometry's {@link TriangleBVH} and
 *   transforms queries into local space. Requires a uniform scale.
 * - *baked*: the vertices are transformed into world space once and a private
 *   BVH is built. Used when the world matrix has a non uniform scale.
 */
export class StaticCollider {
    /** @type {number} Monotonic id source. */
    static _nextId: number;
    /**
     * @param {Object} source Mesh-like object, or `{positions, indices, matrix}`.
     * @param {Object} [options] Configuration.
     * @param {number} [options.friction=0.6] Surface friction coefficient.
     * @param {number} [options.restitution=0] Surface bounciness.
     * @param {number} [options.layer=1] Collision layer bit.
     * @param {Mat4} [options.matrix] Overrides the mesh world matrix.
     * @param {boolean} [options.bake=false] Forces the baked (world space) mode.
     */
    constructor(source: any, options?: {
        friction?: number;
        restitution?: number;
        layer?: number;
        matrix?: Mat4;
        bake?: boolean;
    });
    /** @type {number} */
    id: number;
    /** @type {boolean} True marker for duck typing. */
    isStaticCollider: boolean;
    /** @type {Object|null} Mesh this collider was built from. */
    mesh: any | null;
    /** @type {number} */
    friction: number;
    /** @type {number} */
    restitution: number;
    /** @type {number} */
    layer: number;
    /** @type {boolean} */
    enabled: boolean;
    /** @type {Object} Free-form user storage. */
    userData: any;
    /** @type {Float32Array|null} */
    positions: Float32Array | null;
    /** @type {Uint32Array|Uint16Array|null} */
    indices: Uint32Array | Uint16Array | null;
    /** @type {TriangleBVH|null} */
    bvh: TriangleBVH | null;
    /** @type {boolean} True when `bvh` / `positions` are owned (baked). */
    baked: boolean;
    /** @type {Mat4} Local to world transform. */
    matrix: Mat4;
    /** @type {Mat4} World to local transform. */
    invMatrix: Mat4;
    /** @type {boolean} True when the transform is the identity. */
    identity: boolean;
    /** @type {number} Uniform scale factor of `matrix`. */
    scale: number;
    /** @type {number} 1 / scale. */
    invScale: number;
    /** @type {AABB} World space bounds. */
    aabb: AABB;
    /** @type {number} Broad phase proxy id, -1 when detached. */
    proxyId: number;
    /** @private */
    private _forceBake;
    /** @private @type {Mat4|null} */
    private _matrixOverride;
    /** @private @type {Object|null} Raw triangle source when not a Mesh. */
    private _rawSource;
    /**
     * (Re)reads the source transform and rebuilds whatever depends on it.
     * Call it after moving a static collider.
     * @returns {StaticCollider} this
     */
    refresh(): StaticCollider;
    /**
     * Transforms the geometry into world space and builds a private BVH.
     * @private
     * @param {{positions:Float32Array, indices:*, bvh:TriangleBVH}} data Source triangles.
     * @returns {void}
     */
    private _bake;
    /**
     * Rebuilds the world space AABB from the BVH root bounds.
     * @private
     * @returns {void}
     */
    private _updateWorldAABB;
    /**
     * World -> collider space point transform.
     * @param {Vec3} p World point.
     * @param {Vec3} out Receives the local point.
     * @returns {Vec3} out
     */
    worldToLocalPoint(p: Vec3, out: Vec3): Vec3;
    /**
     * World -> collider space vector transform (length scales by `invScale`).
     * @param {Vec3} v World vector.
     * @param {Vec3} out Receives the local vector.
     * @returns {Vec3} out
     */
    worldToLocalVector(v: Vec3, out: Vec3): Vec3;
    /**
     * Collider space -> world point transform.
     * @param {Vec3} p Local point.
     * @param {Vec3} out Receives the world point.
     * @returns {Vec3} out
     */
    localToWorldPoint(p: Vec3, out: Vec3): Vec3;
    /**
     * Collider space -> world direction transform (renormalized).
     * @param {Vec3} v Local direction.
     * @param {Vec3} out Receives the world direction.
     * @returns {Vec3} out
     */
    localToWorldDirection(v: Vec3, out: Vec3): Vec3;
    /**
     * Releases the resources owned by this collider (baked mode only).
     * @returns {void}
     */
    dispose(): void;
}
/**
 * Owns the static collision geometry, the dynamic bodies and the solver.
 */
export class CollisionWorld {
    /**
     * @param {Object} [options] Configuration.
     * @param {Vec3} [options.gravity] World gravity, defaults to (0, -9.81, 0).
     * @param {number} [options.velocityIterations=8] Sequential impulse iterations.
     * @param {number} [options.positionIterations=3] Position correction iterations.
     * @param {number} [options.subSteps=1] Substeps per `step()` call.
     * @param {number} [options.contactSlop=0.005] Allowed penetration, in metres.
     * @param {number} [options.correctionPercent=0.4] Fraction of the penetration
     *   removed per position iteration.
     * @param {number} [options.bounceThreshold=1] Approach speed below which
     *   restitution is ignored (kills micro bouncing).
     * @param {number} [options.maxTimeStep=0.1] `step(dt)` clamps `dt` to this.
     * @param {number} [options.maxContactsPerBody=16] Contact budget per body.
     * @param {boolean} [options.autoSyncNodes=true] Copy body transforms to nodes.
     */
    constructor(options?: {
        gravity?: Vec3;
        velocityIterations?: number;
        positionIterations?: number;
        subSteps?: number;
        contactSlop?: number;
        correctionPercent?: number;
        bounceThreshold?: number;
        maxTimeStep?: number;
        maxContactsPerBody?: number;
        autoSyncNodes?: boolean;
    });
    /** @type {Vec3} */
    gravity: Vec3;
    /** @type {DynamicBVH} Broad phase over the static colliders. */
    staticBVH: DynamicBVH;
    /** @type {DynamicBVH} Broad phase over the dynamic bodies. */
    dynamicBVH: DynamicBVH;
    /** @type {StaticCollider[]} */
    colliders: StaticCollider[];
    /** @type {import('./RigidBody.js').RigidBody[]} */
    bodies: import('./RigidBody.js').RigidBody[];
    /** @type {number} */
    velocityIterations: number;
    /** @type {number} */
    positionIterations: number;
    /** @type {number} */
    subSteps: number;
    /**
     * @type {boolean} Grow the substep count on long frames so the solver keeps
     * seeing steps of at most `maxSubStepTime`.
     */
    autoSubSteps: boolean;
    /** @type {number} Longest substep the solver should ever integrate. */
    maxSubStepTime: number;
    /** @type {number} Ceiling on the automatic count, so a stall cannot spiral. */
    maxSubSteps: number;
    /** @type {number} */
    contactSlop: number;
    /** @type {number} */
    correctionPercent: number;
    /** @type {number} */
    bounceThreshold: number;
    /** @type {number} */
    maxTimeStep: number;
    /** @type {number} */
    maxContactsPerBody: number;
    /** @type {boolean} */
    autoSyncNodes: boolean;
    /** @type {boolean} Skip the solver entirely. */
    enabled: boolean;
    /** @type {{contacts:number, bodies:number, colliders:number, narrowPhaseTests:number}} */
    stats: {
        contacts: number;
        bodies: number;
        colliders: number;
        narrowPhaseTests: number;
    };
    /**
     * @type {import('./WaterVolume.js').WaterVolume[]} Fluid regions. Bodies
     * inside one receive buoyancy, drag and the current before integration.
     */
    waters: import('./WaterVolume.js').WaterVolume[];
    /** @private @type {Array<*>} Broad phase result buffer. */
    private _colliderList;
    /** @private @type {Array<*>} Broad phase result buffer for bodies. */
    private _bodyList;
    /** @private @type {Array<number>} Triangle index buffer. */
    private _triList;
    /** @private @type {Array<*>} */
    private _contactA;
    /** @private @type {Array<*>} */
    private _contactB;
    /** @private @type {Float64Array} */
    private _contactData;
    /** @private @type {number} */
    private _contactCapacity;
    /** @private @type {number} */
    private _contactCount;
    /** @private @type {number} Index of the first contact of the body in flight. */
    private _bodyContactStart;
    /** @private @type {number} */
    private _mergeDistanceSq;
    /** @private @type {Pool} */
    private _contactPool;
    /** @private Scratch reused by the query paths. */
    private _localPoint;
    _localPoint2: Vec3;
    _localDisp: Vec3;
    _bestNormal: Vec3;
    _bestPoint: Vec3;
    _queryAABB: AABB;
    /**
     * Alias kept for the contract wording ("broadphase com DynamicBVH").
     * @returns {DynamicBVH} The static broad phase.
     */
    get bvh(): DynamicBVH;
    /**
     * Registers a static triangle mesh. The geometry's triangle BVH is built once
     * and shared with the picking system.
     * @param {Object} mesh Mesh-like object, or `{positions, indices, matrix}`.
     * @param {Object} [options] See {@link StaticCollider}.
     * @returns {StaticCollider} The registered collider.
     */
    addStatic(mesh: any, options?: any): StaticCollider;
    /**
     * Inserts a ready collider into the broad phase.
     * @private
     * @param {StaticCollider} collider Collider to insert.
     * @returns {StaticCollider} collider
     */
    private _insertCollider;
    /**
     * Registers many copies of one mesh, sharing a single triangle BVH.
     *
     * This is what makes an instanced field of props collidable at all: building
     * a BVH per instance would cost as much memory and time as the instancing was
     * meant to save. The BVH is built once in local space and every collider only
     * carries its own transform, mapping queries into that shared space.
     *
     * The per instance matrix must have uniform scale — a non uniform one forces
     * the collider to bake its own world space copy, which silently defeats the
     * sharing. Non uniform entries are baked and reported in the return value.
     *
     * @param {{positions:Float32Array, indices:*}|Object} source Mesh or raw triangles.
     * @param {Mat4[]|Float32Array} matrices Per instance transforms; a Float32Array
     *   is read as tightly packed 16-float matrices.
     * @param {Object} [options] Passed to each {@link StaticCollider}.
     * @returns {{colliders: StaticCollider[], shared: boolean, baked: number}}
     */
    addStaticInstanced(source: any, matrices: Mat4[] | Float32Array, options?: any): {
        colliders: StaticCollider[];
        shared: boolean;
        baked: number;
    };
    /**
     * Adds a fluid region.
     * @param {import('./WaterVolume.js').WaterVolume} volume
     * @returns {import('./WaterVolume.js').WaterVolume} volume
     */
    addWater(volume: import('./WaterVolume.js').WaterVolume): import('./WaterVolume.js').WaterVolume;
    /**
     * @param {import('./WaterVolume.js').WaterVolume} volume
     * @returns {boolean} true when it was registered
     */
    removeWater(volume: import('./WaterVolume.js').WaterVolume): boolean;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {import('./WaterVolume.js').WaterVolume|null} the fluid at a point.
     */
    waterAt(x: number, y: number, z: number): import('./WaterVolume.js').WaterVolume | null;
    /**
     * Registers a dynamic (or kinematic) rigid body.
     * @param {import('./RigidBody.js').RigidBody} body Body to simulate.
     * @returns {import('./RigidBody.js').RigidBody} body
     */
    addDynamic(body: import('./RigidBody.js').RigidBody): import('./RigidBody.js').RigidBody;
    /**
     * Removes a collider, a body, or the collider built from a mesh.
     * @param {Object} x Collider, body or mesh.
     * @returns {boolean} True when something was removed.
     */
    remove(x: any): boolean;
    /**
     * Re-reads the transform of a static collider and refreshes its proxy.
     * A baked collider pays a full geometry rebuild, so avoid calling this per
     * frame on non uniformly scaled meshes.
     * @param {StaticCollider|Object} x Collider or the mesh it was built from.
     * @returns {StaticCollider|null} The refreshed collider.
     */
    refreshStatic(x: StaticCollider | any): StaticCollider | null;
    /**
     * Removes every collider and body.
     * @returns {CollisionWorld} this
     */
    clear(): CollisionWorld;
    /**
     * Sweeps a sphere through the static geometry and reports the first impact.
     *
     * The test is analytic and exact (plane, then the three edges as capped
     * cylinders, then the three vertices), so a fast moving sphere can never
     * tunnel through a triangle. Surfaces the sphere already touches are reported
     * only when the motion pushes into them (see the initial overlap rule in the
     * file header).
     *
     * @param {Vec3} origin Sphere centre at the start of the motion.
     * @param {Vec3} direction Normalized motion direction.
     * @param {number} radius Sphere radius.
     * @param {number} maxDist Length of the motion.
     * @param {Object} [out] Reusable record from {@link createSweepHit}.
     * @param {number} [mask=0xffffffff] Collision layer mask.
     * @returns {Object|null} The hit record, or null when nothing was touched.
     */
    sphereCast(origin: Vec3, direction: Vec3, radius: number, maxDist: number, out?: any, mask?: number): any | null;
    /**
     * Sweeps a capsule through the static geometry.
     *
     * Conservative advancement on the exact capsule/triangle distance: the capsule
     * is advanced by `distance / speed` until it touches, which by construction
     * can never step past a contact. That makes the sweep tunnel free even at very
     * high speeds. Convergence is bounded to 24 iterations per triangle; a grazing
     * contact that has not converged by then is reported at the last conservative
     * position, so the result is never optimistic. Surfaces the capsule already
     * touches follow the initial overlap rule described in the file header.
     *
     * @param {Vec3} p0 Lower endpoint of the capsule's inner segment.
     * @param {Vec3} p1 Upper endpoint of the capsule's inner segment.
     * @param {Vec3} direction Normalized motion direction.
     * @param {number} radius Capsule radius.
     * @param {number} maxDist Length of the motion.
     * @param {Object} [out] Reusable record from {@link createSweepHit}.
     * @param {number} [mask=0xffffffff] Collision layer mask.
     * @returns {Object|null} The hit record, or null.
     */
    capsuleCast(p0: Vec3, p1: Vec3, direction: Vec3, radius: number, maxDist: number, out?: any, mask?: number): any | null;
    /**
     * True when a displacement pushes into the surface of a contact the shape is
     * already touching. `_stSeg` / `_stTri` must hold the closest point pair of
     * the current configuration.
     * @private
     * @param {number} vx Displacement x.
     * @param {number} vy Displacement y.
     * @param {number} vz Displacement z.
     * @param {number} t0x Vertex A x.
     * @param {number} t0y Vertex A y.
     * @param {number} t0z Vertex A z.
     * @param {number} t1x Vertex B x.
     * @param {number} t1y Vertex B y.
     * @param {number} t1z Vertex B z.
     * @param {number} t2x Vertex C x.
     * @param {number} t2y Vertex C y.
     * @param {number} t2z Vertex C z.
     * @param {number} mx Shape centre x (fallback orientation).
     * @param {number} my Shape centre y.
     * @param {number} mz Shape centre z.
     * @returns {boolean} True when the surface blocks the motion.
     */
    private _approaches;
    /**
     * Casts a ray against the static colliders only. Use `Raycaster` for scene
     * wide picking; this variant is cheaper for physics probes.
     * @param {Vec3} origin Ray origin.
     * @param {Vec3} direction Normalized direction.
     * @param {number} maxDist Maximum distance.
     * @param {Object} [out] Reusable record from {@link createSweepHit}.
     * @param {number} [mask=0xffffffff] Collision layer mask.
     * @returns {Object|null} The hit record, or null.
     */
    raycast(origin: Vec3, direction: Vec3, maxDist: number, out?: any, mask?: number): any | null;
    /**
     * Collects the static surface contacts overlapping a sphere.
     * The records come from an internal pool: give them back with
     * {@link CollisionWorld#releaseContacts}.
     * @param {Vec3} center Sphere centre in world space.
     * @param {number} radius Sphere radius.
     * @param {Array<Object>} out Output array; emptied first.
     * @param {number} [mask=0xffffffff] Collision layer mask.
     * @returns {number} Number of contacts written.
     */
    overlapSphere(center: Vec3, radius: number, out: Array<any>, mask?: number): number;
    /**
     * Collects the static surface contacts overlapping a capsule.
     * @param {Vec3} p0 Lower endpoint of the inner segment.
     * @param {Vec3} p1 Upper endpoint of the inner segment.
     * @param {number} radius Capsule radius.
     * @param {Array<Object>} out Output array; emptied first.
     * @param {number} [mask=0xffffffff] Collision layer mask.
     * @returns {number} Number of contacts written.
     */
    overlapCapsule(p0: Vec3, p1: Vec3, radius: number, out: Array<any>, mask?: number): number;
    /**
     * Shared implementation of the sphere / capsule overlap queries.
     * @private
     * @param {Vec3} p0 Segment start.
     * @param {Vec3} p1 Segment end.
     * @param {number} radius Sweep radius.
     * @param {Array<Object>} out Output array.
     * @param {number} mask Collision layer mask.
     * @returns {number} Contact count.
     */
    private _overlapSegment;
    /**
     * Collects the colliders whose bounds overlap a sphere (no narrow phase).
     * @param {Vec3} center Sphere centre.
     * @param {number} radius Sphere radius.
     * @param {Array<StaticCollider>} out Output array; emptied first.
     * @returns {number} Number of colliders written.
     */
    overlapSphereColliders(center: Vec3, radius: number, out: Array<StaticCollider>): number;
    /**
     * Returns pooled contacts obtained from an overlap query.
     * @param {Array<Object>} list Contacts to release; the array is emptied.
     * @returns {void}
     */
    releaseContacts(list: Array<any>): void;
    /**
     * Advances the simulation. `dt` is clamped to `maxTimeStep` and divided into
     * `subSteps` equal substeps.
     * @param {number} dt Elapsed time in seconds.
     * @returns {CollisionWorld} this
     */
    step(dt: number): CollisionWorld;
    /**
     * One full substep: integrate velocities, build contacts, solve, integrate
     * positions, correct penetrations and update the sleep state.
     * @private
     * @param {number} dt Substep duration.
     * @returns {void}
     */
    private _substep;
    /**
     * Grows the contact arrays. Amortized: never runs in a steady state.
     * @private
     * @returns {void}
     */
    private _growContacts;
    /**
     * Appends a contact, merging it into an existing one from the same body when
     * both the normal and the position match closely. Merging keeps a sphere
     * resting on a triangle fan from being over constrained while still allowing
     * a box to keep its four corner contacts.
     *
     * Convention: `nx/ny/nz` points from B towards A, i.e. the direction A must
     * move along to separate. `b` is null for the static world.
     *
     * @private
     * @param {Object} a First body.
     * @param {Object|null} b Second body, or null for static geometry.
     * @param {number} nx Normal x.
     * @param {number} ny Normal y.
     * @param {number} nz Normal z.
     * @param {number} px Contact point x.
     * @param {number} py Contact point y.
     * @param {number} pz Contact point z.
     * @param {number} depth Penetration depth (positive).
     * @param {number} friction Combined friction coefficient.
     * @param {number} restitution Combined restitution.
     * @returns {void}
     */
    private _addContact;
    /**
     * Builds the contacts between one body and the static triangle world.
     * @private
     * @param {Object} body Dynamic body.
     * @param {number} dt Substep duration (used to inflate the query bounds).
     * @returns {void}
     */
    private _generateStaticContacts;
    /**
     * Merge radius used by {@link CollisionWorld#_addContact}, squared.
     * @private
     * @param {Object} body Body being processed.
     * @returns {number} Squared merge distance.
     */
    private _computeMergeDistanceSq;
    /**
     * Sphere / capsule body against one static collider.
     * @private
     * @param {Object} body Body with a rounded shape.
     * @param {StaticCollider} collider Static collider.
     * @param {number} friction Combined friction.
     * @param {number} restitution Combined restitution.
     * @returns {void}
     */
    private _roundVsCollider;
    /**
     * Box body against one static collider, using a separating axis test per
     * triangle. The contact point is the closest point of the triangle to the box
     * centre, which is accurate enough for a resting box.
     * @private
     * @param {Object} body Box body.
     * @param {StaticCollider} collider Static collider.
     * @param {number} friction Combined friction.
     * @param {number} restitution Combined restitution.
     * @returns {void}
     */
    private _boxVsCollider;
    /**
     * Builds the contacts between pairs of dynamic bodies.
     * Boxes are approximated by their bounding sphere here; see the file header.
     * @private
     * @returns {void}
     */
    private _generateBodyContacts;
    /**
     * Analytic contact between two dynamic bodies.
     * @private
     * @param {Object} a First body.
     * @param {Object} b Second body.
     * @returns {void}
     */
    private _pairContact;
    /**
     * Angular contribution of a body to a constraint's effective mass.
     * @private
     * @param {Object} body Body.
     * @param {number} rx Contact offset x.
     * @param {number} ry Contact offset y.
     * @param {number} rz Contact offset z.
     * @param {number} nx Constraint axis x.
     * @param {number} ny Constraint axis y.
     * @param {number} nz Constraint axis z.
     * @returns {number} `n . ((I^-1 (r x n)) x r)`.
     */
    private _angularTerm;
    /**
     * Applies a linear + angular impulse to a body.
     * @private
     * @param {Object} body Body.
     * @param {number} sign +1 or -1.
     * @param {number} lambda Impulse magnitude.
     * @param {number} nx Axis x.
     * @param {number} ny Axis y.
     * @param {number} nz Axis z.
     * @param {number} rx Contact offset x.
     * @param {number} ry Contact offset y.
     * @param {number} rz Contact offset z.
     * @returns {void}
     */
    private _applyImpulse;
    /**
     * Precomputes the tangent basis, the effective masses and the restitution
     * target of every contact.
     * @private
     * @param {number} dt Substep duration.
     * @returns {void}
     */
    private _prepareContacts;
    /**
     * One sequential impulse pass over the contact list.
     * @private
     * @returns {void}
     */
    private _solveVelocities;
    /**
     * One soft (Baumgarte) position correction pass. Linear only: a fraction of
     * the remaining penetration is removed and the amount already applied is
     * tracked so repeated passes converge instead of overshooting.
     * @private
     * @returns {void}
     */
    private _solvePositions;
    /**
     * Drops every retained resource.
     * @returns {void}
     */
    dispose(): void;
}
import { TriangleBVH } from "../spatial/TriangleBVH.js";
import { Mat4 } from "../math/Mat4.js";
import { AABB } from "../math/AABB.js";
import { Vec3 } from "../math/Vec3.js";
import { DynamicBVH } from "../spatial/DynamicBVH.js";
