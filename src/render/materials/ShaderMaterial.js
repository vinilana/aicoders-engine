/**
 * Material backed by user supplied GLSL.
 *
 * The sources go through the same preprocessor as the built in shaders, so
 * `#include <brdf>`, `#include <camera_ubo>` and every other chunk are available,
 * and the permutation defines behave exactly like they do for StandardMaterial.
 *
 * The sources are registered into the ShaderLib lazily, under a name unique to this
 * material (or an explicit one shared between several materials that want to reuse
 * the same program). Rewriting `vertexShader` / `fragmentShader` at runtime
 * re-registers them and invalidates every compiled permutation.
 */
import { Material } from '../Material.js';

/** Minimal pass-through vertex stage, used when the caller supplies none. */
const DEFAULT_VERTEX = `#version 300 es

#include <common>
#include <camera_ubo>
#include <instancing>

layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUV0;

uniform mat4 uModelMatrix;

out vec3 vWorldPos;
out vec2 vUV0;

void main() {
  vec4 worldPosition = getModelMatrix(uModelMatrix) * vec4(aPosition, 1.0);
  vWorldPos = worldPosition.xyz;
  vUV0 = aUV0;
  gl_Position = uViewProj * worldPosition;
}
`;

/** Magenta fragment stage, so a material with no fragment source is obvious. */
const DEFAULT_FRAGMENT = `#version 300 es

#include <common>

in vec3 vWorldPos;
in vec2 vUV0;

layout(location = 0) out vec4 outColor;

void main() {
  outColor = vec4(1.0, 0.0, 1.0, 1.0);
}
`;

let _nextShaderMaterialId = 1;

export class ShaderMaterial extends Material {
  /**
   * @param {Object} [options]
   * @param {string} [options.vertexShader] vertex source (alias: `vertex`)
   * @param {string} [options.fragmentShader] fragment source (alias: `fragment`)
   * @param {string} [options.shaderName] share one program between materials
   * @param {Object} [options.uniforms] initial uniform values
   * @param {Object} [options.defines] initial permutation defines
   */
  constructor(options = {}) {
    const serial = _nextShaderMaterialId++;
    const shaderName = options.shaderName !== undefined
      ? options.shaderName
      : 'shaderMaterial_' + serial;

    super(Object.assign({}, options, { shaderName }));

    /** @private @type {string} */
    this._vertexShader = typeof options.vertexShader === 'string'
      ? options.vertexShader
      : (typeof options.vertex === 'string' ? options.vertex : DEFAULT_VERTEX);
    /** @private @type {string} */
    this._fragmentShader = typeof options.fragmentShader === 'string'
      ? options.fragmentShader
      : (typeof options.fragment === 'string' ? options.fragment : DEFAULT_FRAGMENT);

    /**
     * Defines baked into every permutation of this material's program, as opposed
     * to `defines`, which the renderer merges per draw.
     * @type {Object|null}
     */
    this.shaderDefines = options.shaderDefines || null;

    /** @private true while the sources have not reached the library yet */
    this._sourcesDirty = true;
    /** @private @type {Object|null} library the sources were registered on */
    this._registeredOn = null;
  }

  /** @returns {string} */
  get vertexShader() { return this._vertexShader; }
  set vertexShader(source) {
    if (typeof source !== 'string' || source === this._vertexShader) return;
    this._vertexShader = source;
    this._sourcesDirty = true;
    this.needsUpdate = true;
  }

  /** @returns {string} */
  get fragmentShader() { return this._fragmentShader; }
  set fragmentShader(source) {
    if (typeof source !== 'string' || source === this._fragmentShader) return;
    this._fragmentShader = source;
    this._sourcesDirty = true;
    this.needsUpdate = true;
  }

  /** Alias of `vertexShader`. @returns {string} */
  get vertex() { return this._vertexShader; }
  set vertex(source) { this.vertexShader = source; }

  /** Alias of `fragmentShader`. @returns {string} */
  get fragment() { return this._fragmentShader; }
  set fragment(source) { this.fragmentShader = source; }

  /**
   * Replace both stages at once, which is cheaper than two separate assignments
   * because the library is only invalidated once.
   * @param {string} vertexSource
   * @param {string} fragmentSource
   * @returns {ShaderMaterial} this
   */
  setShaders(vertexSource, fragmentSource) {
    let changed = false;
    if (typeof vertexSource === 'string' && vertexSource !== this._vertexShader) {
      this._vertexShader = vertexSource;
      changed = true;
    }
    if (typeof fragmentSource === 'string' && fragmentSource !== this._fragmentShader) {
      this._fragmentShader = fragmentSource;
      changed = true;
    }
    if (changed) {
      this._sourcesDirty = true;
      this.needsUpdate = true;
    }
    return this;
  }

  /**
   * Make sure the library knows about this material's sources, then resolve the
   * program the usual way.
   * @param {Object} shaderLib
   * @param {Object|null} defines
   * @returns {Object} Program
   */
  getProgram(shaderLib, defines) {
    if (this._sourcesDirty || this._registeredOn !== shaderLib || !shaderLib.has(this.shaderName)) {
      shaderLib.register(this.shaderName, {
        vertex: this._vertexShader,
        fragment: this._fragmentShader,
        defines: this.shaderDefines
      });
      this._sourcesDirty = false;
      this._registeredOn = shaderLib;
    }
    return super.getProgram(shaderLib, defines);
  }

  /**
   * A custom shader declares exactly the uniforms it wants, so nothing is derived
   * here beyond what the base class already provides.
   * @param {Object} defines
   * @param {Object|null} geometry
   * @param {Object|null} renderContext
   */
  applyOwnDefines(defines, geometry, renderContext) {
    if (this.shaderDefines) {
      for (const key in this.shaderDefines) defines[key] = this.shaderDefines[key];
    }
  }

  /**
   * @param {ShaderMaterial} source
   * @returns {ShaderMaterial} this
   */
  copy(source) {
    super.copy(source);
    if (!(source instanceof ShaderMaterial)) return this;

    this._vertexShader = source._vertexShader;
    this._fragmentShader = source._fragmentShader;
    this.shaderDefines = source.shaderDefines
      ? Object.assign({}, source.shaderDefines)
      : null;

    // Keep the clone on its own program name unless the sources are explicitly
    // shared, otherwise editing one material would silently recompile the other.
    if (source.shaderName.indexOf('shaderMaterial_') === 0) {
      this.shaderName = 'shaderMaterial_' + (_nextShaderMaterialId++);
    }

    this._sourcesDirty = true;
    this._registeredOn = null;
    this.needsUpdate = true;
    return this;
  }

  /** Release the program cache entry owned by this material. */
  dispose() {
    const shaderLib = this._registeredOn;
    if (shaderLib && typeof shaderLib.invalidate === 'function' &&
        this.shaderName.indexOf('shaderMaterial_') === 0) {
      shaderLib.invalidate(this.shaderName);
    }
    this._registeredOn = null;
    super.dispose();
  }
}

export { DEFAULT_VERTEX as SHADER_MATERIAL_DEFAULT_VERTEX };
export { DEFAULT_FRAGMENT as SHADER_MATERIAL_DEFAULT_FRAGMENT };
