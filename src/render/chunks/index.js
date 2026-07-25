/**
 * Registry of every reusable GLSL chunk.
 *
 * Chunks are plain strings referenced from shader sources with the
 * `#include <name>` directive, resolved by ShaderPreprocessor. The key used in the
 * registry is exactly the exported constant name, which is also the file base name
 * (for example `camera_ubo.glsl.js` registers the chunk `camera_ubo`).
 *
 * Dependency includes inside a chunk are placed *before* its `#ifndef` guard on
 * purpose: the preprocessor only deduplicates includes that appear outside of any
 * conditional block, so keeping them at the top lets a whole dependency graph
 * collapse into a single copy of each chunk.
 */
import { common } from './common.glsl.js';
import { camera_ubo } from './camera_ubo.glsl.js';
import { lights_ubo } from './lights_ubo.glsl.js';
import { brdf } from './brdf.glsl.js';
import { lighting } from './lighting.glsl.js';
import { shadow } from './shadow.glsl.js';
import { cluster } from './cluster.glsl.js';
import { skinning } from './skinning.glsl.js';
import { instancing } from './instancing.glsl.js';
import { fog } from './fog.glsl.js';
import { tonemap } from './tonemap.glsl.js';
import { normal_mapping } from './normal_mapping.glsl.js';
import { ibl } from './ibl.glsl.js';
import { noise } from './noise.glsl.js';
import { depth } from './depth.glsl.js';

export {
  common,
  camera_ubo,
  lights_ubo,
  brdf,
  lighting,
  shadow,
  cluster,
  skinning,
  instancing,
  fog,
  tonemap,
  normal_mapping,
  ibl,
  noise,
  depth
};

/**
 * All chunks keyed by their `#include <name>` identifier.
 * @type {Object<string,string>}
 */
export const CHUNKS = {
  common,
  camera_ubo,
  lights_ubo,
  brdf,
  lighting,
  shadow,
  cluster,
  skinning,
  instancing,
  fog,
  tonemap,
  normal_mapping,
  ibl,
  noise,
  depth
};

/** Ordered list of the chunk names, useful for tooling and tests. */
export const CHUNK_NAMES = Object.keys(CHUNKS);

/**
 * Register every built in chunk on a preprocessor instance.
 * Safe to call more than once: registering the same chunk twice is a no-op.
 * @param {import('../ShaderPreprocessor.js').ShaderPreprocessor} preprocessor
 * @returns {import('../ShaderPreprocessor.js').ShaderPreprocessor} the same instance
 */
export function registerAllChunks(preprocessor) {
  if (!preprocessor || typeof preprocessor.registerChunk !== 'function') {
    throw new Error('registerAllChunks: um ShaderPreprocessor valido e obrigatorio.');
  }
  for (let i = 0, n = CHUNK_NAMES.length; i < n; i++) {
    const name = CHUNK_NAMES[i];
    preprocessor.registerChunk(name, CHUNKS[name]);
  }
  return preprocessor;
}

/**
 * Look a chunk up by name.
 * @param {string} name
 * @returns {string|null}
 */
export function getChunk(name) {
  const chunk = CHUNKS[name];
  return chunk === undefined ? null : chunk;
}
