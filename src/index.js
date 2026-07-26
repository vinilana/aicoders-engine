/**
 * AICoders Engine - public API barrel.
 *
 * Everything the engine exposes is re-exported from here, grouped by area, so a
 * user only ever writes one import:
 *
 *   import { Engine, Scene, Mesh, StandardMaterial, createBox } from './src/index.js';
 *
 * Rules honoured by this file:
 *  - named exports only, no `export default` anywhere in the engine;
 *  - every specifier ends with `.js`, because the browser loads these modules raw;
 *  - no side effects: importing the barrel compiles nothing, touches no DOM and
 *    creates no GL object. Every symbol below is a class, a function or a frozen
 *    constant table.
 *
 * Two names are deliberately NOT re-exported to keep the namespace unambiguous:
 *  - `srgbToLinear` / `linearToSrgb` from `geometry/ProceduralTexture.js`, which
 *    duplicate the canonical `srgbToLinear` / `linearToSRGB` of `math/Color.js`;
 *  - the `register()` hook every module under `render/shaders/` exports; use the
 *    uniquely named aliases (`registerPostShaders`, `registerIBLShaders`,
 *    `registerShadowShader`, `registerDebugShader`) or `registerAllShaders`.
 */

/** Engine version string. */
export const VERSION = '1.3.0';

/* ========================================================================== *
 * MATH
 * ========================================================================== */

export {
  EPSILON,
  DEG2RAD,
  RAD2DEG,
  PI2,
  PI_HALF,
  clamp,
  lerp,
  inverseLerp,
  smoothstep,
  smootherstep,
  damp,
  moveTowards,
  nextPowerOfTwo,
  floorPowerOfTwo,
  isPowerOfTwo,
  randFloat,
  randInt,
  seededRandom,
  hash32,
  hashFloat,
  degToRad,
  radToDeg,
  euclideanModulo,
  pingPong,
  wrapAngle,
  deltaAngle,
  nearlyEqual
} from './math/MathUtils.js';

export { Vec2 } from './math/Vec2.js';
export { Vec3 } from './math/Vec3.js';
export { Vec4 } from './math/Vec4.js';
export { Quat } from './math/Quat.js';
export { Euler } from './math/Euler.js';
export { Mat3 } from './math/Mat3.js';
export { Mat4 } from './math/Mat4.js';
export { Color, srgbToLinear, linearToSRGB } from './math/Color.js';
export { Plane } from './math/Plane.js';
export { Frustum } from './math/Frustum.js';
export { AABB } from './math/AABB.js';
export { Sphere } from './math/Sphere.js';
export { Ray } from './math/Ray.js';

/* ========================================================================== *
 * CORE
 * ========================================================================== */

export { EventBus } from './core/EventBus.js';
export { Time } from './core/Time.js';
export { Pool } from './core/Pool.js';
export { Logger, LogLevel } from './core/Logger.js';
export { Engine } from './core/Engine.js';

/* ========================================================================== *
 * UTIL
 * ========================================================================== */

export { Stats } from './util/Stats.js';

export {
  growTypedArray,
  ensureCapacity,
  concatTypedArrays,
  copyRange,
  fillRange,
  packUnorm8,
  unpackUnorm8,
  packSnorm8,
  unpackSnorm8,
  packUnorm16,
  unpackUnorm16,
  packSnorm16,
  unpackSnorm16,
  packHalfFloat,
  unpackHalfFloat,
  packHalfFloatArray,
  unpackHalfFloatArray,
  radixSortUint32,
  radixSortUint32Pairs,
  compareAndSwapSort,
  insertionSortByKey,
  byteLengthOf
} from './util/TypedArrayUtils.js';

/* ========================================================================== *
 * SCENE GRAPH
 * ========================================================================== */

export { Node3D } from './scene/Node3D.js';
export { Scene } from './scene/Scene.js';
export { Camera } from './scene/Camera.js';
export { PerspectiveCamera } from './scene/PerspectiveCamera.js';
export { OrthographicCamera } from './scene/OrthographicCamera.js';
export { Mesh } from './scene/Mesh.js';
export { InstancedMesh } from './scene/InstancedMesh.js';
export { SkinnedMesh } from './scene/SkinnedMesh.js';
export { Skeleton } from './scene/Skeleton.js';
export { Light, DirectionalLight, PointLight, SpotLight } from './scene/Light.js';
export { LOD } from './scene/LOD.js';

/* ========================================================================== *
 * SPATIAL ACCELERATION
 * ========================================================================== */

export { DynamicBVH } from './spatial/DynamicBVH.js';
export { TriangleBVH } from './spatial/TriangleBVH.js';

/* ========================================================================== *
 * GEOMETRY
 * ========================================================================== */

export {
  createBox,
  createSphere,
  createPlane,
  createCylinder,
  createCone,
  createCapsule,
  createTorus,
  createTorusKnot,
  createDisc,
  createIcosphere,
  createGridLines,
  createQuadFullscreen,
  createSkyboxCube,
  createTerrain
} from './geometry/Primitives.js';

export {
  computeNormals,
  computeTangents,
  computeAABB,
  computeBoundingSphere,
  toNonIndexed,
  toIndexed,
  mergeGeometries,
  optimizeVertexCache,
  simplify
} from './geometry/GeometryUtils.js';

