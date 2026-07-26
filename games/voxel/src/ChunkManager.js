/**
 * Streams the world around the player.
 *
 * Owns three pipelines that run concurrently and are all rate limited so a
 * frame never blocks:
 *
 *   1. **generation** — a worker pool turns (cx, cz) into a column of blocks;
 *   2. **lighting**   — the main thread floods light within a per-frame budget;
 *   3. **meshing**    — dirty sections go back out to the pool and return as
 *      vertex buffers, which are uploaded a few per frame.
 *
 * Requests are always served nearest-first, so the ground under the player
 * appears before the horizon fills in, and results that arrive for a chunk that
 * has since been unloaded are discarded rather than uploaded.
 */

import { Geometry } from '../../../src/render/Geometry.js';
import { Mesh } from '../../../src/scene/Mesh.js';
import { Chunk, ChunkState, SECTION_COUNT, SECTION_H } from './Chunk.js';
import { PAD_VOLUME } from './Mesher.js';

/** Padded buffers handed to the worker, recycled on return. */
class PadPool {
  constructor() {
    /** @type {Uint16Array[]} */
    this.blocks = [];
    /** @type {Uint8Array[]} */
    this.light = [];
    /** @type {Uint8Array[]} */
    this.fluid = [];
  }

  acquireBlocks() {
    return this.blocks.pop() || new Uint16Array(PAD_VOLUME);
  }

  acquireLight() {
    return this.light.pop() || new Uint8Array(PAD_VOLUME);
  }

  acquireFluid() {
    return this.fluid.pop() || new Uint8Array(PAD_VOLUME);
  }

  release(blocks, light, fluid) {
    // Buffers come back detached if the worker kept them; length 0 is the tell.
    if (blocks && blocks.length === PAD_VOLUME && this.blocks.length < 32) this.blocks.push(blocks);
    if (light && light.length === PAD_VOLUME && this.light.length < 32) this.light.push(light);
    if (fluid && fluid.length === PAD_VOLUME && this.fluid.length < 32) this.fluid.push(fluid);
  }
}

/**
 * Loads, meshes and unloads chunks around a moving viewer.
 */
export class ChunkManager {
  /**
   * @param {Object} options
   * @param {import('./World.js').World} options.world
   * @param {Object} options.scene Engine scene.
   * @param {Object} options.material Opaque VoxelMaterial.
   * @param {Object} options.waterMaterial Transparent VoxelMaterial.
   * @param {WebGL2RenderingContext} options.gl
   * @param {number} [options.renderDistance=8] In chunks.
   * @param {number} [options.workerCount] Defaults to hardwareConcurrency - 1.
   * @param {number} [options.uploadsPerFrame=6]
   */
  constructor(options) {
    this.world = options.world;
    this.scene = options.scene;
    this.material = options.material;
    this.waterMaterial = options.waterMaterial;
    this.gl = options.gl;

    /** @type {number} */
    this.renderDistance = options.renderDistance !== undefined ? options.renderDistance : 8;
    /** @type {number} Chunks are dropped this far beyond the render distance. */
    this.unloadMargin = 2;
    /** @type {number} */
    this.uploadsPerFrame = options.uploadsPerFrame !== undefined ? options.uploadsPerFrame : 6;

    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const count = options.workerCount !== undefined
      ? options.workerCount
      : Math.max(2, Math.min(8, hw - 1));

    /** @type {Worker[]} */
    this.workers = [];
    /** @type {number[]} Outstanding jobs per worker, for least-loaded dispatch. */
    this.workerLoad = [];

    const workerURL = new URL('../worker/chunk-worker.js', import.meta.url);
    for (let i = 0; i < count; i++) {
      const worker = new Worker(workerURL, { type: 'module' });
      worker.onmessage = (event) => this._onWorkerMessage(i, event.data);
      worker.onerror = (event) => {
        this.lastError = 'worker: ' + (event.message || 'erro desconhecido');
      };
      this.workers.push(worker);
      this.workerLoad.push(0);
    }

    /** @type {PadPool} */
    this.pads = new PadPool();

    /** @type {Map<number, Object>} In-flight jobs by id. */
    this.jobs = new Map();
    this._nextJobId = 1;

    /** @type {Array<{cx: number, cz: number, dist: number}>} */
    this.generateQueue = [];
    /** @type {Set<string>} Chunks already requested, to avoid duplicates. */
    this.requested = new Set();
    /** @type {Array<Object>} Meshed sections waiting for GPU upload. */
    this.uploadQueue = [];

    /** @type {number} Viewer chunk coordinates. */
    this.viewerCX = 2147483647;
    this.viewerCZ = 2147483647;

    /** @type {Object} Live counters for the debug overlay. */
    this.stats = {
      chunksLoaded: 0,
      sectionsDrawn: 0,
      generating: 0,
      meshing: 0,
      pendingGenerate: 0,
      pendingUpload: 0,
      trianglesResident: 0,
      lightQueue: 0,
      fluidQueue: 0,
      fluidChanged: 0,
    };

    /** @type {string|null} */
    this.lastError = null;
    /** @type {boolean} Set once the first ring around the viewer is meshed. */
    this.initialLoadComplete = false;
    this._initialTarget = 0;
  }

