/**
 * Wavefront OBJ loader with basic MTL support.
 *
 * What it handles:
 *  - `v` (with the optional trailing r/g/b vertex colour some exporters write),
 *    `vt`, `vn`, `f`, `l`, `p`;
 *  - positive, negative (relative) and omitted index components (`v`, `v/vt`,
 *    `v//vn`, `v/vt/vn`), with fan triangulation of n-gons;
 *  - `o` / `g` object splitting, `usemtl` material groups and `mtllib`;
 *  - the classic MTL properties (Kd, Ks, Ke, Ns, Ni, d/Tr, illum), the PBR
 *    extension properties (Pr, Pm) and the map_* statements with their inline
 *    option flags (`-s`, `-o`, `-bm`, ...).
 *
 * Vertices are de-duplicated on the exact OBJ `v/vt/vn` triple, so the produced
 * geometry is indexed and the index buffer is as small as the file allows.
 * OBJ is right handed and +Y up, exactly like the engine, so no axis conversion
 * is applied.
 */

import { Node3D } from '../scene/Node3D.js';
import { Mesh } from '../scene/Mesh.js';
import { Geometry } from '../render/Geometry.js';
import { StandardMaterial } from '../render/materials/StandardMaterial.js';
import { computeNormals, computeTangents } from '../geometry/GeometryUtils.js';
import { srgbToLinear } from '../math/Color.js';
import { Logger } from '../core/Logger.js';

import { resolveURL, extractBasePath, fetchText } from './AssetManager.js';
import { loadImageSource, createTextureFromImage, disposeImage } from './ImageLoader.js';

/** Number of arguments consumed by each MTL texture option flag. */
const MTL_FLAG_ARITY = {
  '-blendu': 1,
  '-blendv': 1,
  '-boost': 1,
  '-cc': 1,
  '-clamp': 1,
  '-imfchan': 1,
  '-texres': 1,
  '-bm': 1,
  '-type': 1,
  '-mm': 2
};

/** MTL texture option flags that take 1 to 3 numbers. */
const MTL_FLAG_VECTOR = { '-o': 1, '-s': 1, '-t': 1 };

/** GL wrap enums used when an MTL map declares `-clamp on`. */
const GL_REPEAT = 10497;
const GL_CLAMP_TO_EDGE = 33071;

/* ------------------------------------------------------------------------ */
/* Growable typed array                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Append-only typed array that doubles its capacity. Avoids the memory blow-up
 * of building a multi-million entry plain `Array` while parsing.
 */
class NumberList {
  /**
   * @param {Function} Ctor Typed array constructor.
   * @param {number} [capacity=1024]
   */
  constructor(Ctor, capacity = 1024) {
    /** @type {ArrayBufferView} */
    this.data = new Ctor(capacity);
    /** @type {number} */
    this.length = 0;
    /** @private */
    this._Ctor = Ctor;
  }

  /**
   * Makes sure `extra` more elements fit.
   * @param {number} extra
   * @private
   */
  _reserve(extra) {
    const required = this.length + extra;
    if (required <= this.data.length) return;
    let capacity = this.data.length > 0 ? this.data.length : 1024;
    while (capacity < required) capacity *= 2;
    const next = new this._Ctor(capacity);
    next.set(this.data);
    this.data = next;
  }

  /** @param {number} a */
  push1(a) {
    this._reserve(1);
    this.data[this.length++] = a;
  }

  /** @param {number} a @param {number} b */
  push2(a, b) {
    this._reserve(2);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }

  /** @param {number} a @param {number} b @param {number} c */
  push3(a, b, c) {
    this._reserve(3);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }

  /** @param {number} a @param {number} b @param {number} c @param {number} d */
  push4(a, b, c, d) {
    this._reserve(4);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
    this.data[this.length++] = d;
  }

  /** @returns {ArrayBufferView} A right-sized copy. */
  toTypedArray() {
    return this.data.slice(0, this.length);
  }
}

/* ------------------------------------------------------------------------ */
/* Per-object builder                                                        */
/* ------------------------------------------------------------------------ */

/**
 * Accumulates the vertices of one OBJ object (or of one contiguous run of a
 * single primitive kind inside it).
 */
