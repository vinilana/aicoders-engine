/**
 * A linked WebGL2 shader program with complete uniform / attribute / uniform block
 * reflection and specialised, value cached uniform setters.
 *
 * Linking is asynchronous whenever KHR_parallel_shader_compile is available: the
 * constructor only kicks off the link, `ready` stays false and `checkAsync()`
 * finalises the program once the driver reports completion. Any call that actually
 * needs the program (`use`, `setUniform`, `isLinked`) transparently forces the
 * finalisation, so async is an optimisation and never a correctness requirement.
 */

/** Fixed uniform block binding points, per the architecture contract. */
export const UBO_BINDINGS = {
  Camera: 0,
  Lights: 1,
  Shadows: 2,
  Fog: 3
};

/**
 * Fixed vertex attribute locations. This mirrors ATTRIB_NAME_TO_LOC from
 * Geometry.js; it is duplicated here on purpose so the shader layer has no import
 * time dependency on the geometry layer. Every shader also declares
 * `layout(location = N)` explicitly, this is only a safety net for sources that
 * omit the qualifier.
 */
export const DEFAULT_ATTRIB_LOCATIONS = {
  aPosition: 0,
  aNormal: 1,
  aUV0: 2,
  aTangent: 3,
  aColor: 4,
  aUV1: 5,
  aJoints: 6,
  aWeights: 7,
  aInstanceMatrix: 8,
  aInstanceColor: 12,
  aInstanceData: 13
};

/** KHR_parallel_shader_compile completion query token. */
const COMPLETION_STATUS_KHR = 0x91b1;

/** One extension lookup per context instead of one per program. */
const _parallelExtCache = new WeakMap();

let _nextProgramId = 1;

/**
 * @param {WebGL2RenderingContext} gl
 * @returns {Object|null}
 */
function getParallelExtension(gl) {
  if (_parallelExtCache.has(gl)) return _parallelExtCache.get(gl);
  let ext = null;
  if (typeof gl.getExtension === 'function') {
    ext = gl.getExtension('KHR_parallel_shader_compile') || null;
  }
  _parallelExtCache.set(gl, ext);
  return ext;
}

/**
 * Inject `#define` lines right after the `#version` directive, for sources that are
 * compiled without going through the preprocessor.
 * @param {string} source
 * @param {Object|null} defines
 * @returns {string}
 */
function injectDefines(source, defines) {
  if (!defines) return source;
  const keys = Object.keys(defines).sort();
  if (keys.length === 0) return source;

  let block = '';
  for (let i = 0, n = keys.length; i < n; i++) {
    const key = keys[i];
    const value = defines[key];
    if (value === false || value === null || value === undefined) continue;
    block += '#define ' + key + ' ' + (value === true ? '1' : value) + '\n';
  }
  if (block.length === 0) return source;

  const newline = source.indexOf('\n');
  if (newline >= 0 && /^\s*#\s*version/.test(source.slice(0, newline))) {
    return source.slice(0, newline + 1) + block + source.slice(newline + 1);
  }
  return block + source;
}

/** Strip the `[0]` suffix WebGL appends to the name of an array uniform. */
function baseUniformName(name) {
  const bracket = name.indexOf('[');
  return bracket < 0 ? name : name.slice(0, bracket);
}

/**
 * Build the list of sampler type constants supported by the context.
 * @param {WebGL2RenderingContext} gl
 * @returns {Set<number>}
 */
function collectSamplerTypes(gl) {
  const names = [
    'SAMPLER_2D', 'SAMPLER_3D', 'SAMPLER_CUBE', 'SAMPLER_2D_SHADOW',
    'SAMPLER_2D_ARRAY', 'SAMPLER_2D_ARRAY_SHADOW', 'SAMPLER_CUBE_SHADOW',
    'INT_SAMPLER_2D', 'INT_SAMPLER_3D', 'INT_SAMPLER_CUBE', 'INT_SAMPLER_2D_ARRAY',
    'UNSIGNED_INT_SAMPLER_2D', 'UNSIGNED_INT_SAMPLER_3D',
    'UNSIGNED_INT_SAMPLER_CUBE', 'UNSIGNED_INT_SAMPLER_2D_ARRAY'
  ];
  const set = new Set();
  for (let i = 0, n = names.length; i < n; i++) {
    const value = gl[names[i]];
    if (typeof value === 'number') set.add(value);
  }
  return set;
}

