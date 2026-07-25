/**
 * Splits an MTL `map_*` statement into its option flags and its filename.
 *
 * Filenames are allowed to contain spaces, so everything that is not consumed
 * by a known flag becomes part of the name.
 *
 * @param {Array<string>} tokens Tokens after the statement keyword.
 * @returns {{file: string, options: Object}}
 */
export function parseMTLMapStatement(tokens: Array<string>): {
    file: string;
    options: any;
};
/**
 * Parses an MTL document into raw material descriptions.
 * @param {string} text
 * @returns {Map<string, Object>} Material name -> raw property bag.
 */
export function parseMTL(text: string): Map<string, any>;
export class OBJLoader {
    /**
     * @param {WebGL2RenderingContext} [gl] Needed to create MTL textures.
     * @param {Object} [options]
     * @param {string} [options.basePath='']
     * @param {boolean} [options.loadMaterials=true] Follow `mtllib` statements.
     * @param {boolean} [options.loadTextures=true] Create GPU textures for map_*.
     * @param {boolean} [options.generateNormals=true] Build normals when `vn` is absent.
     * @param {boolean} [options.generateTangents=true] Build tangents when a bump map is used.
     * @param {string} [options.colorSpace='srgb'] How to read MTL colours and vertex colours.
     * @param {number} [options.anisotropy=1]
     * @param {string} [options.credentials='same-origin']
     * @param {Object} [options.state] StateCache used while creating textures.
     */
    constructor(gl?: WebGL2RenderingContext, options?: {
        basePath?: string;
        loadMaterials?: boolean;
        loadTextures?: boolean;
        generateNormals?: boolean;
        generateTangents?: boolean;
        colorSpace?: string;
        anisotropy?: number;
        credentials?: string;
        state?: any;
    });
    /** @type {WebGL2RenderingContext|null} */
    gl: WebGL2RenderingContext | null;
    /** @type {Object} */
    options: any;
    /** @type {string} */
    basePath: string;
    /** @type {Object|null} */
    manager: any | null;
    /**
     * @param {string} basePath
     * @returns {OBJLoader} this
     */
    setBasePath(basePath: string): OBJLoader;
    /**
     * Downloads and parses an .obj file (and the .mtl files it references).
     * @param {string} url
     * @returns {Promise<Object>} See {@link OBJLoader#parse}.
     */
    load(url: string): Promise<any>;
    /**
     * Parses OBJ source text.
     *
     * @param {string} text
     * @param {string} [basePath] Used to resolve `mtllib` and texture paths.
     * @param {string} [sourceURL] Only used to make error messages readable.
     * @returns {Promise<Object>} `{ scene, meshes, geometries, materials, objects,
     *   materialLibraries, textures, dispose() }`
     */
    parse(text: string, basePath?: string, sourceURL?: string): Promise<any>;
    /**
     * Pure, synchronous OBJ text parse. Touches no network and no GPU.
     *
     * @param {string} text
     * @param {string} [label] Name used in warnings.
     * @returns {{objects: Array<ObjectBuilder>, materialLibraries: Array<string>}}
     */
    parseSync(text: string, label?: string): {
        objects: Array<ObjectBuilder>;
        materialLibraries: Array<string>;
    };
    /**
     * Resolves an OBJ face token (`v`, `v/vt`, `v//vn`, `v/vt/vn`) and appends the
     * vertex to the builder, reusing it when the exact triple was already emitted.
     *
     * @param {ObjectBuilder} builder
     * @param {string} token
     * @param {NumberList} positions
     * @param {NumberList} uvs
     * @param {NumberList} normals
     * @param {NumberList} colors
     * @param {boolean} wantColors
     * @param {string} label
     * @returns {number} Emitted vertex index, or -1 when the token is unusable.
     * @private
     */
    private _emitVertex;
    /**
     * Turns one builder into a Mesh.
     * @param {ObjectBuilder} builder
     * @param {Map<string, Object>} materialMap
     * @param {Array<Object>} materialsOut Materials actually used, appended in order.
     * @param {string} label
     * @returns {{mesh: Mesh, geometry: Geometry}|null}
     * @private
     */
    private _buildMesh;
    /**
     * @param {Array<Object>} materials
     * @returns {boolean} True when at least one material samples a normal map.
     * @private
     */
    private _needsTangents;
    /**
     * Looks a material up by name, creating the fallback when it is missing.
     * @param {string|null} name
     * @param {Map<string, Object>} materialMap
     * @param {Array<Object>} materialsOut
     * @returns {Object}
     * @private
     */
    private _resolveMaterial;
    /**
     * Downloads and converts every referenced material library.
     * @param {Array<string>} libraries
     * @param {string} basePath
     * @param {string} label
     * @param {Array<Object>} texturesOut
     * @returns {Promise<Map<string, Object>>}
     * @private
     */
    private _loadMaterialLibraries;
    /**
     * Converts one MTL description into a {@link StandardMaterial}.
     * @param {string} name
     * @param {Object} def
     * @param {string} basePath
     * @param {Array<Object>} texturesOut
     * @returns {Promise<Object>}
     * @private
     */
    private _createMaterial;
    /**
     * Loads one MTL texture map.
     * @param {{file: string, options: Object}} statement
     * @param {string} basePath
     * @param {boolean} srgb
     * @param {string} materialName
     * @returns {Promise<Object|null>}
     * @private
     */
    private _loadMap;
}
/**
 * Accumulates the vertices of one OBJ object (or of one contiguous run of a
 * single primitive kind inside it).
 */
