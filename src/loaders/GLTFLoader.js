/**
 * glTF 2.0 loader (.gltf + .bin and .glb).
 *
 * Feature coverage:
 *  - buffers / bufferViews / accessors, every component type, `normalized`
 *    accessors and sparse accessors;
 *  - interleaved vertex buffers: when a bufferView declares a `byteStride` the
 *    attributes that share it are handed to the GPU as ONE buffer, exactly as the
 *    exporter laid them out, instead of being split into N tightly packed copies;
 *  - all primitive modes, indexed and non indexed;
 *  - the full metallic-roughness material model, texture samplers and wrap modes;
 *  - node hierarchies expressed as TRS or as a matrix;
 *  - skins (inverse bind matrices + joints) mapped to Skeleton + SkinnedMesh;
 *  - animations with STEP / LINEAR / CUBICSPLINE sampling;
 *  - perspective and orthographic cameras;
 *  - data: URIs everywhere a URI is legal;
 *  - extensions KHR_materials_emissive_strength, KHR_texture_transform,
 *    KHR_materials_unlit, KHR_lights_punctual, KHR_materials_ior.
 *
 * Coordinate system: glTF is right handed, +Y up, -Z forward, and so is this
 * engine, so no conversion of any kind is applied - positions, normals, tangents,
 * quaternions and matrices are copied verbatim. The only convention that differs
 * from raw OpenGL is the texture origin: glTF puts UV (0,0) at the TOP-LEFT
 * texel, which is exactly what an unflipped image upload produces, so images are
 * decoded with `flipY: false`.
 */

import { Node3D } from '../scene/Node3D.js';
import { Mesh } from '../scene/Mesh.js';
import { SkinnedMesh } from '../scene/SkinnedMesh.js';
import { Skeleton } from '../scene/Skeleton.js';
import { PerspectiveCamera } from '../scene/PerspectiveCamera.js';
import { OrthographicCamera } from '../scene/OrthographicCamera.js';
import { DirectionalLight, PointLight, SpotLight } from '../scene/Light.js';

import { Geometry, GL_TYPE } from '../render/Geometry.js';
import { StandardMaterial } from '../render/materials/StandardMaterial.js';
import { UnlitMaterial } from '../render/materials/UnlitMaterial.js';

import { AnimationClip } from '../animation/AnimationClip.js';
import { KeyframeTrack } from '../animation/KeyframeTrack.js';

import { computeNormals, computeTangents } from '../geometry/GeometryUtils.js';

import { Mat4 } from '../math/Mat4.js';
import { AABB } from '../math/AABB.js';
import { Sphere } from '../math/Sphere.js';
import { RAD2DEG } from '../math/MathUtils.js';

import { Logger } from '../core/Logger.js';

import {
  resolveURL, extractBasePath, isDataURI, parseDataURI, fetchBytes, uint8ArrayToText
} from './AssetManager.js';
import { loadImageSource, decodeImageSource, createTextureFromImage, disposeImage } from './ImageLoader.js';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

/** ASCII 'glTF' read as a little endian uint32. */
const GLB_MAGIC = 0x46546c67;
/** ASCII 'JSON'. */
const GLB_CHUNK_JSON = 0x4e4f534a;
/** ASCII 'BIN\0'. */
const GLB_CHUNK_BIN = 0x004e4942;

const COMP_BYTE = 5120;
const COMP_UNSIGNED_BYTE = 5121;
const COMP_SHORT = 5122;
const COMP_UNSIGNED_SHORT = 5123;
const COMP_UNSIGNED_INT = 5125;
const COMP_FLOAT = 5126;

/** glTF component type -> typed array constructor. */
const COMPONENT_ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array
};

/** glTF component type -> byte size. */
const COMPONENT_SIZES = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4
};

/** glTF component type -> engine GL enum. */
const COMPONENT_GL_TYPES = {
  5120: GL_TYPE.BYTE,
  5121: GL_TYPE.UNSIGNED_BYTE,
  5122: GL_TYPE.SHORT,
  5123: GL_TYPE.UNSIGNED_SHORT,
  5125: GL_TYPE.UNSIGNED_INT,
  5126: GL_TYPE.FLOAT
};

/** Little endian component readers used by the strided/unaligned path. */
const COMPONENT_READERS = {
  5120: (view, offset) => view.getInt8(offset),
  5121: (view, offset) => view.getUint8(offset),
  5122: (view, offset) => view.getInt16(offset, true),
  5123: (view, offset) => view.getUint16(offset, true),
  5125: (view, offset) => view.getUint32(offset, true),
  5126: (view, offset) => view.getFloat32(offset, true)
};

/** glTF accessor type -> component count. */
const TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16
};

/** glTF accessor type -> matrix column count (0 for non matrix types). */
const TYPE_COLUMNS = {
  MAT2: 2,
  MAT3: 3,
  MAT4: 4
};

/** glTF semantic -> engine attribute name. Unlisted semantics are ignored. */
const ATTRIBUTE_MAP = {
  POSITION: 'aPosition',
  NORMAL: 'aNormal',
  TANGENT: 'aTangent',
  TEXCOORD_0: 'aUV0',
  TEXCOORD_1: 'aUV1',
  COLOR_0: 'aColor',
  JOINTS_0: 'aJoints',
  WEIGHTS_0: 'aWeights'
};

/** glTF primitive mode -> Geometry draw mode name. */
const DRAW_MODES = [
  'points', 'lines', 'line-loop', 'line-strip', 'triangles', 'triangle-strip', 'triangle-fan'
];

/** glTF animation target path -> engine property name. */
const ANIMATION_PATHS = {
  translation: 'position',
  rotation: 'quaternion',
  scale: 'scale',
  weights: 'morphTargetInfluences'
};

/** Sampler magnification/minification filters that sample a mip chain. */
const MIPMAP_FILTERS = { 9984: 1, 9985: 1, 9986: 1, 9987: 1 };

/** Extensions this loader understands. Anything else is reported, not fatal. */
const SUPPORTED_EXTENSIONS = {
  KHR_materials_emissive_strength: 1,
  KHR_texture_transform: 1,
  KHR_materials_unlit: 1,
  KHR_lights_punctual: 1,
  KHR_materials_ior: 1,
  KHR_mesh_quantization: 1,
  EXT_texture_webp: 1,
  EXT_texture_avif: 1
};

/** Extensions that make the geometry unreadable without a decoder. */
const BLOCKING_EXTENSIONS = {
  KHR_draco_mesh_compression: 'KHR_draco_mesh_compression (geometria comprimida com Draco)',
  EXT_meshopt_compression: 'EXT_meshopt_compression (geometria comprimida com meshoptimizer)',
  KHR_texture_basisu: 'KHR_texture_basisu (texturas KTX2/Basis)'
};

/** Scratch matrix used while decomposing node transforms (load time only). */
const _matrix = new Mat4();

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Scale that maps a normalized integer component to [0,1] (unsigned) or
 * [-1,1] (signed).
 * @param {number} componentType
 * @returns {number}
 */
function normalizationScale(componentType) {
  switch (componentType) {
    case COMP_UNSIGNED_BYTE: return 1 / 255;
    case COMP_UNSIGNED_SHORT: return 1 / 65535;
    case COMP_BYTE: return 1 / 127;
    case COMP_SHORT: return 1 / 32767;
    default: return 1;
  }
}

/**
 * Value representing "fully opaque" for a colour component of the given type.
 * @param {number} componentType
 * @returns {number}
 */
function opaqueValue(componentType) {
  switch (componentType) {
    case COMP_UNSIGNED_BYTE: return 255;
    case COMP_UNSIGNED_SHORT: return 65535;
    case COMP_BYTE: return 127;
    case COMP_SHORT: return 32767;
    default: return 1;
  }
}

/**
 * Converts an attribute into a tightly packed Float32Array copy, denormalizing
 * integer data on the way. Attributes that are already plain floats are left
 * alone (a strided float view is fine: the CPU helpers honour the stride).
 *
 * @param {Geometry} geometry
 * @param {string} name
 * @returns {boolean} True when the attribute exists after the call.
 */
function ensureFloatAttribute(geometry, name) {
  const attr = geometry.getAttribute(name);
  if (attr === null) return false;
  if (attr.data instanceof Float32Array) return true;

  const size = attr.size;
  const count = attr.count;
  const out = new Float32Array(count * size);
  const stride = attr.elementStride;
  const offset = attr.elementOffset;
  const data = attr.data;
  const scale = attr.normalized ? normalizationScale(attr.type) : 1;

  for (let i = 0; i < count; i++) {
    const src = offset + i * stride;
    const dst = i * size;
    for (let k = 0; k < size; k++) {
      const value = data[src + k] * scale;
      out[dst + k] = value < -1 && attr.normalized && scale < 1 ? -1 : value;
    }
  }

  geometry.setAttribute(name, out, size);
  return true;
}

/**
 * Expands a VEC3 colour stream into the VEC4 stream the shaders declare.
 * @param {ArrayBufferView} array
 * @param {number} count
 * @param {number} componentType
 * @returns {ArrayBufferView}
 */
