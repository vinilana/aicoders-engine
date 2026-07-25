/**
 * Byte size of a GL component type.
 * @param {number} type
 * @returns {number}
 */
export function glTypeBytes(type: number): number;
/**
 * Infers the GL component type from a typed array constructor.
 * @param {ArrayBufferView} array
 * @returns {number}
 */
export function glTypeFromArray(array: ArrayBufferView): number;
/**
 * Resolves a draw mode name (or enum) to a GL primitive enum.
 * @param {string|number} mode
 * @returns {number}
 */
export function drawModeToGL(mode: string | number): number;
export namespace ATTRIB {
    const POSITION: number;
    const NORMAL: number;
    const UV0: number;
    const TANGENT: number;
    const COLOR: number;
    const UV1: number;
    const JOINTS: number;
    const WEIGHTS: number;
    const INSTANCE_MATRIX: number;
    const INSTANCE_COLOR: number;
    const INSTANCE_DATA: number;
}
export namespace ATTRIB_NAME_TO_LOC {
    const aPosition: number;
    const aNormal: number;
    const aUV0: number;
    const aTangent: number;
    const aColor: number;
    const aUV1: number;
    const aJoints: number;
    const aWeights: number;
    const aInstanceMatrix: number;
    const aInstanceColor: number;
    const aInstanceData: number;
}
export namespace GL_TYPE {
    const BYTE: number;
    const UNSIGNED_BYTE: number;
    const SHORT: number;
    const UNSIGNED_SHORT: number;
    const INT: number;
    const UNSIGNED_INT: number;
    const FLOAT: number;
    const HALF_FLOAT: number;
}
/** Draw mode name -> GL primitive enum. */
export const DRAW_MODES: {
    points: number;
    lines: number;
    'line-loop': number;
    'line-strip': number;
    triangles: number;
    'triangle-strip': number;
    'triangle-fan': number;
};
/**
 * One vertex attribute: its CPU data, layout and GPU buffer.
 * Kept as a class so every instance shares a single hidden class (V8 perf).
 */
export class GeometryAttribute {
    /**
     * @param {ArrayBufferView} data
     * @param {number} size Components per vertex (1..4).
     * @param {Object} [opts]
     */
    constructor(data: ArrayBufferView, size: number, opts?: any);
    /** @type {ArrayBufferView} */
    data: ArrayBufferView;
    /** @type {number} */
    size: number;
    /** @type {number} GL component type. */
    type: number;
    /** @type {boolean} */
    normalized: boolean;
    /** @type {number} Byte stride, 0 = tightly packed. */
    stride: number;
    /** @type {number} Byte offset inside the buffer. */
    offset: number;
    /** @type {number} Instancing divisor. */
    divisor: number;
    /** @type {boolean} Feed the shader as an integer attribute. */
    integer: boolean;
    /** @type {string} Buffer usage hint. */
    usage: string;
    /** @type {import('./Buffer.js').GLBuffer|null} */
    buffer: import('./Buffer.js').GLBuffer | null;
    /** @type {number} Index into Geometry._interleavedGroups, -1 when standalone. */
    group: number;
    /** @type {number} Explicit shader location override (-1 = derive from name). */
    location: number;
    /** @type {boolean} */
    needsUpdate: boolean;
    /** @type {number} */
    version: number;
    /** @type {number} Vertex count described by this attribute. */
    count: number;
    /** @type {number} Dirty range start, in ELEMENTS of `data`. */
    _dirtyStart: number;
    /** @type {number} Dirty range end (exclusive), in ELEMENTS of `data`. */
    _dirtyEnd: number;
    /** @type {number} */
    _bpe: number;
    /** @type {number} Stride expressed in typed-array elements. */
    get elementStride(): number;
    /** @type {number} Offset expressed in typed-array elements. */
    get elementOffset(): number;
    /** @type {number} CPU byte size of the attribute data. */
    get byteLength(): number;
    /**
     * Flags a vertex range for re-upload.
     * @param {number} [startVertex=0]
     * @param {number} [vertexCount=Infinity]
     */
    markDirty(startVertex?: number, vertexCount?: number): void;
    /** Flags the whole attribute for re-upload. */
    markAllDirty(): void;
    /**
     * Reads one component.
     * @param {number} vertex
     * @param {number} component
     * @returns {number}
     */
    getComponent(vertex: number, component: number): number;
    /**
     * Writes one component (does not mark dirty).
     * @param {number} vertex
     * @param {number} component
     * @param {number} value
     */
    setComponent(vertex: number, component: number, value: number): void;
    /**
     * Deep copy of the attribute (fresh CPU data, no GPU buffer).
     * @returns {GeometryAttribute}
     */
    clone(): GeometryAttribute;
}
/**
 * A drawable chunk of vertex data.
 */
