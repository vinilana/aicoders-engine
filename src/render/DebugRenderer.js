/**
 * Immediate mode line renderer for engine diagnostics.
 *
 * Every gizmo - boxes, oriented boxes, spheres, circles, cones, frusta, arrows,
 * axis crosses, BVH nodes, skeletons, vertex normals - is decomposed on the CPU
 * into GL_LINES segments and appended to ONE interleaved vertex stream
 * (`vec3 position + vec4 colour`, 7 floats, 28 bytes per vertex). `render(camera)`
 * uploads the dirty prefix of that stream and issues exactly ONE draw call, no
 * matter how many gizmos were queued.
 *
 * Usage is the classic retained-per-frame pattern:
 *
 *   const debug = new DebugRenderer(gl, renderer);
 *   // ... every frame, after renderer.render(scene, camera):
 *   debug.box(mesh.boundingBoxWorld, 0x00ff00);
 *   debug.drawSkeleton(character);
 *   debug.render(camera);   // one draw call, then clears itself
 *
 * Colours are stored LINEAR, like every other colour in the engine. Numeric hex
 * arguments are treated as sRGB and converted; `Color` instances, arrays and
 * `{r,g,b}` objects are taken as linear. The shader encodes linear -> sRGB on
 * output unless `linearOutput` is set, which is what an overlay drawn straight
 * into the default framebuffer needs.
 *
 * Allocation behaviour: after construction (and after any growth of the vertex
 * pool) the whole class is allocation free. Colours are resolved into module
 * scope scalars and every geometric helper writes directly into the pool.
 */

import { GLBuffer } from './Buffer.js';
import { VertexArray } from './VertexArray.js';
import { StateCache, getStateCache } from './StateCache.js';
import { ShaderLib } from './ShaderLib.js';
import { ATTRIB } from './Geometry.js';
import { CAMERA_OFFSETS } from './UniformBuffers.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';
import { Color, srgbToLinear } from '../math/Color.js';
import { registerDebugShader, DEBUG_SHADER_NAME } from './shaders/debug.js';

/* -------------------------------------------------------------------------- *
 * Constants
 * -------------------------------------------------------------------------- */

/** Floats per vertex: vec3 position + vec4 colour. */
const FLOATS_PER_VERTEX = 7;
/** Byte stride of one vertex. */
const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4;
/** Byte offset of the colour attribute inside a vertex. */
const COLOR_BYTE_OFFSET = 12;

/** Default pool size: 28672 vertices = 200704 floats (~800 KB, ~14336 segments). */
const DEFAULT_VERTEX_CAPACITY = 28672;
/** Hard ceiling so a runaway loop cannot eat all the memory. */
const DEFAULT_MAX_VERTICES = 1 << 20;

const GL_FLOAT = 0x1406;
const GL_LINES = 0x0001;

/**
 * Corner ordering used by the box / OBB / frustum helpers:
 * `index = x + 2*y + 4*z`, with each component 0 = min / 1 = max.
 */
const BOX_EDGES = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, // edges along X
  0, 2, 1, 3, 4, 6, 5, 7, // edges along Y
  0, 4, 1, 5, 2, 6, 3, 7  // edges along Z
]);

/** The 8 clip space corners in the same order as BOX_EDGES indexes them. */
const NDC_CORNERS = new Float32Array([
  -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
  -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1
]);

/* -------------------------------------------------------------------------- *
 * Module scratch (never allocated per call)
 * -------------------------------------------------------------------------- */

const _mat = new Mat4();
const _vec = new Vec3();
/** 8 transformed corners, xyz interleaved. */
const _corners = new Float32Array(24);

/** Current colour, linear, written by `_resolveColor` and read by `_segment`. */
let _cr = 1;
let _cg = 1;
let _cb = 1;
let _ca = 1;

/**
 * Resolves any colour-ish argument into the module scratch scalars.
 * Accepts: null/undefined (uses `fallback`), a packed sRGB hex number, a
 * `Color`-like `{r, g, b}` (linear), an array `[r, g, b, a]` (linear), or a
 * `Vec4`-like `{x, y, z, w}` (linear).
 * @param {*} color
 * @param {Color} fallback Colour used when `color` is null or unusable.
 * @param {number} [alpha=1] Alpha applied when the value carries none.
 * @returns {void}
 */
function _resolveColor(color, fallback, alpha) {
  _ca = alpha === undefined ? 1 : alpha;

  if (color === null || color === undefined) {
    _cr = fallback.r;
    _cg = fallback.g;
    _cb = fallback.b;
    return;
  }

  if (typeof color === 'number') {
    _cr = srgbToLinear(((color >> 16) & 255) / 255);
    _cg = srgbToLinear(((color >> 8) & 255) / 255);
    _cb = srgbToLinear((color & 255) / 255);
    return;
  }

  if (typeof color === 'object') {
    if (color.r !== undefined) {
      _cr = color.r;
      _cg = color.g;
      _cb = color.b;
      if (color.a !== undefined) _ca = color.a;
      return;
    }
    if (color.x !== undefined) {
      _cr = color.x;
      _cg = color.y;
      _cb = color.z;
      if (color.w !== undefined) _ca = color.w;
      return;
    }
    if (color.length >= 3) {
      _cr = color[0];
      _cg = color[1];
      _cb = color[2];
      if (color.length >= 4) _ca = color[3];
      return;
    }
  }

  _cr = fallback.r;
  _cg = fallback.g;
  _cb = fallback.b;
}

/**
 * Builds an orthonormal basis around `n` (assumed normalized) without any
 * branch on a degenerate axis. Frisvad / Duff's revised method.
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {Float32Array} outU Receives the first tangent (3 floats).
 * @param {Float32Array} outV Receives the second tangent (3 floats).
 * @returns {void}
 */
