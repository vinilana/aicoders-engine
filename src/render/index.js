/**
 * Renderizacao — barril da area.
 *
 * Curado a mao, ao contrario dos outros barris: todo modulo em shaders/ exporta
 * um `register` com significado diferente, entao um `export *` engoliria os
 * nomes ambiguos em silencio. Use os apelidos unicos (registerPostShaders,
 * registerIBLShaders, registerShadowShader, registerDebugShader) ou
 * registerAllShaders.
 *
 *   import { Renderer, StandardMaterial } from 'aicoders-engine/render';
 */

export { createGLContext, Capabilities } from './GLContext.js';
export { StateCache, getStateCache } from './StateCache.js';
export { GLBuffer, bufferTargetToGL, bufferUsageToGL } from './Buffer.js';
export { VertexArray } from './VertexArray.js';

export {
  Geometry,
  GeometryAttribute,
  ATTRIB,
  ATTRIB_NAME_TO_LOC,
  GL_TYPE,
  DRAW_MODES,
  glTypeBytes,
  glTypeFromArray,
  drawModeToGL
} from './Geometry.js';

export {
  Texture,
  createTexture2D,
  createTextureCube,
  createTextureArray,
  createTexture3D,
  createDataTexture,
  createWhiteTexture,
  resolveFormat,
  validateTextureSize
} from './Texture.js';

export { RenderTarget } from './RenderTarget.js';

export { ShaderPreprocessor, formatDefines, definesKey } from './ShaderPreprocessor.js';
export { Program, UBO_BINDINGS, DEFAULT_ATTRIB_LOCATIONS } from './Program.js';
export { ShaderLib } from './ShaderLib.js';

export { CHUNKS, CHUNK_NAMES, registerAllChunks, getChunk } from './chunks/index.js';

export {
  registerAllShaders,
  registerAllShadersAsync,
  registerCoreShaders,
  loadOptionalShaders,
  shaderModulesReady,
  optionalShaderStatus,
  registerShaderModule,
  registerOptionalShaderLoader,
  applyShaderModule,
  CORE_SHADER_NAMES,
  OPTIONAL_SHADER_NAMES
} from './shaders/index.js';

export { registerShadowShader, SHADOW_SHADER_NAME } from './shaders/shadow.js';
export { registerPostShaders, POST_SHADER_NAMES } from './shaders/post.js';
export { registerIBLShaders, IBL_SHADER_NAMES } from './shaders/ibl.js';
export { registerDebugShader, DEBUG_SHADER_NAME } from './shaders/debug.js';

export { Material, SIDE_CODE, TEXTURE_UNITS } from './Material.js';
export { StandardMaterial } from './materials/StandardMaterial.js';
export { UnlitMaterial } from './materials/UnlitMaterial.js';
export {
  ShaderMaterial,
  SHADER_MATERIAL_DEFAULT_VERTEX,
  SHADER_MATERIAL_DEFAULT_FRAGMENT
} from './materials/ShaderMaterial.js';
export { SkyMaterial } from './materials/SkyMaterial.js';
export { WaterMaterial } from './materials/WaterMaterial.js';

export { Renderer } from './Renderer.js';
export { RenderList, RenderItem, makeSortKey } from './RenderList.js';

export {
  UniformBuffers,
  UniformBlock,
  UBO_BINDING_POINTS,
  CAMERA_OFFSETS,
  CAMERA_FLOATS,
  LIGHTS_OFFSETS,
  LIGHTS_FLOATS,
  DIR_LIGHT_SLOTS,
  SHADOWS_OFFSETS,
  SHADOWS_FLOATS,
  CASCADE_SLOTS,
  FOG_OFFSETS,
  FOG_FLOATS
} from './UniformBuffers.js';

export { ShadowMapper } from './ShadowMapper.js';
export {
  ClusteredLighting,
  CLUSTER_TEXTURE_UNITS,
  TEXELS_PER_LIGHT,
  FLOATS_PER_LIGHT
} from './ClusteredLighting.js';
export { LightManager } from './LightManager.js';
export { PostProcessing, ToneMapping } from './PostProcessing.js';
export { IBL, IBL_TEXTURE_UNITS } from './IBL.js';
export { DebugRenderer } from './DebugRenderer.js';
