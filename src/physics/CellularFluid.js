/**
 * Cellular fluid: liquid that flows across a discrete grid.
 *
 * This is the other half of fluid simulation from `WaterVolume`. That one models
 * a *fixed* body of water acting on rigid bodies (buoyancy, drag, currents) and
 * never changes shape. This one models the water itself as the thing that moves:
 * it fills holes, pours over ledges, runs downhill and recedes when its source
 * is cut off. A voxel game needs both — one to float a boat, this one to answer
 * "I dug next to the lake, what happens?".
 *
 * ## The model
 *
 * Each cell holds an integer level from 0 (empty) to `maxLevel` (full). A cell's
 * level is not integrated from flow rates; it is *derived* from its neighbours:
 *
 *   - a **source** cell is always `maxLevel`;
 *   - a cell with fluid directly above it is `maxLevel` (falling water fills the
 *     cell it lands in completely, which is what lets a hole fill to the brim
 *     and then let the flow continue past it);
 *   - otherwise it is `max(neighbour) - falloff` over the four horizontal
 *     neighbours, floored at zero.
 *
 * That makes the steady state a breadth-first distance field measured from the
 * sources, which matters for two reasons. It **always converges** — there is no
 * oscillation to damp and no CFL condition to respect — and it **recedes
 * correctly**: delete the source and the same rule drains the pool, because no
 * cell can hold a level its neighbours do not justify.
 *
 * Mass is deliberately not conserved. A conserving solver on a coarse grid gives
 * you puddles that never quite disappear and shorelines that jitter; a source
 * that spreads a bounded distance and stops is both what players expect and what
 * stays stable when they edit the world underneath it.
 *
 * ## Pressure, and why water rises
 *
 * The rules above only ever move water down and sideways, so on their own they
 * cannot answer "I connected a tunnel to the bottom of the lake, why does the
 * room not fill to lake level?". Communicating vessels need a notion of
 * hydrostatic head, and that is what the optional pressure field adds.
 *
 * `p[c]` is how far the free surface of the connected body sits **above the top
 * of cell c**, measured in units where `maxLevel` units make one cell. A full
 * cell with nothing above it has no pressure; one under nine cells of water has
 * `9 * maxLevel`.
 *
 * Pressure is anchored by the water actually standing on a cell, and spreads
 * from there:
 *
 *   - **anchor** — the run of full cells directly above c;
 *   - **sideways** — a neighbour's pressure minus one unit, an eighth of a cell
 *     of head lost per cell of distance;
 *   - **upward** — the cell below's pressure minus one cell's worth.
 *
 * Every edge costs something and none of them point downward, so the field is a
 * distance field exactly like the level field: it converges, it cannot sustain
 * itself in a loop, and it collapses the moment the water standing on top of it
 * goes away. That is the whole reason pressure is not simply propagated as a
 * maximum — a plain max-flood holds a stale value forever in any cycle, and
 * would need the two-queue removal that light propagation needs.
 *
 * Water then rises: a cell fills from a pressurised neighbour beside it, or from
 * a pressurised cell below it, up to `p` — partially when what remains is less
 * than a whole cell, which is what makes a U-tube settle level instead of
 * snapping to the nearest block.
 *
 * The sideways loss is a deliberate approximation. Real pressure does not fade
 * with horizontal distance, but a lossless field would need cycle handling, and
 * one eighth of a cell per cell means a lake ten deep still carries its head
 * eighty cells — far past any tunnel a player digs, while keeping every flood
 * bounded by how deep the water actually is.
 *
 * Pressure is off unless `getPressure`/`setPressure` are supplied, and with it
 * off the solver behaves exactly as it did without it.
 *
 * ## Flowing toward the drop
 *
 * One extra rule does most of the work of making the result look deliberate:
 * **a cell that can drain downward does not spread sideways**. Water arriving at
 * the lip of a pit pours in instead of continuing to creep along the floor, and
 * only resumes spreading once the pit has filled. Without it a spill expands as
 * a uniform disc and ignores the hole next to it, which reads as obviously fake.
 *
 * ## Timing
 *
 * Fluid advances on its own clock, not the frame's. `update(dt)` accumulates
 * time and runs a tick every `flowInterval` seconds, and each tick propagates
 * the front by exactly one cell. Running it per frame would make water snap to
 * its final shape within a few frames, losing the spreading motion entirely —
 * the motion *is* the feedback that tells the player the world reacted.
 *
 * Work inside a tick is budgeted. Breaching a dam can touch tens of thousands of
 * cells; the leftovers simply carry into the next tick rather than stalling a
 * frame.
 *
 * @example
 * const fluid = new CellularFluid({
 *   getLevel: (x, y, z) => grid.level(x, y, z),
 *   setLevel: (x, y, z, level) => grid.setLevel(x, y, z, level),
 *   isSolid:  (x, y, z) => grid.blocks(x, y, z),
 *   isSource: (x, y, z) => grid.isSpring(x, y, z),
 * });
 * fluid.markDirty(10, 40, 10);   // something changed here
 * fluid.update(dt);              // in the frame loop
 */