export {
  checkerTexture,
  noiseTexture,
  gradientTexture,
  normalMapFromHeight,
  uvGridTexture,
  brdfLUTTexture,
  solidColorTexture,
  noiseHeightField,
  perlin3,
  perlin3Periodic,
  simplex3,
  fbm,
  fbmPeriodic,
  ridgedFbm
} from './geometry/ProceduralTexture.js';

/* ========================================================================== *
 * RENDER - GL LAYER
 * ========================================================================== */

export { createGLContext, Capabilities } from './render/GLContext.js';
export { StateCache, getStateCache } from './render/StateCache.js';
export { GLBuffer, bufferTargetToGL, bufferUsageToGL } from './render/Buffer.js';
export { VertexArray } from './render/VertexArray.js';

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
} from './render/Geometry.js';

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
} from './render/Texture.js';

export { RenderTarget } from './render/RenderTarget.js';

/* ========================================================================== *
 * RENDER - SHADERS
 * ========================================================================== */

export { ShaderPreprocessor, formatDefines, definesKey } from './render/ShaderPreprocessor.js';
export { Program, UBO_BINDINGS, DEFAULT_ATTRIB_LOCATIONS } from './render/Program.js';
export { ShaderLib } from './render/ShaderLib.js';

export { CHUNKS, CHUNK_NAMES, registerAllChunks, getChunk } from './render/chunks/index.js';

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
} from './render/shaders/index.js';

export { registerShadowShader, SHADOW_SHADER_NAME } from './render/shaders/shadow.js';
export { registerPostShaders, POST_SHADER_NAMES } from './render/shaders/post.js';
export { registerIBLShaders, IBL_SHADER_NAMES } from './render/shaders/ibl.js';
export { registerDebugShader, DEBUG_SHADER_NAME } from './render/shaders/debug.js';

/* ========================================================================== *
 * RENDER - MATERIALS
 * ========================================================================== */

export { Material, SIDE_CODE, TEXTURE_UNITS } from './render/Material.js';
export { StandardMaterial } from './render/materials/StandardMaterial.js';
export { UnlitMaterial } from './render/materials/UnlitMaterial.js';
export {
  ShaderMaterial,
  SHADER_MATERIAL_DEFAULT_VERTEX,
  SHADER_MATERIAL_DEFAULT_FRAGMENT
} from './render/materials/ShaderMaterial.js';
export { SkyMaterial } from './render/materials/SkyMaterial.js';

/* ========================================================================== *
 * RENDER - PIPELINE
 * ========================================================================== */

export { Renderer } from './render/Renderer.js';
export { RenderList, RenderItem, makeSortKey } from './render/RenderList.js';

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
} from './render/UniformBuffers.js';

export { ShadowMapper } from './render/ShadowMapper.js';
export {
  ClusteredLighting,
  CLUSTER_TEXTURE_UNITS,
  TEXELS_PER_LIGHT,
  FLOATS_PER_LIGHT
} from './render/ClusteredLighting.js';
export { LightManager } from './render/LightManager.js';
export { PostProcessing, ToneMapping } from './render/PostProcessing.js';
export { IBL, IBL_TEXTURE_UNITS } from './render/IBL.js';
export { DebugRenderer } from './render/DebugRenderer.js';

/* ========================================================================== *
 * ANIMATION
 * ========================================================================== */

export { KeyframeTrack, InterpolationMode } from './animation/KeyframeTrack.js';
export { AnimationClip } from './animation/AnimationClip.js';
export { AnimationAction, LoopMode } from './animation/AnimationAction.js';
export { AnimationMixer, PropertyBinding, BindingType } from './animation/AnimationMixer.js';

/* ========================================================================== *
 * LOADERS
 * ========================================================================== */

export {
  AssetManager,
  resolveURL,
  extractBasePath,
  guessAssetType,
  isDataURI,
  isAbsoluteURL,
  parseDataURI,
  fetchBytes,
  fetchText,
  fetchJSON
} from './loaders/AssetManager.js';

export {
  loadImage,
  loadImageBitmap,
  loadTexture,
  loadImageSource,
  createTextureFromImage,
  isImageBitmapSupported
} from './loaders/ImageLoader.js';

export { GLTFLoader, GLTFParser } from './loaders/GLTFLoader.js';
export { OBJLoader, parseMTL } from './loaders/OBJLoader.js';

/* ========================================================================== *
 * PHYSICS / COLLISION
 * ========================================================================== */

export { Raycaster, getMeshTriangleData } from './physics/Raycaster.js';
export { CollisionWorld, StaticCollider, createSweepHit } from './physics/CollisionWorld.js';
export { CharacterController } from './physics/CharacterController.js';
export { RigidBody, BodyType, BodyShape } from './physics/RigidBody.js';
export { WaterVolume } from './physics/WaterVolume.js';
export { CellularFluid } from './physics/CellularFluid.js';

/* ========================================================================== *
 * INPUT
 * ========================================================================== */

export { Input } from './input/Input.js';
export { OrbitControls } from './input/OrbitControls.js';
export { FirstPersonControls } from './input/FirstPersonControls.js';

/* ========================================================================== *
 * AUDIO
 * ========================================================================== */

export { AudioEngine } from './audio/AudioEngine.js';
export { AudioSource } from './audio/AudioSource.js';