class ObjectBuilder {
  /**
   * @param {string} name
   * @param {string} mode `'triangles'` | `'lines'` | `'points'`
   */
  constructor(name, mode) {
    /** @type {string} */
    this.name = name;
    /** @type {string} */
    this.mode = mode;

    this.positions = new NumberList(Float32Array);
    this.normals = new NumberList(Float32Array);
    this.uvs = new NumberList(Float32Array);
    this.colors = new NumberList(Float32Array);
    this.indices = new NumberList(Uint32Array);

    /** @type {Array<{materialName: string|null, start: number, count: number}>} */
    this.groups = [];
    /** @type {Object|null} */
    this.currentGroup = null;

    /** @type {Map<number, Array<number>>} v index -> [combinedKey, emitted, ...] */
    this.vertexMap = new Map();

    /** @type {boolean} */
    this.hasNormals = false;
    /** @type {boolean} */
    this.hasUVs = false;
    /** @type {boolean} */
    this.hasColors = false;
    /** @type {number} */
    this.vertexCount = 0;
  }

  /**
   * Opens a new material group (closing the previous one).
   * @param {string|null} materialName
   */
  startGroup(materialName) {
    if (this.currentGroup !== null && this.currentGroup.count === 0) {
      // Nothing was emitted into the previous group: just retarget it.
      this.currentGroup.materialName = materialName;
      return;
    }
    const group = { materialName, start: this.indices.length, count: 0 };
    this.groups.push(group);
    this.currentGroup = group;
  }

  /**
   * Appends one index, growing the active group.
   * @param {number} index
   */
  pushIndex(index) {
    if (this.currentGroup === null) this.startGroup(null);
    this.indices.push1(index);
    this.currentGroup.count++;
  }
}

/* ------------------------------------------------------------------------ */
/* MTL                                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Splits an MTL `map_*` statement into its option flags and its filename.
 *
 * Filenames are allowed to contain spaces, so everything that is not consumed
 * by a known flag becomes part of the name.
 *
 * @param {Array<string>} tokens Tokens after the statement keyword.
 * @returns {{file: string, options: Object}}
 */
export function parseMTLMapStatement(tokens) {
  const options = {};
  const nameParts = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    const flag = token.toLowerCase();

    if (MTL_FLAG_ARITY[flag] !== undefined) {
      const arity = MTL_FLAG_ARITY[flag];
      options[flag.slice(1)] = tokens.slice(i + 1, i + 1 + arity).join(' ');
      i += 1 + arity;
      continue;
    }

    if (MTL_FLAG_VECTOR[flag] !== undefined) {
      const values = [];
      let k = i + 1;
      while (k < tokens.length && values.length < 3) {
        const value = parseFloat(tokens[k]);
        if (!(value === value)) break; // NaN check without isNaN
        values.push(value);
        k++;
      }
      options[flag.slice(1)] = values;
      i = k;
      continue;
    }

    nameParts.push(token);
    i++;
  }

  return { file: nameParts.join(' '), options };
}

/**
 * Parses an MTL document into raw material descriptions.
 * @param {string} text
 * @returns {Map<string, Object>} Material name -> raw property bag.
 */
export function parseMTL(text) {
  const materials = new Map();
  let current = null;

  const lines = text.split('\n');
  const tokens = [];

  for (let i = 0, n = lines.length; i < n; i++) {
    const line = lines[i].trim();
    if (line === '' || line.charCodeAt(0) === 35 /* # */) continue;

    tokens.length = 0;
    let start = -1;
    for (let c = 0, cn = line.length; c <= cn; c++) {
      const code = c < cn ? line.charCodeAt(c) : 32;
      const isSpace = code === 32 || code === 9 || code === 13;
      if (isSpace) {
        if (start >= 0) {
          tokens.push(line.slice(start, c));
          start = -1;
        }
      } else if (start < 0) {
        start = c;
      }
    }
    if (tokens.length === 0) continue;

    const keyword = tokens[0].toLowerCase();
    const args = tokens.slice(1);

    if (keyword === 'newmtl') {
      const name = args.join(' ') || ('material_' + materials.size);
      current = { name, maps: {} };
      materials.set(name, current);
      continue;
    }
    if (current === null) continue;

    switch (keyword) {
      case 'ka': current.ambient = readVec3(args); break;
      case 'kd': current.diffuse = readVec3(args); break;
      case 'ks': current.specular = readVec3(args); break;
      case 'ke': current.emissive = readVec3(args); break;
      case 'ns': current.shininess = parseFloat(args[0]); break;
      case 'ni': current.ior = parseFloat(args[0]); break;
      case 'pr': current.roughness = parseFloat(args[0]); break;
      case 'pm': current.metallic = parseFloat(args[0]); break;
      case 'illum': current.illum = parseInt(args[0], 10); break;
      case 'd': current.opacity = parseFloat(args[0]); break;
      case 'tr': {
        const value = parseFloat(args[0]);
        // `Tr` is the inverse of `d`; only use it when `d` was not given.
        if (current.opacity === undefined && value === value) current.opacity = 1 - value;
        break;
      }
      case 'map_kd':
      case 'map_ks':
      case 'map_ke':
      case 'map_ka':
      case 'map_d':
      case 'map_pr':
      case 'map_pm':
      case 'map_bump':
      case 'bump':
      case 'norm':
      case 'map_ns':
      case 'disp':
        current.maps[keyword] = parseMTLMapStatement(args);
        break;
      default:
        break;
    }
  }

  return materials;
}