function _basisFromNormal(nx, ny, nz, outU, outV) {
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;
  outU[0] = 1 + sign * nx * nx * a;
  outU[1] = sign * b;
  outU[2] = -sign * nx;
  outV[0] = b;
  outV[1] = sign + ny * ny * a;
  outV[2] = -ny;
}

const _basisU = new Float32Array(3);
const _basisV = new Float32Array(3);

/* -------------------------------------------------------------------------- *
 * DebugRenderer
 * -------------------------------------------------------------------------- */

/**
 * Batched line renderer for debug overlays.
 */
export class DebugRenderer {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object|null} [renderer] Engine Renderer; its StateCache, ShaderLib and
   *        UniformBuffers are reused when present. An options bag may be passed
   *        here instead (it is detected automatically).
   * @param {Object} [options]
   * @param {number}  [options.capacity=28672] Initial vertex pool size.
   * @param {number}  [options.maxVertices=1048576] Hard growth ceiling.
   * @param {boolean} [options.depthTest=true] Occlude gizmos behind geometry.
   * @param {boolean} [options.depthWrite=false]
   * @param {string}  [options.depthFunc='lequal']
   * @param {string}  [options.blending='normal'] StateCache blend preset.
   * @param {number}  [options.lineWidth=1] WebGL2 only guarantees 1.
   * @param {number}  [options.opacity=1] Global alpha multiplier.
   * @param {number}  [options.depthOffset=0] NDC depth bias towards the viewer.
   * @param {boolean} [options.linearOutput=false] Skip the linear -> sRGB encode.
   * @param {boolean} [options.autoClear=true] `render()` empties the batch when done.
   * @param {boolean} [options.cameraUBO] Force the `Camera` uniform block path.
   * @param {boolean} [options.syncCameraUBO=true] Refresh the block from the camera
   *        handed to `render()` before drawing.
   * @param {number|Object} [options.defaultColor=0xffffff] Colour used when a call
   *        passes null.
   * @param {Object} [options.shaderLib] Explicit ShaderLib.
   * @param {Object} [options.state] Explicit StateCache.
   */
  constructor(gl, renderer, options) {
    let rendererRef = renderer || null;
    let opts = options || {};

    // Tolerate `new DebugRenderer(gl, options)`: a Renderer always exposes at
    // least one of state / shaderLib / gl, an options bag never does.
    if (rendererRef !== null &&
        rendererRef.state === undefined &&
        rendererRef.shaderLib === undefined &&
        rendererRef.gl === undefined) {
      if (options === undefined || options === null) opts = rendererRef;
      rendererRef = null;
    }

    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {Object|null} Renderer this overlay belongs to, when any. */
    this.renderer = rendererRef;
    /** @type {StateCache} Every GL state change funnels through this. */
    this.state = opts.state || (rendererRef && rendererRef.state) || getStateCache(gl) || new StateCache(gl);

    /** @private True when the shader library is owned (and must be disposed). */
    this._ownsShaderLib = false;
    let lib = opts.shaderLib || (rendererRef && rendererRef.shaderLib) || null;
    if (lib === null) {
      lib = new ShaderLib(gl);
      this._ownsShaderLib = true;
    }
    /** @type {ShaderLib} */
    this.shaderLib = lib;
    registerDebugShader(this.shaderLib);

    /** @type {Object|null} UniformBuffers used for the `Camera` block, when any. */
    this.ubo = opts.ubo || (rendererRef && rendererRef.ubo) || null;

    // --- draw state -------------------------------------------------------
    /** @type {boolean} Set to false to skip rendering without touching the batch. */
    this.enabled = opts.enabled !== false;
    /** @type {boolean} Depth test the lines against the scene. */
    this.depthTest = opts.depthTest !== false;
    /** @type {boolean} Debug lines normally must not pollute the depth buffer. */
    this.depthWrite = opts.depthWrite === true;
    /** @type {string} Depth comparison used when `depthTest` is on. */
    this.depthFunc = opts.depthFunc || 'lequal';
    /** @type {string} StateCache blend preset. */
    this.blending = opts.blending || 'normal';
    /** @type {number} Line width; WebGL2 only guarantees 1. */
    this.lineWidth = opts.lineWidth > 0 ? opts.lineWidth : 1;
    /** @type {number} Global alpha multiplier. */
    this.opacity = opts.opacity !== undefined ? opts.opacity : 1;
    /** @type {number} NDC depth bias, pulls the lines towards the viewer. */
    this.depthOffset = opts.depthOffset !== undefined ? opts.depthOffset : 0;
    /** @type {boolean} True when drawing into an HDR buffer before tone mapping. */
    this.linearOutput = opts.linearOutput === true;
    /** @type {boolean} `render()` empties the batch once the draw is issued. */
    this.autoClear = opts.autoClear !== false;
    /** @type {boolean} Refresh the `Camera` block from the camera given to render(). */
    this.syncCameraUBO = opts.syncCameraUBO !== false;
    /** @type {Color} Colour used whenever a call passes null. */
    this.defaultColor = new Color(opts.defaultColor !== undefined ? opts.defaultColor : 0xffffff);

    // --- vertex pool ------------------------------------------------------
    const capacity = Math.max(64, opts.capacity > 0 ? (opts.capacity | 0) : DEFAULT_VERTEX_CAPACITY);
    /** @type {number} Vertices the pool can currently hold. */
    this.capacity = capacity;
    /** @type {number} Growth ceiling, in vertices. */
    this.maxVertices = Math.max(capacity, opts.maxVertices > 0 ? (opts.maxVertices | 0) : DEFAULT_MAX_VERTICES);
    /** @type {Float32Array} Interleaved position + colour stream. */
    this.data = new Float32Array(capacity * FLOATS_PER_VERTEX);
    /** @type {number} Vertices queued for the next draw. */
    this.vertexCount = 0;

    /** @type {GLBuffer} */
    this.buffer = new GLBuffer(gl, 'array', 'dynamic');
    this.buffer.allocate(capacity * BYTES_PER_VERTEX, this.state);
    /** @type {VertexArray} */
    this.vao = new VertexArray(gl, this.state);
    this._recordVAO();

    /** @private @type {Object|null} Resolved program for the active permutation. */
    this._program = null;
    /** @private @type {boolean} sRGB encode flag the cached program was built with. */
    this._programSRGB = !this.linearOutput;
    /** @private @type {boolean} Camera UBO flag the cached program was built with. */
    this._useCameraUBO = opts.cameraUBO !== undefined ? !!opts.cameraUBO : (this.ubo !== null);
    /** @private @type {boolean} True when the GPU store must be reallocated. */
    this._storeDirty = false;
    /** @private One-shot warning latch for the vertex ceiling. */
    this._overflowWarned = false;
    /** @private Reused time payload for UniformBuffers.updateCamera. */
    this._timeScratch = { elapsed: 0, delta: 0, frame: 0 };
    /** @private Reused bone lookup for drawSkeleton. */
    this._boneSet = new Set();
    /** @private Traversal stacks for drawBVH (grown on demand). */
    this._bvhStack = new Int32Array(256);
    this._bvhDepth = new Int32Array(256);

    /** @type {boolean} */
    this.disposed = false;

    /** Per-frame statistics. */
    this.info = {
      vertices: 0,
      lines: 0,
      drawCalls: 0,
      uploads: 0,
      dropped: 0,
      capacity: capacity
    };
  }

  /* ---------------------------------------------------------------------- *
   * Pool management
   * ---------------------------------------------------------------------- */

  /**
   * Records the interleaved attribute layout into the VAO.
   * @private
   * @returns {void}
   */
  _recordVAO() {
    this.vao.setAttribute(ATTRIB.POSITION, this.buffer, 3, GL_FLOAT, false, BYTES_PER_VERTEX, 0, 0, false);
    this.vao.setAttribute(ATTRIB.COLOR, this.buffer, 4, GL_FLOAT, false, BYTES_PER_VERTEX, COLOR_BYTE_OFFSET, 0, false);
  }

  /**
   * Makes room for `count` additional vertices, growing the pool if needed.
   * @private
   * @param {number} count
   * @returns {boolean} false when the ceiling was hit and the caller must bail out
   */
  _reserve(count) {
    const needed = this.vertexCount + count;
    if (needed <= this.capacity) return true;
    if (needed > this.maxVertices) {
      this.info.dropped += count;
      if (!this._overflowWarned) {
        this._overflowWarned = true;
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(
            'DebugRenderer: limite de ' + this.maxVertices +
            ' vertices atingido; as linhas seguintes deste frame serao descartadas.'
          );
        }
      }
      return false;
    }

    let capacity = this.capacity;
    while (capacity < needed) capacity *= 2;
    if (capacity > this.maxVertices) capacity = this.maxVertices;

    const data = new Float32Array(capacity * FLOATS_PER_VERTEX);
    data.set(this.data);
    this.data = data;
    this.capacity = capacity;
    this.info.capacity = capacity;
    this._storeDirty = true;
    return true;
  }

  /**
   * Appends one line segment using the current scratch colour.
   * @private
   * @param {number} x0 @param {number} y0 @param {number} z0
   * @param {number} x1 @param {number} y1 @param {number} z1
   * @returns {void}
   */
  _segment(x0, y0, z0, x1, y1, z1) {
    if (!this._reserve(2)) return;
    const d = this.data;
    let o = this.vertexCount * FLOATS_PER_VERTEX;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = z0;
    d[o + 3] = _cr; d[o + 4] = _cg; d[o + 5] = _cb; d[o + 6] = _ca;
    o += FLOATS_PER_VERTEX;
    d[o] = x1; d[o + 1] = y1; d[o + 2] = z1;
    d[o + 3] = _cr; d[o + 4] = _cg; d[o + 5] = _cb; d[o + 6] = _ca;
    this.vertexCount += 2;
  }

  /**
   * Number of line segments currently queued.
   * @type {number}
   */
  get lineCount() {
    return this.vertexCount >> 1;
  }

  /**
   * CPU + GPU bytes held by the vertex pool.
   * @type {number}
   */
  get memoryBytes() {
    return this.data.byteLength + this.buffer.byteLength;
  }

  /** Empties the batch. Call once per frame (or let `autoClear` do it). */
  clear() {
    this.vertexCount = 0;
    this.info.dropped = 0;
    this._overflowWarned = false;
    return this;
  }

  /* ---------------------------------------------------------------------- *
   * Primitives
   * ---------------------------------------------------------------------- */

  /**
   * One line segment between two points.
   * @param {{x:number,y:number,z:number}} a
   * @param {{x:number,y:number,z:number}} b
   * @param {number|Color|Array<number>|null} [color]
   * @returns {DebugRenderer} this
   */
  line(a, b, color) {
    _resolveColor(color, this.defaultColor);
    this._segment(a.x, a.y, a.z, b.x, b.y, b.z);
    return this;
  }

  /**
   * Allocation free variant of {@link DebugRenderer#line} taking raw components.
   * @param {number} x0 @param {number} y0 @param {number} z0
   * @param {number} x1 @param {number} y1 @param {number} z1
   * @param {number|Color|Array<number>|null} [color]
   * @returns {DebugRenderer} this
   */
  lineXYZ(x0, y0, z0, x1, y1, z1, color) {
    _resolveColor(color, this.defaultColor);
    this._segment(x0, y0, z0, x1, y1, z1);
    return this;
  }

  /**
   * A polyline through a flat coordinate array.
   * @param {ArrayLike<number>} points xyz triplets.
   * @param {number|Color|Array<number>|null} [color]
   * @param {boolean} [closed=false] Also connect the last point to the first.
   * @returns {DebugRenderer} this
   */
  polyline(points, color, closed = false) {
    const n = (points.length / 3) | 0;
    if (n < 2) return this;
    _resolveColor(color, this.defaultColor);
    this._reserve((closed ? n : n - 1) * 2);
    for (let i = 0; i < n - 1; i++) {
      const a = i * 3;
      const b = a + 3;
      this._segment(points[a], points[a + 1], points[a + 2], points[b], points[b + 1], points[b + 2]);
    }
    if (closed) {
      const last = (n - 1) * 3;
      this._segment(points[last], points[last + 1], points[last + 2], points[0], points[1], points[2]);
    }
    return this;
  }

  /**
   * Axis aligned wireframe box from explicit bounds (allocation free).
   * @param {number} minX @param {number} minY @param {number} minZ
   * @param {number} maxX @param {number} maxY @param {number} maxZ
   * @param {number|Color|Array<number>|null} [color]
   * @returns {DebugRenderer} this
   */
  boxMinMax(minX, minY, minZ, maxX, maxY, maxZ, color) {
    _resolveColor(color, this.defaultColor);
    this._boxMinMaxNoColor(minX, minY, minZ, maxX, maxY, maxZ);
    return this;
  }

  /**
   * Emits the 12 edges of an axis aligned box with the current scratch colour.
   * @private
   */
  _boxMinMaxNoColor(minX, minY, minZ, maxX, maxY, maxZ) {
    if (!this._reserve(24)) return;
    // 4 edges along X
    this._segment(minX, minY, minZ, maxX, minY, minZ);
    this._segment(minX, maxY, minZ, maxX, maxY, minZ);
    this._segment(minX, minY, maxZ, maxX, minY, maxZ);
    this._segment(minX, maxY, maxZ, maxX, maxY, maxZ);
    // 4 edges along Y
    this._segment(minX, minY, minZ, minX, maxY, minZ);
    this._segment(maxX, minY, minZ, maxX, maxY, minZ);
    this._segment(minX, minY, maxZ, minX, maxY, maxZ);
    this._segment(maxX, minY, maxZ, maxX, maxY, maxZ);
    // 4 edges along Z
    this._segment(minX, minY, minZ, minX, minY, maxZ);
    this._segment(maxX, minY, minZ, maxX, minY, maxZ);
    this._segment(minX, maxY, minZ, minX, maxY, maxZ);
    this._segment(maxX, maxY, minZ, maxX, maxY, maxZ);
  }

  /**
   * Axis aligned wireframe box.
   * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
   * @param {number|Color|Array<number>|null} [color]
   * @returns {DebugRenderer} this
   */
  box(aabb, color) {
    if (!aabb || !aabb.min || !aabb.max) return this;
    const min = aabb.min;
    const max = aabb.max;
    if (max.x < min.x || max.y < min.y || max.z < min.z) return this; // empty box
    return this.boxMinMax(min.x, min.y, min.z, max.x, max.y, max.z, color);
  }

  /**
   * Oriented wireframe box: a box of `size`, centred on the origin, transformed
   * by `matrix`.
   * @param {Mat4|{elements:Float32Array}} matrix
   * @param {{x:number,y:number,z:number}|number} [size=1] Full extents.
   * @param {number|Color|Array<number>|null} [color]
   * @param {{x:number,y:number,z:number}} [center] Optional local centre offset.
   * @returns {DebugRenderer} this
   */
  obb(matrix, size, color, center) {
    if (!matrix) return this;
    const e = matrix.elements !== undefined ? matrix.elements : matrix;

    let hx = 0.5;
    let hy = 0.5;
    let hz = 0.5;
    if (typeof size === 'number') {
      hx = hy = hz = size * 0.5;
    } else if (size && size.x !== undefined) {
      hx = size.x * 0.5;
      hy = size.y * 0.5;
      hz = size.z * 0.5;
    }

    const ox = center ? center.x : 0;
    const oy = center ? center.y : 0;
    const oz = center ? center.z : 0;

    for (let i = 0; i < 8; i++) {
      const lx = ox + ((i & 1) ? hx : -hx);
      const ly = oy + ((i & 2) ? hy : -hy);
      const lz = oz + ((i & 4) ? hz : -hz);
      const o = i * 3;
      _corners[o] = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      _corners[o + 1] = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      _corners[o + 2] = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
    }

    _resolveColor(color, this.defaultColor);
    this._emitCornerEdges();
    return this;
  }

  /**
   * Emits the 12 BOX_EDGES connections over `_corners` with the scratch colour.
   * @private
   */
  _emitCornerEdges() {
    if (!this._reserve(24)) return;
    for (let i = 0; i < 24; i += 2) {
      const a = BOX_EDGES[i] * 3;
      const b = BOX_EDGES[i + 1] * 3;
      this._segment(
        _corners[a], _corners[a + 1], _corners[a + 2],
        _corners[b], _corners[b + 1], _corners[b + 2]
      );
    }
  }

  /**
   * A circle described by a centre, a radius and two orthonormal tangents.
   * @private
   */
  _circle(cx, cy, cz, radius, ux, uy, uz, vx, vy, vz, segments) {
    const n = segments < 3 ? 3 : segments | 0;
    if (!this._reserve(n * 2)) return;
    const step = (Math.PI * 2) / n;
    let px = cx + ux * radius;
    let py = cy + uy * radius;
    let pz = cz + uz * radius;
    for (let i = 1; i <= n; i++) {
      const angle = i * step;
      const c = Math.cos(angle) * radius;
      const s = Math.sin(angle) * radius;
      const qx = cx + ux * c + vx * s;
      const qy = cy + uy * c + vy * s;
      const qz = cz + uz * c + vz * s;
      this._segment(px, py, pz, qx, qy, qz);
      px = qx;
      py = qy;
      pz = qz;
    }
  }

  /**
   * Circle lying in the plane whose normal is `normal`.
   * @param {{x:number,y:number,z:number}} center
   * @param {number} radius
   * @param {{x:number,y:number,z:number}} [normal] Defaults to +Y.
   * @param {number|Color|Array<number>|null} [color]
   * @param {number} [segments=32]
   * @returns {DebugRenderer} this
   */
  circle(center, radius, normal, color, segments = 32) {
    let nx = 0;
    let ny = 1;
    let nz = 0;
    if (normal) {
      nx = normal.x;
      ny = normal.y;
      nz = normal.z;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-12) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nx = 0; ny = 1; nz = 0;
      }
    }
    _basisFromNormal(nx, ny, nz, _basisU, _basisV);
    _resolveColor(color, this.defaultColor);
    this._circle(
      center.x, center.y, center.z, radius,
      _basisU[0], _basisU[1], _basisU[2],
      _basisV[0], _basisV[1], _basisV[2],
      segments
    );
    return this;
  }

  /**
   * Wireframe sphere drawn as three great circles (XY, XZ and YZ planes).
   * @param {{x:number,y:number,z:number}} center
   * @param {number} radius
   * @param {number|Color|Array<number>|null} [color]
   * @param {number} [segments=24] Segments per great circle.
   * @returns {DebugRenderer} this
   */
  sphere(center, radius, color, segments = 24) {
    if (!(radius > 0)) return this;
    _resolveColor(color, this.defaultColor);
    const cx = center.x;
    const cy = center.y;
    const cz = center.z;
    this._circle(cx, cy, cz, radius, 1, 0, 0, 0, 1, 0, segments); // XY
    this._circle(cx, cy, cz, radius, 1, 0, 0, 0, 0, 1, segments); // XZ
    this._circle(cx, cy, cz, radius, 0, 1, 0, 0, 0, 1, segments); // YZ
    return this;
  }

  /**
   * Wireframe cone, the shape a spot light casts.
   * @param {{x:number,y:number,z:number}} apex
   * @param {{x:number,y:number,z:number}} direction Points from apex to base.
   * @param {number} length Distance from the apex to the base plane.
   * @param {number} angle Half angle of the cone, in radians.
   * @param {number|Color|Array<number>|null} [color]
   * @param {number} [segments=24] Segments of the base circle.
   * @returns {DebugRenderer} this
   */
  cone(apex, direction, length, angle, color, segments = 24) {
    let dx = direction.x;
    let dy = direction.y;
    let dz = direction.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-12) || !(length > 0)) return this;
    dx /= len;
    dy /= len;
    dz /= len;

    const bx = apex.x + dx * length;
    const by = apex.y + dy * length;
    const bz = apex.z + dz * length;
    const radius = Math.tan(angle) * length;

    _basisFromNormal(dx, dy, dz, _basisU, _basisV);
    _resolveColor(color, this.defaultColor);

    this._circle(
      bx, by, bz, radius,
      _basisU[0], _basisU[1], _basisU[2],
      _basisV[0], _basisV[1], _basisV[2],
      segments
    );

    // Four side lines plus the axis.
    if (!this._reserve(10)) return this;
    for (let i = 0; i < 4; i++) {
      const a = i * (Math.PI * 0.5);
      const c = Math.cos(a) * radius;
      const s = Math.sin(a) * radius;
      this._segment(
        apex.x, apex.y, apex.z,
        bx + _basisU[0] * c + _basisV[0] * s,
        by + _basisU[1] * c + _basisV[1] * s,
        bz + _basisU[2] * c + _basisV[2] * s
      );
    }
    this._segment(apex.x, apex.y, apex.z, bx, by, bz);
    return this;
  }

  /**
   * Wireframe of a camera frustum, reconstructed by unprojecting the 8 clip
   * space corners through the camera's inverse projection and world matrix.
   * @param {Object} camera Any Camera with projectionMatrixInverse + worldMatrix.
   * @param {number|Color|Array<number>|null} [color]
   * @returns {DebugRenderer} this
   */
  frustum(camera, color) {
    if (!camera || !camera.projectionMatrixInverse || !camera.worldMatrix) return this;
    if (typeof camera.updateProjectionIfNeeded === 'function') camera.updateProjectionIfNeeded();

    _mat.multiplyMatrices(camera.worldMatrix, camera.projectionMatrixInverse);
    for (let i = 0; i < 8; i++) {
      const o = i * 3;
      _vec.set(NDC_CORNERS[o], NDC_CORNERS[o + 1], NDC_CORNERS[o + 2]).applyMat4(_mat);
      _corners[o] = _vec.x;
      _corners[o + 1] = _vec.y;
      _corners[o + 2] = _vec.z;
    }

    _resolveColor(color, this.defaultColor);
    this._emitCornerEdges();
    return this;
  }

  /**
   * Red / green / blue axis cross for a transform.
   * @param {Mat4|{elements:Float32Array}} matrix
   * @param {number} [size=1] Axis length in world units.
   * @param {number} [alpha=1]
   * @returns {DebugRenderer} this
   */
  axes(matrix, size = 1, alpha = 1) {
    if (!matrix) return this;
    const e = matrix.elements !== undefined ? matrix.elements : matrix;
    const ox = e[12];
    const oy = e[13];
    const oz = e[14];
    if (!this._reserve(6)) return this;

    // Normalize each basis vector so a scaled node still shows unit-length axes.
    let lx = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
    let ly = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    let lz = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
    lx = lx > 1e-12 ? size / lx : 0;
    ly = ly > 1e-12 ? size / ly : 0;
    lz = lz > 1e-12 ? size / lz : 0;

    _cr = 1; _cg = 0; _cb = 0; _ca = alpha;
    this._segment(ox, oy, oz, ox + e[0] * lx, oy + e[1] * lx, oz + e[2] * lx);
    _cr = 0; _cg = 1; _cb = 0;
    this._segment(ox, oy, oz, ox + e[4] * ly, oy + e[5] * ly, oz + e[6] * ly);
    _cr = 0; _cg = 0; _cb = 1;
    this._segment(ox, oy, oz, ox + e[8] * lz, oy + e[9] * lz, oz + e[10] * lz);
    return this;
  }

  /**
   * A small three-axis cross marking a position.
   * @param {{x:number,y:number,z:number}} p
   * @param {number} [size=0.05] Half length of each arm.
   * @param {number|Color|Array<number>|null} [color]
   * @returns {DebugRenderer} this
   */
  point(p, size = 0.05, color) {
    _resolveColor(color, this.defaultColor);
    if (!this._reserve(6)) return this;
    this._segment(p.x - size, p.y, p.z, p.x + size, p.y, p.z);
    this._segment(p.x, p.y - size, p.z, p.x, p.y + size, p.z);
    this._segment(p.x, p.y, p.z - size, p.x, p.y, p.z + size);
    return this;
  }

  /**
   * A line with a four-barb arrow head at its far end.
   * @param {{x:number,y:number,z:number}} from
   * @param {{x:number,y:number,z:number}} to
   * @param {number|Color|Array<number>|null} [color]
   * @param {number} [headSize] Head length; defaults to 15% of the shaft.
   * @returns {DebugRenderer} this
   */
  arrow(from, to, color, headSize) {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let dz = to.z - from.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    _resolveColor(color, this.defaultColor);
    if (!(len > 1e-12)) {
      this._segment(from.x, from.y, from.z, to.x, to.y, to.z);
      return this;
    }
    dx /= len;
    dy /= len;
    dz /= len;

    const head = headSize > 0 ? Math.min(headSize, len) : len * 0.15;
    const wide = head * 0.4;
    const baseX = to.x - dx * head;
    const baseY = to.y - dy * head;
    const baseZ = to.z - dz * head;

    _basisFromNormal(dx, dy, dz, _basisU, _basisV);
    if (!this._reserve(10)) return this;

    this._segment(from.x, from.y, from.z, to.x, to.y, to.z);
    this._segment(to.x, to.y, to.z, baseX + _basisU[0] * wide, baseY + _basisU[1] * wide, baseZ + _basisU[2] * wide);
    this._segment(to.x, to.y, to.z, baseX - _basisU[0] * wide, baseY - _basisU[1] * wide, baseZ - _basisU[2] * wide);
    this._segment(to.x, to.y, to.z, baseX + _basisV[0] * wide, baseY + _basisV[1] * wide, baseZ + _basisV[2] * wide);
    this._segment(to.x, to.y, to.z, baseX - _basisV[0] * wide, baseY - _basisV[1] * wide, baseZ - _basisV[2] * wide);
    return this;
  }

  /**
   * A ground grid on the XZ plane, handy as a spatial reference.
   * @param {number} [size=10] Total side length.
   * @param {number} [divisions=10]
   * @param {number|Color|Array<number>|null} [color]
   * @param {number} [y=0] Height of the plane.
   * @returns {DebugRenderer} this
   */
  grid(size = 10, divisions = 10, color, y = 0) {
    const n = divisions < 1 ? 1 : divisions | 0;
    const half = size * 0.5;
    const step = size / n;
    _resolveColor(color, this.defaultColor);
    if (!this._reserve((n + 1) * 4)) return this;
    for (let i = 0; i <= n; i++) {
      const t = -half + i * step;
      this._segment(-half, y, t, half, y, t);
      this._segment(t, y, -half, t, y, half);
    }
    return this;
  }

  /* ---------------------------------------------------------------------- *
   * Engine object helpers
   * ---------------------------------------------------------------------- */

  /**
   * Draws every node box of a {@link DynamicBVH}, coloured by depth.
   *
   * Reads the tree's SoA node arrays directly; falls back to the root bounds
   * when a foreign implementation does not expose them.
   *
   * @param {Object} bvh DynamicBVH instance.
   * @param {number} [maxDepth=-1] Deepest level drawn, -1 for the whole tree.
   * @param {number|Color|Array<number>|null} [color] null colours by depth.
   * @returns {number} how many node boxes were emitted
   */
  drawBVH(bvh, maxDepth = -1, color) {
    if (!bvh) return 0;

    const bounds = bvh._bounds;
    const child1 = bvh._child1;
    const child2 = bvh._child2;
    const root = typeof bvh.root === 'number' ? bvh.root : -1;

    if (!bounds || !child1 || !child2 || root < 0) {
      // Foreign / empty tree: draw whatever the public API can give us.
      if (typeof bvh.getBounds === 'function') {
        const box = bvh.getBounds();
        if (box && box.min && box.max && box.max.x >= box.min.x) {
          this.box(box, color);
          return 1;
        }
      }
      return 0;
    }

    const limit = maxDepth < 0 ? 0x7fffffff : maxDepth | 0;
    let stack = this._bvhStack;
    let depths = this._bvhDepth;
    const needed = (typeof bvh.height === 'number' ? bvh.height : 0) * 2 + 64;
    if (stack.length < needed) {
      stack = this._bvhStack = new Int32Array(needed);
      depths = this._bvhDepth = new Int32Array(needed);
    }

    let top = 0;
    stack[top] = root;
    depths[top] = 0;
    top++;
    let drawn = 0;

    while (top > 0) {
      top--;
      const node = stack[top];
      const depth = depths[top];
      if (node < 0) continue;

      if (color === null || color === undefined) {
        // Cheap depth ramp: green -> yellow -> red as the level grows.
        const t = depth > 8 ? 1 : depth / 8;
        _cr = t;
        _cg = 1 - t * 0.75;
        _cb = 0.15;
        _ca = 1;
      } else {
        _resolveColor(color, this.defaultColor);
      }

      const o = node * 6;
      this._boxMinMaxNoColor(bounds[o], bounds[o + 1], bounds[o + 2], bounds[o + 3], bounds[o + 4], bounds[o + 5]);
      drawn++;

      if (depth >= limit) continue;
      const a = child1[node];
      const b = child2[node];
      // Leaves store the free-list pointer in child1, so guard on child2.
      if (b < 0) continue;
      if (top + 2 > stack.length) {
        const grown = new Int32Array(stack.length * 2);
        grown.set(stack);
        stack = this._bvhStack = grown;
        const grownDepths = new Int32Array(depths.length * 2);
        grownDepths.set(depths);
        depths = this._bvhDepth = grownDepths;
      }
      stack[top] = a;
      depths[top] = depth + 1;
      top++;
      stack[top] = b;
      depths[top] = depth + 1;
      top++;
    }

    return drawn;
  }

  /**
   * Draws the bone hierarchy of a skinned mesh: one segment per parent/child
   * pair plus a small marker on every joint.
   * @param {Object} skinnedMesh SkinnedMesh, or a Skeleton directly.
   * @param {number|Color|Array<number>|null} [color]
   * @param {number} [jointSize=0.02] Half size of the joint markers.
   * @returns {number} how many bones were drawn
   */
  drawSkeleton(skinnedMesh, color, jointSize = 0.02) {
    if (!skinnedMesh) return 0;
    const skeleton = skinnedMesh.skeleton || skinnedMesh;
    const bones = skeleton && skeleton.bones;
    if (!bones || bones.length === 0) return 0;

    const set = this._boneSet;
    set.clear();
    for (let i = 0, n = bones.length; i < n; i++) {
      if (bones[i]) set.add(bones[i]);
    }

    _resolveColor(color, this.defaultColor);
    const cr = _cr;
    const cg = _cg;
    const cb = _cb;
    const ca = _ca;

    let drawn = 0;
    for (let i = 0, n = bones.length; i < n; i++) {
      const bone = bones[i];
      if (!bone || !bone.worldMatrix) continue;
      const e = bone.worldMatrix.elements;
      const x = e[12];
      const y = e[13];
      const z = e[14];

      const parent = bone.parent;
      if (parent && parent.worldMatrix && set.has(parent)) {
        const pe = parent.worldMatrix.elements;
        _cr = cr; _cg = cg; _cb = cb; _ca = ca;
        this._segment(pe[12], pe[13], pe[14], x, y, z);
        drawn++;
      }

      if (jointSize > 0) {
        _cr = 1; _cg = 1; _cb = 0.2; _ca = ca;
        if (!this._reserve(6)) break;
        this._segment(x - jointSize, y, z, x + jointSize, y, z);
        this._segment(x, y - jointSize, z, x, y + jointSize, z);
        this._segment(x, y, z - jointSize, x, y, z + jointSize);
      }
    }
    return drawn;
  }

  /**
   * Draws the vertex normals of a mesh in world space.
   *
   * The direction is transformed by the upper-left 3x3 of the world matrix and
   * renormalized, which is exact for rotation plus uniform scale and close
   * enough for a debug overlay otherwise.
   *
   * @param {Object} mesh Mesh with `geometry` and `worldMatrix`.
   * @param {number} [length=0.1] World length of each normal.
   * @param {number|Color|Array<number>|null} [color]
   * @param {number} [stride=1] Draw one vertex out of every `stride`.
   * @returns {number} how many normals were drawn
   */
  drawNormals(mesh, length = 0.1, color, stride = 1) {
    if (!mesh || !mesh.geometry || !mesh.worldMatrix) return 0;
    const geometry = mesh.geometry;
    if (typeof geometry.getAttribute !== 'function') return 0;

    const positions = geometry.getAttribute('aPosition');
    const normals = geometry.getAttribute('aNormal');
    if (!positions || !normals || !positions.data || !normals.data) return 0;

    const count = Math.min(positions.count, normals.count);
    if (count === 0) return 0;

    const step = stride > 1 ? stride | 0 : 1;
    const e = mesh.worldMatrix.elements;

    const pData = positions.data;
    const pStride = positions.elementStride;
    const pOffset = positions.elementOffset;
    const nData = normals.data;
    const nStride = normals.elementStride;
    const nOffset = normals.elementOffset;

    _resolveColor(color, this.defaultColor);
    const wanted = Math.ceil(count / step) * 2;
    if (!this._reserve(wanted)) return 0;

    let drawn = 0;
    for (let i = 0; i < count; i += step) {
      const pi = pOffset + i * pStride;
      const ni = nOffset + i * nStride;

      const lx = pData[pi];
      const ly = pData[pi + 1];
      const lz = pData[pi + 2];
      const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];

      const sx = nData[ni];
      const sy = nData[ni + 1];
      const sz = nData[ni + 2];
      let dx = e[0] * sx + e[4] * sy + e[8] * sz;
      let dy = e[1] * sx + e[5] * sy + e[9] * sz;
      let dz = e[2] * sx + e[6] * sy + e[10] * sz;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len > 1e-12) {
        const inv = length / len;
        dx *= inv;
        dy *= inv;
        dz *= inv;
      } else {
        continue;
      }

      this._segment(wx, wy, wz, wx + dx, wy + dy, wz + dz);
      drawn++;
    }
    return drawn;
  }

  /**
   * Convenience: world-space bounding volumes of a mesh.
   * @param {Object} mesh Mesh with `boundingBoxWorld` / `boundingSphereWorld`.
   * @param {number|Color|Array<number>|null} [boxColor]
   * @param {number|Color|Array<number>|null} [sphereColor] null skips the sphere.
   * @returns {DebugRenderer} this
   */
  meshBounds(mesh, boxColor, sphereColor) {
    if (!mesh) return this;
    if (mesh.boundingBoxWorld) this.box(mesh.boundingBoxWorld, boxColor);
    if (sphereColor !== undefined && sphereColor !== null && mesh.boundingSphereWorld) {
      const s = mesh.boundingSphereWorld;
      if (s.radius > 0) this.sphere(s.center, s.radius, sphereColor, 20);
    }
    return this;
  }

  /* ---------------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------------- */

  /**
   * Enables or disables depth testing for the whole batch.
   * @param {boolean} enabled
   * @returns {DebugRenderer} this
   */
  setDepthTest(enabled) {
    this.depthTest = !!enabled;
    return this;
  }

  /**
   * Resolves (and compiles on demand) the program for the active permutation.
   * @private
   * @returns {Object|null}
   */
  _getProgram() {
    const wantSRGB = !this.linearOutput;
    const cached = this._program;
    if (cached !== null && this._programSRGB === wantSRGB && cached.program !== null) return cached;

    const defines = {};
    if (this._useCameraUBO) defines.DEBUG_CAMERA_UBO = 1;
    if (wantSRGB) defines.DEBUG_SRGB_OUTPUT = 1;

    const program = this.shaderLib.get(DEBUG_SHADER_NAME, defines);
    this._program = program;
    this._programSRGB = wantSRGB;
    return program;
  }

  /**
   * Refreshes the `Camera` uniform block from the camera being drawn with,
   * preserving the time values the renderer already published.
   * @private
   * @param {Object} camera
   * @returns {void}
   */
  _syncCamera(camera) {
    const ubo = this.ubo;
    if (typeof camera.updateViewMatrix === 'function') camera.updateViewMatrix();
    if (typeof camera.updateFrustum === 'function') camera.updateFrustum();

    const gl = this.gl;
    const renderer = this.renderer;
    const width = renderer && renderer.drawingBufferWidth > 0 ? renderer.drawingBufferWidth : gl.drawingBufferWidth;
    const height = renderer && renderer.drawingBufferHeight > 0 ? renderer.drawingBufferHeight : gl.drawingBufferHeight;

    const time = this._timeScratch;
    const data = ubo.camera && ubo.camera.data;
    if (data) {
      time.elapsed = data[CAMERA_OFFSETS.timeParams];
      time.delta = data[CAMERA_OFFSETS.timeParams + 1];
      time.frame = data[CAMERA_OFFSETS.timeParams + 2];
    }

    ubo.updateCamera(camera, width, height, time);
    ubo.camera.bind(this.state);
  }

  /**
   * Uploads the queued vertices and draws them with a single `drawArrays`.
   * @param {Object} camera Camera to draw with.
   * @returns {number} vertices drawn (0 when nothing was queued)
   */
  render(camera) {
    this.info.drawCalls = 0;
    this.info.uploads = 0;
    this.info.vertices = this.vertexCount;
    this.info.lines = this.vertexCount >> 1;

    if (this.disposed || !this.enabled || this.vertexCount === 0 || !camera) {
      if (this.autoClear) this.clear();
      return 0;
    }

    const program = this._getProgram();
    if (program === null || !program.isLinked()) {
      if (this.autoClear) this.clear();
      return 0;
    }

    const state = this.state;
    const drawn = this.vertexCount;

    // --- upload ----------------------------------------------------------
    if (this._storeDirty || this.buffer.byteLength < this.capacity * BYTES_PER_VERTEX) {
      this.buffer.setData(this.data, state);
      this._storeDirty = false;
    } else {
      this.buffer.setSubData(this.data, 0, 0, drawn * FLOATS_PER_VERTEX, state);
    }
    this.info.uploads = 1;

    // --- state -----------------------------------------------------------
    state.setDepthTest(this.depthTest);
    state.setDepthWrite(this.depthWrite);
    if (this.depthTest) state.setDepthFunc(this.depthFunc);
    state.setCullFace('none');
    state.setBlending(this.blending);
    state.setColorMask(true, true, true, true);
    state.setPolygonOffset(false, 0, 0);
    state.setLineWidth(this.lineWidth);

    // --- program ---------------------------------------------------------
    if (!program.use(state)) {
      if (this.autoClear) this.clear();
      return 0;
    }
    program.setUniform('uOpacity', this.opacity);
    program.setUniform('uDepthOffset', this.depthOffset);

    if (this._useCameraUBO) {
      if (this.ubo !== null && this.syncCameraUBO) this._syncCamera(camera);
    } else {
      if (typeof camera.updateViewMatrix === 'function') camera.updateViewMatrix();
      _mat.multiplyMatrices(camera.projectionMatrix, camera.viewMatrix);
      program.setUniform('uDebugViewProj', _mat);
    }

    // --- draw ------------------------------------------------------------
    this.vao.bind(state);
    state.drawArrays(GL_LINES, 0, drawn);
    this.info.drawCalls = 1;

    if (this.autoClear) this.clear();
    return drawn;
  }

  /**
   * Re-creates the GPU resources after a context loss / restore.
   * @returns {DebugRenderer} this
   */
  onContextRestored() {
    this.buffer = new GLBuffer(this.gl, 'array', 'dynamic');
    this.buffer.allocate(this.capacity * BYTES_PER_VERTEX, this.state);
    this.vao = new VertexArray(this.gl, this.state);
    this._recordVAO();
    this._program = null;
    this._storeDirty = true;
    registerDebugShader(this.shaderLib);
    return this;
  }

  /** Releases the GPU buffer, the VAO and (when owned) the shader library. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.vao.dispose(this.state);
    this.buffer.dispose(this.state);
    if (this._ownsShaderLib) this.shaderLib.dispose();
    this._program = null;
    this._boneSet.clear();
    this.vertexCount = 0;
  }
}
