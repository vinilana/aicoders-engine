/**
 * Grid fluid solver.
 *
 * The solver owns no storage: it reads and writes cells through the accessors
 * given at construction. That is what keeps it independent of how the host
 * stores its world — chunked voxel columns, a flat array, a tile map — and what
 * lets the host apply its own side effects (remesh, relight, mark for saving)
 * inside `setLevel`.
 */
export class CellularFluid {
    /**
     * @param {Object} options
     * @param {(x: number, y: number, z: number) => number} options.getLevel
     *   Current level of a cell, 0 when empty.
     * @param {(x: number, y: number, z: number, level: number) => void} options.setLevel
     *   Writes a level. Called only when the value actually changed, so this is
     *   the right place to invalidate meshes or wake lighting.
     * @param {(x: number, y: number, z: number) => boolean} options.isSolid
     *   True when the cell blocks fluid entirely.
     * @param {(x: number, y: number, z: number) => boolean} [options.isSource]
     *   True for cells that are held at `maxLevel` forever — a spring, an ocean,
     *   the output of a pump. Without at least one source everything drains.
     * @param {(x: number, y: number, z: number) => boolean} [options.isLoaded]
     *   False for cells outside the simulated region. Fluid neither reads from nor
     *   spreads into them, so a chunk that has not streamed in yet does not read
     *   as a wall that water pools against.
     * @param {number} [options.maxLevel=8] Level of a full cell. Also the distance
     *   in cells a source spreads across flat ground, since each step costs
     *   `falloff`.
     * @param {number} [options.falloff=1] Levels lost per horizontal step.
     * @param {number} [options.flowInterval=0.25] Seconds between ticks. Each tick
     *   advances the front one cell, so this is directly the flow speed.
     * @param {number} [options.budget=20000] Cells evaluated per tick.
     * @param {number} [options.maxCatchUpTicks=4] Ticks a single `update()` may
     *   run. Bounds the work after a tab has been backgrounded, where `dt` arrives
     *   as one enormous value.
     */
    constructor(options: {
        getLevel: (x: number, y: number, z: number) => number;
        setLevel: (x: number, y: number, z: number, level: number) => void;
        isSolid: (x: number, y: number, z: number) => boolean;
        isSource?: (x: number, y: number, z: number) => boolean;
        isLoaded?: (x: number, y: number, z: number) => boolean;
        maxLevel?: number;
        falloff?: number;
        flowInterval?: number;
        budget?: number;
        maxCatchUpTicks?: number;
    });
    /** @type {(x: number, y: number, z: number) => number} */
    getLevel: (x: number, y: number, z: number) => number;
    /** @type {(x: number, y: number, z: number, level: number) => void} */
    setLevel: (x: number, y: number, z: number, level: number) => void;
    /** @type {(x: number, y: number, z: number) => boolean} */
    isSolid: (x: number, y: number, z: number) => boolean;
    /** @type {(x: number, y: number, z: number) => boolean} */
    isSource: (x: number, y: number, z: number) => boolean;
    /** @type {(x: number, y: number, z: number) => boolean} */
    isLoaded: (x: number, y: number, z: number) => boolean;
    /**
     * Hydrostatic pressure, optional. Supplying both accessors turns on
     * communicating vessels; leaving them out keeps the solver purely
     * downhill-and-sideways, which is all a Minecraft-like game needs.
     * @type {boolean}
     */
    hydrostatic: boolean;
    /** @type {(x: number, y: number, z: number) => number} */
    getPressure: (x: number, y: number, z: number) => number;
    /** @type {(x: number, y: number, z: number, pressure: number) => void} */
    setPressure: (x: number, y: number, z: number, pressure: number) => void;
    /**
     * @type {number} Largest head the field can carry, in pressure units. Also
     * caps the upward scan that anchors the field, so a very deep ocean does not
     * pay for depth nobody can reach.
     */
    maxPressure: number;
    /** @type {number} */
    maxLevel: number;
    /** @type {number} */
    falloff: number;
    /** @type {number} */
    flowInterval: number;
    /** @type {number} */
    budget: number;
    /** @type {number} */
    maxCatchUpTicks: number;
    /**
     * Cells to evaluate in the current tick, and cells scheduled for the next
     * one. Separating them is what makes the front advance a cell per tick
     * instead of racing to the steady state inside a single tick.
     * @private
     */
    private _current;
    /** @private */
    private _next;
    /** @private @type {number} */
    private _accumulator;
    /** @type {number} Cells whose level changed during the last tick. */
    lastChanged: number;
    /** @type {number} Cells evaluated during the last tick. */
    lastEvaluated: number;
    /** @type {number} Ticks run since construction. */
    ticks: number;
    /** @returns {boolean} true when there is queued work. */
    get pending(): boolean;
    /** @returns {number} cells queued across both tick buffers. */
    get queueLength(): number;
    /**
     * Queues a cell for re-evaluation, along with the neighbours that could be
     * affected by it changing.
     *
     * Call this whenever the world changes in a way the solver cannot see: a block
     * dug or placed, a source created or removed, terrain streamed in. Marking the
     * cell alone is not enough — digging a hole *beside* water changes nothing
     * about the water cell itself, and the flow would never start.
     *
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    markDirty(x: number, y: number, z: number): void;
    /**
     * Queues a single cell without its neighbourhood.
     * Useful when seeding a large region, where every cell gets marked anyway and
     * the neighbour pushes would be pure duplication.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    markCell(x: number, y: number, z: number): void;
    /**
     * Advances the simulation.
     *
     * @param {number} dt Seconds since the last call.
     * @returns {number} cells whose level changed.
     */
    update(dt: number): number;
    /**
     * Runs exactly one propagation step, ignoring the clock.
     *
     * Exposed because tests and level editors want the fluid settled *now*, and
     * because a host with its own fixed timestep may prefer to drive it directly.
     *
     * @returns {number} cells whose level changed.
     */
    tick(): number;
    /**
     * Recomputes one cell from its neighbourhood and writes it if it moved.
     * @private
     * @returns {boolean} true when the level changed.
     */
    private _evaluate;
    /** @private */
    private _pushNeighbours;
    /**
     * Head above the top of a cell, in units of `maxLevel` per cell.
     *
     * Anchored by the water actually standing on the cell and relayed sideways and
     * upward at a cost, never downward. That is what makes it a distance field
     * rather than a max-flood, and therefore what makes it collapse on its own
     * when the water above drains instead of holding a stale value in a loop.
     *
     * @private
     * @param {number} level The level this cell is settling at.
     * @returns {number} 0..maxPressure
     */
    private _targetPressure;
    /**
     * The level a cell should settle at, given its neighbourhood.
     * @private
     * @returns {number} 0..maxLevel
     */
    private _targetLevel;
    /**
     * The level a cell would settle at with no hydrostatic help at all: source,
     * fed from above, or fed sideways by a neighbour that has nowhere better to
     * send its water.
     *
     * Split out of `_targetLevel` so the hydrostatic rules sit in front of it
     * rather than tangled through it: pressure decides first whether a cell is
     * part of a filled body, and only what pressure does not claim falls through
     * to spreading.
     *
     * @private
     * @returns {number} 0..maxLevel
     */
    private _gravityLevel;
    /**
     * True when a cell is walled in on all four sides, by solid or by more of the
     * same liquid.
     *
     * Unloaded counts as walled: a column that runs off the edge of the simulated
     * region should not stop weighing just because the neighbour has not streamed
     * in yet.
     *
     * @private
     */
    private _isConfined;
    /**
     * True when a cell still has somewhere below to send water.
     *
     * Sources are not exempt: a spring with open space under it pours straight
     * down and does not creep outwards first. Exempting them made a source in
     * mid-air throw a horizontal sheet that then cascaded down as a curtain.
     *
     * "Room below" is not simply `level < maxLevel`. A column in free fall is full
     * at every height, so that test flips to false the moment the fall reaches the
     * ground and the whole column starts behaving like a stack of settled pools —
     * water piling up in mid-air. What actually matters is whether the water below
     * is *going* anywhere, so a full cell still counts as an outlet while it is
     * itself falling through.
     *
     * @private
     */
    private _canDrain;
    /**
     * True when a cell is water on its way down rather than water at rest: it is
     * fed from above *and* still has open space below to continue into.
     *
     * The distinction matters because both states hold `maxLevel`. The cell where
     * a fall lands — solid ground beneath it — is a pool and behaves like a
     * source; every cell above it in the column is transient and must not feed its
     * neighbours, or the fall spreads sideways at every height it passes through.
     *
     * @private
     */
    private _isFallingThrough;
    /**
     * How full a cell is, as a fraction.
     * The natural input for a renderer that lowers a liquid surface with its
     * level, and for a physics step deciding how deeply a body is submerged.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number} 0..1
     */
    fillFraction(x: number, y: number, z: number): number;
    /**
     * Direction the fluid at a cell is moving, for pushing whatever is standing
     * in it.
     *
     * Derived from the level gradient: fluid moves away from where it is deep and
     * toward where it is shallow, plus straight down whenever there is somewhere
     * below to fall into. Solid neighbours are skipped rather than treated as
     * empty, so a wall does not read as a place the current is heading.
     *
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {{x: number, y: number, z: number}} out Written in place.
     * @returns {{x: number, y: number, z: number}} `out`, unit length, or zero
     *   when the cell is dry or the fluid is still.
     */
    flowAt(x: number, y: number, z: number, out: {
        x: number;
        y: number;
        z: number;
    }): {
        x: number;
        y: number;
        z: number;
    };
    /**
     * Runs ticks until nothing changes.
     *
     * For level generation and tests, where the settled shape is what matters and
     * watching it spread is not. Bounded so a bug cannot hang the caller.
     *
     * @param {number} [maxTicks=512]
     * @returns {number} ticks actually run.
     */
    settle(maxTicks?: number): number;
    /** Drops all queued work. The world keeps whatever levels it already had. */
    clear(): void;
}