/**
 * Reads up to three floats out of a token list.
 * @param {Array<string>} args
 * @returns {Array<number>}
 */
function readVec3(args) {
  const x = parseFloat(args[0]);
  const y = args.length > 1 ? parseFloat(args[1]) : x;
  const z = args.length > 2 ? parseFloat(args[2]) : x;
  return [x === x ? x : 0, y === y ? y : 0, z === z ? z : 0];
}

/* ------------------------------------------------------------------------ */
/* OBJLoader                                                                 */
/* ------------------------------------------------------------------------ */

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
  constructor(gl = null, options = {}) {
    /** @type {WebGL2RenderingContext|null} */
    this.gl = gl || null;
    /** @type {Object} */
    this.options = options;
    /** @type {string} */
    this.basePath = options.basePath || '';
    /** @type {Object|null} */
    this.manager = options.manager || null;
  }

  /**
   * @param {string} basePath
   * @returns {OBJLoader} this
   */
  setBasePath(basePath) {
    this.basePath = basePath || '';
    return this;
  }

  /**
   * Downloads and parses an .obj file (and the .mtl files it references).
   * @param {string} url
   * @returns {Promise<Object>} See {@link OBJLoader#parse}.
   */
  async load(url) {
    if (typeof url !== 'string' || url === '') {
      throw new Error('OBJLoader.load: url invalida (' + String(url) + ').');
    }
    const resolved = resolveURL(url, this.basePath);
    let text;
    try {
      text = await fetchText(resolved, {
        credentials: this.options.credentials || 'same-origin',
        signal: this.options.signal,
        label: resolved
      });
    } catch (err) {
      throw new Error(
        'OBJLoader: nao foi possivel baixar "' + resolved + '": ' +
        (err && err.message ? err.message : String(err))
      );
    }
    return this.parse(text, extractBasePath(resolved), resolved);
  }

  /**
   * Parses OBJ source text.
   *
   * @param {string} text
   * @param {string} [basePath] Used to resolve `mtllib` and texture paths.
   * @param {string} [sourceURL] Only used to make error messages readable.
   * @returns {Promise<Object>} `{ scene, meshes, geometries, materials, objects,
   *   materialLibraries, textures, dispose() }`
   */
  async parse(text, basePath, sourceURL) {
    if (typeof text !== 'string') {
      throw new Error('OBJLoader.parse: esperava o conteudo do arquivo como texto.');
    }
    const label = sourceURL || '(obj em memoria)';
    const base = basePath !== undefined && basePath !== null ? basePath : this.basePath;

    const parsed = this.parseSync(text, label);

    const textures = [];
    let materialMap = new Map();
    if (this.options.loadMaterials !== false && parsed.materialLibraries.length > 0) {
      materialMap = await this._loadMaterialLibraries(parsed.materialLibraries, base, label, textures);
    }

    const scene = new Node3D('OBJ');
    const meshes = [];
    const geometries = [];
    const materials = [];

    for (let i = 0, n = parsed.objects.length; i < n; i++) {
      const built = this._buildMesh(parsed.objects[i], materialMap, materials, label);
      if (built === null) continue;
      geometries.push(built.geometry);
      meshes.push(built.mesh);
      scene.add(built.mesh);
    }

    return {
      scene,
      scenes: [scene],
      meshes,
      geometries,
      materials,
      materialLibraries: parsed.materialLibraries,
      textures,
      animations: [],
      cameras: [],
      dispose: () => {
        for (let i = 0, n = geometries.length; i < n; i++) geometries[i].dispose(this.gl);
        for (let i = 0, n = textures.length; i < n; i++) {
          if (textures[i] && typeof textures[i].dispose === 'function') textures[i].dispose();
        }
        for (let i = 0, n = materials.length; i < n; i++) {
          if (materials[i] && typeof materials[i].dispose === 'function') materials[i].dispose();
        }
      }
    };
  }

  /* ------------------------------------------------------------- OBJ parse */

  /**
   * Pure, synchronous OBJ text parse. Touches no network and no GPU.
   *
   * @param {string} text
   * @param {string} [label] Name used in warnings.
   * @returns {{objects: Array<ObjectBuilder>, materialLibraries: Array<string>}}
   */
  parseSync(text, label = '(obj)') {
    // Global vertex pools shared by every object, as OBJ indices are global.
    const positions = new NumberList(Float32Array, 3072);
    const normals = new NumberList(Float32Array, 3072);
    const uvs = new NumberList(Float32Array, 2048);
    const colors = new NumberList(Float32Array, 3072);

    const objects = [];
    const materialLibraries = [];
    const srgbColors = (this.options.colorSpace || 'srgb') === 'srgb';

    let objectName = '';
    let currentMaterial = null;
    /** @type {ObjectBuilder|null} */
    let builder = null;
    let anyVertexColor = false;

    // Scratch token storage, reused for every line.
    const tokens = [];
    // Scratch face vertex storage: [v, vt, vn] triples of the current face.
    const face = [];

    const startObject = (name) => {
      objectName = name;
      builder = null;
    };

    const getBuilder = (mode) => {
      if (builder !== null && builder.mode === mode) return builder;
      const suffix = mode === 'triangles' ? '' : ('_' + mode);
      const name = (objectName !== '' ? objectName : 'object_' + objects.length) + suffix;
      builder = new ObjectBuilder(name, mode);
      builder.startGroup(currentMaterial);
      objects.push(builder);
      return builder;
    };

    const length = text.length;
    let cursor = 0;

    while (cursor <= length) {
      let lineEnd = text.indexOf('\n', cursor);
      if (lineEnd < 0) lineEnd = length;
      const line = text.slice(cursor, lineEnd);
      cursor = lineEnd + 1;

      // Tokenize in place.
      tokens.length = 0;
      let start = -1;
      let comment = false;
      for (let c = 0, cn = line.length; c <= cn; c++) {
        const code = c < cn ? line.charCodeAt(c) : 32;
        if (code === 35 /* # */) {
          if (start >= 0) tokens.push(line.slice(start, c));
          comment = true;
          break;
        }
        const isSpace = code === 32 || code === 9 || code === 13;
        if (isSpace) {
          if (start >= 0) {
            tokens.push(line.slice(start, c));
            start = -1;
          }
        } else if (start < 0) {
          start = c;
        }
      }
      if (tokens.length === 0) {
        if (comment || line.length === 0) continue;
        continue;
      }

      const keyword = tokens[0];

      if (keyword === 'v') {
        positions.push3(parseFloat(tokens[1]), parseFloat(tokens[2]), parseFloat(tokens[3]));
        if (tokens.length >= 7) {
          // Some exporters append a per-vertex colour after the position.
          let r = parseFloat(tokens[4]);
          let g = parseFloat(tokens[5]);
          let b = parseFloat(tokens[6]);
          if (r === r && g === g && b === b) {
            if (srgbColors) {
              r = srgbToLinear(r);
              g = srgbToLinear(g);
              b = srgbToLinear(b);
            }
            colors.push3(r, g, b);
            anyVertexColor = true;
          } else {
            colors.push3(1, 1, 1);
          }
        } else if (anyVertexColor) {
          colors.push3(1, 1, 1);
        }
        continue;
      }

      if (keyword === 'vt') {
        uvs.push2(parseFloat(tokens[1]), tokens.length > 2 ? parseFloat(tokens[2]) : 0);
        continue;
      }

      if (keyword === 'vn') {
        normals.push3(parseFloat(tokens[1]), parseFloat(tokens[2]), parseFloat(tokens[3]));
        continue;
      }

      if (keyword === 'f') {
        const target = getBuilder('triangles');
        face.length = 0;
        for (let t = 1, tn = tokens.length; t < tn; t++) {
          const emitted = this._emitVertex(
            target, tokens[t], positions, uvs, normals, colors, anyVertexColor, label
          );
          if (emitted >= 0) face.push(emitted);
        }
        // Fan triangulation: valid for the convex polygons OBJ is allowed to use.
        for (let t = 1, tn = face.length - 1; t < tn; t++) {
          target.pushIndex(face[0]);
          target.pushIndex(face[t]);
          target.pushIndex(face[t + 1]);
        }
        continue;
      }

      if (keyword === 'l') {
        const target = getBuilder('lines');
        face.length = 0;
        for (let t = 1, tn = tokens.length; t < tn; t++) {
          const emitted = this._emitVertex(
            target, tokens[t], positions, uvs, normals, colors, anyVertexColor, label
          );
          if (emitted >= 0) face.push(emitted);
        }
        for (let t = 0, tn = face.length - 1; t < tn; t++) {
          target.pushIndex(face[t]);
          target.pushIndex(face[t + 1]);
        }
        continue;
      }

      if (keyword === 'p') {
        const target = getBuilder('points');
        for (let t = 1, tn = tokens.length; t < tn; t++) {
          const emitted = this._emitVertex(
            target, tokens[t], positions, uvs, normals, colors, anyVertexColor, label
          );
          if (emitted >= 0) target.pushIndex(emitted);
        }
        continue;
      }

      if (keyword === 'o' || keyword === 'g') {
        startObject(tokens.slice(1).join(' '));
        continue;
      }

      if (keyword === 'usemtl') {
        currentMaterial = tokens.slice(1).join(' ') || null;
        if (builder !== null) builder.startGroup(currentMaterial);
        continue;
      }

      if (keyword === 'mtllib') {
        const file = tokens.slice(1).join(' ');
        if (file !== '' && materialLibraries.indexOf(file) < 0) materialLibraries.push(file);
        continue;
      }

      // 's', 'vp', 'mg', 'bevel', ... carry no information this engine uses.
    }

    // Drop objects that ended up empty (a stray `g` before any face).
    const kept = [];
    for (let i = 0, n = objects.length; i < n; i++) {
      if (objects[i].indices.length > 0) kept.push(objects[i]);
    }

    return { objects: kept, materialLibraries };
  }

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
  _emitVertex(builder, token, positions, uvs, normals, colors, wantColors, label) {
    const first = token.indexOf('/');
    let vRaw;
    let vtRaw = 0;
    let vnRaw = 0;

    if (first < 0) {
      vRaw = parseInt(token, 10);
    } else {
      vRaw = parseInt(token.slice(0, first), 10);
      const second = token.indexOf('/', first + 1);
      if (second < 0) {
        vtRaw = parseInt(token.slice(first + 1), 10);
      } else {
        if (second > first + 1) vtRaw = parseInt(token.slice(first + 1, second), 10);
        vnRaw = parseInt(token.slice(second + 1), 10);
      }
    }

    const positionCount = positions.length / 3;
    const uvCount = uvs.length / 2;
    const normalCount = normals.length / 3;

    const v = resolveIndex(vRaw, positionCount);
    if (v < 0) {
      Logger.warnOnce(
        'OBJLoader.badIndex.' + label,
        'OBJLoader: indice de vertice invalido "' + token + '" em "' + label + '"; vertice ignorado.'
      );
      return -1;
    }
    const vt = vtRaw !== 0 && vtRaw === vtRaw ? resolveIndex(vtRaw, uvCount) : -1;
    const vn = vnRaw !== 0 && vnRaw === vnRaw ? resolveIndex(vnRaw, normalCount) : -1;

    // Cache lookup: one bucket per position index, scanned linearly (buckets
    // hold at most a handful of uv/normal combinations in practice).
    let bucket = builder.vertexMap.get(v);
    const combined = (vt + 1) * 16777216 + (vn + 1);
    if (bucket !== undefined) {
      for (let i = 0, n = bucket.length; i < n; i += 2) {
        if (bucket[i] === combined) return bucket[i + 1];
      }
    } else {
      bucket = [];
      builder.vertexMap.set(v, bucket);
    }

    const emitted = builder.vertexCount++;
    const p = v * 3;
    builder.positions.push3(positions.data[p], positions.data[p + 1], positions.data[p + 2]);

    if (vn >= 0) {
      const o = vn * 3;
      builder.normals.push3(normals.data[o], normals.data[o + 1], normals.data[o + 2]);
      builder.hasNormals = true;
    } else if (builder.hasNormals) {
      builder.normals.push3(0, 0, 0);
    }

    if (vt >= 0) {
      const o = vt * 2;
      builder.uvs.push2(uvs.data[o], uvs.data[o + 1]);
      builder.hasUVs = true;
    } else if (builder.hasUVs) {
      builder.uvs.push2(0, 0);
    }

    if (wantColors && colors.length >= (v + 1) * 3) {
      const o = v * 3;
      builder.colors.push4(colors.data[o], colors.data[o + 1], colors.data[o + 2], 1);
      builder.hasColors = true;
    } else if (builder.hasColors) {
      builder.colors.push4(1, 1, 1, 1);
    }

    bucket.push(combined, emitted);
    return emitted;
  }

  /* ---------------------------------------------------------- mesh assembly */

  /**
   * Turns one builder into a Mesh.
   * @param {ObjectBuilder} builder
   * @param {Map<string, Object>} materialMap
   * @param {Array<Object>} materialsOut Materials actually used, appended in order.
   * @param {string} label
   * @returns {{mesh: Mesh, geometry: Geometry}|null}
   * @private
   */
  _buildMesh(builder, materialMap, materialsOut, label) {
    const geometry = new Geometry();
    geometry.name = builder.name;
    geometry.drawMode = builder.mode;

    const vertexCount = builder.vertexCount;
    geometry.setAttribute('aPosition', builder.positions.toTypedArray(), 3);

    // A partially specified stream (some faces with vn, some without) is padded
    // to the full vertex count so the attribute stays in lockstep with the rest.
    if (builder.hasNormals) {
      geometry.setAttribute('aNormal', padTo(builder.normals, vertexCount * 3), 3);
    }
    if (builder.hasUVs) {
      geometry.setAttribute('aUV0', padTo(builder.uvs, vertexCount * 2), 2);
    }
    if (builder.hasColors) {
      geometry.setAttribute('aColor', padTo(builder.colors, vertexCount * 4, 1), 4);
    }

    const indices = builder.indices.toTypedArray();
    geometry.setIndex(vertexCount > 65535 ? indices : new Uint16Array(indices));

    // --- material groups ----------------------------------------------------
    const usedMaterials = [];
    const groups = [];
    for (let i = 0, n = builder.groups.length; i < n; i++) {
      const group = builder.groups[i];
      if (group.count === 0) continue;
      const material = this._resolveMaterial(group.materialName, materialMap, materialsOut);
      let slot = usedMaterials.indexOf(material);
      if (slot < 0) {
        slot = usedMaterials.length;
        usedMaterials.push(material);
      }
      const previous = groups.length > 0 ? groups[groups.length - 1] : null;
      if (previous !== null && previous.materialIndex === slot &&
          previous.start + previous.count === group.start) {
        previous.count += group.count;
      } else {
        groups.push({ start: group.start, count: group.count, materialIndex: slot });
      }
    }

    if (usedMaterials.length === 0) {
      usedMaterials.push(this._resolveMaterial(null, materialMap, materialsOut));
    }
    if (usedMaterials.length > 1) geometry.groups = groups;

    // --- generated attributes ----------------------------------------------
    if (builder.mode === 'triangles') {
      if (!builder.hasNormals && this.options.generateNormals !== false) {
        computeNormals(geometry);
      }
      if (this.options.generateTangents !== false && builder.hasUVs &&
          !geometry.hasAttribute('aTangent') && this._needsTangents(usedMaterials)) {
        computeTangents(geometry);
      }
    }

    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new Mesh(geometry, usedMaterials.length > 1 ? usedMaterials : usedMaterials[0]);
    mesh.name = builder.name;
    if (builder.mode !== 'triangles') {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
    return { mesh, geometry };
  }

  /**
   * @param {Array<Object>} materials
   * @returns {boolean} True when at least one material samples a normal map.
   * @private
   */
  _needsTangents(materials) {
    for (let i = 0, n = materials.length; i < n; i++) {
      if (materials[i] && materials[i].normalMap) return true;
    }
    return false;
  }

  /**
   * Looks a material up by name, creating the fallback when it is missing.
   * @param {string|null} name
   * @param {Map<string, Object>} materialMap
   * @param {Array<Object>} materialsOut
   * @returns {Object}
   * @private
   */
  _resolveMaterial(name, materialMap, materialsOut) {
    let material = name !== null ? materialMap.get(name) : undefined;
    if (material === undefined) {
      material = materialMap.get('__default__');
      if (material === undefined) {
        material = new StandardMaterial({ name: 'obj_default', metallic: 0, roughness: 0.8 });
        material.baseColor.set(0.8, 0.8, 0.8);
        materialMap.set('__default__', material);
      }
      if (name !== null) {
        Logger.warnOnce(
          'OBJLoader.material.' + name,
          'OBJLoader: material "' + name + '" nao foi encontrado nos arquivos .mtl; usando o padrao.'
        );
      }
    }
    if (materialsOut.indexOf(material) < 0) materialsOut.push(material);
    return material;
  }

  /* ------------------------------------------------------------------ MTL */

  /**
   * Downloads and converts every referenced material library.
   * @param {Array<string>} libraries
   * @param {string} basePath
   * @param {string} label
   * @param {Array<Object>} texturesOut
   * @returns {Promise<Map<string, Object>>}
   * @private
   */
  async _loadMaterialLibraries(libraries, basePath, label, texturesOut) {
    const out = new Map();
    const definitions = new Map();

    for (let i = 0, n = libraries.length; i < n; i++) {
      const url = resolveURL(libraries[i], basePath);
      let text;
      try {
        text = await fetchText(url, {
          credentials: this.options.credentials || 'same-origin',
          signal: this.options.signal,
          label: url
        });
      } catch (err) {
        Logger.warn(
          'OBJLoader: nao foi possivel carregar a biblioteca de materiais "' + libraries[i] +
          '" referenciada por "' + label + '": ' + (err && err.message ? err.message : String(err)) +
          '. Os objetos usarao o material padrao.'
        );
        continue;
      }
      const parsed = parseMTL(text);
      const it = parsed.entries();
      for (let step = it.next(); !step.done; step = it.next()) {
        definitions.set(step.value[0], { def: step.value[1], basePath: extractBasePath(url) || basePath });
      }
    }

    const jobs = [];
    const it = definitions.entries();
    for (let step = it.next(); !step.done; step = it.next()) {
      const name = step.value[0];
      const entry = step.value[1];
      jobs.push(this._createMaterial(name, entry.def, entry.basePath, texturesOut).then((material) => {
        out.set(name, material);
      }));
    }
    await Promise.all(jobs);
    return out;
  }

  /**
   * Converts one MTL description into a {@link StandardMaterial}.
   * @param {string} name
   * @param {Object} def
   * @param {string} basePath
   * @param {Array<Object>} texturesOut
   * @returns {Promise<Object>}
   * @private
   */
  async _createMaterial(name, def, basePath, texturesOut) {
    const material = new StandardMaterial({ name });
    const srgb = (this.options.colorSpace || 'srgb') === 'srgb';

    const diffuse = def.diffuse || [1, 1, 1];
    material.baseColor.set(
      srgb ? srgbToLinear(diffuse[0]) : diffuse[0],
      srgb ? srgbToLinear(diffuse[1]) : diffuse[1],
      srgb ? srgbToLinear(diffuse[2]) : diffuse[2]
    );

    const emissive = def.emissive;
    if (emissive) {
      material.emissive.set(
        srgb ? srgbToLinear(emissive[0]) : emissive[0],
        srgb ? srgbToLinear(emissive[1]) : emissive[1],
        srgb ? srgbToLinear(emissive[2]) : emissive[2]
      );
    }

    // Blinn-Phong exponent -> perceptual roughness, the usual approximation.
    if (def.roughness === def.roughness && def.roughness !== undefined) {
      material.roughness = clamp01(def.roughness);
    } else if (def.shininess === def.shininess && def.shininess !== undefined) {
      material.roughness = clamp01(Math.sqrt(2 / (Math.max(def.shininess, 0) + 2)));
    } else {
      material.roughness = 0.8;
    }

    if (def.metallic === def.metallic && def.metallic !== undefined) {
      material.metallic = clamp01(def.metallic);
    } else if (def.illum === 3 || def.illum === 5) {
      // illum 3/5 declare a reflective surface; treat it as a metal.
      material.metallic = 1;
    } else {
      material.metallic = 0;
    }

    if (def.ior === def.ior && def.ior !== undefined && def.ior > 0) material.ior = def.ior;

    const opacity = def.opacity;
    if (opacity === opacity && opacity !== undefined && opacity < 1) {
      material.opacity = Math.max(0, opacity);
      material.setAlphaMode('blend');
    } else {
      material.opacity = 1;
    }

    if (this.gl !== null && this.options.loadTextures !== false) {
      const maps = def.maps || {};
      const jobs = [];
      const assign = (statement, slot, isSRGB) => {
        if (!statement || !statement.file) return;
        jobs.push(this._loadMap(statement, basePath, isSRGB, name).then((texture) => {
          if (texture === null) return;
          texturesOut.push(texture);
          material[slot] = texture;
          if (slot === 'normalMap' && statement.options.bm !== undefined) {
            const scale = parseFloat(statement.options.bm);
            if (scale === scale) material.normalScale = scale;
          }
        }));
      };

      assign(maps.map_kd, 'baseColorMap', true);
      assign(maps.map_ke, 'emissiveMap', true);
      assign(maps.map_ka, 'occlusionMap', false);

      const bump = maps.norm || maps.map_bump || maps.bump;
      assign(bump, 'normalMap', false);

      // The engine packs metallic and roughness in one texture; only reuse an
      // MTL map when both channels genuinely come from the same file.
      const pr = maps.map_pr;
      const pm = maps.map_pm;
      if (pr && pm && pr.file === pm.file) {
        assign(pr, 'metallicRoughnessMap', false);
      } else if (pr || pm) {
        Logger.warnOnce(
          'OBJLoader.mrSplit.' + name,
          'OBJLoader: o material "' + name + '" define map_Pr/map_Pm em arquivos diferentes; a engine ' +
          'usa uma unica textura metallic-roughness, entao esses mapas serao ignorados.'
        );
      }

      if (maps.map_d) {
        Logger.warnOnce(
          'OBJLoader.alphaMap.' + name,
          'OBJLoader: o material "' + name + '" usa map_d (mapa de opacidade), que a engine nao possui ' +
          'como slot separado; use um PNG com alpha em map_Kd.'
        );
      }

      await Promise.all(jobs);
    }

    if (maps_needTransparency(def) && material.alphaMode === 'opaque') {
      // A base colour map with alpha is common in OBJ kits; keep it masked so
      // foliage cut-outs work without forcing a full sort.
      if (material.baseColorMap) material.setAlphaMode('mask', 0.5);
    }

    material.needsUpdate = true;
    return material;
  }

  /**
   * Loads one MTL texture map.
   * @param {{file: string, options: Object}} statement
   * @param {string} basePath
   * @param {boolean} srgb
   * @param {string} materialName
   * @returns {Promise<Object|null>}
   * @private
   */
  async _loadMap(statement, basePath, srgb, materialName) {
    const url = resolveURL(statement.file.replace(/\\/g, '/'), basePath);
    let source;
    try {
      source = await loadImageSource(url, {
        flipY: false,
        premultiplyAlpha: false,
        credentials: this.options.credentials || 'same-origin',
        crossOrigin: this.options.crossOrigin
      });
    } catch (err) {
      Logger.warn(
        'OBJLoader: nao foi possivel carregar a textura "' + statement.file + '" do material "' +
        materialName + '": ' + (err && err.message ? err.message : String(err))
      );
      return null;
    }

    const clamp = String(statement.options.clamp || '').toLowerCase() === 'on';
    const wrap = clamp ? GL_CLAMP_TO_EDGE : GL_REPEAT;

    try {
      return createTextureFromImage(this.gl, source.image, {
        srgb,
        generateMipmaps: true,
        wrapS: wrap,
        wrapT: wrap,
        anisotropy: this.options.anisotropy,
        flipY: false,
        alreadyFlipped: source.flipped,
        premultiplyAlpha: false,
        name: statement.file,
        state: this.options.state
      });
    } catch (err) {
      Logger.warn(
        'OBJLoader: falha ao criar a textura "' + statement.file + '" do material "' + materialName +
        '": ' + (err && err.message ? err.message : String(err))
      );
      return null;
    } finally {
      if (this.options.keepImages !== true) disposeImage(source.image);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Free helpers                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Converts an OBJ index (1 based, negative = relative to the end) to a 0 based
 * index, or -1 when it is out of range.
 * @param {number} raw
 * @param {number} count
 * @returns {number}
 */
function resolveIndex(raw, count) {
  if (!(raw === raw)) return -1;
  const index = raw > 0 ? raw - 1 : count + raw;
  return index >= 0 && index < count ? index : -1;
}

/**
 * @param {number} value
 * @returns {number} `value` clamped into [0,1] (0 for NaN).
 */
function clamp01(value) {
  if (!(value === value)) return 0;
  return value < 0 ? 0 : (value > 1 ? 1 : value);
}

/**
 * Right-sizes a list, padding the tail with a constant when the stream started
 * later than the first vertex.
 * @param {NumberList} list
 * @param {number} length
 * @param {number} [fill=0]
 * @returns {Float32Array}
 */
function padTo(list, length, fill = 0) {
  if (list.length === length) return list.toTypedArray();
  const out = new Float32Array(length);
  out.set(list.data.subarray(0, Math.min(list.length, length)));
  if (fill !== 0) {
    for (let i = list.length; i < length; i++) out[i] = fill;
  }
  return out;
}

/**
 * True when the material description suggests a cut-out surface.
 * @param {Object} def
 * @returns {boolean}
 */
function maps_needTransparency(def) {
  return def.maps !== undefined && def.maps.map_kd !== undefined;
}