  /* ------------------------------------------------------------- dispatch */

  /** @private @returns {number} index of the least loaded worker */
  _pickWorker() {
    let best = 0;
    let bestLoad = this.workerLoad[0];
    for (let i = 1; i < this.workerLoad.length; i++) {
      if (this.workerLoad[i] < bestLoad) { bestLoad = this.workerLoad[i]; best = i; }
    }
    return best;
  }

  /** @private */
  _send(message, transfer) {
    const index = this._pickWorker();
    this.workerLoad[index]++;
    this.workers[index].postMessage(message, transfer || []);
    return index;
  }

  /** @private */
  _onWorkerMessage(workerIndex, msg) {
    this.workerLoad[workerIndex] = Math.max(0, this.workerLoad[workerIndex] - 1);

    const job = this.jobs.get(msg.id);
    this.jobs.delete(msg.id);

    if (msg.type === 'error') {
      this.lastError = msg.message;
      return;
    }

    if (msg.type === 'generated') {
      this._onGenerated(msg, job);
      return;
    }

    if (msg.type === 'meshed') {
      this.pads.release(msg.recycleBlocks, msg.recycleLight, msg.recycleFluid);
      if (job !== undefined && job.cancelled === true) return;
      // The chunk may have been unloaded while the worker was busy.
      const chunk = this.world.getChunk(msg.cx, msg.cz);
      if (chunk === null) return;
      chunk.sections[msg.section].meshing = false;
      this.uploadQueue.push(msg);
    }
  }

  /** @private */
  _onGenerated(msg, job) {
    this.requested.delete(msg.cx + ',' + msg.cz);
    if (job !== undefined && job.cancelled === true) return;
    if (this.world.chunks.has(msg.cx + ',' + msg.cz)) return;

    const chunk = new Chunk(msg.cx, msg.cz);
    chunk.blocks.set(msg.blocks);
    chunk.rebuildDerived();
    chunk.state = ChunkState.GENERATED;

    this.world.addChunk(chunk);
  }

  /* ---------------------------------------------------------------- update */

  /**
   * Drives all three pipelines. Call once per frame.
   *
   * @param {number} viewerX World position of the viewer.
   * @param {number} viewerZ
   * @param {number} [dt=0] Seconds since the last frame, for the fluid clock.
   */
  update(viewerX, viewerZ, dt = 0) {
    const cx = Math.floor(viewerX) >> 4;
    const cz = Math.floor(viewerZ) >> 4;

    if (cx !== this.viewerCX || cz !== this.viewerCZ) {
      this.viewerCX = cx;
      this.viewerCZ = cz;
      this._rebuildLoadQueue();
      this._unloadFar();
    }

    this._dispatchGeneration();
    this.world.lighting.update();
    // Water runs before meshing so a cell that moved this frame is remeshed in
    // the same frame, instead of showing its previous level for one more.
    this.world.fluid.update(dt);
    this._dispatchMeshing();
    this._processUploads();
    this._updateStats();
  }

