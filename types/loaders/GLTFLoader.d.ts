export class GLTFLoader {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} [options]
     * @param {string} [options.basePath=''] Prefix for relative URLs.
     * @param {Object} [options.manager] AssetManager used for the network layer.
     * @param {boolean} [options.generateNormals=true] Build normals when NORMAL is absent.
     * @param {boolean} [options.generateTangents=true] Build tangents when a normal map needs them.
     * @param {boolean} [options.flatShadeMissingNormals=false] Split vertices before
     *   generating missing normals, which is what the spec asks for (costs memory).
     * @param {boolean} [options.interleave=true] Keep exporter interleaved buffers interleaved.
     * @param {boolean} [options.loadTextures=true] Set to false for a geometry only load.
     * @param {number} [options.anisotropy=1] Anisotropy applied to every texture.
     * @param {boolean} [options.keepImages=false] Do not close the decoded bitmaps.
     * @param {number} [options.defaultFar=2000000] Far plane for cameras without `zfar`.
     * @param {string} [options.credentials='same-origin']
     * @param {Object} [options.state] StateCache used while creating textures.
     */
    constructor(gl: WebGL2RenderingContext, options?: {
        basePath?: string;
        manager?: any;
        generateNormals?: boolean;
        generateTangents?: boolean;
        flatShadeMissingNormals?: boolean;
        interleave?: boolean;
        loadTextures?: boolean;
        anisotropy?: number;
        keepImages?: boolean;
        defaultFar?: number;
        credentials?: string;
        state?: any;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object} */
    options: any;
    /** @type {string} */
    basePath: string;
    /** @type {Object|null} */
    manager: any | null;
    /**
     * Sets the prefix used to resolve relative URLs.
     * @param {string} basePath
     * @returns {GLTFLoader} this
     */
    setBasePath(basePath: string): GLTFLoader;
    /**
     * Downloads and parses a .gltf or .glb file.
     * @param {string} url
     * @returns {Promise<Object>} See {@link GLTFLoader#parse}.
     */
    load(url: string): Promise<any>;
    /**
     * Parses an already downloaded glTF asset.
     *
     * @param {ArrayBuffer|ArrayBufferView|string|Object} data `.glb` bytes, `.gltf`
     *   bytes, the JSON text, or the already parsed JSON object.
     * @param {string} [basePath=''] Used to resolve relative buffer/image URIs.
     * @param {string} [sourceURL=''] Only used to make error messages readable.
     * @returns {Promise<Object>} `{ scene, scenes, animations, cameras, materials,
     *   meshes, nodes, skeletons, textures, lights, asset, json, dispose() }`
     */
    parse(data: ArrayBuffer | ArrayBufferView | string | any, basePath?: string, sourceURL?: string): Promise<any>;
    /**
     * @param {string} text
     * @param {string} label
     * @returns {Object}
     * @private
     */
    private _parseJSONText;
    /**
     * Splits a binary .glb container into its JSON and BIN chunks.
     * @param {Uint8Array} bytes
     * @param {string} label
     * @returns {{json: Object, bin: Uint8Array|null}}
     * @private
     */
    private _parseGLB;
}
/**
 * Stateful worker that turns one glTF document into engine objects. Exported so
 * an application can subclass it or reuse a single piece (for a custom pipeline);
 * `GLTFLoader` is the supported entry point.
 */