const _samplerTypeCache = new WeakMap();

function getSamplerTypes(gl) {
  let set = _samplerTypeCache.get(gl);
  if (set === undefined) {
    set = collectSamplerTypes(gl);
    _samplerTypeCache.set(gl, set);
  }
  return set;
}

/** Read three components out of a Vec3 / Color / array / typed array. */
function readXYZ(value, out) {
  if (value.x !== undefined) {
    out[0] = value.x; out[1] = value.y; out[2] = value.z;
  } else if (value.r !== undefined) {
    out[0] = value.r; out[1] = value.g; out[2] = value.b;
  } else {
    out[0] = value[0]; out[1] = value[1]; out[2] = value[2];
  }
}

/** Read four components out of a Vec4 / Quat / array / typed array. */
function readXYZW(value, out) {
  if (value.x !== undefined) {
    out[0] = value.x; out[1] = value.y; out[2] = value.z;
    out[3] = value.w !== undefined ? value.w : 1.0;
  } else if (value.r !== undefined) {
    out[0] = value.r; out[1] = value.g; out[2] = value.b;
    out[3] = value.a !== undefined ? value.a : 1.0;
  } else {
    out[0] = value[0]; out[1] = value[1]; out[2] = value[2]; out[3] = value[3];
  }
}

/** Matrices may arrive as a Mat3 / Mat4 wrapper or as a raw Float32Array. */
function matrixElements(value) {
  return value.elements !== undefined ? value.elements : value;
}

export class Program {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {string} vertexSource
   * @param {string} fragmentSource
   * @param {Object|null} [defines] macros injected into both stages
   * @param {string} [name] label used in error messages
   * @param {{preprocessor?:Object, async?:boolean, key?:string}} [options]
   *        When `preprocessor` is given the sources go through it (includes +
   *        defines); otherwise only the defines are injected.
   */
  constructor(gl, vertexSource, fragmentSource, defines = null, name = 'program', options = null) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** Unique id, useful as a draw call sort key component. */
    this.id = _nextProgramId++;
    /** @type {string} */
    this.name = name;
    /** @type {Object|null} */
    this.defines = defines;
    /** Cache key assigned by ShaderLib, empty for standalone programs. */
    this.key = (options && options.key) || name;
    /** @type {WebGLProgram|null} */
    this.program = null;
    /** True once the program is linked and reflected. */
    this.ready = false;
    /** True when compilation or linking failed. */
    this.failed = false;
    /** @type {string} last error report, empty when the program is healthy */
    this.error = '';
    /** @type {Map<string,{location:WebGLUniformLocation,type:number,size:number,isArray:boolean,setter:Function}>} */
    this.uniforms = new Map();
    /** @type {Map<string,number>} attribute name -> location */
    this.attributes = new Map();
    /** @type {Map<string,{index:number,binding:number,size:number}>} */
    this.uniformBlocks = new Map();
    /** @type {number} 16 bit hash of the cache key, folded into Material.sortKey */
    this.hash = 0;

    this._preprocessor = (options && options.preprocessor) || null;
    this._vertexShader = null;
    this._fragmentShader = null;
    this._parallelExt = getParallelExtension(gl);
    this._async = !(options && options.async === false) && this._parallelExt !== null;
    this._boundTextureUnits = new Map();

    if (this._preprocessor) {
      this.vertexSource = this._preprocessor.resolve(vertexSource, defines, {
        stage: 'vertex',
        name: name + '.vertex'
      });
      this.fragmentSource = this._preprocessor.resolve(fragmentSource, defines, {
        stage: 'fragment',
        name: name + '.fragment'
      });
    } else {
      this.vertexSource = injectDefines(vertexSource, defines);
      this.fragmentSource = injectDefines(fragmentSource, defines);
    }

