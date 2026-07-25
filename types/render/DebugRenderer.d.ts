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
    constructor(gl: WebGL2RenderingContext, renderer?: any | null, options?: {
        capacity?: number;
        maxVertices?: number;
        depthTest?: boolean;
        depthWrite?: boolean;
        depthFunc?: string;
        blending?: string;
        lineWidth?: number;
        opacity?: number;
        depthOffset?: number;
        linearOutput?: boolean;
        autoClear?: boolean;
        cameraUBO?: boolean;
        syncCameraUBO?: boolean;
        defaultColor?: number | any;
        shaderLib?: any;
        state?: any;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object|null} Renderer this overlay belongs to, when any. */
    renderer: any | null;
    /** @type {StateCache} Every GL state change funnels through this. */
    state: StateCache;
    /** @private True when the shader library is owned (and must be disposed). */
    private _ownsShaderLib;
    /** @type {ShaderLib} */
    shaderLib: ShaderLib;
    /** @type {Object|null} UniformBuffers used for the `Camera` block, when any. */
    ubo: any | null;
    /** @type {boolean} Set to false to skip rendering without touching the batch. */
    enabled: boolean;
    /** @type {boolean} Depth test the lines against the scene. */
    depthTest: boolean;
    /** @type {boolean} Debug lines normally must not pollute the depth buffer. */
    depthWrite: boolean;
    /** @type {string} Depth comparison used when `depthTest` is on. */
    depthFunc: string;
    /** @type {string} StateCache blend preset. */
    blending: string;
    /** @type {number} Line width; WebGL2 only guarantees 1. */
    lineWidth: number;
    /** @type {number} Global alpha multiplier. */
    opacity: number;
    /** @type {number} NDC depth bias, pulls the lines towards the viewer. */
    depthOffset: number;
    /** @type {boolean} True when drawing into an HDR buffer before tone mapping. */
    linearOutput: boolean;
    /** @type {boolean} `render()` empties the batch once the draw is issued. */
    autoClear: boolean;
    /** @type {boolean} Refresh the `Camera` block from the camera given to render(). */
    syncCameraUBO: boolean;
    /** @type {Color} Colour used whenever a call passes null. */
    defaultColor: Color;
    /** @type {number} Vertices the pool can currently hold. */
    capacity: number;
    /** @type {number} Growth ceiling, in vertices. */
    maxVertices: number;
    /** @type {Float32Array} Interleaved position + colour stream. */
    data: Float32Array;
    /** @type {number} Vertices queued for the next draw. */
    vertexCount: number;
    /** @type {GLBuffer} */
    buffer: GLBuffer;
    /** @type {VertexArray} */
    vao: VertexArray;
    /** @private @type {Object|null} Resolved program for the active permutation. */
    private _program;
    /** @private @type {boolean} sRGB encode flag the cached program was built with. */
    private _programSRGB;
    /** @private @type {boolean} Camera UBO flag the cached program was built with. */
    private _useCameraUBO;
    /** @private @type {boolean} True when the GPU store must be reallocated. */
    private _storeDirty;
    /** @private One-shot warning latch for the vertex ceiling. */
    private _overflowWarned;
    /** @private Reused time payload for UniformBuffers.updateCamera. */
    private _timeScratch;
    /** @private Reused bone lookup for drawSkeleton. */
    private _boneSet;
    /** @private Traversal stacks for drawBVH (grown on demand). */
    private _bvhStack;
    _bvhDepth: Int32Array;
    /** @type {boolean} */
    disposed: boolean;
    /** Per-frame statistics. */
    info: {
        vertices: number;
        lines: number;
        drawCalls: number;
        uploads: number;
        dropped: number;
        capacity: number;
    };
    /**
     * Records the interleaved attribute layout into the VAO.
     * @private
     * @returns {void}
     */
    private _recordVAO;
    /**
     * Makes room for `count` additional vertices, growing the pool if needed.
     * @private
     * @param {number} count
     * @returns {boolean} false when the ceiling was hit and the caller must bail out
     */
    private _reserve;
    /**
     * Appends one line segment using the current scratch colour.
     * @private
     * @param {number} x0 @param {number} y0 @param {number} z0
     * @param {number} x1 @param {number} y1 @param {number} z1
     * @returns {void}
     */
    private _segment;
    /**
     * Number of line segments currently queued.
     * @type {number}
     */
    get lineCount(): number;
    /**
     * CPU + GPU bytes held by the vertex pool.
     * @type {number}
     */
    get memoryBytes(): number;
    /** Empties the batch. Call once per frame (or let `autoClear` do it). */
    clear(): DebugRenderer;
    /**
     * One line segment between two points.
     * @param {{x:number,y:number,z:number}} a
     * @param {{x:number,y:number,z:number}} b
     * @param {number|Color|Array<number>|null} [color]
     * @returns {DebugRenderer} this
     */
    line(a: {
        x: number;
        y: number;
        z: number;
    }, b: {
        x: number;
        y: number;
        z: number;
    }, color?: number | Color | Array<number> | null): DebugRenderer;
    /**
     * Allocation free variant of {@link DebugRenderer#line} taking raw components.
     * @param {number} x0 @param {number} y0 @param {number} z0
     * @param {number} x1 @param {number} y1 @param {number} z1
     * @param {number|Color|Array<number>|null} [color]
     * @returns {DebugRenderer} this
     */
    lineXYZ(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color?: number | Color | Array<number> | null): DebugRenderer;
    /**
     * A polyline through a flat coordinate array.
     * @param {ArrayLike<number>} points xyz triplets.
     * @param {number|Color|Array<number>|null} [color]
     * @param {boolean} [closed=false] Also connect the last point to the first.
     * @returns {DebugRenderer} this
     */
    polyline(points: ArrayLike<number>, color?: number | Color | Array<number> | null, closed?: boolean): DebugRenderer;
    /**
     * Axis aligned wireframe box from explicit bounds (allocation free).
     * @param {number} minX @param {number} minY @param {number} minZ
     * @param {number} maxX @param {number} maxY @param {number} maxZ
     * @param {number|Color|Array<number>|null} [color]
     * @returns {DebugRenderer} this
     */
    boxMinMax(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, color?: number | Color | Array<number> | null): DebugRenderer;
    /**
     * Emits the 12 edges of an axis aligned box with the current scratch colour.
     * @private
     */
    private _boxMinMaxNoColor;
    /**
     * Axis aligned wireframe box.
     * @param {{min:{x:number,y:number,z:number}, max:{x:number,y:number,z:number}}} aabb
     * @param {number|Color|Array<number>|null} [color]
     * @returns {DebugRenderer} this
     */
    box(aabb: {
        min: {
            x: number;
            y: number;
            z: number;
        };
        max: {
            x: number;
            y: number;
            z: number;
        };
    }, color?: number | Color | Array<number> | null): DebugRenderer;
    /**
     * Oriented wireframe box: a box of `size`, centred on the origin, transformed
     * by `matrix`.
     * @param {Mat4|{elements:Float32Array}} matrix
     * @param {{x:number,y:number,z:number}|number} [size=1] Full extents.
     * @param {number|Color|Array<number>|null} [color]
     * @param {{x:number,y:number,z:number}} [center] Optional local centre offset.
     * @returns {DebugRenderer} this
     */
    obb(matrix: Mat4 | {
        elements: Float32Array;
    }, size?: {
        x: number;
        y: number;
        z: number;
    } | number, color?: number | Color | Array<number> | null, center?: {
        x: number;
        y: number;
        z: number;
    }): DebugRenderer;
    /**
     * Emits the 12 BOX_EDGES connections over `_corners` with the scratch colour.
     * @private
     */
    private _emitCornerEdges;
    /**
     * A circle described by a centre, a radius and two orthonormal tangents.
     * @private
     */
    private _circle;
    /**
     * Circle lying in the plane whose normal is `normal`.
     * @param {{x:number,y:number,z:number}} center
     * @param {number} radius
     * @param {{x:number,y:number,z:number}} [normal] Defaults to +Y.
     * @param {number|Color|Array<number>|null} [color]
     * @param {number} [segments=32]
     * @returns {DebugRenderer} this
     */
    circle(center: {
        x: number;
        y: number;
        z: number;
    }, radius: number, normal?: {
        x: number;
        y: number;
        z: number;
    }, color?: number | Color | Array<number> | null, segments?: number): DebugRenderer;
    /**
     * Wireframe sphere drawn as three great circles (XY, XZ and YZ planes).
     * @param {{x:number,y:number,z:number}} center
     * @param {number} radius
     * @param {number|Color|Array<number>|null} [color]
     * @param {number} [segments=24] Segments per great circle.
     * @returns {DebugRenderer} this
     */
    sphere(center: {
        x: number;
        y: number;
        z: number;
    }, radius: number, color?: number | Color | Array<number> | null, segments?: number): DebugRenderer;
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
    cone(apex: {
        x: number;
        y: number;
        z: number;
    }, direction: {
        x: number;
        y: number;
        z: number;
    }, length: number, angle: number, color?: number | Color | Array<number> | null, segments?: number): DebugRenderer;
    /**
     * Wireframe of a camera frustum, reconstructed by unprojecting the 8 clip
     * space corners through the camera's inverse projection and world matrix.
     * @param {Object} camera Any Camera with projectionMatrixInverse + worldMatrix.
     * @param {number|Color|Array<number>|null} [color]
     * @returns {DebugRenderer} this
     */
    frustum(camera: any, color?: number | Color | Array<number> | null): DebugRenderer;
    /**
     * Red / green / blue axis cross for a transform.
     * @param {Mat4|{elements:Float32Array}} matrix
     * @param {number} [size=1] Axis length in world units.
     * @param {number} [alpha=1]
     * @returns {DebugRenderer} this
     */
    axes(matrix: Mat4 | {
        elements: Float32Array;
    }, size?: number, alpha?: number): DebugRenderer;
    /**
     * A small three-axis cross marking a position.
     * @param {{x:number,y:number,z:number}} p
     * @param {number} [size=0.05] Half length of each arm.
     * @param {number|Color|Array<number>|null} [color]
     * @returns {DebugRenderer} this
     */
    point(p: {
        x: number;
        y: number;
        z: number;
    }, size?: number, color?: number | Color | Array<number> | null): DebugRenderer;
    /**
     * A line with a four-barb arrow head at its far end.
     * @param {{x:number,y:number,z:number}} from
     * @param {{x:number,y:number,z:number}} to
     * @param {number|Color|Array<number>|null} [color]
     * @param {number} [headSize] Head length; defaults to 15% of the shaft.
     * @returns {DebugRenderer} this
     */
    arrow(from: {
        x: number;
        y: number;
        z: number;
    }, to: {
        x: number;
        y: number;
        z: number;
    }, color?: number | Color | Array<number> | null, headSize?: number): DebugRenderer;
    /**
     * A ground grid on the XZ plane, handy as a spatial reference.
     * @param {number} [size=10] Total side length.
     * @param {number} [divisions=10]
     * @param {number|Color|Array<number>|null} [color]
     * @param {number} [y=0] Height of the plane.
     * @returns {DebugRenderer} this
     */
    grid(size?: number, divisions?: number, color?: number | Color | Array<number> | null, y?: number): DebugRenderer;
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
    drawBVH(bvh: any, maxDepth?: number, color?: number | Color | Array<number> | null): number;
    /**
     * Draws the bone hierarchy of a skinned mesh: one segment per parent/child
     * pair plus a small marker on every joint.
     * @param {Object} skinnedMesh SkinnedMesh, or a Skeleton directly.
     * @param {number|Color|Array<number>|null} [color]
     * @param {number} [jointSize=0.02] Half size of the joint markers.
     * @returns {number} how many bones were drawn
     */
    drawSkeleton(skinnedMesh: any, color?: number | Color | Array<number> | null, jointSize?: number): number;
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
    drawNormals(mesh: any, length?: number, color?: number | Color | Array<number> | null, stride?: number): number;
    /**
     * Convenience: world-space bounding volumes of a mesh.
     * @param {Object} mesh Mesh with `boundingBoxWorld` / `boundingSphereWorld`.
     * @param {number|Color|Array<number>|null} [boxColor]
     * @param {number|Color|Array<number>|null} [sphereColor] null skips the sphere.
     * @returns {DebugRenderer} this
     */
    meshBounds(mesh: any, boxColor?: number | Color | Array<number> | null, sphereColor?: number | Color | Array<number> | null): DebugRenderer;
    /**
     * Enables or disables depth testing for the whole batch.
     * @param {boolean} enabled
     * @returns {DebugRenderer} this
     */
    setDepthTest(enabled: boolean): DebugRenderer;
    /**
     * Resolves (and compiles on demand) the program for the active permutation.
     * @private
     * @returns {Object|null}
     */
    private _getProgram;
    /**
     * Refreshes the `Camera` uniform block from the camera being drawn with,
     * preserving the time values the renderer already published.
     * @private
     * @param {Object} camera
     * @returns {void}
     */
    private _syncCamera;
    /**
     * Uploads the queued vertices and draws them with a single `drawArrays`.
     * @param {Object} camera Camera to draw with.
     * @returns {number} vertices drawn (0 when nothing was queued)
     */
    render(camera: any): number;
    /**
     * Re-creates the GPU resources after a context loss / restore.
     * @returns {DebugRenderer} this
     */
    onContextRestored(): DebugRenderer;
    /** Releases the GPU buffer, the VAO and (when owned) the shader library. */
    dispose(): void;
}
import { StateCache } from "./StateCache.js";
import { ShaderLib } from "./ShaderLib.js";
import { Color } from "../math/Color.js";
import { GLBuffer } from "./Buffer.js";
import { VertexArray } from "./VertexArray.js";
import { Mat4 } from "../math/Mat4.js";