export class Geometry {
    /** @type {number} */
    id: number;
    /** @type {string} */
    name: string;
    /** @type {Map<string, GeometryAttribute>} */
    attributes: Map<string, GeometryAttribute>;
    /**
     * Index buffer descriptor or null.
     * @type {{data: ArrayBufferView, type: number, buffer: GLBuffer|null, count: number,
     *         needsUpdate: boolean, usage: string, _dirtyStart: number, _dirtyEnd: number}|null}
     */
    index: {
        data: ArrayBufferView;
        type: number;
        buffer: GLBuffer | null;
        count: number;
        needsUpdate: boolean;
        usage: string;
        _dirtyStart: number;
        _dirtyEnd: number;
    };
    /** @type {string} 'triangles' | 'lines' | 'points' | 'line-strip' | ... */
    drawMode: string;
    /** @type {number} -1 = not instanced. */
    instanceCount: number;
    /** @type {{start: number, count: number}} */
    drawRange: {
        start: number;
        count: number;
    };
    /** @type {Array<{start: number, count: number, materialIndex: number}>} */
    groups: {
        start: number;
        count: number;
        materialIndex: number;
    }[];
    /** @type {AABB|null} */
    boundingBox: AABB | null;
    /** @type {Sphere|null} */
    boundingSphere: Sphere | null;
    /** @type {Object} Free-form user payload. */
    userData: any;
    /**
     * Interleaved buffer groups shared by several attributes.
     * @type {Array<{data: ArrayBufferView, buffer: GLBuffer|null, usage: string,
     *               needsUpdate: boolean, dirtyStart: number, dirtyEnd: number, stride: number}>}
     * @private
     */
    private _interleavedGroups;
    /** @type {VertexArray|null} @private */
    private _vao;
    /** @type {number} Geometry version the cached VAO was built from. @private */
    private _vaoVersion;
    /** @type {Map<number, {vao: VertexArray, version: number, geoVersion: number}>|null} @private */
    private _instancedVAOs;
    /** @type {WebGL2RenderingContext|null} @private */
    private _gl;
    /** @type {number} @private */
    private _version;
    /**
     * Adds or replaces an attribute.
     * @param {string} name Canonical name ('aPosition', 'aNormal', ...).
     * @param {ArrayBufferView|Array<number>|GeometryAttribute} data
     * @param {number} [size=3] Components per vertex.
     * @param {Object} [opts] type / normalized / stride / offset / divisor / integer / usage / location
     * @returns {Geometry} this
     */
    setAttribute(name: string, data: ArrayBufferView | Array<number> | GeometryAttribute, size?: number, opts?: any): Geometry;
    /**
     * @param {string} name
     * @returns {GeometryAttribute|null}
     */
    getAttribute(name: string): GeometryAttribute | null;
    /**
     * @param {string} name
     * @returns {boolean}
     */
    hasAttribute(name: string): boolean;
    /**
     * Removes an attribute and releases its GPU buffer (unless interleaved).
     * @param {string} name
     * @returns {Geometry} this
     */
    deleteAttribute(name: string): Geometry;
    /**
     * Releases the private buffer of an attribute (interleaved groups are owned
     * by the geometry and released in `dispose`).
     * @param {GeometryAttribute} attr
     * @private
     */
    private _disposeAttribute;
    /**
     * Declares several attributes sharing one interleaved buffer.
     *
     * @param {ArrayBufferView|GLBuffer} buffer Interleaved data (or a ready GPU buffer).
     * @param {Object|Array} layout Either an array of attribute descriptors or
     *   `{ stride, count, usage, attributes: [...] }`. Each descriptor is
     *   `{ name, size, offset, type?, normalized?, divisor?, integer? }` with
     *   `offset` and `stride` expressed in BYTES.
     * @returns {Geometry} this
     */
    setInterleaved(buffer: ArrayBufferView | GLBuffer, layout: any | any[]): Geometry;
    /**
     * Sets (or clears) the index buffer. Plain arrays are converted to
     * Uint16Array or Uint32Array automatically according to the vertex count.
     * @param {ArrayBufferView|Array<number>|null} array
     * @returns {Geometry} this
     */
    setIndex(array: ArrayBufferView | Array<number> | null): Geometry;
    /**
     * Marks part (or all) of an attribute for re-upload.
     * @param {string} name
     * @param {number} [startVertex=0]
     * @param {number} [vertexCount=Infinity]
     * @returns {Geometry} this
     */
    markAttributeDirty(name: string, startVertex?: number, vertexCount?: number): Geometry;
    /**
     * Marks the index buffer for re-upload.
     * @param {number} [start=0] First index element.
     * @param {number} [count=Infinity]
     * @returns {Geometry} this
     */
    markIndexDirty(start?: number, count?: number): Geometry;
    /**
     * Adds a multi-material group.
     * @param {number} start First index/vertex.
     * @param {number} count Element count.
     * @param {number} [materialIndex=0]
     * @returns {Geometry} this
     */
    addGroup(start: number, count: number, materialIndex?: number): Geometry;
    /** Removes every group. @returns {Geometry} this */
    clearGroups(): Geometry;
    /**
     * Restricts drawing to a sub range.
     * @param {number} start
     * @param {number} count
     * @returns {Geometry} this
     */
    setDrawRange(start: number, count: number): Geometry;
    /** @type {number} Vertices described by aPosition (0 when absent). */
    get vertexCount(): number;
    /** @type {number} Total drawable elements (indices when indexed). */
    get elementCount(): number;
    /** @type {number} Triangle count of the current draw range. */
    get triangleCount(): number;
    /** @type {number} GL enum of the index type, 0 when non indexed. */
    get indexType(): number;
    /** @type {number} Byte size of one index. */
    get indexBytesPerElement(): number;
    /**
     * First element to draw, honouring `drawRange`.
     * @returns {number}
     */
    getDrawStart(): number;
    /**
     * Element count to draw, honouring `drawRange` and the available data.
     * @returns {number}
     */
    getDrawCount(): number;
    /**
     * Computes the axis aligned bounding box from aPosition.
     * @returns {Geometry} this
     */
    computeBoundingBox(): Geometry;
    /**
     * Computes a tight bounding sphere: Ritter's approximation followed by an
     * exact containment refinement pass (keeps Ritter's better center, then grows
     * the radius to the farthest vertex).
     * @returns {Geometry} this
     */
    computeBoundingSphere(): Geometry;
    /**
     * Recomputes smooth vertex normals. Face contributions are weighted by the
     * un-normalized cross product, i.e. by triangle area, which gives much better
     * results on irregular meshes than plain averaging.
     * @returns {Geometry} this
     */
    computeNormals(): Geometry;
    /**
     * Computes per-vertex tangents (MikkTSpace style: per-triangle UV gradients
     * accumulated per vertex, Gram-Schmidt orthonormalization against the normal,
     * handedness stored in `w`). Requires aPosition, aNormal and aUV0; when UVs
     * are missing a deterministic orthogonal basis is generated instead.
     * @returns {Geometry} this
     */
    computeTangents(): Geometry;
    /**
     * Uploads whatever changed since the last call.
     * @param {WebGL2RenderingContext} gl
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {Geometry} this
     */
    upload(gl: WebGL2RenderingContext, state?: import('./StateCache.js').StateCache): Geometry;
    /**
     * Full or partial buffer upload depending on how much of it is dirty.
     * @private
     */
    private _uploadRange;
    /**
     * Returns the cached VAO, creating (or rebuilding) it when needed.
     * @param {WebGL2RenderingContext} gl
     * @param {import('./StateCache.js').StateCache} [state]
     * @returns {VertexArray}
     */
    getVAO(gl: WebGL2RenderingContext, state?: import('./StateCache.js').StateCache): VertexArray;
    /**
     * Records every geometry attribute into a VAO.
     * @param {VertexArray} vao
     * @private
     */
    private _bindAttributesTo;
    /**
     * Returns a VAO that combines this geometry with per-instance attributes.
     * Used by InstancedMesh, which owns the instance buffers: the geometry itself
     * stays shareable between meshes.
     *
     * @param {WebGL2RenderingContext} gl
     * @param {import('./StateCache.js').StateCache} state
     * @param {number} key Unique owner id (e.g. the InstancedMesh id).
     * @param {Array<{location: number, buffer: GLBuffer, size: number, type?: number,
     *                normalized?: boolean, stride?: number, offset?: number,
     *                divisor?: number, matrix?: boolean, integer?: boolean}>} instanceAttributes
     * @param {number} [version=0] Bump to force a rebuild (e.g. after `grow()`).
     * @returns {VertexArray}
     */
    getVAOWithInstanceAttributes(gl: WebGL2RenderingContext, state: import('./StateCache.js').StateCache, key: number, instanceAttributes: Array<{
        location: number;
        buffer: GLBuffer;
        size: number;
        type?: number;
        normalized?: boolean;
        stride?: number;
        offset?: number;
        divisor?: number;
        matrix?: boolean;
        integer?: boolean;
    }>, version?: number): VertexArray;
    /**
     * Releases an instanced VAO variant (call from InstancedMesh.dispose).
     * @param {number} key
     * @param {import('./StateCache.js').StateCache} [state]
     */
    releaseInstanceVAO(key: number, state?: import('./StateCache.js').StateCache): void;
    /** @type {number} Total CPU/GPU bytes held by this geometry. */
    get memoryBytes(): number;
    /**
     * Deep copy: fresh CPU arrays, no GPU resources (they are recreated lazily).
     * @returns {Geometry}
     */
    clone(): Geometry;
    /**
     * Releases every GPU resource owned by this geometry. The CPU arrays stay
     * usable, so a disposed geometry can be uploaded again.
     * @param {WebGL2RenderingContext} [gl]
     * @param {import('./StateCache.js').StateCache} [state]
     */
    dispose(gl?: WebGL2RenderingContext, state?: import('./StateCache.js').StateCache): void;
}
import { GLBuffer } from "./Buffer.js";
import { AABB } from "../math/AABB.js";
import { Sphere } from "../math/Sphere.js";
import { VertexArray } from "./VertexArray.js";