export class GLTFParser {
    /**
     * @param {WebGL2RenderingContext} gl
     * @param {Object} json Parsed glTF JSON.
     * @param {Object} [context]
     * @param {string} [context.basePath]
     * @param {string} [context.sourceURL]
     * @param {Uint8Array|null} [context.binChunk]
     * @param {Object} [context.options]
     */
    constructor(gl: WebGL2RenderingContext, json: any, context?: {
        basePath?: string;
        sourceURL?: string;
        binChunk?: Uint8Array | null;
        options?: any;
    });
    /** @type {WebGL2RenderingContext} */
    gl: WebGL2RenderingContext;
    /** @type {Object} */
    json: any;
    /** @type {string} */
    basePath: string;
    /** @type {string} */
    sourceURL: string;
    /** @type {Uint8Array|null} */
    binChunk: Uint8Array | null;
    /** @type {Object} */
    options: any;
    /** @type {Object|null} */
    manager: any | null;
    /** @type {Array<Uint8Array>} */
    buffers: Array<Uint8Array>;
    /** @type {Map<number, Uint8Array>} */
    bufferViewCache: Map<number, Uint8Array>;
    /** @type {Map<number, Object>} */
    accessorCache: Map<number, any>;
    /** @type {Map<number, Promise<Object>>} */
    imagePromises: Map<number, Promise<any>>;
    /** @type {Array<Object>} */
    imageSources: Array<any>;
    /** @type {Map<string, Object>} */
    textures: Map<string, any>;
    /** @type {Array<Object>} */
    materials: Array<any>;
    /** @type {Map<Object, Geometry>} */
    geometryCache: Map<any, Geometry>;
    /** @type {Map<number, Array<Object>>} */
    meshCache: Map<number, Array<any>>;
    /** @type {Array<Node3D>} */
    nodes: Array<Node3D>;
    /** @type {Array<string>} */
    nodeNames: Array<string>;
    /** @type {Array<Skeleton>} */
    skeletons: Array<Skeleton>;
    /** @type {Array<Object>} */
    cameras: Array<any>;
    /** @type {Array<Object>} */
    lights: Array<any>;
    /** @type {Array<AnimationClip>} */
    animations: Array<AnimationClip>;
    /** @type {Array<Node3D>} */
    scenes: Array<Node3D>;
    /** @type {Array<Geometry>} */
    geometries: Array<Geometry>;
    /** @type {Array<{mesh: SkinnedMesh, skin: number}>} */
    pendingSkins: {
        mesh: SkinnedMesh;
        skin: number;
    }[];
    /** @type {Object|null} */
    defaultMaterial: any | null;
    /** @type {boolean} */
    uvTransformWarned: boolean;
    /**
     * Runs the whole pipeline.
     * @returns {Promise<Object>}
     */
    parse(): Promise<any>;
    /**
     * Releases every GPU resource created by this parse.
     * @returns {GLTFParser} this
     */
    dispose(): GLTFParser;
    /**
     * Rejects documents this loader cannot honour and reports the ones it can only
     * partially honour.
     * @private
     */
    private _validate;
    /**
     * Resolves every `buffers[]` entry into bytes.
     * @returns {Promise<void>}
     * @private
     */
    private _loadBuffers;
    /**
     * Returns the bytes of a bufferView as a view (no copy).
     * @param {number} index
     * @returns {Uint8Array}
     * @private
     */
    private _bufferViewBytes;
    /**
     * Reads an accessor into a tightly packed typed array, applying the sparse
     * substitution when present.
     *
     * @param {number} index
     * @returns {{array: ArrayBufferView, count: number, numComponents: number,
     *            componentType: number, normalized: boolean, type: string}}
     */
    readAccessor(index: number): {
        array: ArrayBufferView;
        count: number;
        numComponents: number;
        componentType: number;
        normalized: boolean;
        type: string;
    };
    /**
     * Reads the accessor payload, honouring `byteStride` and the 4 byte column
     * padding of small-component matrix types.
     *
     * When the data is contiguous, aligned and does not need to be patched by a
     * sparse block, a VIEW over the glTF buffer is returned instead of a copy -
     * which is what makes loading a 20 MB .glb cheap.
     *
     * @param {Object} def Accessor definition.
     * @param {number} count
     * @param {number} numComponents
     * @param {number} index Accessor index, for error messages.
     * @param {boolean} forceCopy Set when the caller is going to mutate the result.
     * @returns {ArrayBufferView}
     * @private
     */
    private _readAccessorArray;
    /**
     * Applies the `sparse` substitution of an accessor.
     * @param {ArrayBufferView} target
     * @param {Object} def
     * @param {number} numComponents
     * @param {number} index
     * @private
     */
    private _applySparse;
    /**
     * Reads a tightly packed block out of a bufferView (used by sparse accessors,
     * whose bufferViews are forbidden to declare a byteStride).
     *
     * @param {number} bufferViewIndex
     * @param {number} byteOffset
     * @param {number} componentType
     * @param {number} numComponents
     * @param {number} count
     * @param {number} accessorIndex For error messages.
     * @returns {ArrayBufferView}
     * @private
     */
    private _readPacked;
    /**
     * Reads an accessor as denormalized Float32 data (animation samplers).
     * @param {number} index
     * @returns {Float32Array}
     */
    readAccessorAsFloat(index: number): Float32Array;
    /**
     * Decodes an image, once per glTF image index.
     * @param {number} index
     * @returns {Promise<Object>} `{ image, isBitmap, flipped }`
     * @private
     */
    private _loadImage;
    /** Closes every decoded bitmap once the textures have been uploaded. @private */
    _releaseImages(): void;
    /**
     * Creates (and caches) a GPU texture for a glTF texture index.
     *
     * The colour space is part of the cache key: the very same image can legally
     * feed a base colour slot (sRGB) and an occlusion slot (linear), and those need
     * two different GPU objects.
     *
     * @param {number} index
     * @param {boolean} srgb
     * @returns {Promise<Object|null>}
     * @private
     */
    private _loadTexture;
    /**
     * Builds every material declared in the document (textures included).
     * @returns {Promise<void>}
     * @private
     */
    private _buildMaterials;
    /**
     * The glTF default material: white dielectric-to-metal, fully rough.
     * @returns {Object}
     * @private
     */
    private _getDefaultMaterial;
    /**
     * Translates one glTF material into an engine material.
     * @param {Object} def
     * @param {number} index
     * @returns {Promise<Object>}
     * @private
     */
    private _createMaterial;
    /**
     * Loads a texture referenced by a `textureInfo` and assigns it to a material
     * slot, remembering which UV set it wants.
     *
     * @param {Object} material
     * @param {string} slot Material property name.
     * @param {Object} info glTF textureInfo.
     * @param {boolean} srgb
     * @param {string} uv1Flag Material property that selects TEXCOORD_1.
     * @returns {Promise<void>}
     * @private
     */
    private _assignTexture;
    /**
     * Applies a KHR_texture_transform block to the material UV transform.
     * @param {Object} material
     * @param {Object|null} info
     * @param {string} materialName
     * @private
     */
    private _applyTextureTransform;
    /**
     * Builds (and caches) the geometry of one primitive.
     * @param {Object} primitive
     * @param {number} meshIndex For error messages.
     * @returns {Geometry}
     * @private
     */
    private _buildGeometry;
    /**
     * Detects the float attributes that share a strided bufferView and uploads
     * them as a single interleaved GPU buffer.
     *
     * @param {Geometry} geometry
     * @param {Array<Object>} entries
     * @param {number} vertexCount
     * @param {Set<Object>} consumed Entries handled here are added to this set.
     * @private
     */
    private _buildInterleavedGroups;
    /**
     * Uploads one interleaved slice.
     * @param {Geometry} geometry
     * @param {number} bvIndex
     * @param {Array<Object>} list
     * @param {number} vertexCount
     * @returns {boolean} True when the group was installed.
     * @private
     */
    private _addInterleavedGroup;
    /**
     * Reads one attribute into its own tightly packed buffer.
     * @param {Geometry} geometry
     * @param {Object} entry
     * @param {number} vertexCount
     * @private
     */
    private _setStandaloneAttribute;
    /**
     * Uses the POSITION accessor min/max as the bounding box when the exporter
     * provided it (it is mandatory for POSITION), falling back to a full scan.
     * @param {Geometry} geometry
     * @param {Object|undefined} positionAccessor
     * @private
     */
    private _applyBounds;
    /**
     * Generates normals and tangents when the file omits them.
     * @param {Geometry} geometry
     * @param {Object} primitive
     * @private
     */
    private _generateMissingAttributes;
    /**
     * Resolves a glTF mesh into `{geometry, material}` pairs.
     * @param {number} index
     * @returns {Array<{geometry: Geometry, material: Object, name: string}>}
     * @private
     */
    private _getMeshParts;
    /**
     * Instantiates every node and wires the hierarchy.
     * @private
     */
    private _buildNodes;
    /**
     * Gives every node a unique, non empty name. The animation mixer binds tracks
     * by name, so duplicates would make two nodes fight over the same channel.
     * @param {Array<Object>} defs
     * @private
     */
    private _assignNodeNames;
    /**
     * Creates one node with the right concrete class.
     * @param {Object} def
     * @param {number} index
     * @returns {Node3D}
     * @private
     */
    private _createNode;
    /**
     * Builds the renderable subtree of a node that carries a mesh.
     * @param {Object} def
     * @param {number} index
     * @param {string} name
     * @returns {Node3D}
     * @private
     */
    private _createMeshNode;
    /**
     * @param {{geometry: Geometry, material: Object}} part
     * @param {boolean} skinned
     * @param {string} name
     * @returns {Mesh}
     * @private
     */
    private _createRenderable;
    /**
     * Copies the glTF transform (matrix OR TRS) onto a node.
     * @param {Node3D} node
     * @param {Object} def
     * @private
     */
    private _applyTransform;
    /**
     * @param {number} index
     * @param {string} name
     * @returns {Object} PerspectiveCamera or OrthographicCamera
     * @private
     */
    private _createCamera;
    /**
     * Instantiates a KHR_lights_punctual light.
     * @param {number} index
     * @param {string} name
     * @returns {Object}
     * @private
     */
    private _createLight;
    /**
     * Builds the skeletons and binds them to the skinned meshes created earlier.
     * @private
     */
    private _buildSkins;
    /**
     * Builds one root node per glTF scene.
     * @private
     */
    private _buildScenes;
    /**
     * Flattens the renderable meshes of every scene.
     * @returns {Array<Mesh>}
     * @private
     */
    private _collectMeshes;
    /**
     * Converts every glTF animation into an {@link AnimationClip}.
     * @private
     */
    private _buildAnimations;
    /**
     * Builds one {@link KeyframeTrack} from an animation channel.
     * @param {Object} channel
     * @param {Array<Object>} samplers
     * @param {number} animationIndex
     * @returns {KeyframeTrack|null}
     * @private
     */
    private _buildTrack;
}
import { Geometry } from "../render/Geometry.js";
import { Node3D } from "../scene/Node3D.js";
import { Skeleton } from "../scene/Skeleton.js";
import { AnimationClip } from "../animation/AnimationClip.js";
import { SkinnedMesh } from "../scene/SkinnedMesh.js";
