/**
 * Register every built in chunk on a preprocessor instance.
 * Safe to call more than once: registering the same chunk twice is a no-op.
 * @param {import('../ShaderPreprocessor.js').ShaderPreprocessor} preprocessor
 * @returns {import('../ShaderPreprocessor.js').ShaderPreprocessor} the same instance
 */
export function registerAllChunks(preprocessor: import('../ShaderPreprocessor.js').ShaderPreprocessor): import('../ShaderPreprocessor.js').ShaderPreprocessor;
/**
 * Look a chunk up by name.
 * @param {string} name
 * @returns {string|null}
 */
export function getChunk(name: string): string | null;
/**
 * All chunks keyed by their `#include <name>` identifier.
 * @type {Object<string,string>}
 */
export const CHUNKS: {
    [x: string]: string;
};
/** Ordered list of the chunk names, useful for tooling and tests. */
export const CHUNK_NAMES: string[];
import { common } from "./common.glsl.js";
import { camera_ubo } from "./camera_ubo.glsl.js";
import { lights_ubo } from "./lights_ubo.glsl.js";
import { brdf } from "./brdf.glsl.js";
import { lighting } from "./lighting.glsl.js";
import { shadow } from "./shadow.glsl.js";
import { cluster } from "./cluster.glsl.js";
import { skinning } from "./skinning.glsl.js";
import { instancing } from "./instancing.glsl.js";
import { fog } from "./fog.glsl.js";
import { tonemap } from "./tonemap.glsl.js";
import { normal_mapping } from "./normal_mapping.glsl.js";
import { ibl } from "./ibl.glsl.js";
import { noise } from "./noise.glsl.js";
import { depth } from "./depth.glsl.js";
export { common, camera_ubo, lights_ubo, brdf, lighting, shadow, cluster, skinning, instancing, fog, tonemap, normal_mapping, ibl, noise, depth };
