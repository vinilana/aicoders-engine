/**
 * Registry and permutation cache for shader programs.
 *
 * A shader is registered once as a (vertex, fragment) source pair under a name;
 * every distinct set of defines then produces one Program, keyed by
 * `name|K=V;K=V;` with the define names sorted alphabetically. The same
 * permutation is never compiled twice for the lifetime of the library.
 */
import { ShaderPreprocessor, definesKey } from './ShaderPreprocessor.js';
import { Program } from './Program.js';
import { registerAllChunks } from './chunks/index.js';

export class ShaderLib {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {ShaderPreprocessor} [preprocessor] shared preprocessor; a new one with
   *        every built in chunk registered is created when omitted
   */
  constructor(gl, preprocessor = null) {
    /** @type {WebGL2RenderingContext} */
    this.gl = gl;
    /** @type {ShaderPreprocessor} */
    this.preprocessor = preprocessor || new ShaderPreprocessor();
    // Registering is idempotent, so this also fixes up a caller supplied
    // preprocessor that was created without the built in chunks.
    if (!this.preprocessor.hasChunk('common')) registerAllChunks(this.preprocessor);

    /** @type {Map<string,{vertex:string, fragment:string, defaultDefines:Object|null}>} */
    this.sources = new Map();
    /** @type {Map<string,Program>} permutation key -> program */
    this.cache = new Map();
    /** @type {Program[]} programs still linking asynchronously */
    this.pending = [];
    /** Compilation statistics. */
    this.stats = { compiled: 0, cacheHits: 0, failed: 0 };
  }

  /**
   * Register (or replace) a shader source pair.
   * @param {string} name
   * @param {{vertex:string, fragment:string, defines?:Object}} sources
   * @returns {ShaderLib} this
   */
  register(name, sources) {
    if (!sources || typeof sources.vertex !== 'string' || typeof sources.fragment !== 'string') {
      throw new Error('ShaderLib.register: "' + name + '" precisa de {vertex, fragment} como strings.');
    }
    const previous = this.sources.get(name);
    this.sources.set(name, {
      vertex: sources.vertex,
      fragment: sources.fragment,
      defaultDefines: sources.defines || null
    });
    // Replacing a source invalidates every permutation built from it.
    if (previous !== undefined) this.invalidate(name);
    return this;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.sources.has(name);
  }

  /**
   * @param {string} name
   * @returns {{vertex:string, fragment:string, defaultDefines:Object|null}|null}
   */
  getSource(name) {
    const entry = this.sources.get(name);
    return entry === undefined ? null : entry;
  }

  /** @returns {string[]} every registered shader name */
  get shaderNames() {
    return Array.from(this.sources.keys());
  }

  /** @returns {number} number of compiled permutations currently cached */
  get programCount() {
    return this.cache.size;
  }

  /**
   * Deterministic cache key for a (name, defines) pair.
   * @param {string} name
   * @param {Object|null} defines
   * @returns {string}
   */
  getKey(name, defines) {
    return name + '|' + definesKey(defines);
  }

  /**
   * Fetch, compiling on demand, the program for one permutation.
   * @param {string} name registered shader name
   * @param {Object|null} [defines]
   * @returns {Program}
   */
  get(name, defines = null) {
    const key = this.getKey(name, defines);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.cacheHits++;
      return cached;
    }

    const entry = this.sources.get(name);
    if (entry === undefined) {
      throw new Error(
        'ShaderLib: shader "' + name + '" nao registrado. Registrados: ' +
        Array.from(this.sources.keys()).sort().join(', ')
      );
    }

    const merged = this._mergeDefines(entry.defaultDefines, defines);
    const program = new Program(this.gl, entry.vertex, entry.fragment, merged, name, {
      preprocessor: this.preprocessor,
      key
    });

    this.cache.set(key, program);
    this.stats.compiled++;
    if (!program.ready && !program.failed) this.pending.push(program);
    if (program.failed) this.stats.failed++;
    return program;
  }

  /**
   * Merge the shader default defines with the per call ones.
   * @private
   * @returns {Object|null}
   */
  _mergeDefines(defaults, defines) {
    if (!defaults) return defines;
    if (!defines) return defaults;
    const merged = {};
    for (const key in defaults) merged[key] = defaults[key];
    for (const key in defines) merged[key] = defines[key];
    return merged;
  }

  /**
   * Warm up a set of permutations ahead of time so no frame pays for the compile.
   * @param {string} name
   * @param {Array<Object>} definesList
   * @returns {Program[]}
   */
  precompile(name, definesList) {
    const list = definesList && definesList.length > 0 ? definesList : [null];
    const programs = [];
    for (let i = 0, n = list.length; i < n; i++) {
      programs.push(this.get(name, list[i]));
    }
    return programs;
  }

  /**
   * Block until every pending program has finished linking. Used by
   * Renderer.compile() before the first frame is drawn.
   * @returns {number} number of programs that failed
   */
  finishAll() {
    let failed = 0;
    for (let i = 0, n = this.pending.length; i < n; i++) {
      if (!this.pending[i].isLinked()) failed++;
    }
    this.pending.length = 0;
    return failed;
  }

  /**
   * Poll the asynchronously linking programs. Cheap enough to call once per frame.
   * @returns {number} how many are still pending
   */
  poll() {
    const pending = this.pending;
    let write = 0;
    for (let i = 0, n = pending.length; i < n; i++) {
      const program = pending[i];
      if (!program.checkAsync()) {
        pending[write++] = program;
      } else if (program.failed) {
        this.stats.failed++;
      }
    }
    pending.length = write;
    return write;
  }

  /**
   * Drop every compiled permutation of one shader.
   * @param {string} name
   * @returns {number} how many programs were released
   */
  invalidate(name) {
    const prefix = name + '|';
    let removed = 0;
    for (const entry of Array.from(this.cache)) {
      if (entry[0].startsWith(prefix)) {
        entry[1].dispose();
        this.cache.delete(entry[0]);
        removed++;
      }
    }
    if (removed > 0) {
      const pending = this.pending;
      let write = 0;
      for (let i = 0, n = pending.length; i < n; i++) {
        if (pending[i].program !== null) pending[write++] = pending[i];
      }
      pending.length = write;
    }
    return removed;
  }

  /** Release every compiled program. Sources stay registered. */
  clearCache() {
    for (const program of this.cache.values()) program.dispose();
    this.cache.clear();
    this.pending.length = 0;
  }

  /** Release programs and forget every registered source. */
  dispose() {
    this.clearCache();
    this.sources.clear();
  }
}