  /**
   * Rebuilds the generation queue as a disc around the viewer, nearest first.
   * @private
   */
  _rebuildLoadQueue() {
    const r = this.renderDistance;
    const queue = this.generateQueue;
    queue.length = 0;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > r + 0.5) continue;
        const gx = this.viewerCX + dx;
        const gz = this.viewerCZ + dz;
        const key = gx + ',' + gz;
        if (this.world.chunks.has(key) || this.requested.has(key)) continue;
        queue.push({ cx: gx, cz: gz, dist });
      }
    }

    queue.sort((a, b) => a.dist - b.dist);
    if (this._initialTarget === 0) this._initialTarget = queue.length;
  }

  /** @private */
  _dispatchGeneration() {
    // Keep roughly two jobs queued per worker: enough to hide latency, few
    // enough that a teleport does not leave a long stale backlog.
    const capacity = this.workers.length * 2;
    let inFlight = 0;
    for (let i = 0; i < this.workerLoad.length; i++) inFlight += this.workerLoad[i];

    while (inFlight < capacity && this.generateQueue.length > 0) {
      const item = this.generateQueue.shift();
      const key = item.cx + ',' + item.cz;
      if (this.world.chunks.has(key) || this.requested.has(key)) continue;

      const id = this._nextJobId++;
      this.jobs.set(id, { kind: 'generate', cx: item.cx, cz: item.cz, cancelled: false });
      this.requested.add(key);
      this._send({ type: 'generate', id, cx: item.cx, cz: item.cz, seed: this.world.seed });
      inFlight++;
    }
  }

  /**
   * Sends dirty sections out for meshing, nearest first.
   * @private
   */
  _dispatchMeshing() {
    const dirty = this.world.dirtySections;
    if (dirty.size === 0) return;

    const capacity = this.workers.length * 3;
    let inFlight = 0;
    for (let i = 0; i < this.workerLoad.length; i++) inFlight += this.workerLoad[i];
    if (inFlight >= capacity) return;

    // Order by distance so the player never waits on the horizon.
    const items = [];
    for (const key of dirty) {
      const parts = key.split(',');
      const cx = parseInt(parts[0], 10);
      const cz = parseInt(parts[1], 10);
      const section = parseInt(parts[2], 10);
      const dx = cx - this.viewerCX;
      const dz = cz - this.viewerCZ;
      items.push({ key, cx, cz, section, dist: dx * dx + dz * dz });
    }
    items.sort((a, b) => a.dist - b.dist);

    for (let i = 0; i < items.length && inFlight < capacity; i++) {
      const item = items[i];
      const chunk = this.world.getChunk(item.cx, item.cz);
      if (chunk === null) { dirty.delete(item.key); continue; }

      const section = chunk.sections[item.section];
      if (section.meshing) continue;

      // An empty section with nothing already drawn has no work to do.
      if (section.nonAir === 0 && section.opaque === null && section.water === null) {
        dirty.delete(item.key);
        section.dirty = false;
        continue;
      }

      const padded = this.world.buildPadded(chunk, item.section);
      const blocks = this.pads.acquireBlocks();
      const light = this.pads.acquireLight();
      const fluid = this.pads.acquireFluid();
      blocks.set(padded.blocks);
      light.set(padded.light);
      fluid.set(padded.fluid);

      const id = this._nextJobId++;
      this.jobs.set(id, { kind: 'mesh', cx: item.cx, cz: item.cz, section: item.section, cancelled: false });
      section.meshing = true;
      section.dirty = false;
      dirty.delete(item.key);

      this._send(
        { type: 'mesh', id, cx: item.cx, cz: item.cz, section: item.section, blocks, light, fluid },
        [blocks.buffer, light.buffer, fluid.buffer],
      );
      inFlight++;
    }
  }

  /**
   * Uploads a bounded number of finished meshes per frame. Creating GPU buffers
   * is the one genuinely blocking step, so it is throttled hardest.
   * @private
   */
  _processUploads() {
    let budget = this.uploadsPerFrame;

    while (budget > 0 && this.uploadQueue.length > 0) {
      const msg = this.uploadQueue.shift();
      const chunk = this.world.getChunk(msg.cx, msg.cz);
      if (chunk === null) continue;

      const section = chunk.sections[msg.section];
      this._applySectionMesh(chunk, section, msg.section, msg.opaque, false);
      this._applySectionMesh(chunk, section, msg.section, msg.water, true);
      budget--;
    }

    if (!this.initialLoadComplete &&
        this.generateQueue.length === 0 &&
        this.uploadQueue.length === 0 &&
        this.jobs.size === 0 &&
        this.world.chunkCount > 0) {
      this.initialLoadComplete = true;
    }
  }

  /**
   * Replaces one section mesh, disposing whatever was there.
   * @private
   */
  _applySectionMesh(chunk, section, sectionIndex, data, isWater) {
    const slot = isWater ? 'water' : 'opaque';
    const existing = section[slot];

    if (data === null || data === undefined) {
      if (existing !== null) {
        this.scene.remove(existing);
        existing.geometry.dispose(this.gl);
        section[slot] = null;
      }
      return;
    }

    const geometry = new Geometry();
    geometry.setAttribute('aPosition', data.positions, 3);
    geometry.setAttribute('aNormal', data.normals, 3, { normalized: true });
    geometry.setAttribute('aUV0', data.uvs, 2);
    geometry.setAttribute('aColor', data.colors, 4, { normalized: true });
    geometry.setIndex(data.indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    if (existing !== null) {
      // Swap the geometry in place: the node stays in the scene and in the BVH,
      // which avoids a remove/insert pair per edit.
      const old = existing.geometry;
      existing.geometry = geometry;
      old.dispose(this.gl);
      existing.updateWorldBounds();
      return;
    }

    const mesh = new Mesh(geometry, isWater ? this.waterMaterial : this.material);
    mesh.name = 'chunk_' + chunk.cx + '_' + chunk.cz + '_' + sectionIndex + (isWater ? '_water' : '');
    mesh.position.set(chunk.cx * 16, sectionIndex * SECTION_H, chunk.cz * 16);
    // Chunk meshes never move, so the engine can skip them in the transform pass.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;

    this.scene.add(mesh);
    section[slot] = mesh;
  }

  /* --------------------------------------------------------------- unload */

  /** @private */
  _unloadFar() {
    const limit = this.renderDistance + this.unloadMargin;
    const limitSq = limit * limit;
    const doomed = [];

    for (const chunk of this.world.chunks.values()) {
      const dx = chunk.cx - this.viewerCX;
      const dz = chunk.cz - this.viewerCZ;
      if (dx * dx + dz * dz > limitSq) doomed.push(chunk);
    }

    for (let i = 0; i < doomed.length; i++) this.unloadChunk(doomed[i]);
  }

  /**
   * Removes a chunk from the scene and frees its GPU resources.
   * @param {Chunk} chunk
   */
  unloadChunk(chunk) {
    for (let s = 0; s < SECTION_COUNT; s++) {
      const section = chunk.sections[s];
      if (section.opaque !== null) {
        this.scene.remove(section.opaque);
        section.opaque.geometry.dispose(this.gl);
        section.opaque = null;
      }
      if (section.water !== null) {
        this.scene.remove(section.water);
        section.water.geometry.dispose(this.gl);
        section.water = null;
      }
    }

    // Cancel anything still in flight for this chunk.
    for (const [id, job] of this.jobs) {
      if (job.cx === chunk.cx && job.cz === chunk.cz) job.cancelled = true;
    }

    this.world.removeChunk(chunk.cx, chunk.cz);
  }

  /**
   * Forces every loaded chunk to remesh, e.g. after a render setting changes.
   */
  remeshAll() {
    for (const chunk of this.world.chunks.values()) {
      chunk.markAllDirty();
      this.world.markChunkDirty(chunk);
    }
  }

  /**
   * @param {number} distance New render distance in chunks.
   */
  setRenderDistance(distance) {
    this.renderDistance = Math.max(2, Math.min(24, distance | 0));
    this._rebuildLoadQueue();
    this._unloadFar();
  }

  /** @private */
  _updateStats() {
    const s = this.stats;
    s.chunksLoaded = this.world.chunkCount;
    s.pendingGenerate = this.generateQueue.length;
    s.pendingUpload = this.uploadQueue.length;
    s.lightQueue = this.world.lighting.queueLength;
    s.fluidQueue = this.world.fluid.queueLength;
    s.fluidChanged = this.world.fluid.lastChanged;

    let generating = 0;
    let meshing = 0;
    for (const job of this.jobs.values()) {
      if (job.kind === 'generate') generating++;
      else meshing++;
    }
    s.generating = generating;
    s.meshing = meshing;

    let sections = 0;
    let triangles = 0;
    for (const chunk of this.world.chunks.values()) {
      for (let i = 0; i < SECTION_COUNT; i++) {
        const section = chunk.sections[i];
        if (section.opaque !== null) {
          sections++;
          const index = section.opaque.geometry.index;
          if (index !== null) triangles += index.count / 3;
        }
        if (section.water !== null) {
          sections++;
          const index = section.water.geometry.index;
          if (index !== null) triangles += index.count / 3;
        }
      }
    }
    s.sectionsDrawn = sections;
    s.trianglesResident = triangles;
  }

  /** Tears down the worker pool and every GPU resource. */
  dispose() {
    for (let i = 0; i < this.workers.length; i++) this.workers[i].terminate();
    this.workers.length = 0;
    for (const chunk of Array.from(this.world.chunks.values())) this.unloadChunk(chunk);
    this.jobs.clear();
    this.uploadQueue.length = 0;
    this.generateQueue.length = 0;
  }
}