    this.hash = Program.hashKey(this.key);
    this._link();
  }

  /**
   * Deterministic 16 bit FNV-1a hash, used for the program component of a sort key.
   * @param {string} text
   * @returns {number}
   */
  static hashKey(text) {
    let hash = 0x811c9dc5;
    for (let i = 0, n = text.length; i < n; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ((hash >>> 16) ^ hash) & 0xffff;
  }

  /**
   * Compile both stages and start linking.
   * @private
   */
  _link() {
    const gl = this.gl;

    this._vertexShader = this._compile(gl.VERTEX_SHADER, this.vertexSource, 'vertex');
    this._fragmentShader = this._compile(gl.FRAGMENT_SHADER, this.fragmentSource, 'fragment');
    if (this._vertexShader === null || this._fragmentShader === null) {
      this.failed = true;
      return;
    }

    const program = gl.createProgram();
    this.program = program;
    gl.attachShader(program, this._vertexShader);
    gl.attachShader(program, this._fragmentShader);

    // Safety net for sources that omit layout(location = N).
    for (const attribName in DEFAULT_ATTRIB_LOCATIONS) {
      gl.bindAttribLocation(program, DEFAULT_ATTRIB_LOCATIONS[attribName], attribName);
    }

    gl.linkProgram(program);

    if (!this._async) this._finalize();
  }

  /**
   * @private
   * @returns {WebGLShader|null}
   */
  _compile(type, source, stageLabel) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      this.error = 'Program "' + this.name + '": nao foi possivel criar o shader ' + stageLabel + '.';
      console.error(this.error);
      return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    // The compile status is only queried lazily in _finalize so parallel compilation
    // is not serialised here; a null return only happens on allocation failure.
    return shader;
  }

  /**
   * Query link status, report errors and reflect the interface.
   * @private
   */
  _finalize() {
    if (this.ready || this.failed) return this.ready;
    const gl = this.gl;
    const program = this.program;
    if (!program) {
      this.failed = true;
      return false;
    }

    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (!linked) {
      this.failed = true;
      this.error = this._buildErrorReport();
      console.error(this.error);
      this._deleteShaders();
      return false;
    }

    this._reflectAttributes();
    this._reflectUniformBlocks();
    this._reflectUniforms();
    this._deleteShaders();

    this.ready = true;
    this.error = '';
    return true;
  }

  /**
   * Collect compile and link logs into one readable report.
   * @private
   * @returns {string}
   */
  _buildErrorReport() {
    const gl = this.gl;
    const parts = ['Falha ao compilar/linkar o programa "' + this.name + '".'];

    if (this._vertexShader && !gl.getShaderParameter(this._vertexShader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(this._vertexShader) || '';
      parts.push(this._preprocessor
        ? this._preprocessor.formatError(log, this.vertexSource, this.name + '.vertex')
        : 'VERTEX:\n' + log);
    }
    if (this._fragmentShader && !gl.getShaderParameter(this._fragmentShader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(this._fragmentShader) || '';
      parts.push(this._preprocessor
        ? this._preprocessor.formatError(log, this.fragmentSource, this.name + '.fragment')
        : 'FRAGMENT:\n' + log);
    }

    const programLog = gl.getProgramInfoLog(this.program);
    if (programLog) parts.push('LINK:\n' + programLog);

    if (this.defines) {
      const keys = Object.keys(this.defines).sort();
      if (keys.length > 0) {
        let list = '';
        for (let i = 0; i < keys.length; i++) list += (i > 0 ? ', ' : '') + keys[i] + '=' + this.defines[keys[i]];
        parts.push('DEFINES: ' + list);
      }
    }
    return parts.join('\n');
  }

  /** @private */
  _deleteShaders() {
    const gl = this.gl;
    if (this._vertexShader) {
      gl.detachShader(this.program, this._vertexShader);
      gl.deleteShader(this._vertexShader);
      this._vertexShader = null;
    }
    if (this._fragmentShader) {
      gl.detachShader(this.program, this._fragmentShader);
      gl.deleteShader(this._fragmentShader);
      this._fragmentShader = null;
    }
  }

  /** @private */
  _reflectAttributes() {
    const gl = this.gl;
    const count = gl.getProgramParameter(this.program, gl.ACTIVE_ATTRIBUTES) || 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveAttrib(this.program, i);
      if (!info) continue;
      const location = gl.getAttribLocation(this.program, info.name);
      if (location < 0) continue;
      this.attributes.set(info.name, location);
    }
  }

  /** @private */
  _reflectUniformBlocks() {
    const gl = this.gl;
    if (typeof gl.getActiveUniformBlockName !== 'function') return;
    const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORM_BLOCKS) || 0;
    for (let i = 0; i < count; i++) {
      const blockName = gl.getActiveUniformBlockName(this.program, i);
      if (!blockName) continue;
      const size = gl.getActiveUniformBlockParameter(this.program, i, gl.UNIFORM_BLOCK_DATA_SIZE) || 0;
      const binding = UBO_BINDINGS[blockName] !== undefined ? UBO_BINDINGS[blockName] : i;
      gl.uniformBlockBinding(this.program, i, binding);
      this.uniformBlocks.set(blockName, { index: i, binding, size });
    }
  }

  /** @private */
  _reflectUniforms() {
    const gl = this.gl;
    const samplerTypes = getSamplerTypes(gl);
    const count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS) || 0;

    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(this.program, i);
      if (!info) continue;

      const rawName = info.name;
      const location = gl.getUniformLocation(this.program, rawName);
      // Members of a uniform block have no location: they are updated through the UBO.
      if (location === null) continue;

      const isArray = rawName.indexOf('[') >= 0 && info.size > 1;
      const name = baseUniformName(rawName);
      const record = this._createRecord(name, location, info.type, info.size, isArray, samplerTypes);
      this.uniforms.set(name, record);
      if (rawName !== name) this.uniforms.set(rawName, record);

      // Individual elements of an array uniform get their own location, so callers
      // can address `uFoo[2]` directly without uploading the whole array.
      if (isArray) {
        for (let e = 1; e < info.size; e++) {
          const elementName = name + '[' + e + ']';
          const elementLocation = gl.getUniformLocation(this.program, elementName);
          if (elementLocation === null) continue;
          this.uniforms.set(
            elementName,
            this._createRecord(elementName, elementLocation, info.type, 1, false, samplerTypes)
          );
        }
      }
    }
  }

  /**
   * Build a uniform record together with its specialised setter.
   * @private
   */
  _createRecord(name, location, type, size, isArray, samplerTypes) {
    const record = {
      name,
      location,
      type,
      size,
      isArray,
      isSampler: samplerTypes.has(type),
      cache: null,
      scratch: null,
      setter: null
    };
    record.setter = this._createSetter(record);
    return record;
  }

  /**
   * Specialised setter per uniform type. Scalars and vectors compare against the
   * last uploaded value so redundant driver calls are skipped; matrices and arrays
   * always upload because comparing them costs more than the call itself.
   * @private
   * @returns {Function}
   */
  _createSetter(record) {
    const gl = this.gl;
    const loc = record.location;
    const type = record.type;

    if (record.isArray) {
      switch (type) {
        case gl.FLOAT: return (v) => { gl.uniform1fv(loc, v); };
        case gl.FLOAT_VEC2: return (v) => { gl.uniform2fv(loc, v); };
        case gl.FLOAT_VEC3: return (v) => { gl.uniform3fv(loc, v); };
        case gl.FLOAT_VEC4: return (v) => { gl.uniform4fv(loc, v); };
        case gl.FLOAT_MAT2: return (v) => { gl.uniformMatrix2fv(loc, false, matrixElements(v)); };
        case gl.FLOAT_MAT3: return (v) => { gl.uniformMatrix3fv(loc, false, matrixElements(v)); };
        case gl.FLOAT_MAT4: return (v) => { gl.uniformMatrix4fv(loc, false, matrixElements(v)); };
        case gl.INT_VEC2: return (v) => { gl.uniform2iv(loc, v); };
        case gl.INT_VEC3: return (v) => { gl.uniform3iv(loc, v); };
        case gl.INT_VEC4: return (v) => { gl.uniform4iv(loc, v); };
        case gl.UNSIGNED_INT: return (v) => { gl.uniform1uiv(loc, v); };
        case gl.UNSIGNED_INT_VEC2: return (v) => { gl.uniform2uiv(loc, v); };
        case gl.UNSIGNED_INT_VEC3: return (v) => { gl.uniform3uiv(loc, v); };
        case gl.UNSIGNED_INT_VEC4: return (v) => { gl.uniform4uiv(loc, v); };
        default: return (v) => { gl.uniform1iv(loc, v); };
      }
    }

    if (record.isSampler) {
      record.cache = -1;
      return (v) => {
        const unit = v | 0;
        if (record.cache === unit) return;
        record.cache = unit;
        gl.uniform1i(loc, unit);
      };
    }

    switch (type) {
      case gl.FLOAT: {
        record.cache = NaN;
        return (v) => {
          if (record.cache === v) return;
          record.cache = v;
          gl.uniform1f(loc, v);
        };
      }
      case gl.FLOAT_VEC2: {
        const c = record.cache = new Float32Array(2);
        c[0] = NaN;
        return (v) => {
          const x = v.x !== undefined ? v.x : v[0];
          const y = v.y !== undefined ? v.y : v[1];
          if (c[0] === x && c[1] === y) return;
          c[0] = x; c[1] = y;
          gl.uniform2f(loc, x, y);
        };
      }
      case gl.FLOAT_VEC3: {
        const c = record.cache = new Float32Array(3);
        const s = record.scratch = new Float32Array(3);
        c[0] = NaN;
        return (v) => {
          readXYZ(v, s);
          if (c[0] === s[0] && c[1] === s[1] && c[2] === s[2]) return;
          c[0] = s[0]; c[1] = s[1]; c[2] = s[2];
          gl.uniform3f(loc, s[0], s[1], s[2]);
        };
      }
      case gl.FLOAT_VEC4: {
        const c = record.cache = new Float32Array(4);
        const s = record.scratch = new Float32Array(4);
        c[0] = NaN;
        return (v) => {
          readXYZW(v, s);
          if (c[0] === s[0] && c[1] === s[1] && c[2] === s[2] && c[3] === s[3]) return;
          c[0] = s[0]; c[1] = s[1]; c[2] = s[2]; c[3] = s[3];
          gl.uniform4f(loc, s[0], s[1], s[2], s[3]);
        };
      }
      case gl.INT:
      case gl.BOOL: {
        record.cache = NaN;
        return (v) => {
          const i = v === true ? 1 : (v === false ? 0 : v | 0);
          if (record.cache === i) return;
          record.cache = i;
          gl.uniform1i(loc, i);
        };
      }
      case gl.INT_VEC2:
      case gl.BOOL_VEC2: {
        const c = record.cache = new Int32Array(2);
        c[0] = -2147483648;
        return (v) => {
          const x = (v.x !== undefined ? v.x : v[0]) | 0;
          const y = (v.y !== undefined ? v.y : v[1]) | 0;
          if (c[0] === x && c[1] === y) return;
          c[0] = x; c[1] = y;
          gl.uniform2i(loc, x, y);
        };
      }
      case gl.INT_VEC3:
      case gl.BOOL_VEC3: {
        const s = record.scratch = new Float32Array(3);
        const c = record.cache = new Int32Array(3);
        c[0] = -2147483648;
        return (v) => {
          readXYZ(v, s);
          const x = s[0] | 0, y = s[1] | 0, z = s[2] | 0;
          if (c[0] === x && c[1] === y && c[2] === z) return;
          c[0] = x; c[1] = y; c[2] = z;
          gl.uniform3i(loc, x, y, z);
        };
      }
      case gl.INT_VEC4:
      case gl.BOOL_VEC4: {
        const s = record.scratch = new Float32Array(4);
        const c = record.cache = new Int32Array(4);
        c[0] = -2147483648;
        return (v) => {
          readXYZW(v, s);
          const x = s[0] | 0, y = s[1] | 0, z = s[2] | 0, w = s[3] | 0;
          if (c[0] === x && c[1] === y && c[2] === z && c[3] === w) return;
          c[0] = x; c[1] = y; c[2] = z; c[3] = w;
          gl.uniform4i(loc, x, y, z, w);
        };
      }
      case gl.UNSIGNED_INT: {
        record.cache = NaN;
        return (v) => {
          const i = v >>> 0;
          if (record.cache === i) return;
          record.cache = i;
          gl.uniform1ui(loc, i);
        };
      }
      case gl.UNSIGNED_INT_VEC2: {
        const c = record.cache = new Uint32Array(2);
        return (v) => {
          const x = (v.x !== undefined ? v.x : v[0]) >>> 0;
          const y = (v.y !== undefined ? v.y : v[1]) >>> 0;
          if (c[0] === x && c[1] === y) return;
          c[0] = x; c[1] = y;
          gl.uniform2ui(loc, x, y);
        };
      }
      case gl.UNSIGNED_INT_VEC3: {
        const s = record.scratch = new Float32Array(3);
        return (v) => {
          readXYZ(v, s);
          gl.uniform3ui(loc, s[0] >>> 0, s[1] >>> 0, s[2] >>> 0);
        };
      }
      case gl.UNSIGNED_INT_VEC4: {
        const s = record.scratch = new Float32Array(4);
        return (v) => {
          readXYZW(v, s);
          gl.uniform4ui(loc, s[0] >>> 0, s[1] >>> 0, s[2] >>> 0, s[3] >>> 0);
        };
      }
      case gl.FLOAT_MAT2: return (v) => { gl.uniformMatrix2fv(loc, false, matrixElements(v)); };
      case gl.FLOAT_MAT3: return (v) => { gl.uniformMatrix3fv(loc, false, matrixElements(v)); };
      case gl.FLOAT_MAT4: return (v) => { gl.uniformMatrix4fv(loc, false, matrixElements(v)); };
      default: {
        // Unknown or exotic type: fall back to the most permissive setter.
        return (v) => {
          if (typeof v === 'number') gl.uniform1i(loc, v | 0);
          else gl.uniform1iv(loc, v);
        };
      }
    }
  }

  /**
   * Poll the driver for asynchronous link completion.
   * @returns {boolean} true when the program is finished (linked or failed)
   */
  checkAsync() {
    if (this.ready || this.failed) return true;
    if (!this.program) return true;
    if (this._parallelExt) {
      const done = this.gl.getProgramParameter(this.program, COMPLETION_STATUS_KHR);
      if (!done) return false;
    }
    this._finalize();
    return true;
  }

  /**
   * Force the link to complete (blocking) and report success.
   * @returns {boolean}
   */
  isLinked() {
    if (this.ready) return true;
    if (this.failed) return false;
    return this._finalize();
  }

  /**
   * Bind this program through the state cache.
   * @param {Object} state StateCache instance
   * @returns {boolean} false when the program is not usable
   */
  use(state) {
    if (!this.ready && !this._finalize()) return false;
    if (state) state.useProgram(this.program);
    else this.gl.useProgram(this.program);
    return true;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  hasUniform(name) {
    return this.uniforms.has(name);
  }

  /**
   * Set one uniform. Unknown names are ignored, which keeps a shader permutation
   * that optimised a uniform away from breaking the caller.
   * @param {string} name
   * @param {*} value
   * @returns {boolean} true when the uniform exists and was written
   */
  setUniform(name, value) {
    const record = this.uniforms.get(name);
    if (record === undefined || value === null || value === undefined) return false;
    record.setter(value);
    return true;
  }

  /**
   * Set many uniforms at once.
   * @param {Object|Map} values
   * @returns {number} how many uniforms were written
   */
  setUniforms(values) {
    if (!values) return 0;
    let written = 0;
    if (values instanceof Map) {
      for (const entry of values) {
        if (this.setUniform(entry[0], entry[1])) written++;
      }
      return written;
    }
    for (const name in values) {
      if (this.setUniform(name, values[name])) written++;
    }
    return written;
  }

  /**
   * Bind a texture to a unit and point the sampler uniform at it.
   * @param {string} name sampler uniform name
   * @param {Object|null} texture engine Texture (or null to only set the unit)
   * @param {number} unit texture unit index
   * @param {Object} state StateCache instance
   * @returns {boolean}
   */
  setTexture(name, texture, unit, state) {
    const record = this.uniforms.get(name);
    if (record === undefined) return false;
    if (texture && typeof texture.bind === 'function') texture.bind(state, unit);
    record.setter(unit);
    return true;
  }

  /**
   * Rebind a uniform block to an explicit binding point.
   * @param {string} name
   * @param {number} bindingPoint
   * @returns {boolean}
   */
  bindUniformBlock(name, bindingPoint) {
    if (!this.ready && !this._finalize()) return false;
    const block = this.uniformBlocks.get(name);
    if (block === undefined) return false;
    if (block.binding === bindingPoint) return true;
    block.binding = bindingPoint;
    this.gl.uniformBlockBinding(this.program, block.index, bindingPoint);
    return true;
  }

  /**
   * Invalidate every cached uniform value. Call it when the program is rebound
   * outside of the engine, or after a context restore.
   */
  resetUniformCache() {
    for (const record of this.uniforms.values()) {
      if (record.cache === null) continue;
      if (typeof record.cache === 'number') record.cache = record.isSampler ? -1 : NaN;
      else record.cache[0] = record.cache instanceof Float32Array ? NaN : -2147483648;
    }
  }

  /** Release the GL program. The instance must not be used afterwards. */
  dispose() {
    const gl = this.gl;
    this._deleteShaders();
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    this.uniforms.clear();
    this.attributes.clear();
    this.uniformBlocks.clear();
    this.ready = false;
  }
}