/** Horizontal neighbour offsets: +X, -X, +Z, -Z. */
const SIDES = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/**
 * Growable FIFO of packed cells.
 *
 * A queue of `{x, y, z}` objects would allocate once per visited cell, which is
 * exactly the allocation pattern a flood fill must not have.
 */
class CellQueue {
  /** @param {number} [capacity=1024] Cells, not integers. */
  constructor(capacity = 1024) {
    /** @type {Int32Array} */
    this.data = new Int32Array(capacity * 3);
    this.capacity = capacity;
    this.head = 0;
    this.tail = 0;
  }

  /** @returns {number} cells waiting */
  get size() { return this.tail - this.head; }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  push(x, y, z) {
    if (this.tail === this.capacity) this._grow();
    const o = this.tail * 3;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.tail++;
  }

  /**
   * Slides live entries to the front, and only doubles when that would not
   * recover enough room to be worth it.
   * @private
   */
  _grow() {
    const live = this.tail - this.head;
    if (this.head > 0 && live < this.capacity * 0.75) {
      this.data.copyWithin(0, this.head * 3, this.tail * 3);
    } else {
      const next = new Int32Array(this.capacity * 2 * 3);
      next.set(this.data.subarray(this.head * 3, this.tail * 3));
      this.data = next;
      this.capacity *= 2;
    }
    this.tail = live;
    this.head = 0;
  }

  /** Appends every cell of another queue and empties it. */
  drainFrom(other) {
    while (other.size > 0) {
      const o = other.head * 3;
      this.push(other.data[o], other.data[o + 1], other.data[o + 2]);
      other.head++;
    }
    other.clear();
  }