declare class ObjectBuilder {
    /**
     * @param {string} name
     * @param {string} mode `'triangles'` | `'lines'` | `'points'`
     */
    constructor(name: string, mode: string);
    /** @type {string} */
    name: string;
    /** @type {string} */
    mode: string;
    positions: NumberList;
    normals: NumberList;
    uvs: NumberList;
    colors: NumberList;
    indices: NumberList;
    /** @type {Array<{materialName: string|null, start: number, count: number}>} */
    groups: {
        materialName: string | null;
        start: number;
        count: number;
    }[];
    /** @type {Object|null} */
    currentGroup: any | null;
    /** @type {Map<number, Array<number>>} v index -> [combinedKey, emitted, ...] */
    vertexMap: Map<number, Array<number>>;
    /** @type {boolean} */
    hasNormals: boolean;
    /** @type {boolean} */
    hasUVs: boolean;
    /** @type {boolean} */
    hasColors: boolean;
    /** @type {number} */
    vertexCount: number;
    /**
     * Opens a new material group (closing the previous one).
     * @param {string|null} materialName
     */
    startGroup(materialName: string | null): void;
    /**
     * Appends one index, growing the active group.
     * @param {number} index
     */
    pushIndex(index: number): void;
}
/**
 * Append-only typed array that doubles its capacity. Avoids the memory blow-up
 * of building a multi-million entry plain `Array` while parsing.
 */
declare class NumberList {
    /**
     * @param {Function} Ctor Typed array constructor.
     * @param {number} [capacity=1024]
     */
    constructor(Ctor: Function, capacity?: number);
    /** @type {ArrayBufferView} */
    data: ArrayBufferView;
    /** @type {number} */
    length: number;
    /** @private */
    private _Ctor;
    /**
     * Makes sure `extra` more elements fit.
     * @param {number} extra
     * @private
     */
    private _reserve;
    /** @param {number} a */
    push1(a: number): void;
    /** @param {number} a @param {number} b */
    push2(a: number, b: number): void;
    /** @param {number} a @param {number} b @param {number} c */
    push3(a: number, b: number, c: number): void;
    /** @param {number} a @param {number} b @param {number} c @param {number} d */
    push4(a: number, b: number, c: number, d: number): void;
    /** @returns {ArrayBufferView} A right-sized copy. */
    toTypedArray(): ArrayBufferView;
}
export {};
