/**
 * A box of fluid with a wavy surface.
 */
export class WaterVolume {
    /**
     * Builds a volume from a centre and size.
     * @param {number} cx
     * @param {number} cy Centre height; the surface ends up at `cy + sy / 2`.
     * @param {number} cz
     * @param {number} sx
     * @param {number} sy
     * @param {number} sz
     * @param {Object} [options]
     * @returns {WaterVolume}
     */
    static fromBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, options?: any): WaterVolume;
    /**
     * Volume of a rigid body, used to turn its mass into a density.
     * @param {import('./RigidBody.js').RigidBody} body
     * @returns {number}
     */
    static bodyVolume(body: import('./RigidBody.js').RigidBody): number;
    /**
     * @param {Object} [options]
     * @param {Vec3|{x:number,y:number,z:number}} [options.min] Lower corner.
     * @param {Vec3|{x:number,y:number,z:number}} [options.max] Upper corner; its
     *   `y` is the still water level unless `surfaceY` is given.
     * @param {number} [options.surfaceY] Explicit still water level.
     * @param {number} [options.density=1] Fluid density. A body whose mass over
     *   volume is below this floats, above it sinks, equal to it hangs neutral.
     * @param {number} [options.linearDrag=1.6] Velocity proportional drag.
     * @param {number} [options.quadraticDrag=0.9] Velocity squared drag.
     * @param {number} [options.angularDrag=2.2] Rotational drag.
     * @param {Vec3} [options.flow] Current velocity; bodies are dragged towards it.
     * @param {number} [options.waveAmplitude=0] Surface displacement amplitude.
     * @param {number} [options.waveLength=8] Distance between wave crests.
     * @param {number} [options.waveSpeed=1.1] Crest travel speed.
     */
    constructor(options?: {
        min?: Vec3 | {
            x: number;
            y: number;
            z: number;
        };
        max?: Vec3 | {
            x: number;
            y: number;
            z: number;
        };
        surfaceY?: number;
        density?: number;
        linearDrag?: number;
        quadraticDrag?: number;
        angularDrag?: number;
        flow?: Vec3;
        waveAmplitude?: number;
        waveLength?: number;
        waveSpeed?: number;
    });
    /** @type {boolean} Duck typing marker. */
    isWaterVolume: boolean;
    /** @type {string} */
    name: string;
    /** @type {boolean} */
    enabled: boolean;
    /** @type {AABB} Region occupied by the fluid. */
    aabb: AABB;
    /** @type {number} Still water level. */
    surfaceY: number;
    /** @type {number} */
    density: number;
    /** @type {number} */
    linearDrag: number;
    /** @type {number} */
    quadraticDrag: number;
    /** @type {number} */
    angularDrag: number;
    /** @type {Vec3} Current velocity the fluid drags bodies towards. */
    flow: Vec3;
    /** @type {number} */
    waveAmplitude: number;
    /** @type {number} */
    waveLength: number;
    /** @type {number} */
    waveSpeed: number;
    /** @type {number} Seconds, advanced by the world; drives the waves. */
    time: number;
    /**
     * Surface height at a horizontal position. Matches the vertex displacement a
     * water shader should apply, so physics and rendering agree on where the
     * waterline is.
     * @param {number} x
     * @param {number} z
     * @returns {number}
     */
    surfaceHeightAt(x: number, z: number): number;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {boolean} true when the point is inside the fluid.
     */
    containsPoint(x: number, y: number, z: number): boolean;
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number} depth below the surface, negative above it.
     */
    depthAt(x: number, y: number, z: number): number;
    /**
     * Fraction of a sphere below the surface.
     *
     * Exact, via the spherical cap volume — smooth all the way from just touching
     * the surface to fully submerged, which is what keeps a floating body from
     * buzzing at the waterline.
     *
     * @param {number} cx
     * @param {number} cy
     * @param {number} cz
     * @param {number} radius
     * @returns {number} 0..1
     */
    sphereSubmergedFraction(cx: number, cy: number, cz: number, radius: number): number;
    /**
     * Fraction of a capsule below the surface.
     *
     * Integrated along the axis as a series of spheres, so it stays smooth and
     * handles any orientation. A closed form exists only for capsules that are
     * exactly vertical or exactly horizontal, and a body that floats is rarely
     * either.
     *
     * @param {Vec3} p0 First segment endpoint.
     * @param {Vec3} p1 Second segment endpoint.
     * @param {number} radius
     * @returns {number} 0..1
     */
    capsuleSubmergedFraction(p0: Vec3, p1: Vec3, radius: number): number;
    /**
     * Fraction of an axis aligned box below the surface.
     *
     * For a rotated box this uses the world AABB, which overestimates near the
     * corners. Documented rather than hidden: crates in a pond read fine, a long
     * plank tilted 45 degrees will float slightly high.
     *
     * @param {number} cx
     * @param {number} cy
     * @param {number} cz
     * @param {number} hx Half extent.
     * @param {number} hy
     * @param {number} hz
     * @returns {number} 0..1
     */
    boxSubmergedFraction(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): number;
    /**
     * Submerged fraction of a rigid body, dispatched on its shape.
     * @param {import('./RigidBody.js').RigidBody} body
     * @returns {number} 0..1
     */
    bodySubmergedFraction(body: import('./RigidBody.js').RigidBody): number;
    /**
     * Applies buoyancy, drag and current to a body for one step.
     *
     * Forces rather than velocity assignments: that is what lets a crate bob,
     * overshoot and settle instead of snapping to the waterline, and it composes
     * correctly with gravity, contacts and any other force acting the same frame.
     *
     * @param {import('./RigidBody.js').RigidBody} body
     * @param {Vec3} gravity
     * @param {number} dt
     * @returns {number} the submerged fraction that was applied, 0..1
     */
    applyToBody(body: import('./RigidBody.js').RigidBody, gravity: Vec3, dt: number): number;
}
import { AABB } from "../math/AABB.js";
import { Vec3 } from "../math/Vec3.js";