function expandColorToVec4(array, count, componentType) {
  const Ctor = array.constructor;
  const out = new Ctor(count * 4);
  const one = opaqueValue(componentType);
  for (let i = 0; i < count; i++) {
    const s = i * 3;
    const d = i * 4;
    out[d] = array[s];
    out[d + 1] = array[s + 1];
    out[d + 2] = array[s + 2];
    out[d + 3] = one;
  }
  return out;
}

/**
 * Byte size of one element of an accessor, taking the 4 byte column padding of
 * small-component matrix types into account.
 * @param {string} type
 * @param {number} componentType
 * @returns {{elementBytes: number, columnBytes: number, columns: number, rows: number}}
 */
function accessorElementLayout(type, componentType) {
  const componentSize = COMPONENT_SIZES[componentType];
  const components = TYPE_COMPONENTS[type];
  const columns = TYPE_COLUMNS[type] || 0;
  if (columns === 0) {
    return { elementBytes: components * componentSize, columnBytes: 0, columns: 0, rows: 0 };
  }
  const rows = columns;
  const rawColumn = rows * componentSize;
  const columnBytes = Math.ceil(rawColumn / 4) * 4;
  return { elementBytes: columnBytes * columns, columnBytes, columns, rows };
}

/* ------------------------------------------------------------------------ */
/* GLTFLoader                                                                */
/* ------------------------------------------------------------------------ */

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
  constructor(gl, options = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl || null;
    /** @type {Object} */
    this.options = options;
    /** @type {string} */
    this.basePath = options.basePath ? options.basePath : '';
    /** @type {Object|null} */
    this.manager = options.manager || null;
  }

  /**
   * Sets the prefix used to resolve relative URLs.
   * @param {string} basePath
   * @returns {GLTFLoader} this
   */
  setBasePath(basePath) {
    this.basePath = basePath || '';
    return this;
  }

  /**
   * Downloads and parses a .gltf or .glb file.
   * @param {string} url
   * @returns {Promise<Object>} See {@link GLTFLoader#parse}.
   */
  async load(url) {
    if (typeof url !== 'string' || url === '') {
      throw new Error('GLTFLoader.load: url invalida (' + String(url) + ').');
    }
    const resolved = resolveURL(url, this.basePath);
    const basePath = extractBasePath(resolved);

    let bytes;
    try {
      bytes = await fetchBytes(resolved, {
        credentials: this.options.credentials || 'same-origin',
        signal: this.options.signal,
        label: resolved
      });
    } catch (err) {
      throw new Error(
        'GLTFLoader: nao foi possivel baixar "' + resolved + '": ' +
        (err && err.message ? err.message : String(err))
      );
    }

    return this.parse(bytes, basePath, resolved);
  }

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
  async parse(data, basePath = '', sourceURL = '') {
    const label = sourceURL || '(buffer em memoria)';
    let json = null;
    let binChunk = null;

    if (data === null || data === undefined) {
      throw new Error('GLTFLoader.parse: nenhum dado fornecido para "' + label + '".');
    }

    if (typeof data === 'string') {
      json = this._parseJSONText(data, label);
    } else if (typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
      json = data;
    } else {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength >= 4) {
        const header = new DataView(bytes.buffer, bytes.byteOffset, Math.min(12, bytes.byteLength));
        if (header.getUint32(0, true) === GLB_MAGIC) {
          const glb = this._parseGLB(bytes, label);
          json = glb.json;
          binChunk = glb.bin;
        }
      }
      if (json === null) json = this._parseJSONText(uint8ArrayToText(bytes), label);
    }

    const parser = new GLTFParser(this.gl, json, {
      basePath: basePath || this.basePath,
      sourceURL: label,
      binChunk,
      options: this.options,
      manager: this.manager
    });
    return parser.parse();
  }

  /**
   * @param {string} text
   * @param {string} label
   * @returns {Object}
   * @private
   */
  _parseJSONText(text, label) {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(
        'GLTFLoader: "' + label + '" nao e um glTF valido - o JSON nao pode ser lido: ' +
        (err && err.message ? err.message : String(err))
      );
    }
  }

  /**
   * Splits a binary .glb container into its JSON and BIN chunks.
   * @param {Uint8Array} bytes
   * @param {string} label
   * @returns {{json: Object, bin: Uint8Array|null}}
   * @private
   */
  _parseGLB(bytes, label) {
    if (bytes.byteLength < 12) {
      throw new Error('GLTFLoader: "' + label + '" e um .glb truncado (cabecalho com menos de 12 bytes).');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(4, true);
    const totalLength = view.getUint32(8, true);

    if (version !== 2) {
      throw new Error('GLTFLoader: "' + label + '" usa GLB versao ' + version + '; apenas a versao 2 e suportada.');
    }
    if (totalLength > bytes.byteLength) {
      throw new Error(
        'GLTFLoader: "' + label + '" declara ' + totalLength + ' bytes mas o arquivo tem apenas ' +
        bytes.byteLength + ' (download incompleto?).'
      );
    }

    let json = null;
    let bin = null;
    let offset = 12;
    const end = Math.min(totalLength, bytes.byteLength);

    while (offset + 8 <= end) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      if (dataStart + chunkLength > end) {
        throw new Error('GLTFLoader: "' + label + '" tem um chunk GLB truncado no offset ' + offset + '.');
      }

      if (chunkType === GLB_CHUNK_JSON && json === null) {
        json = this._parseJSONText(
          uint8ArrayToText(new Uint8Array(bytes.buffer, bytes.byteOffset + dataStart, chunkLength)),
          label
        );
      } else if (chunkType === GLB_CHUNK_BIN && bin === null) {
        bin = new Uint8Array(bytes.buffer, bytes.byteOffset + dataStart, chunkLength);
      }

      // Chunks are padded to a 4 byte boundary.
      offset = dataStart + chunkLength + ((4 - (chunkLength % 4)) % 4);
    }

    if (json === null) {
      throw new Error('GLTFLoader: "' + label + '" nao contem o chunk JSON obrigatorio.');
    }
    return { json, bin };
  }
}