  clear() { this.head = 0; this.tail = 0; }
}

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
  constructor(options) {
    if (options === undefined || typeof options.getLevel !== 'function' ||
        typeof options.setLevel !== 'function' || typeof options.isSolid !== 'function') {
      throw new Error('CellularFluid: getLevel, setLevel and isSolid are required');
    }

    /** @type {(x: number, y: number, z: number) => number} */
    this.getLevel = options.getLevel;
    /** @type {(x: number, y: number, z: number, level: number) => void} */
    this.setLevel = options.setLevel;
    /** @type {(x: number, y: number, z: number) => boolean} */
    this.isSolid = options.isSolid;
    /** @type {(x: number, y: number, z: number) => boolean} */
    this.isSource = options.isSource || (() => false);
    /** @type {(x: number, y: number, z: number) => boolean} */
    this.isLoaded = options.isLoaded || (() => true);

    /**
     * Hydrostatic pressure, optional. Supplying both accessors turns on
     * communicating vessels; leaving them out keeps the solver purely
     * downhill-and-sideways, which is all a Minecraft-like game needs.
     * @type {boolean}
     */
    this.hydrostatic = typeof options.getPressure === 'function' &&
      typeof options.setPressure === 'function';
    /** @type {(x: number, y: number, z: number) => number} */
    this.getPressure = options.getPressure || (() => 0);
    /** @type {(x: number, y: number, z: number, pressure: number) => void} */
    this.setPressure = options.setPressure || (() => {});
    /**
     * @type {number} Largest head the field can carry, in pressure units. Also
     * caps the upward scan that anchors the field, so a very deep ocean does not
     * pay for depth nobody can reach.
     */
    this.maxPressure = options.maxPressure !== undefined ? options.maxPressure : 255;

    /** @type {number} */
    this.maxLevel = options.maxLevel !== undefined ? options.maxLevel : 8;
    /** @type {number} */
    this.falloff = options.falloff !== undefined ? options.falloff : 1;
    /** @type {number} */
    this.flowInterval = options.flowInterval !== undefined ? options.flowInterval : 0.25;
    /** @type {number} */
    this.budget = options.budget !== undefined ? options.budget : 20000;
    /** @type {number} */
    this.maxCatchUpTicks = options.maxCatchUpTicks !== undefined ? options.maxCatchUpTicks : 4;

    /**
     * Cells to evaluate in the current tick, and cells scheduled for the next
     * one. Separating them is what makes the front advance a cell per tick
     * instead of racing to the steady state inside a single tick.
     * @private
     */
    this._current = new CellQueue(2048);
    /** @private */
    this._next = new CellQueue(2048);

    /** @private @type {number} */
    this._accumulator = 0;

    /** @type {number} Cells whose level changed during the last tick. */
    this.lastChanged = 0;
    /** @type {number} Cells evaluated during the last tick. */
    this.lastEvaluated = 0;
    /** @type {number} Ticks run since construction. */
    this.ticks = 0;
  }

  /** @returns {boolean} true when there is queued work. */
  get pending() { return this._current.size > 0 || this._next.size > 0; }

  /** @returns {number} cells queued across both tick buffers. */
  get queueLength() { return this._current.size + this._next.size; }

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
  markDirty(x, y, z) {
    this._next.push(x, y, z);
    this._next.push(x, y + 1, z);
    this._next.push(x, y - 1, z);
    for (let i = 0; i < 4; i++) {
      this._next.push(x + SIDES[i][0], y, z + SIDES[i][1]);
    }
  }

  /**
   * Queues a single cell without its neighbourhood.
   * Useful when seeding a large region, where every cell gets marked anyway and
   * the neighbour pushes would be pure duplication.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  markCell(x, y, z) {
    this._next.push(x, y, z);
  }

  /**
   * Advances the simulation.
   *
   * @param {number} dt Seconds since the last call.
   * @returns {number} cells whose level changed.
   */
  update(dt) {
    if (dt > 0) this._accumulator += dt;

    let changed = 0;
    let ticks = 0;
    while (this._accumulator >= this.flowInterval && ticks < this.maxCatchUpTicks) {
      this._accumulator -= this.flowInterval;
      ticks++;
      if (!this.pending) {
        // Nothing to do; drop the backlog so a long idle period does not bank
        // ticks that all fire at once the moment someone opens a floodgate.
        this._accumulator = 0;
        break;
      }
      changed += this.tick();
    }
    if (ticks >= this.maxCatchUpTicks) this._accumulator = 0;
    return changed;
  }

  /**
   * Runs exactly one propagation step, ignoring the clock.
   *
   * Exposed because tests and level editors want the fluid settled *now*, and
   * because a host with its own fixed timestep may prefer to drive it directly.
   *
   * @returns {number} cells whose level changed.
   */
  tick() {
    const queue = this._current;
    // Cells scheduled since the last tick become this tick's work, appended
    // behind anything the previous tick's budget could not reach.
    queue.drainFrom(this._next);

    const budget = this.budget;
    let evaluated = 0;
    let changed = 0;

    // `queue` cannot grow while this runs: cells discovered here are pushed to
    // `_next`. That is the entire mechanism behind one-cell-per-tick — without
    // the split the loop would chase its own output and resolve the whole flood
    // instantly. It also means a budget cut simply leaves the remainder at the
    // front of `queue` for next time, in order.
    while (queue.size > 0 && evaluated < budget) {
      const o = queue.head * 3;
      const x = queue.data[o];
      const y = queue.data[o + 1];
      const z = queue.data[o + 2];
      queue.head++;
      evaluated++;

      if (this._evaluate(x, y, z)) changed++;
    }

    this.lastEvaluated = evaluated;
    this.lastChanged = changed;
    this.ticks++;
    return changed;
  }

  /**
   * Recomputes one cell from its neighbourhood and writes it if it moved.
   * @private
   * @returns {boolean} true when the level changed.
   */
  _evaluate(x, y, z) {
    if (!this.isLoaded(x, y, z)) return false;

    const current = this.getLevel(x, y, z);
    const target = this._targetLevel(x, y, z);

    // Pressure is recomputed even when the level holds steady: the head above a
    // cell can change without the cell itself changing, and a stale head is what
    // would leave water standing where nothing supports it any more.
    let pressureMoved = false;
    if (this.hydrostatic === true) {
      const nextPressure = this._targetPressure(x, y, z, target);
      if (nextPressure !== this.getPressure(x, y, z)) {
        this.setPressure(x, y, z, nextPressure);
        pressureMoved = true;
      }
    }

    if (target === current) {
      if (pressureMoved) this._pushNeighbours(x, y, z);
      return false;
    }

    this.setLevel(x, y, z, target);

    // The change can only matter to cells that read this one: the six
    // neighbours. Queue them for the next tick, which is what makes the front
    // advance one cell at a time.
    this._pushNeighbours(x, y, z);
    return true;
  }

  /** @private */
  _pushNeighbours(x, y, z) {
    this._next.push(x, y + 1, z);
    this._next.push(x, y - 1, z);
    for (let i = 0; i < 4; i++) {
      this._next.push(x + SIDES[i][0], y, z + SIDES[i][1]);
    }
  }

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
  _targetPressure(x, y, z, level) {
    // Only a filled cell carries head. A partial cell has a free surface of its
    // own, so by definition nothing is pressing down on it.
    if (level !== this.maxLevel || this.isSolid(x, y, z)) return 0;

    // Anchor: walk up the unbroken column of full cells standing on this one and
    // take the height of the **highest source** in it. Only a source anchors.
    //
    // This is the whole reason the field terminates, and it took two wrong
    // answers to get to. Counting any full cell above makes the anchor a
    // downward edge, and a downward edge closes a loop with the upward one: the
    // cell above is full because this cell has pressure, and this cell has
    // pressure because the cell above is full. The pair then holds its own
    // weight forever and a tank stays brim full after its supply is cut.
    //
    // Excluding cells that pressure lifted is not enough either, because the
    // falling-water rule reports a pressure-lifted cell as legitimately fed from
    // above and the loop simply reappears one step further out. A source is the
    // only thing in the model that owes its existence to nothing, so a source is
    // the only thing that can carry the weight of a column.
    let best = 0;
    const limit = (this.maxPressure / this.maxLevel) | 0;
    for (let i = 1; i <= limit; i++) {
      const ay = y + i;
      if (!this.isLoaded(x, ay, z) || this.isSolid(x, ay, z)) break;
      if (this.getLevel(x, ay, z) !== this.maxLevel) break;
      // An unconfined column is a fall, not a head. Water in free air has walls
      // of nothing to press against, so it weighs on nothing; without this a
      // waterfall pressurises its own splash pool and sprays a full-strength
      // sheet across the floor. Confinement is what tells a standing column
      // apart from a falling one, and both look identical cell by cell.
      if (!this._isConfined(x, ay, z)) break;
      if (this.isSource(x, ay, z)) best = i * this.maxLevel;
    }

    // Relayed from the side, an eighth of a cell of head per cell of distance.
    for (let i = 0; i < 4; i++) {
      const nx = x + SIDES[i][0];
      const nz = z + SIDES[i][1];
      if (!this.isLoaded(nx, y, nz) || this.isSolid(nx, y, nz)) continue;
      if (this.getLevel(nx, y, nz) !== this.maxLevel) continue;
      const relayed = this.getPressure(nx, y, nz) - 1;
      if (relayed > best) best = relayed;
    }

    // Relayed up from below, one cell of head per cell climbed. This is what
    // carries the head around the bend of a U and back up the far arm.
    if (this.isLoaded(x, y - 1, z) && !this.isSolid(x, y - 1, z) &&
        this.getLevel(x, y - 1, z) === this.maxLevel) {
      const relayed = this.getPressure(x, y - 1, z) - this.maxLevel;
      if (relayed > best) best = relayed;
    }

    if (best < 0) return 0;
    return best > this.maxPressure ? this.maxPressure : best;
  }

  /**
   * The level a cell should settle at, given its neighbourhood.
   * @private
   * @returns {number} 0..maxLevel
   */
  _targetLevel(x, y, z) {
    if (this.isSolid(x, y, z)) return 0;
    if (this.isSource(x, y, z)) return this.maxLevel;

    // Hydrostatic rise, checked first because a cell under head is not a film
    // running downhill: it is part of a filled body, and the level it settles at
    // owes nothing to how far it is from a source.
    let best = 0;
    if (this.hydrostatic === true) {
      // Pushed up from below. The water climbs as far as the head reaches, and
      // the last cell fills only partially when less than a whole cell of head
      // is left — without that a U-tube snaps to whole blocks and reads as
      // permanently out of balance.
      if (this.isLoaded(x, y - 1, z) && !this.isSolid(x, y - 1, z) &&
          this.getLevel(x, y - 1, z) === this.maxLevel) {
        const head = this.getPressure(x, y - 1, z);
        if (head > 0) best = head < this.maxLevel ? head : this.maxLevel;
      }
      // Pushed in from the side. A full neighbour at this height with anything
      // standing on it puts the free surface above this cell's ceiling too, so
      // this cell belongs to the same filled body and fills completely.
      if (best < this.maxLevel) {
        for (let i = 0; i < 4; i++) {
          const nx = x + SIDES[i][0];
          const nz = z + SIDES[i][1];
          if (!this.isLoaded(nx, y, nz) || this.isSolid(nx, y, nz)) continue;
          if (this.getLevel(nx, y, nz) !== this.maxLevel) continue;
          if (this.getPressure(nx, y, nz) > 0) { best = this.maxLevel; break; }
        }
      }
      if (best === this.maxLevel) return best;
    }

    const gravity = this._gravityLevel(x, y, z);
    return gravity > best ? gravity : best;
  }

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
  _gravityLevel(x, y, z) {
    if (this.isSolid(x, y, z)) return 0;
    if (this.isSource(x, y, z)) return this.maxLevel;

    // Fed from directly above. Falling water fills the cell it lands in
    // completely, so a pit fills to the brim and the flow can then continue
    // across it rather than draining forever into a cell that never tops up.
    if (!this.isSolid(x, y + 1, z) && this.isLoaded(x, y + 1, z) &&
        this.getLevel(x, y + 1, z) > 0) {
      return this.maxLevel;
    }

    let best = 0;
    for (let i = 0; i < 4; i++) {
      const nx = x + SIDES[i][0];
      const nz = z + SIDES[i][1];
      if (!this.isLoaded(nx, y, nz) || this.isSolid(nx, y, nz)) continue;

      const level = this.getLevel(nx, y, nz);
      if (level <= this.falloff) continue;

      // A neighbour with somewhere to fall spends its water there instead of
      // spreading. This is what steers a spill into the nearest hole rather than
      // letting it creep outward as a uniform disc.
      if (this._canDrain(nx, y, nz)) continue;
      // Water merely passing through on its way down does not feed the sides
      // either. Without this a waterfall sprays a sheet out of every cell it
      // occupies, because a saturated column reads as "no room below" and would
      // otherwise look like a settled pool at every height.
      if (this._isFallingThrough(nx, y, nz)) continue;

      const candidate = level - this.falloff;
      if (candidate > best) best = candidate;
    }
    return best;
  }

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
  _isConfined(x, y, z) {
    for (let i = 0; i < 4; i++) {
      const nx = x + SIDES[i][0];
      const nz = z + SIDES[i][1];
      if (!this.isLoaded(nx, y, nz)) continue;
      if (this.isSolid(nx, y, nz)) continue;
      if (this.getLevel(nx, y, nz) === this.maxLevel) continue;
      return false;
    }
    return true;
  }

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
  _canDrain(x, y, z) {
    const by = y - 1;
    if (!this.isLoaded(x, by, z) || this.isSolid(x, by, z)) return false;
    if (this.getLevel(x, by, z) < this.maxLevel) return true;
    return this._isFallingThrough(x, by, z);
  }

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
  _isFallingThrough(x, y, z) {
    if (this.isSource(x, y, z)) return false;
    const ay = y + 1;
    if (!this.isLoaded(x, ay, z) || this.isSolid(x, ay, z)) return false;
    if (this.getLevel(x, ay, z) <= 0) return false;
    const by = y - 1;
    return this.isLoaded(x, by, z) && !this.isSolid(x, by, z);
  }

  /**
   * How full a cell is, as a fraction.
   * The natural input for a renderer that lowers a liquid surface with its
   * level, and for a physics step deciding how deeply a body is submerged.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} 0..1
   */
  fillFraction(x, y, z) {
    return this.getLevel(x, y, z) / this.maxLevel;
  }

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
  flowAt(x, y, z, out) {
    out.x = 0;
    out.y = 0;
    out.z = 0;

    const level = this.getLevel(x, y, z);
    if (level <= 0) return out;

    for (let i = 0; i < 4; i++) {
      const dx = SIDES[i][0];
      const dz = SIDES[i][1];
      const nx = x + dx;
      const nz = z + dz;
      if (!this.isLoaded(nx, y, nz) || this.isSolid(nx, y, nz)) continue;
      const diff = level - this.getLevel(nx, y, nz);
      if (diff <= 0) continue;
      out.x += dx * diff;
      out.z += dz * diff;
    }

    if (this._canDrain(x, y, z) || this._isFallingThrough(x, y, z)) {
      out.y -= this.maxLevel;
    }

    const lengthSq = out.x * out.x + out.y * out.y + out.z * out.z;
    if (lengthSq > 0) {
      const inv = 1 / Math.sqrt(lengthSq);
      out.x *= inv;
      out.y *= inv;
      out.z *= inv;
    }
    return out;
  }

  /**
   * Runs ticks until nothing changes.
   *
   * For level generation and tests, where the settled shape is what matters and
   * watching it spread is not. Bounded so a bug cannot hang the caller.
   *
   * @param {number} [maxTicks=512]
   * @returns {number} ticks actually run.
   */
  settle(maxTicks = 512) {
    let n = 0;
    while (this.pending && n < maxTicks) {
      this.tick();
      n++;
    }
    this._accumulator = 0;
    return n;
  }

  /** Drops all queued work. The world keeps whatever levels it already had. */
  clear() {
    this._current.clear();
    this._next.clear();
    this._accumulator = 0;
  }
}
