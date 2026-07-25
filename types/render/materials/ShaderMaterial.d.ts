export class ShaderMaterial extends Material {
    /**
     * @param {Object} [options]
     * @param {string} [options.vertexShader] vertex source (alias: `vertex`)
     * @param {string} [options.fragmentShader] fragment source (alias: `fragment`)
     * @param {string} [options.shaderName] share one program between materials
     * @param {Object} [options.uniforms] initial uniform values
     * @param {Object} [options.defines] initial permutation defines
     */
    constructor(options?: {
        vertexShader?: string;
        fragmentShader?: string;
        shaderName?: string;
        uniforms?: any;
        defines?: any;
    });
    /** @private @type {string} */
    private _vertexShader;
    /** @private @type {string} */
    private _fragmentShader;
    /**
     * Defines baked into every permutation of this material's program, as opposed
     * to `defines`, which the renderer merges per draw.
     * @type {Object|null}
     */
    shaderDefines: any | null;
    /** @private true while the sources have not reached the library yet */
    private _sourcesDirty;
    /** @private @type {Object|null} library the sources were registered on */
    private _registeredOn;
    set vertexShader(arg: string);
    /** @returns {string} */
    get vertexShader(): string;
    set fragmentShader(arg: string);
    /** @returns {string} */
    get fragmentShader(): string;
    set vertex(arg: string);
    /** Alias of `vertexShader`. @returns {string} */
    get vertex(): string;
    set fragment(arg: string);
    /** Alias of `fragmentShader`. @returns {string} */
    get fragment(): string;
    /**
     * Replace both stages at once, which is cheaper than two separate assignments
     * because the library is only invalidated once.
     * @param {string} vertexSource
     * @param {string} fragmentSource
     * @returns {ShaderMaterial} this
     */
    setShaders(vertexSource: string, fragmentSource: string): ShaderMaterial;
    /**
     * Publishes this material's sources into a library if they are not there yet.
     *
     * Kept separate from `getProgram` because the renderer checks whether a shader
     * name is known *before* it asks the material for a program. Without a hook it
     * can call first, a custom material could never register itself and would be
     * skipped as "shader not registered".
     *
     * @param {Object} shaderLib
     * @returns {boolean} true when the library knows this shader afterwards
     */
    ensureRegistered(shaderLib: any): boolean;
    /**
     * @param {ShaderMaterial} source
     * @returns {ShaderMaterial} this
     */
    copy(source: ShaderMaterial): ShaderMaterial;
}
import { Material } from "../Material.js";
/** Minimal pass-through vertex stage, used when the caller supplies none. */
declare const DEFAULT_VERTEX: "#version 300 es\n\n#include <common>\n#include <camera_ubo>\n#include <instancing>\n\nlayout(location = 0) in vec3 aPosition;\nlayout(location = 2) in vec2 aUV0;\n\nuniform mat4 uModelMatrix;\n\nout vec3 vWorldPos;\nout vec2 vUV0;\n\nvoid main() {\n  vec4 worldPosition = getModelMatrix(uModelMatrix) * vec4(aPosition, 1.0);\n  vWorldPos = worldPosition.xyz;\n  vUV0 = aUV0;\n  gl_Position = uViewProj * worldPosition;\n}\n";
/** Magenta fragment stage, so a material with no fragment source is obvious. */
declare const DEFAULT_FRAGMENT: "#version 300 es\n\n#include <common>\n\nin vec3 vWorldPos;\nin vec2 vUV0;\n\nlayout(location = 0) out vec4 outColor;\n\nvoid main() {\n  outColor = vec4(1.0, 0.0, 1.0, 1.0);\n}\n";
export { DEFAULT_VERTEX as SHADER_MATERIAL_DEFAULT_VERTEX, DEFAULT_FRAGMENT as SHADER_MATERIAL_DEFAULT_FRAGMENT };