/* ------------------------------------------------------------------------ */
/* GLTFParser                                                                */
/* ------------------------------------------------------------------------ */

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
  constructor(gl, json, context = {}) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl || null;
    /** @type {Object} */
    this.json = json || {};
    /** @type {string} */
    this.basePath = context.basePath || '';
    /** @type {string} */
    this.sourceURL = context.sourceURL || '(glTF)';
    /** @type {Uint8Array|null} */
    this.binChunk = context.binChunk || null;
    /** @type {Object} */
    this.options = context.options || {};
    /** @type {Object|null} */
    this.manager = context.manager || null;

    /** @type {Array<Uint8Array>} */
    this.buffers = [];
    /** @type {Map<number, Uint8Array>} */
    this.bufferViewCache = new Map();
    /** @type {Map<number, Object>} */
    this.accessorCache = new Map();
    /** @type {Map<number, Promise<Object>>} */
    this.imagePromises = new Map();
    /** @type {Array<Object>} */
    this.imageSources = [];
    /** @type {Map<string, Object>} */
    this.textures = new Map();
    /** @type {Array<Object>} */
    this.materials = [];
    /** @type {Map<Object, Geometry>} */
    this.geometryCache = new Map();
    /** @type {Map<number, Array<Object>>} */
    this.meshCache = new Map();
    /** @type {Array<Node3D>} */
    this.nodes = [];
    /** @type {Array<string>} */
    this.nodeNames = [];
    /** @type {Array<Skeleton>} */
    this.skeletons = [];
    /** @type {Array<Object>} */
    this.cameras = [];
    /** @type {Array<Object>} */
    this.lights = [];
    /** @type {Array<AnimationClip>} */
    this.animations = [];
    /** @type {Array<Node3D>} */
    this.scenes = [];
    /** @type {Array<Geometry>} */
    this.geometries = [];
    /** @type {Array<{mesh: SkinnedMesh, skin: number}>} */
    this.pendingSkins = [];
    /** @type {Object|null} */
    this.defaultMaterial = null;
    /** @type {boolean} */
    this.uvTransformWarned = false;
  }

  /**
   * Runs the whole pipeline.
   * @returns {Promise<Object>}
   */
  async parse() {
    this._validate();
    await this._loadBuffers();
    await this._buildMaterials();
    this._buildNodes();
    this._buildSkins();
    this._buildScenes();
    this._buildAnimations();
    this._releaseImages();

    const json = this.json;
    const sceneIndex = json.scene !== undefined ? json.scene : 0;
    const scene = this.scenes[sceneIndex] || this.scenes[0] || new Node3D('Scene');

    return {
      scene,
      scenes: this.scenes,
      animations: this.animations,
      cameras: this.cameras,
      materials: this.materials,
      meshes: this._collectMeshes(),
      nodes: this.nodes,
      skeletons: this.skeletons,
      textures: Array.from(this.textures.values()),
      lights: this.lights,
      geometries: this.geometries,
      asset: json.asset || {},
      json,
      dispose: () => this.dispose()
    };
  }

  /**
   * Releases every GPU resource created by this parse.
   * @returns {GLTFParser} this
   */
  dispose() {
    const it = this.textures.values();
    for (let entry = it.next(); !entry.done; entry = it.next()) {
      const texture = entry.value;
      if (texture && typeof texture.dispose === 'function') texture.dispose();
    }
    this.textures.clear();

    for (let i = 0, n = this.geometries.length; i < n; i++) {
      const geometry = this.geometries[i];
      if (geometry && typeof geometry.dispose === 'function') geometry.dispose(this.gl);
    }
    this.geometries.length = 0;

    for (let i = 0, n = this.materials.length; i < n; i++) {
      const material = this.materials[i];
      if (material && typeof material.dispose === 'function') material.dispose();
    }
    this._releaseImages();
    return this;
  }

  /* -------------------------------------------------------------- validate */

  /**
   * Rejects documents this loader cannot honour and reports the ones it can only
   * partially honour.
   * @private
   */
  _validate() {
    const json = this.json;
    const asset = json.asset;
    if (!asset || typeof asset.version !== 'string') {
      throw new Error('GLTFLoader: "' + this.sourceURL + '" nao declara asset.version; nao e um glTF 2.0 valido.');
    }
    const major = parseInt(asset.version, 10);
    if (!(major >= 2)) {
      throw new Error(
        'GLTFLoader: "' + this.sourceURL + '" usa glTF ' + asset.version +
        '; apenas a versao 2.0 ou superior e suportada.'
      );
    }

    const required = json.extensionsRequired || [];
    for (let i = 0, n = required.length; i < n; i++) {
      const name = required[i];
      const blocking = BLOCKING_EXTENSIONS[name];
      if (blocking !== undefined) {
        throw new Error(
          'GLTFLoader: "' + this.sourceURL + '" exige a extensao ' + blocking +
          ', que este carregador nao implementa. Reexporte o modelo sem essa extensao.'
        );
      }
      if (SUPPORTED_EXTENSIONS[name] === undefined) {
        Logger.warn(
          'GLTFLoader: "' + this.sourceURL + '" exige a extensao desconhecida "' + name +
          '"; o modelo pode ser carregado de forma incorreta.'
        );
      }
    }

    const used = json.extensionsUsed || [];
    for (let i = 0, n = used.length; i < n; i++) {
      const name = used[i];
      if (SUPPORTED_EXTENSIONS[name] === undefined && BLOCKING_EXTENSIONS[name] === undefined) {
        Logger.debug('GLTFLoader: extensao "' + name + '" usada por "' + this.sourceURL + '" sera ignorada.');
      }
    }
  }

  /* --------------------------------------------------------------- buffers */

  /**
   * Resolves every `buffers[]` entry into bytes.
   * @returns {Promise<void>}
   * @private
   */
  async _loadBuffers() {
    const defs = this.json.buffers || [];
    const out = new Array(defs.length);
    const jobs = [];

    for (let i = 0, n = defs.length; i < n; i++) {
      const def = defs[i];
      if (def.uri === undefined) {
        if (this.binChunk === null) {
          throw new Error(
            'GLTFLoader: o buffer ' + i + ' de "' + this.sourceURL + '" nao tem uri e o arquivo nao ' +
            'possui um chunk binario GLB.'
          );
        }
        out[i] = this.binChunk;
        continue;
      }

      if (isDataURI(def.uri)) {
        try {
          out[i] = parseDataURI(def.uri).data;
        } catch (err) {
          throw new Error(
            'GLTFLoader: data URI do buffer ' + i + ' de "' + this.sourceURL + '" e invalida: ' +
            (err && err.message ? err.message : String(err))
          );
        }
        continue;
      }

      const url = resolveURL(def.uri, this.basePath);
      const index = i;
      jobs.push(
        fetchBytes(url, {
          credentials: this.options.credentials || 'same-origin',
          signal: this.options.signal,
          label: url
        }).then((bytes) => {
          out[index] = bytes;
        }).catch((err) => {
          throw new Error(
            'GLTFLoader: falha ao carregar o buffer ' + index + ' ("' + def.uri + '") de "' +
            this.sourceURL + '": ' + (err && err.message ? err.message : String(err))
          );
        })
      );
    }

    await Promise.all(jobs);

    for (let i = 0, n = defs.length; i < n; i++) {
      const bytes = out[i];
      const expected = defs[i].byteLength;
      if (bytes === undefined) {
        throw new Error('GLTFLoader: buffer ' + i + ' de "' + this.sourceURL + '" nao pode ser resolvido.');
      }
      if (typeof expected === 'number' && bytes.byteLength < expected) {
        throw new Error(
          'GLTFLoader: buffer ' + i + ' de "' + this.sourceURL + '" tem ' + bytes.byteLength +
          ' bytes mas o glTF declara ' + expected + '.'
        );
      }
    }

    this.buffers = out;
  }

  /**
   * Returns the bytes of a bufferView as a view (no copy).
   * @param {number} index
   * @returns {Uint8Array}
   * @private
   */
  _bufferViewBytes(index) {
    const cached = this.bufferViewCache.get(index);
    if (cached !== undefined) return cached;

    const def = (this.json.bufferViews || [])[index];
    if (def === undefined) {
      throw new Error('GLTFLoader: bufferView ' + index + ' inexistente em "' + this.sourceURL + '".');
    }
    const buffer = this.buffers[def.buffer];
    if (buffer === undefined) {
      throw new Error(
        'GLTFLoader: bufferView ' + index + ' de "' + this.sourceURL + '" aponta para o buffer ' +
        def.buffer + ', que nao foi carregado.'
      );
    }
    const offset = def.byteOffset || 0;
    const length = def.byteLength;
    if (offset + length > buffer.byteLength) {
      throw new Error(
        'GLTFLoader: bufferView ' + index + ' de "' + this.sourceURL + '" excede o buffer ' + def.buffer +
        ' (' + (offset + length) + ' > ' + buffer.byteLength + ').'
      );
    }
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
    this.bufferViewCache.set(index, bytes);
    return bytes;
  }

  /* -------------------------------------------------------------- accessors */

  /**
   * Reads an accessor into a tightly packed typed array, applying the sparse
   * substitution when present.
   *
   * @param {number} index
   * @returns {{array: ArrayBufferView, count: number, numComponents: number,
   *            componentType: number, normalized: boolean, type: string}}
   */
  readAccessor(index) {
    const cached = this.accessorCache.get(index);
    if (cached !== undefined) return cached;

    const def = (this.json.accessors || [])[index];
    if (def === undefined) {
      throw new Error('GLTFLoader: accessor ' + index + ' inexistente em "' + this.sourceURL + '".');
    }

    const numComponents = TYPE_COMPONENTS[def.type];
    const Ctor = COMPONENT_ARRAYS[def.componentType];
    if (numComponents === undefined || Ctor === undefined) {
      throw new Error(
        'GLTFLoader: accessor ' + index + ' de "' + this.sourceURL + '" usa type="' + def.type +
        '" / componentType=' + def.componentType + ', combinacao nao suportada pelo glTF 2.0.'
      );
    }

    const count = def.count | 0;
    const sparse = def.sparse !== undefined;
    let array;

    if (def.bufferView !== undefined) {
      array = this._readAccessorArray(def, count, numComponents, index, sparse);
    } else {
      // No bufferView: the accessor starts as all zeros and is filled by `sparse`.
      array = new Ctor(count * numComponents);
    }

    if (sparse) {
      this._applySparse(array, def, numComponents, index);
    }

    const result = {
      array,
      count,
      numComponents,
      componentType: def.componentType,
      normalized: def.normalized === true,
      type: def.type
    };
    this.accessorCache.set(index, result);
    return result;
  }

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
  _readAccessorArray(def, count, numComponents, index, forceCopy) {
    const bvIndex = def.bufferView;
    const bv = (this.json.bufferViews || [])[bvIndex];
    if (bv === undefined) {
      throw new Error(
        'GLTFLoader: accessor ' + index + ' de "' + this.sourceURL + '" referencia o bufferView ' +
        bvIndex + ', inexistente.'
      );
    }
    const buffer = this.buffers[bv.buffer];
    if (buffer === undefined) {
      throw new Error(
        'GLTFLoader: accessor ' + index + ' de "' + this.sourceURL + '" depende do buffer ' +
        bv.buffer + ', que nao foi carregado.'
      );
    }
    const componentType = def.componentType;
    const componentSize = COMPONENT_SIZES[componentType];
    const layout = accessorElementLayout(def.type, componentType);
    const stride = bv.byteStride ? bv.byteStride : layout.elementBytes;
    const base = buffer.byteOffset + (bv.byteOffset || 0) + (def.byteOffset || 0);
    const lastByte = base + (count > 0 ? (count - 1) * stride + layout.elementBytes : 0);

    if (lastByte > buffer.byteOffset + buffer.byteLength) {
      throw new Error(
        'GLTFLoader: accessor ' + index + ' de "' + this.sourceURL + '" le alem do fim do buffer ' +
        bv.buffer + '. O arquivo esta corrompido ou truncado.'
      );
    }

    const Ctor = COMPONENT_ARRAYS[componentType];
    const tightlyPacked = stride === layout.elementBytes && layout.columns === 0;
    const aligned = base % componentSize === 0;

    if (tightlyPacked && aligned) {
      const view = new Ctor(buffer.buffer, base, count * numComponents);
      if (!forceCopy) return view;
      const copy = new Ctor(count * numComponents);
      copy.set(view);
      return copy;
    }

    const target = new Ctor(count * numComponents);
    const view = new DataView(buffer.buffer);
    const read = COMPONENT_READERS[componentType];

    if (layout.columns === 0) {
      for (let i = 0; i < count; i++) {
        const src = base + i * stride;
        const dst = i * numComponents;
        for (let k = 0; k < numComponents; k++) {
          target[dst + k] = read(view, src + k * componentSize);
        }
      }
      return target;
    }

    // Matrix accessor: each column starts on a 4 byte boundary.
    const rows = layout.rows;
    for (let i = 0; i < count; i++) {
      const src = base + i * stride;
      const dst = i * numComponents;
      for (let c = 0; c < layout.columns; c++) {
        const columnSrc = src + c * layout.columnBytes;
        const columnDst = dst + c * rows;
        for (let r = 0; r < rows; r++) {
          target[columnDst + r] = read(view, columnSrc + r * componentSize);
        }
      }
    }
    return target;
  }

  /**
   * Applies the `sparse` substitution of an accessor.
   * @param {ArrayBufferView} target
   * @param {Object} def
   * @param {number} numComponents
   * @param {number} index
   * @private
   */
  _applySparse(target, def, numComponents, index) {
    const sparse = def.sparse;
    const sparseCount = sparse.count | 0;
    if (sparseCount <= 0) return;

    const indices = this._readPacked(
      sparse.indices.bufferView,
      sparse.indices.byteOffset || 0,
      sparse.indices.componentType,
      1,
      sparseCount,
      index
    );
    const values = this._readPacked(
      sparse.values.bufferView,
      sparse.values.byteOffset || 0,
      def.componentType,
      numComponents,
      sparseCount,
      index
    );

    const total = def.count | 0;
    for (let i = 0; i < sparseCount; i++) {
      const vertex = indices[i];
      if (vertex < 0 || vertex >= total) continue;
      const dst = vertex * numComponents;
      const src = i * numComponents;
      for (let k = 0; k < numComponents; k++) target[dst + k] = values[src + k];
    }
  }

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
  _readPacked(bufferViewIndex, byteOffset, componentType, numComponents, count, accessorIndex) {
    const Ctor = COMPONENT_ARRAYS[componentType];
    if (Ctor === undefined) {
      throw new Error(
        'GLTFLoader: accessor esparso ' + accessorIndex + ' de "' + this.sourceURL +
        '" usa componentType ' + componentType + ', invalido.'
      );
    }
    const bv = (this.json.bufferViews || [])[bufferViewIndex];
    if (bv === undefined) {
      throw new Error(
        'GLTFLoader: accessor esparso ' + accessorIndex + ' de "' + this.sourceURL +
        '" referencia o bufferView ' + bufferViewIndex + ', inexistente.'
      );
    }
    const buffer = this.buffers[bv.buffer];
    const componentSize = COMPONENT_SIZES[componentType];
    const base = buffer.byteOffset + (bv.byteOffset || 0) + byteOffset;
    const total = count * numComponents;

    if (base + total * componentSize > buffer.byteOffset + buffer.byteLength) {
      throw new Error(
        'GLTFLoader: accessor esparso ' + accessorIndex + ' de "' + this.sourceURL +
        '" le alem do fim do buffer ' + bv.buffer + '.'
      );
    }

    if (base % componentSize === 0) return new Ctor(buffer.buffer, base, total);

    const out = new Ctor(total);
    const view = new DataView(buffer.buffer);
    const read = COMPONENT_READERS[componentType];
    for (let i = 0; i < total; i++) out[i] = read(view, base + i * componentSize);
    return out;
  }

  /**
   * Reads an accessor as denormalized Float32 data (animation samplers).
   * @param {number} index
   * @returns {Float32Array}
   */
  readAccessorAsFloat(index) {
    const accessor = this.readAccessor(index);
    if (accessor.array instanceof Float32Array) return accessor.array;

    const out = new Float32Array(accessor.array.length);
    const scale = accessor.normalized ? normalizationScale(accessor.componentType) : 1;
    const clampSigned = accessor.normalized &&
      (accessor.componentType === COMP_BYTE || accessor.componentType === COMP_SHORT);
    for (let i = 0, n = out.length; i < n; i++) {
      const value = accessor.array[i] * scale;
      out[i] = clampSigned && value < -1 ? -1 : value;
    }
    return out;
  }

  /* ---------------------------------------------------------------- images */

  /**
   * Decodes an image, once per glTF image index.
   * @param {number} index
   * @returns {Promise<Object>} `{ image, isBitmap, flipped }`
   * @private
   */
  _loadImage(index) {
    const cached = this.imagePromises.get(index);
    if (cached !== undefined) return cached;

    const def = (this.json.images || [])[index];
    if (def === undefined) {
      return Promise.reject(new Error(
        'GLTFLoader: imagem ' + index + ' inexistente em "' + this.sourceURL + '".'
      ));
    }

    const label = 'imagem ' + index + (def.name ? ' ("' + def.name + '")' : '') + ' de "' + this.sourceURL + '"';
    const imageOptions = {
      flipY: false,
      premultiplyAlpha: false,
      credentials: this.options.credentials || 'same-origin',
      crossOrigin: this.options.crossOrigin,
      label
    };

    let promise;
    if (def.uri !== undefined && isDataURI(def.uri)) {
      let parsed;
      try {
        parsed = parseDataURI(def.uri);
      } catch (err) {
        return Promise.reject(new Error('GLTFLoader: data URI da ' + label + ' e invalida.'));
      }
      promise = decodeImageSource(parsed.data, Object.assign({ mimeType: def.mimeType || parsed.mimeType }, imageOptions));
    } else if (def.uri !== undefined) {
      const url = resolveURL(def.uri, this.basePath);
      promise = loadImageSource(url, imageOptions);
    } else if (def.bufferView !== undefined) {
      let bytes;
      try {
        bytes = this._bufferViewBytes(def.bufferView);
      } catch (err) {
        return Promise.reject(err);
      }
      promise = decodeImageSource(bytes, Object.assign({ mimeType: def.mimeType || 'image/png' }, imageOptions));
    } else {
      return Promise.reject(new Error(
        'GLTFLoader: ' + label + ' nao tem uri nem bufferView.'
      ));
    }

    const tracked = promise.then((source) => {
      this.imageSources.push(source);
      return source;
    }).catch((err) => {
      throw new Error(
        'GLTFLoader: falha ao decodificar a ' + label + ': ' + (err && err.message ? err.message : String(err))
      );
    });

    this.imagePromises.set(index, tracked);
    return tracked;
  }

  /** Closes every decoded bitmap once the textures have been uploaded. @private */
  _releaseImages() {
    if (this.options.keepImages === true) return;
    for (let i = 0, n = this.imageSources.length; i < n; i++) {
      disposeImage(this.imageSources[i].image);
    }
    this.imageSources.length = 0;
  }

  /* -------------------------------------------------------------- textures */

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
  async _loadTexture(index, srgb) {
    if (this.gl === null || this.options.loadTextures === false) return null;

    const key = index + '|' + (srgb ? 1 : 0);
    const cached = this.textures.get(key);
    if (cached !== undefined) return cached;

    const def = (this.json.textures || [])[index];
    if (def === undefined) {
      Logger.warn('GLTFLoader: textura ' + index + ' inexistente em "' + this.sourceURL + '"; ignorada.');
      return null;
    }

    let source = def.source;
    const extensions = def.extensions;
    if (source === undefined && extensions) {
      if (extensions.EXT_texture_webp && extensions.EXT_texture_webp.source !== undefined) {
        source = extensions.EXT_texture_webp.source;
      } else if (extensions.EXT_texture_avif && extensions.EXT_texture_avif.source !== undefined) {
        source = extensions.EXT_texture_avif.source;
      } else if (extensions.KHR_texture_basisu !== undefined) {
        Logger.warn(
          'GLTFLoader: a textura ' + index + ' de "' + this.sourceURL + '" usa KHR_texture_basisu ' +
          '(KTX2/Basis), formato nao suportado; a textura sera ignorada.'
        );
        return null;
      }
    }
    if (source === undefined) {
      Logger.warn('GLTFLoader: textura ' + index + ' de "' + this.sourceURL + '" nao tem imagem; ignorada.');
      return null;
    }

    const imageSource = await this._loadImage(source);
    const sampler = def.sampler !== undefined ? (this.json.samplers || [])[def.sampler] : undefined;

    const minFilter = sampler && sampler.minFilter !== undefined ? sampler.minFilter : 9987;
    const magFilter = sampler && sampler.magFilter !== undefined ? sampler.magFilter : 9729;
    const wrapS = sampler && sampler.wrapS !== undefined ? sampler.wrapS : 10497;
    const wrapT = sampler && sampler.wrapT !== undefined ? sampler.wrapT : 10497;
    const generateMipmaps = MIPMAP_FILTERS[minFilter] === 1;

    let texture;
    try {
      texture = createTextureFromImage(this.gl, imageSource.image, {
        srgb,
        generateMipmaps,
        minFilter,
        magFilter,
        wrapS,
        wrapT,
        anisotropy: this.options.anisotropy,
        flipY: false,
        alreadyFlipped: imageSource.flipped,
        premultiplyAlpha: false,
        name: def.name || ('gltf_texture_' + index),
        state: this.options.state
      });
    } catch (err) {
      throw new Error(
        'GLTFLoader: falha ao criar a textura ' + index + ' de "' + this.sourceURL + '": ' +
        (err && err.message ? err.message : String(err))
      );
    }

    this.textures.set(key, texture);
    return texture;
  }

  /* ------------------------------------------------------------- materials */

  /**
   * Builds every material declared in the document (textures included).
   * @returns {Promise<void>}
   * @private
   */
  async _buildMaterials() {
    const defs = this.json.materials || [];
    this.materials = new Array(defs.length);
    const jobs = [];
    for (let i = 0, n = defs.length; i < n; i++) {
      const index = i;
      jobs.push(this._createMaterial(defs[i], index).then((material) => {
        this.materials[index] = material;
      }));
    }
    await Promise.all(jobs);
  }

  /**
   * The glTF default material: white dielectric-to-metal, fully rough.
   * @returns {Object}
   * @private
   */
  _getDefaultMaterial() {
    if (this.defaultMaterial === null) {
      this.defaultMaterial = new StandardMaterial({
        name: 'gltf_default',
        metallic: 1,
        roughness: 1
      });
      this.defaultMaterial.baseColor.set(1, 1, 1);
    }
    return this.defaultMaterial;
  }

  /**
   * Translates one glTF material into an engine material.
   * @param {Object} def
   * @param {number} index
   * @returns {Promise<Object>}
   * @private
   */
  async _createMaterial(def, index) {
    const extensions = def.extensions || {};
    const unlit = extensions.KHR_materials_unlit !== undefined;
    const pbr = def.pbrMetallicRoughness || {};
    const name = def.name || ('material_' + index);

    const material = unlit ? new UnlitMaterial({ name }) : new StandardMaterial({ name });

    // --- base colour (glTF factors are already linear) ----------------------
    const baseColorFactor = pbr.baseColorFactor;
    if (Array.isArray(baseColorFactor)) {
      material.baseColor.set(baseColorFactor[0], baseColorFactor[1], baseColorFactor[2]);
      material.opacity = baseColorFactor.length > 3 ? baseColorFactor[3] : 1;
    } else {
      material.baseColor.set(1, 1, 1);
      material.opacity = 1;
    }

    const jobs = [];
    let transformSource = null;

    if (pbr.baseColorTexture) {
      transformSource = pbr.baseColorTexture;
      jobs.push(this._assignTexture(material, 'baseColorMap', pbr.baseColorTexture, true, 'baseColorUV1'));
    }

    if (!unlit) {
      material.metallic = pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1;
      material.roughness = pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1;

      if (pbr.metallicRoughnessTexture) {
        if (transformSource === null) transformSource = pbr.metallicRoughnessTexture;
        jobs.push(this._assignTexture(
          material, 'metallicRoughnessMap', pbr.metallicRoughnessTexture, false, 'metallicRoughnessUV1'
        ));
      }

      if (def.normalTexture) {
        if (transformSource === null) transformSource = def.normalTexture;
        material.normalScale = def.normalTexture.scale !== undefined ? def.normalTexture.scale : 1;
        jobs.push(this._assignTexture(material, 'normalMap', def.normalTexture, false, 'normalUV1'));
      }

      if (def.occlusionTexture) {
        if (transformSource === null) transformSource = def.occlusionTexture;
        material.occlusionStrength = def.occlusionTexture.strength !== undefined
          ? def.occlusionTexture.strength
          : 1;
        jobs.push(this._assignTexture(material, 'occlusionMap', def.occlusionTexture, false, 'occlusionUV1'));
      }

      const emissiveFactor = def.emissiveFactor;
      if (Array.isArray(emissiveFactor)) {
        material.emissive.set(emissiveFactor[0], emissiveFactor[1], emissiveFactor[2]);
      } else {
        material.emissive.set(0, 0, 0);
      }

      const strength = extensions.KHR_materials_emissive_strength;
      material.emissiveIntensity = strength && strength.emissiveStrength !== undefined
        ? strength.emissiveStrength
        : 1;

      if (def.emissiveTexture) {
        if (transformSource === null) transformSource = def.emissiveTexture;
        jobs.push(this._assignTexture(material, 'emissiveMap', def.emissiveTexture, true, 'emissiveUV1'));
      }

      const iorExt = extensions.KHR_materials_ior;
      if (iorExt && iorExt.ior !== undefined) material.ior = iorExt.ior;
    }

    // --- transparency -------------------------------------------------------
    const alphaMode = def.alphaMode || 'OPAQUE';
    const alphaCutoff = def.alphaCutoff !== undefined ? def.alphaCutoff : 0.5;
    if (alphaMode === 'BLEND') {
      material.setAlphaMode('blend');
    } else if (alphaMode === 'MASK') {
      material.setAlphaMode('mask', alphaCutoff);
    } else {
      material.setAlphaMode('opaque');
    }

    material.side = def.doubleSided === true ? 'double' : 'front';

    await Promise.all(jobs);

    // The engine carries one UV transform per material, so the first texture
    // that declares KHR_texture_transform sets it for the whole material.
    this._applyTextureTransform(material, transformSource, name);

    material.needsUpdate = true;
    return material;
  }

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
  async _assignTexture(material, slot, info, srgb, uv1Flag) {
    if (info.index === undefined) return;
    const texture = await this._loadTexture(info.index, srgb);
    if (texture === null) return;
    material[slot] = texture;

    const transform = info.extensions && info.extensions.KHR_texture_transform;
    const texCoord = transform && transform.texCoord !== undefined ? transform.texCoord : info.texCoord;
    if (uv1Flag && texCoord === 1) material[uv1Flag] = true;
  }

  /**
   * Applies a KHR_texture_transform block to the material UV transform.
   * @param {Object} material
   * @param {Object|null} info
   * @param {string} materialName
   * @private
   */
  _applyTextureTransform(material, info, materialName) {
    const transform = info && info.extensions ? info.extensions.KHR_texture_transform : null;
    if (!transform) return;

    const offset = transform.offset || [0, 0];
    const scale = transform.scale || [1, 1];
    const rotation = transform.rotation || 0;

    if (rotation !== 0 && scale[0] !== scale[1] && !this.uvTransformWarned) {
      this.uvTransformWarned = true;
      Logger.warn(
        'GLTFLoader: o material "' + materialName + '" de "' + this.sourceURL + '" combina rotacao com ' +
        'escala nao uniforme em KHR_texture_transform; a engine aplica escala e rotacao em ordem ' +
        'invertida, entao o resultado sera aproximado.'
      );
    }

    if (typeof material.setUVTransform === 'function') {
      material.setUVTransform(scale[0], scale[1], offset[0], offset[1], rotation);
    } else {
      material.uvScale.set(scale[0], scale[1]);
      material.uvOffset.set(offset[0], offset[1]);
      material.uvRotation = rotation;
      material.needsUpdate = true;
    }
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * Builds (and caches) the geometry of one primitive.
   * @param {Object} primitive
   * @param {number} meshIndex For error messages.
   * @returns {Geometry}
   * @private
   */
  _buildGeometry(primitive, meshIndex) {
    const cached = this.geometryCache.get(primitive);
    if (cached !== undefined) return cached;

    const geometry = new Geometry();
    const accessors = this.json.accessors || [];
    const attributes = primitive.attributes || {};

    // --- 1. collect the semantics we understand -----------------------------
    const entries = [];
    let vertexCount = 0;
    for (const semantic in attributes) {
      const name = ATTRIBUTE_MAP[semantic];
      if (name === undefined) continue;
      const accessorIndex = attributes[semantic];
      const accessor = accessors[accessorIndex];
      if (accessor === undefined) {
        Logger.warn(
          'GLTFLoader: primitive da mesh ' + meshIndex + ' de "' + this.sourceURL + '" referencia o ' +
          'accessor ' + accessorIndex + ' (' + semantic + '), inexistente; atributo ignorado.'
        );
        continue;
      }
      const numComponents = TYPE_COMPONENTS[accessor.type];
      if (numComponents === undefined) continue;
      entries.push({ name, semantic, accessorIndex, accessor, numComponents });
      if (name === 'aPosition') vertexCount = accessor.count | 0;
    }

    if (entries.length === 0) {
      throw new Error(
        'GLTFLoader: primitive da mesh ' + meshIndex + ' de "' + this.sourceURL +
        '" nao tem nenhum atributo reconhecido (POSITION e obrigatorio).'
      );
    }
    if (vertexCount === 0) vertexCount = entries[0].accessor.count | 0;

    // --- 2. interleaved groups ---------------------------------------------
    const consumed = new Set();
    if (this.options.interleave !== false) {
      this._buildInterleavedGroups(geometry, entries, vertexCount, consumed);
    }

    // --- 3. everything else, de-interleaved --------------------------------
    for (let i = 0, n = entries.length; i < n; i++) {
      const entry = entries[i];
      if (consumed.has(entry)) continue;
      this._setStandaloneAttribute(geometry, entry, vertexCount);
    }

    // --- 4. indices ---------------------------------------------------------
    if (primitive.indices !== undefined) {
      const indexAccessor = this.readAccessor(primitive.indices);
      let indices = indexAccessor.array;
      // WebGL2 accepts UNSIGNED_BYTE indices but the extra draw-call bookkeeping
      // is not worth it; widen to the two types the renderer expects.
      if (!(indices instanceof Uint16Array) && !(indices instanceof Uint32Array)) {
        indices = indexAccessor.count > 65535 || geometry.vertexCount > 65535
          ? new Uint32Array(indices)
          : new Uint16Array(indices);
      }
      geometry.setIndex(indices);
    }

    // --- 5. topology --------------------------------------------------------
    const mode = primitive.mode !== undefined ? primitive.mode : 4;
    geometry.drawMode = DRAW_MODES[mode] || 'triangles';
    if (DRAW_MODES[mode] === undefined) {
      Logger.warn(
        'GLTFLoader: primitive mode ' + mode + ' desconhecido em "' + this.sourceURL +
        '"; assumindo triangulos.'
      );
    }

    // --- 6. bounds ----------------------------------------------------------
    this._applyBounds(geometry, accessors[attributes.POSITION]);

    // --- 7. generated attributes -------------------------------------------
    this._generateMissingAttributes(geometry, primitive);

    if (primitive.targets !== undefined) {
      // Morph targets are parsed but not deformed by the engine yet; keep the
      // description so application code (or a future system) can use it.
      geometry.userData.morphTargets = primitive.targets;
    }

    this.geometryCache.set(primitive, geometry);
    this.geometries.push(geometry);
    return geometry;
  }

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
  _buildInterleavedGroups(geometry, entries, vertexCount, consumed) {
    const bufferViews = this.json.bufferViews || [];
    const groups = new Map();

    for (let i = 0, n = entries.length; i < n; i++) {
      const entry = entries[i];
      const accessor = entry.accessor;
      if (accessor.sparse !== undefined) continue;
      if (accessor.bufferView === undefined) continue;
      if (accessor.componentType !== COMP_FLOAT) continue;
      if (accessor.normalized === true) continue;
      if ((accessor.count | 0) !== vertexCount) continue;
      // A VEC3 colour has to be expanded into the vec4 the shaders declare.
      if (entry.name === 'aColor' && entry.numComponents !== 4) continue;

      const bv = bufferViews[accessor.bufferView];
      if (bv === undefined || !bv.byteStride) continue;
      // A stride equal to the element size cannot be shared by two attributes.
      if (bv.byteStride === entry.numComponents * 4) continue;

      let list = groups.get(accessor.bufferView);
      if (list === undefined) {
        list = [];
        groups.set(accessor.bufferView, list);
      }
      list.push(entry);
    }

    const it = groups.entries();
    for (let step = it.next(); !step.done; step = it.next()) {
      const bvIndex = step.value[0];
      const list = step.value[1];
      if (list.length < 2) continue;
      if (this._addInterleavedGroup(geometry, bvIndex, list, vertexCount)) {
        for (let i = 0, n = list.length; i < n; i++) consumed.add(list[i]);
      }
    }
  }

  /**
   * Uploads one interleaved slice.
   * @param {Geometry} geometry
   * @param {number} bvIndex
   * @param {Array<Object>} list
   * @param {number} vertexCount
   * @returns {boolean} True when the group was installed.
   * @private
   */
  _addInterleavedGroup(geometry, bvIndex, list, vertexCount) {
    const bv = this.json.bufferViews[bvIndex];
    const buffer = this.buffers[bv.buffer];
    if (buffer === undefined) return false;

    const stride = bv.byteStride;
    const bvStart = bv.byteOffset || 0;
    const bvEnd = bvStart + bv.byteLength;

    let minOffset = Infinity;
    for (let i = 0, n = list.length; i < n; i++) {
      const offset = bvStart + (list[i].accessor.byteOffset || 0);
      if (offset < minOffset) minOffset = offset;
    }
    // Keep the slice start 4 byte aligned so every float offset inside it stays
    // aligned as well (glTF guarantees byteStride % 4 === 0).
    const sliceStart = minOffset - (minOffset % 4);
    const needed = stride * vertexCount;
    if (needed <= 0 || needed % 4 !== 0) return false;

    const available = Math.min(bvEnd, buffer.byteLength) - sliceStart;
    if (available <= 0) return false;

    const absoluteBase = buffer.byteOffset + sliceStart;
    let data;
    if (available >= needed && (absoluteBase & 3) === 0) {
      data = new Float32Array(buffer.buffer, absoluteBase, needed >> 2);
    } else {
      // Short tail or misaligned source: pad into a private, aligned copy.
      const copy = new Uint8Array(needed);
      copy.set(new Uint8Array(
        buffer.buffer,
        absoluteBase,
        Math.min(available, needed)
      ));
      data = new Float32Array(copy.buffer);
    }

    const descriptors = new Array(list.length);
    for (let i = 0, n = list.length; i < n; i++) {
      const entry = list[i];
      descriptors[i] = {
        name: entry.name,
        size: entry.numComponents,
        offset: bvStart + (entry.accessor.byteOffset || 0) - sliceStart,
        type: GL_TYPE.FLOAT,
        normalized: false
      };
    }

    geometry.setInterleaved(data, {
      stride,
      count: vertexCount,
      usage: 'static',
      attributes: descriptors
    });
    return true;
  }

  /**
   * Reads one attribute into its own tightly packed buffer.
   * @param {Geometry} geometry
   * @param {Object} entry
   * @param {number} vertexCount
   * @private
   */
  _setStandaloneAttribute(geometry, entry, vertexCount) {
    const accessor = this.readAccessor(entry.accessorIndex);
    let array = accessor.array;
    let size = entry.numComponents;

    if (entry.name === 'aColor' && size === 3) {
      array = expandColorToVec4(array, accessor.count, accessor.componentType);
      size = 4;
    }

    // Joint indices are consumed as floats by the shaders (the skinning chunk
    // declares `in vec4 aJoints`), so they must NOT be normalized and must NOT
    // go through vertexAttribIPointer.
    const isJoints = entry.name === 'aJoints';
    geometry.setAttribute(entry.name, array, size, {
      type: COMPONENT_GL_TYPES[accessor.componentType],
      normalized: isJoints ? false : accessor.normalized,
      integer: false
    });

    const attribute = geometry.getAttribute(entry.name);
    if (attribute !== null && vertexCount > 0) attribute.count = Math.min(attribute.count, vertexCount);
  }

  /**
   * Uses the POSITION accessor min/max as the bounding box when the exporter
   * provided it (it is mandatory for POSITION), falling back to a full scan.
   * @param {Geometry} geometry
   * @param {Object|undefined} positionAccessor
   * @private
   */
  _applyBounds(geometry, positionAccessor) {
    const min = positionAccessor ? positionAccessor.min : null;
    const max = positionAccessor ? positionAccessor.max : null;

    if (Array.isArray(min) && Array.isArray(max) && min.length >= 3 && max.length >= 3) {
      const box = new AABB();
      box.min.set(min[0], min[1], min[2]);
      box.max.set(max[0], max[1], max[2]);
      geometry.boundingBox = box;
      geometry.boundingSphere = box.getBoundingSphere(new Sphere());
      return;
    }

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  /**
   * Generates normals and tangents when the file omits them.
   * @param {Geometry} geometry
   * @param {Object} primitive
   * @private
   */
  _generateMissingAttributes(geometry, primitive) {
    if (geometry.drawMode !== 'triangles') return;

    if (!geometry.hasAttribute('aNormal') && this.options.generateNormals !== false) {
      ensureFloatAttribute(geometry, 'aPosition');
      computeNormals(geometry);
    }

    if (this.options.generateTangents === false) return;
    if (geometry.hasAttribute('aTangent')) return;
    if (!geometry.hasAttribute('aUV0')) return;

    // Tangents are only worth their memory when something samples a normal map.
    const materialIndex = primitive.material;
    if (materialIndex === undefined) return;
    const materialDef = (this.json.materials || [])[materialIndex];
    if (!materialDef || !materialDef.normalTexture) return;

    ensureFloatAttribute(geometry, 'aPosition');
    ensureFloatAttribute(geometry, 'aNormal');
    ensureFloatAttribute(geometry, 'aUV0');
    computeTangents(geometry);
  }

  /* ------------------------------------------------------------------ mesh */

  /**
   * Resolves a glTF mesh into `{geometry, material}` pairs.
   * @param {number} index
   * @returns {Array<{geometry: Geometry, material: Object, name: string}>}
   * @private
   */
  _getMeshParts(index) {
    const cached = this.meshCache.get(index);
    if (cached !== undefined) return cached;

    const def = (this.json.meshes || [])[index];
    if (def === undefined) {
      throw new Error('GLTFLoader: mesh ' + index + ' inexistente em "' + this.sourceURL + '".');
    }
    const primitives = def.primitives || [];
    const parts = new Array(primitives.length);

    for (let i = 0, n = primitives.length; i < n; i++) {
      const primitive = primitives[i];
      const geometry = this._buildGeometry(primitive, index);
      geometry.name = (def.name || ('mesh_' + index)) + (n > 1 ? '_' + i : '');
      const material = primitive.material !== undefined
        ? (this.materials[primitive.material] || this._getDefaultMaterial())
        : this._getDefaultMaterial();
      parts[i] = { geometry, material, name: geometry.name };
    }

    this.meshCache.set(index, parts);
    return parts;
  }

  /* ----------------------------------------------------------------- nodes */

  /**
   * Instantiates every node and wires the hierarchy.
   * @private
   */
  _buildNodes() {
    const defs = this.json.nodes || [];
    const count = defs.length;

    this._assignNodeNames(defs);
    this.nodes = new Array(count);
    for (let i = 0; i < count; i++) this.nodes[i] = this._createNode(defs[i], i);

    for (let i = 0; i < count; i++) {
      const children = defs[i].children;
      if (children === undefined) continue;
      const parent = this.nodes[i];
      for (let k = 0, kn = children.length; k < kn; k++) {
        const child = this.nodes[children[k]];
        if (child === undefined) {
          Logger.warn(
            'GLTFLoader: no ' + i + ' de "' + this.sourceURL + '" referencia o filho ' + children[k] +
            ', inexistente.'
          );
          continue;
        }
        parent.add(child);
      }
    }
  }

  /**
   * Gives every node a unique, non empty name. The animation mixer binds tracks
   * by name, so duplicates would make two nodes fight over the same channel.
   * @param {Array<Object>} defs
   * @private
   */
  _assignNodeNames(defs) {
    const used = new Set();
    const names = new Array(defs.length);
    for (let i = 0, n = defs.length; i < n; i++) {
      let name = typeof defs[i].name === 'string' && defs[i].name !== '' ? defs[i].name : 'node_' + i;
      if (used.has(name)) {
        let candidate = name + '_' + i;
        let suffix = i;
        while (used.has(candidate)) {
          suffix++;
          candidate = name + '_' + suffix;
        }
        Logger.debug(
          'GLTFLoader: nome de no duplicado "' + name + '" em "' + this.sourceURL + '"; renomeado para "' +
          candidate + '" para nao quebrar as animacoes.'
        );
        name = candidate;
      }
      used.add(name);
      names[i] = name;
    }
    this.nodeNames = names;
  }

  /**
   * Creates one node with the right concrete class.
   * @param {Object} def
   * @param {number} index
   * @returns {Node3D}
   * @private
   */
  _createNode(def, index) {
    const name = this.nodeNames[index];
    let node = null;
    let camera = null;
    let light = null;

    if (def.mesh !== undefined) {
      node = this._createMeshNode(def, index, name);
    }

    if (def.camera !== undefined) {
      camera = this._createCamera(def.camera, node === null ? name : name + '_camera');
      if (node === null) {
        node = camera;
        camera = null;
      }
    }

    const lightIndex = def.extensions && def.extensions.KHR_lights_punctual
      ? def.extensions.KHR_lights_punctual.light
      : undefined;
    if (lightIndex !== undefined) {
      light = this._createLight(lightIndex, node === null ? name : name + '_light');
      if (node === null) {
        node = light;
        light = null;
      }
    }

    if (node === null) node = new Node3D(name);
    node.name = name;
    node.userData.gltfIndex = index;

    this._applyTransform(node, def);
    // A node carrying both a mesh and a camera/light keeps the extras as
    // children, so all three share the node transform.
    if (camera !== null) node.add(camera);
    if (light !== null) node.add(light);

    if (def.mesh !== undefined) {
      const weights = def.weights || (this.json.meshes[def.mesh] || {}).weights;
      if (Array.isArray(weights) && weights.length > 0) {
        node.morphTargetInfluences = new Float32Array(weights);
      }
    }

    return node;
  }

  /**
   * Builds the renderable subtree of a node that carries a mesh.
   * @param {Object} def
   * @param {number} index
   * @param {string} name
   * @returns {Node3D}
   * @private
   */
  _createMeshNode(def, index, name) {
    const parts = this._getMeshParts(def.mesh);
    const skinned = def.skin !== undefined;

    if (parts.length === 0) return new Node3D(name);

    if (parts.length === 1) {
      const mesh = this._createRenderable(parts[0], skinned, name);
      if (skinned) this.pendingSkins.push({ mesh, skin: def.skin });
      return mesh;
    }

    const group = new Node3D(name);
    for (let i = 0, n = parts.length; i < n; i++) {
      const mesh = this._createRenderable(parts[i], skinned, parts[i].name);
      group.add(mesh);
      if (skinned) this.pendingSkins.push({ mesh, skin: def.skin });
    }
    return group;
  }

  /**
   * @param {{geometry: Geometry, material: Object}} part
   * @param {boolean} skinned
   * @param {string} name
   * @returns {Mesh}
   * @private
   */
  _createRenderable(part, skinned, name) {
    const useSkinning = skinned &&
      part.geometry.hasAttribute('aJoints') &&
      part.geometry.hasAttribute('aWeights');

    const mesh = useSkinning
      ? new SkinnedMesh(part.geometry, part.material)
      : new Mesh(part.geometry, part.material);

    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Copies the glTF transform (matrix OR TRS) onto a node.
   * @param {Node3D} node
   * @param {Object} def
   * @private
   */
  _applyTransform(node, def) {
    if (Array.isArray(def.matrix) && def.matrix.length === 16) {
      _matrix.fromArray(def.matrix);
      _matrix.decompose(node.position, node.quaternion, node.scale);
      return;
    }
    if (Array.isArray(def.translation)) node.position.fromArray(def.translation);
    if (Array.isArray(def.rotation)) node.quaternion.fromArray(def.rotation);
    if (Array.isArray(def.scale)) node.scale.fromArray(def.scale);
  }

  /* --------------------------------------------------------------- cameras */

  /**
   * @param {number} index
   * @param {string} name
   * @returns {Object} PerspectiveCamera or OrthographicCamera
   * @private
   */
  _createCamera(index, name) {
    const def = (this.json.cameras || [])[index];
    if (def === undefined) {
      Logger.warn('GLTFLoader: camera ' + index + ' inexistente em "' + this.sourceURL + '".');
      return new Node3D(name);
    }

    const defaultFar = this.options.defaultFar !== undefined ? this.options.defaultFar : 2000000;
    let camera;

    if (def.type === 'orthographic') {
      const ortho = def.orthographic || {};
      const xmag = ortho.xmag !== undefined ? ortho.xmag : 1;
      const ymag = ortho.ymag !== undefined ? ortho.ymag : 1;
      const near = ortho.znear !== undefined ? ortho.znear : 0.1;
      const far = ortho.zfar !== undefined ? ortho.zfar : defaultFar;
      camera = new OrthographicCamera(-xmag, xmag, ymag, -ymag, near, far);
    } else {
      const persp = def.perspective || {};
      // glTF stores the VERTICAL field of view in radians.
      const fov = (persp.yfov !== undefined ? persp.yfov : 1) * RAD2DEG;
      const aspect = persp.aspectRatio !== undefined && persp.aspectRatio > 0 ? persp.aspectRatio : 1;
      const near = persp.znear !== undefined ? persp.znear : 0.1;
      const far = persp.zfar !== undefined ? persp.zfar : defaultFar;
      camera = new PerspectiveCamera(fov, aspect, near, far);
    }

    camera.name = def.name || name;
    camera.updateProjection();
    this.cameras.push(camera);
    return camera;
  }

  /* ---------------------------------------------------------------- lights */

  /**
   * Instantiates a KHR_lights_punctual light.
   * @param {number} index
   * @param {string} name
   * @returns {Object}
   * @private
   */
  _createLight(index, name) {
    const ext = this.json.extensions && this.json.extensions.KHR_lights_punctual;
    const def = ext && Array.isArray(ext.lights) ? ext.lights[index] : undefined;
    if (def === undefined) {
      Logger.warn(
        'GLTFLoader: luz KHR_lights_punctual ' + index + ' inexistente em "' + this.sourceURL + '".'
      );
      return new Node3D(name);
    }

    const intensity = def.intensity !== undefined ? def.intensity : 1;
    const range = def.range !== undefined ? def.range : 0;
    let light;

    if (def.type === 'directional') {
      light = new DirectionalLight(0xffffff, intensity);
    } else if (def.type === 'spot') {
      const spot = def.spot || {};
      const outer = spot.outerConeAngle !== undefined ? spot.outerConeAngle : Math.PI / 4;
      const inner = spot.innerConeAngle !== undefined ? spot.innerConeAngle : 0;
      light = new SpotLight(0xffffff, intensity, range, outer, 0);
      light.angle = outer;
      light.penumbra = outer > 0 ? Math.max(0, Math.min(1, 1 - inner / outer)) : 0;
    } else {
      light = new PointLight(0xffffff, intensity, range);
    }

    // glTF colours are linear, exactly like Color.
    const color = Array.isArray(def.color) ? def.color : [1, 1, 1];
    light.color.set(color[0], color[1], color[2]);
    light.intensity = intensity;
    light.range = range;
    // The light points along the node local -Z; there is no separate target node.
    light.useTarget = false;
    light.name = def.name || name;

    this.lights.push(light);
    return light;
  }

  /* ----------------------------------------------------------------- skins */

  /**
   * Builds the skeletons and binds them to the skinned meshes created earlier.
   * @private
   */
  _buildSkins() {
    const defs = this.json.skins || [];
    this.skeletons = new Array(defs.length);

    for (let i = 0, n = defs.length; i < n; i++) {
      const def = defs[i];
      const joints = def.joints || [];
      const bones = new Array(joints.length);
      for (let k = 0, kn = joints.length; k < kn; k++) {
        const bone = this.nodes[joints[k]];
        if (bone === undefined) {
          Logger.warn(
            'GLTFLoader: skin ' + i + ' de "' + this.sourceURL + '" referencia o no ' + joints[k] +
            ', inexistente; usando um no vazio.'
          );
          bones[k] = new Node3D('missing_joint_' + joints[k]);
        } else {
          bones[k] = bone;
        }
      }

      let inverses = null;
      if (def.inverseBindMatrices !== undefined) {
        const accessor = this.readAccessor(def.inverseBindMatrices);
        if (accessor.count < joints.length) {
          throw new Error(
            'GLTFLoader: skin ' + i + ' de "' + this.sourceURL + '" tem ' + joints.length +
            ' juntas mas apenas ' + accessor.count + ' inverseBindMatrices.'
          );
        }
        inverses = accessor.array instanceof Float32Array
          ? accessor.array
          : new Float32Array(accessor.array);
      }

      const skeleton = new Skeleton(bones, inverses);
      skeleton.name = def.name || ('skin_' + i);
      this.skeletons[i] = skeleton;
    }

    // glTF requires the transform of a skinned mesh node to be ignored: the joint
    // matrices already carry everything. An identity bind matrix plus the
    // 'attached' bind mode gives exactly worldPos = jointWorld * inverseBind * p.
    for (let i = 0, n = this.pendingSkins.length; i < n; i++) {
      const pending = this.pendingSkins[i];
      const skeleton = this.skeletons[pending.skin];
      if (skeleton === undefined) {
        Logger.warn(
          'GLTFLoader: a mesh "' + pending.mesh.name + '" de "' + this.sourceURL + '" referencia a skin ' +
          pending.skin + ', inexistente; ela sera renderizada sem skinning.'
        );
        continue;
      }
      if (typeof pending.mesh.bind !== 'function') continue;
      pending.mesh.bindMode = 'attached';
      pending.mesh.bind(skeleton, new Mat4());
      pending.mesh.frustumCulled = true;
      if (typeof pending.mesh.normalizeSkinWeights === 'function') {
        pending.mesh.normalizeSkinWeights();
      }
    }
  }

  /* ---------------------------------------------------------------- scenes */

  /**
   * Builds one root node per glTF scene.
   * @private
   */
  _buildScenes() {
    const defs = this.json.scenes || [];
    this.scenes = new Array(defs.length);

    for (let i = 0, n = defs.length; i < n; i++) {
      const def = defs[i];
      const root = new Node3D(def.name || ('scene_' + i));
      const nodes = def.nodes || [];
      for (let k = 0, kn = nodes.length; k < kn; k++) {
        const node = this.nodes[nodes[k]];
        if (node === undefined) {
          Logger.warn(
            'GLTFLoader: a cena ' + i + ' de "' + this.sourceURL + '" referencia o no ' + nodes[k] +
            ', inexistente.'
          );
          continue;
        }
        root.add(node);
      }
      this.scenes[i] = root;
    }

    if (this.scenes.length === 0) {
      // A glTF with nodes but no scene is legal; expose every root under one node.
      const root = new Node3D('scene_0');
      for (let i = 0, n = this.nodes.length; i < n; i++) {
        if (this.nodes[i].parent === null) root.add(this.nodes[i]);
      }
      this.scenes.push(root);
    }
  }

  /**
   * Flattens the renderable meshes of every scene.
   * @returns {Array<Mesh>}
   * @private
   */
  _collectMeshes() {
    const out = [];
    const seen = new Set();
    const collect = (child) => {
      if (child.isMesh === true && !seen.has(child)) {
        seen.add(child);
        out.push(child);
      }
    };
    for (let i = 0, n = this.scenes.length; i < n; i++) this.scenes[i].traverse(collect);
    // Nodes left outside every scene are still part of the result.
    for (let i = 0, n = this.nodes.length; i < n; i++) {
      if (this.nodes[i].parent === null) this.nodes[i].traverse(collect);
    }
    return out;
  }

  /* ------------------------------------------------------------ animations */

  /**
   * Converts every glTF animation into an {@link AnimationClip}.
   * @private
   */
  _buildAnimations() {
    const defs = this.json.animations || [];
    this.animations = [];

    for (let i = 0, n = defs.length; i < n; i++) {
      const def = defs[i];
      const channels = def.channels || [];
      const samplers = def.samplers || [];
      const tracks = [];

      for (let c = 0, cn = channels.length; c < cn; c++) {
        const track = this._buildTrack(channels[c], samplers, i);
        if (track !== null) tracks.push(track);
      }

      if (tracks.length === 0) {
        Logger.warn(
          'GLTFLoader: a animacao ' + i + ' de "' + this.sourceURL + '" nao produziu nenhuma track valida.'
        );
        continue;
      }

      const clip = new AnimationClip(def.name || ('animation_' + i), -1, tracks);
      this.animations.push(clip);
    }
  }

  /**
   * Builds one {@link KeyframeTrack} from an animation channel.
   * @param {Object} channel
   * @param {Array<Object>} samplers
   * @param {number} animationIndex
   * @returns {KeyframeTrack|null}
   * @private
   */
  _buildTrack(channel, samplers, animationIndex) {
    const target = channel.target;
    if (!target || target.node === undefined) return null;

    const sampler = samplers[channel.sampler];
    if (sampler === undefined) {
      Logger.warn(
        'GLTFLoader: canal da animacao ' + animationIndex + ' de "' + this.sourceURL +
        '" aponta para o sampler ' + channel.sampler + ', inexistente.'
      );
      return null;
    }

    const property = ANIMATION_PATHS[target.path];
    if (property === undefined) {
      Logger.warn(
        'GLTFLoader: caminho de animacao "' + target.path + '" desconhecido em "' + this.sourceURL +
        '"; canal ignorado.'
      );
      return null;
    }

    const nodeName = this.nodeNames[target.node];
    if (nodeName === undefined) {
      Logger.warn(
        'GLTFLoader: a animacao ' + animationIndex + ' de "' + this.sourceURL + '" anima o no ' +
        target.node + ', inexistente.'
      );
      return null;
    }

    const times = this.readAccessorAsFloat(sampler.input);
    const values = this.readAccessorAsFloat(sampler.output);
    if (times.length === 0) return null;

    const interpolation = (sampler.interpolation || 'LINEAR').toLowerCase();
    const samplesPerKey = interpolation === 'cubicspline' ? 3 : 1;

    let valueSize;
    if (property === 'quaternion') {
      valueSize = 4;
    } else if (property === 'position' || property === 'scale') {
      valueSize = 3;
    } else {
      // Morph weights: one value per target, per keyframe.
      valueSize = Math.max(1, Math.floor(values.length / (times.length * samplesPerKey)));
    }

    const expected = times.length * valueSize * samplesPerKey;
    if (values.length < expected) {
      Logger.warn(
        'GLTFLoader: a animacao ' + animationIndex + ' de "' + this.sourceURL + '" tem um sampler com ' +
        values.length + ' valores mas precisaria de ' + expected + '; canal ignorado.'
      );
      return null;
    }

    // The engine's CUBICSPLINE evaluator already implements the glTF Hermite
    // form (tangents scaled by the keyframe delta), so the raw layout
    // [inTangent, value, outTangent] can be handed over untouched.
    return new KeyframeTrack(nodeName + '.' + property, times, values, valueSize, interpolation);
  }
}
