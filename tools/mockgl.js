/**
 * mockgl.js - a complete, dependency free fake WebGL2 context plus the minimal
 * DOM surface the AICoders Engine needs, so the whole engine can be exercised
 * headlessly inside Node.
 *
 * The mock is deliberately *semantic* rather than a blind stub collection:
 *
 *   - it parses the GLSL sources handed to `shaderSource()` and reports real
 *     active uniforms / attributes / uniform blocks through the reflection API,
 *     which means `Program` reflection produces the same map it would produce
 *     on a real driver;
 *   - it computes plausible std140 block sizes so `UniformBuffers` allocates
 *     correctly sized buffers;
 *   - it tracks bound objects, counts draw calls, triangles, allocations and
 *     can record every single call for later inspection.
 *
 * Nothing here touches the network, the filesystem or any global unless
 * `installDOMShims()` is called explicitly.
 */

/* ------------------------------------------------------------------------- *
 * WebGL2 constants
 * ------------------------------------------------------------------------- */

/** Every WebGL2 enum the engine can reasonably touch. */
export const GL_CONSTANTS = {
  DEPTH_BUFFER_BIT: 0x00000100,
  STENCIL_BUFFER_BIT: 0x00000400,
  COLOR_BUFFER_BIT: 0x00004000,

  FALSE: 0,
  TRUE: 1,

  POINTS: 0x0000,
  LINES: 0x0001,
  LINE_LOOP: 0x0002,
  LINE_STRIP: 0x0003,
  TRIANGLES: 0x0004,
  TRIANGLE_STRIP: 0x0005,
  TRIANGLE_FAN: 0x0006,

  ZERO: 0,
  ONE: 1,
  SRC_COLOR: 0x0300,
  ONE_MINUS_SRC_COLOR: 0x0301,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  DST_ALPHA: 0x0304,
  ONE_MINUS_DST_ALPHA: 0x0305,
  DST_COLOR: 0x0306,
  ONE_MINUS_DST_COLOR: 0x0307,
  SRC_ALPHA_SATURATE: 0x0308,
  CONSTANT_COLOR: 0x8001,
  ONE_MINUS_CONSTANT_COLOR: 0x8002,
  CONSTANT_ALPHA: 0x8003,
  ONE_MINUS_CONSTANT_ALPHA: 0x8004,

  FUNC_ADD: 0x8006,
  FUNC_SUBTRACT: 0x800a,
  FUNC_REVERSE_SUBTRACT: 0x800b,
  MIN: 0x8007,
  MAX: 0x8008,
  BLEND_EQUATION: 0x8009,
  BLEND_EQUATION_RGB: 0x8009,
  BLEND_EQUATION_ALPHA: 0x883d,
  BLEND_DST_RGB: 0x80c8,
  BLEND_SRC_RGB: 0x80c9,
  BLEND_DST_ALPHA: 0x80ca,
  BLEND_SRC_ALPHA: 0x80cb,
  BLEND_COLOR: 0x8005,
  BLEND: 0x0be2,

  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  ARRAY_BUFFER_BINDING: 0x8894,
  ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  COPY_READ_BUFFER: 0x8f36,
  COPY_WRITE_BUFFER: 0x8f37,
  PIXEL_PACK_BUFFER: 0x88eb,
  PIXEL_UNPACK_BUFFER: 0x88ec,
  UNIFORM_BUFFER: 0x8a11,
  TRANSFORM_FEEDBACK_BUFFER: 0x8c8e,

  STREAM_DRAW: 0x88e0,
  STREAM_READ: 0x88e1,
  STREAM_COPY: 0x88e2,
  STATIC_DRAW: 0x88e4,
  STATIC_READ: 0x88e5,
  STATIC_COPY: 0x88e6,
  DYNAMIC_DRAW: 0x88e8,
  DYNAMIC_READ: 0x88e9,
  DYNAMIC_COPY: 0x88ea,

  BUFFER_SIZE: 0x8764,
  BUFFER_USAGE: 0x8765,

  FRONT: 0x0404,
  BACK: 0x0405,
  FRONT_AND_BACK: 0x0408,
  CULL_FACE: 0x0b44,
  DEPTH_TEST: 0x0b71,
  DEPTH_WRITEMASK: 0x0b72,
  DEPTH_FUNC: 0x0b74,
  STENCIL_TEST: 0x0b90,
  DITHER: 0x0bd0,
  SCISSOR_TEST: 0x0c11,
  POLYGON_OFFSET_FILL: 0x8037,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
  SAMPLE_COVERAGE: 0x80a0,
  RASTERIZER_DISCARD: 0x8c89,

  CW: 0x0900,
  CCW: 0x0901,

  NEVER: 0x0200,
  LESS: 0x0201,
  EQUAL: 0x0202,
  LEQUAL: 0x0203,
  GREATER: 0x0204,
  NOTEQUAL: 0x0205,
  GEQUAL: 0x0206,
  ALWAYS: 0x0207,

  KEEP: 0x1e00,
  REPLACE: 0x1e01,
  INCR: 0x1e02,
  DECR: 0x1e03,
  INVERT: 0x150a,
  INCR_WRAP: 0x8507,
  DECR_WRAP: 0x8508,

  NO_ERROR: 0,
  INVALID_ENUM: 0x0500,
  INVALID_VALUE: 0x0501,
  INVALID_OPERATION: 0x0502,
  OUT_OF_MEMORY: 0x0505,
  INVALID_FRAMEBUFFER_OPERATION: 0x0506,
  CONTEXT_LOST_WEBGL: 0x9242,

  BYTE: 0x1400,
  UNSIGNED_BYTE: 0x1401,
  SHORT: 0x1402,
  UNSIGNED_SHORT: 0x1403,
  INT: 0x1404,
  UNSIGNED_INT: 0x1405,
  FLOAT: 0x1406,
  HALF_FLOAT: 0x140b,

  FLOAT_VEC2: 0x8b50,
  FLOAT_VEC3: 0x8b51,
  FLOAT_VEC4: 0x8b52,
  INT_VEC2: 0x8b53,
  INT_VEC3: 0x8b54,
  INT_VEC4: 0x8b55,
  BOOL: 0x8b56,
  BOOL_VEC2: 0x8b57,
  BOOL_VEC3: 0x8b58,
  BOOL_VEC4: 0x8b59,
  FLOAT_MAT2: 0x8b5a,
  FLOAT_MAT3: 0x8b5b,
  FLOAT_MAT4: 0x8b5c,
  FLOAT_MAT2x3: 0x8b65,
  FLOAT_MAT2x4: 0x8b66,
  FLOAT_MAT3x2: 0x8b67,
  FLOAT_MAT3x4: 0x8b68,
  FLOAT_MAT4x2: 0x8b69,
  FLOAT_MAT4x3: 0x8b6a,
  UNSIGNED_INT_VEC2: 0x8dc6,
  UNSIGNED_INT_VEC3: 0x8dc7,
  UNSIGNED_INT_VEC4: 0x8dc8,
  SAMPLER_2D: 0x8b5e,
  SAMPLER_3D: 0x8b5f,
  SAMPLER_CUBE: 0x8b60,
  SAMPLER_2D_SHADOW: 0x8b62,
  SAMPLER_2D_ARRAY: 0x8dc1,
  SAMPLER_2D_ARRAY_SHADOW: 0x8dc4,
  SAMPLER_CUBE_SHADOW: 0x8dc5,
  INT_SAMPLER_2D: 0x8dca,
  INT_SAMPLER_3D: 0x8dcb,
  INT_SAMPLER_CUBE: 0x8dcc,
  INT_SAMPLER_2D_ARRAY: 0x8dcf,
  UNSIGNED_INT_SAMPLER_2D: 0x8dd2,
  UNSIGNED_INT_SAMPLER_3D: 0x8dd3,
  UNSIGNED_INT_SAMPLER_CUBE: 0x8dd4,
  UNSIGNED_INT_SAMPLER_2D_ARRAY: 0x8dd7,

  DEPTH_COMPONENT: 0x1902,
  ALPHA: 0x1906,
  RGB: 0x1907,
  RGBA: 0x1908,
  LUMINANCE: 0x1909,
  LUMINANCE_ALPHA: 0x190a,
  RED: 0x1903,
  RG: 0x8227,
  RED_INTEGER: 0x8d94,
  RG_INTEGER: 0x8228,
  RGB_INTEGER: 0x8d98,
  RGBA_INTEGER: 0x8d99,
  DEPTH_STENCIL: 0x84f9,

  R8: 0x8229,
  R8_SNORM: 0x8f94,
  R16F: 0x822d,
  R32F: 0x822e,
  R8UI: 0x8232,
  R8I: 0x8231,
  R16UI: 0x8234,
  R16I: 0x8233,
  R32UI: 0x8236,
  R32I: 0x8235,
  RG8: 0x822b,
  RG16F: 0x822f,
  RG32F: 0x8230,
  RG8UI: 0x8238,
  RG16UI: 0x823a,
  RG32UI: 0x823c,
  RGB8: 0x8051,
  SRGB8: 0x8c41,
  RGB565: 0x8d62,
  R11F_G11F_B10F: 0x8c3a,
  RGB9_E5: 0x8c3d,
  RGB16F: 0x881b,
  RGB32F: 0x8815,
  RGB8UI: 0x8d7d,
  RGBA8: 0x8058,
  SRGB8_ALPHA8: 0x8c43,
  RGB5_A1: 0x8057,
  RGBA4: 0x8056,
  RGB10_A2: 0x8059,
  RGBA16F: 0x881a,
  RGBA32F: 0x8814,
  RGBA8UI: 0x8d7c,
  RGBA32UI: 0x8d70,
  RGBA16UI: 0x8d76,
  RGBA32I: 0x8d82,
  RGBA16I: 0x8d88,
  RGBA8I: 0x8d8e,
  RGB10_A2UI: 0x906f,
  DEPTH_COMPONENT16: 0x81a5,
  DEPTH_COMPONENT24: 0x81a6,
  DEPTH_COMPONENT32F: 0x8cac,
  DEPTH24_STENCIL8: 0x88f0,
  DEPTH32F_STENCIL8: 0x8cad,
  STENCIL_INDEX8: 0x8d48,

  UNSIGNED_SHORT_4_4_4_4: 0x8033,
  UNSIGNED_SHORT_5_5_5_1: 0x8034,
  UNSIGNED_SHORT_5_6_5: 0x8363,
  UNSIGNED_INT_2_10_10_10_REV: 0x8368,
  UNSIGNED_INT_10F_11F_11F_REV: 0x8c3b,
  UNSIGNED_INT_5_9_9_9_REV: 0x8c3e,
  UNSIGNED_INT_24_8: 0x84fa,
  FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8dad,

  FRAGMENT_SHADER: 0x8b30,
  VERTEX_SHADER: 0x8b31,
  SHADER_TYPE: 0x8b4f,
  COMPILE_STATUS: 0x8b81,
  DELETE_STATUS: 0x8b80,
  LINK_STATUS: 0x8b82,
  VALIDATE_STATUS: 0x8b83,
  ATTACHED_SHADERS: 0x8b85,
  ACTIVE_UNIFORMS: 0x8b86,
  ACTIVE_ATTRIBUTES: 0x8b89,
  ACTIVE_UNIFORM_BLOCKS: 0x8a36,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  CURRENT_PROGRAM: 0x8b8d,

  UNIFORM_BLOCK_BINDING: 0x8a3f,
  UNIFORM_BLOCK_DATA_SIZE: 0x8a40,
  UNIFORM_BLOCK_ACTIVE_UNIFORMS: 0x8a42,
  UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: 0x8a43,
  UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER: 0x8a44,
  UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER: 0x8a46,
  UNIFORM_TYPE: 0x8a37,
  UNIFORM_SIZE: 0x8a38,
  UNIFORM_BLOCK_INDEX: 0x8a3a,
  UNIFORM_OFFSET: 0x8a3b,
  UNIFORM_ARRAY_STRIDE: 0x8a3c,
  UNIFORM_MATRIX_STRIDE: 0x8a3d,
  UNIFORM_IS_ROW_MAJOR: 0x8a3e,
  UNIFORM_BUFFER_BINDING: 0x8a28,
  UNIFORM_BUFFER_START: 0x8a29,
  UNIFORM_BUFFER_SIZE: 0x8a2a,
  UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8a34,
  MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f,
  MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
  INVALID_INDEX: 0xffffffff,

  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
  LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702,
  LINEAR_MIPMAP_LINEAR: 0x2703,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TEXTURE_WRAP_R: 0x8072,
  TEXTURE_MIN_LOD: 0x813a,
  TEXTURE_MAX_LOD: 0x813b,
  TEXTURE_BASE_LEVEL: 0x813c,
  TEXTURE_MAX_LEVEL: 0x813d,
  TEXTURE_COMPARE_MODE: 0x884c,
  TEXTURE_COMPARE_FUNC: 0x884d,
  COMPARE_REF_TO_TEXTURE: 0x884e,
  NONE: 0,
  TEXTURE_2D: 0x0de1,
  TEXTURE_3D: 0x806f,
  TEXTURE_2D_ARRAY: 0x8c1a,
  TEXTURE_CUBE_MAP: 0x8513,
  TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
  TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
  TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517,
  TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
  TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519,
  TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851a,
  TEXTURE_BINDING_2D: 0x8069,
  TEXTURE_BINDING_CUBE_MAP: 0x8514,
  TEXTURE_BINDING_2D_ARRAY: 0x8c1d,
  TEXTURE_BINDING_3D: 0x806a,
  TEXTURE0: 0x84c0,
  ACTIVE_TEXTURE: 0x84e0,
  REPEAT: 0x2901,
  CLAMP_TO_EDGE: 0x812f,
  MIRRORED_REPEAT: 0x8370,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_TEXTURE_LOD_BIAS: 0x84fd,

  UNPACK_ALIGNMENT: 0x0cf5,
  PACK_ALIGNMENT: 0x0d05,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  BROWSER_DEFAULT_WEBGL: 0x9244,
  UNPACK_ROW_LENGTH: 0x0cf2,
  UNPACK_SKIP_ROWS: 0x0cf3,
  UNPACK_SKIP_PIXELS: 0x0cf4,
  UNPACK_SKIP_IMAGES: 0x806d,
  UNPACK_IMAGE_HEIGHT: 0x806e,
  PACK_ROW_LENGTH: 0x0d02,

  FRAMEBUFFER: 0x8d40,
  RENDERBUFFER: 0x8d41,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
  FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8cd7,
  FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8cd9,
  FRAMEBUFFER_UNSUPPORTED: 0x8cdd,
  FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: 0x8d56,
  COLOR_ATTACHMENT0: 0x8ce0,
  COLOR_ATTACHMENT1: 0x8ce1,
  COLOR_ATTACHMENT2: 0x8ce2,
  COLOR_ATTACHMENT3: 0x8ce3,
  COLOR_ATTACHMENT4: 0x8ce4,
  COLOR_ATTACHMENT5: 0x8ce5,
  COLOR_ATTACHMENT6: 0x8ce6,
  COLOR_ATTACHMENT7: 0x8ce7,
  DEPTH_ATTACHMENT: 0x8d00,
  STENCIL_ATTACHMENT: 0x8d20,
  DEPTH_STENCIL_ATTACHMENT: 0x821a,
  FRAMEBUFFER_BINDING: 0x8ca6,
  RENDERBUFFER_BINDING: 0x8ca7,
  DRAW_BUFFER0: 0x8825,
  READ_BUFFER: 0x0c02,
  MAX_COLOR_ATTACHMENTS: 0x8cdf,
  MAX_DRAW_BUFFERS: 0x8824,
  MAX_SAMPLES: 0x8d57,
  SAMPLES: 0x80a9,
  RENDERBUFFER_SAMPLES: 0x8cab,
  MAX_RENDERBUFFER_SIZE: 0x84e8,

  VERTEX_ARRAY_BINDING: 0x85b5,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_VERTEX_UNIFORM_COMPONENTS: 0x8b4a,
  MAX_FRAGMENT_UNIFORM_COMPONENTS: 0x8b49,
  MAX_VERTEX_OUTPUT_COMPONENTS: 0x9122,
  MAX_FRAGMENT_INPUT_COMPONENTS: 0x9125,
  MAX_ELEMENT_INDEX: 0x8d6b,
  MAX_ELEMENTS_INDICES: 0x80e9,
  MAX_ELEMENTS_VERTICES: 0x80e8,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  VIEWPORT: 0x0ba2,
  SCISSOR_BOX: 0x0c10,
  COLOR_CLEAR_VALUE: 0x0c22,
  ALIASED_LINE_WIDTH_RANGE: 0x846e,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  SUBPIXEL_BITS: 0x0d50,

  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  VERSION: 0x1f02,
  EXTENSIONS: 0x1f03,

  LOW_FLOAT: 0x8df0,
  MEDIUM_FLOAT: 0x8df1,
  HIGH_FLOAT: 0x8df2,
  LOW_INT: 0x8df3,
  MEDIUM_INT: 0x8df4,
  HIGH_INT: 0x8df5,

  QUERY_RESULT: 0x8866,
  QUERY_RESULT_AVAILABLE: 0x8867,
  ANY_SAMPLES_PASSED: 0x8c2f,
  ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8d6a,
  TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN: 0x8c88,
  TRANSFORM_FEEDBACK: 0x8e22,
  SEPARATE_ATTRIBS: 0x8c8d,
  INTERLEAVED_ATTRIBS: 0x8c8c,

  SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
  ALREADY_SIGNALED: 0x911a,
  TIMEOUT_EXPIRED: 0x911b,
  CONDITION_SATISFIED: 0x911c,
  WAIT_FAILED: 0x911d,
  SYNC_FLUSH_COMMANDS_BIT: 0x00000001,
  SYNC_STATUS: 0x9114,
  SIGNALED: 0x9119,

  COMPRESSED_RGB_S3TC_DXT1_EXT: 0x83f0,
  COMPRESSED_RGBA_S3TC_DXT1_EXT: 0x83f1,
  COMPRESSED_RGBA_S3TC_DXT3_EXT: 0x83f2,
  COMPRESSED_RGBA_S3TC_DXT5_EXT: 0x83f3,

  TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
  COMPLETION_STATUS_KHR: 0x91b1,
  TIME_ELAPSED_EXT: 0x88bf,
  TIMESTAMP_EXT: 0x8e28,
  GPU_DISJOINT_EXT: 0x8fbb,
  QUERY_COUNTER_BITS_EXT: 0x8864,
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246
};

/** GLSL type name -> GL uniform type enum. */
const GLSL_TYPE_TO_ENUM = {
  float: GL_CONSTANTS.FLOAT,
  vec2: GL_CONSTANTS.FLOAT_VEC2,
  vec3: GL_CONSTANTS.FLOAT_VEC3,
  vec4: GL_CONSTANTS.FLOAT_VEC4,
  int: GL_CONSTANTS.INT,
  ivec2: GL_CONSTANTS.INT_VEC2,
  ivec3: GL_CONSTANTS.INT_VEC3,
  ivec4: GL_CONSTANTS.INT_VEC4,
  uint: GL_CONSTANTS.UNSIGNED_INT,
  uvec2: GL_CONSTANTS.UNSIGNED_INT_VEC2,
  uvec3: GL_CONSTANTS.UNSIGNED_INT_VEC3,
  uvec4: GL_CONSTANTS.UNSIGNED_INT_VEC4,
  bool: GL_CONSTANTS.BOOL,
  bvec2: GL_CONSTANTS.BOOL_VEC2,
  bvec3: GL_CONSTANTS.BOOL_VEC3,
  bvec4: GL_CONSTANTS.BOOL_VEC4,
  mat2: GL_CONSTANTS.FLOAT_MAT2,
  mat3: GL_CONSTANTS.FLOAT_MAT3,
  mat4: GL_CONSTANTS.FLOAT_MAT4,
  mat2x3: GL_CONSTANTS.FLOAT_MAT2x3,
  mat2x4: GL_CONSTANTS.FLOAT_MAT2x4,
  mat3x2: GL_CONSTANTS.FLOAT_MAT3x2,
  mat3x4: GL_CONSTANTS.FLOAT_MAT3x4,
  mat4x2: GL_CONSTANTS.FLOAT_MAT4x2,
  mat4x3: GL_CONSTANTS.FLOAT_MAT4x3,
  sampler2D: GL_CONSTANTS.SAMPLER_2D,
  sampler3D: GL_CONSTANTS.SAMPLER_3D,
  samplerCube: GL_CONSTANTS.SAMPLER_CUBE,
  sampler2DShadow: GL_CONSTANTS.SAMPLER_2D_SHADOW,
  sampler2DArray: GL_CONSTANTS.SAMPLER_2D_ARRAY,
  sampler2DArrayShadow: GL_CONSTANTS.SAMPLER_2D_ARRAY_SHADOW,
  samplerCubeShadow: GL_CONSTANTS.SAMPLER_CUBE_SHADOW,
  isampler2D: GL_CONSTANTS.INT_SAMPLER_2D,
  isampler3D: GL_CONSTANTS.INT_SAMPLER_3D,
  isamplerCube: GL_CONSTANTS.INT_SAMPLER_CUBE,
  isampler2DArray: GL_CONSTANTS.INT_SAMPLER_2D_ARRAY,
  usampler2D: GL_CONSTANTS.UNSIGNED_INT_SAMPLER_2D,
  usampler3D: GL_CONSTANTS.UNSIGNED_INT_SAMPLER_3D,
  usamplerCube: GL_CONSTANTS.UNSIGNED_INT_SAMPLER_CUBE,
  usampler2DArray: GL_CONSTANTS.UNSIGNED_INT_SAMPLER_2D_ARRAY
};

/** GLSL type -> { align, size } in bytes following std140 rules. */
const STD140_LAYOUT = {
  float: { align: 4, size: 4 },
  int: { align: 4, size: 4 },
  uint: { align: 4, size: 4 },
  bool: { align: 4, size: 4 },
  vec2: { align: 8, size: 8 },
  ivec2: { align: 8, size: 8 },
  uvec2: { align: 8, size: 8 },
  bvec2: { align: 8, size: 8 },
  vec3: { align: 16, size: 12 },
  ivec3: { align: 16, size: 12 },
  uvec3: { align: 16, size: 12 },
  bvec3: { align: 16, size: 12 },
  vec4: { align: 16, size: 16 },
  ivec4: { align: 16, size: 16 },
  uvec4: { align: 16, size: 16 },
  bvec4: { align: 16, size: 16 },
  mat2: { align: 16, size: 32 },
  mat3: { align: 16, size: 48 },
  mat4: { align: 16, size: 64 },
  mat2x3: { align: 16, size: 32 },
  mat2x4: { align: 16, size: 32 },
  mat3x2: { align: 16, size: 48 },
  mat3x4: { align: 16, size: 48 },
  mat4x2: { align: 16, size: 64 },
  mat4x3: { align: 16, size: 64 }
};

/* ------------------------------------------------------------------------- *
 * GLSL reflection
 * ------------------------------------------------------------------------- */

/**
 * Remove GLSL comments.
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Collect `#define NAME <int>` values so array sizes can be resolved.
 * @param {string} src
 * @returns {Map<string, number>}
 */
function collectDefines(src) {
  const defines = new Map();
  const re = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(-?\d+)[ \t]*$/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) defines.set(m[1], Number(m[2]));
  return defines;
}

/**
 * Evaluate an array length expression using known defines.
 * @param {string} text
 * @param {Map<string, number>} defines
 * @returns {number}
 */
function resolveArrayLength(text, defines) {
  const trimmed = String(text || '').trim();
  if (trimmed === '') return 1;
  if (/^\d+$/.test(trimmed)) return Math.max(1, parseInt(trimmed, 10));
  if (defines.has(trimmed)) return Math.max(1, defines.get(trimmed));
  const expression = trimmed.replace(/[A-Za-z_]\w*/g, (name) => (defines.has(name) ? String(defines.get(name)) : 'NaN'));
  if (/^[\d\s+\-*/()]+$/.test(expression)) {
    try {
      // eslint-disable-next-line no-new-func
      const value = Function('"use strict";return (' + expression + ');')();
      if (Number.isFinite(value) && value > 0) return Math.floor(value);
    } catch {
      /* fall through */
    }
  }
  return 1;
}

/**
 * Compute the std140 size of a uniform block body.
 * @param {Array<{type:string, size:number}>} members
 * @returns {number}
 */
function std140BlockSize(members) {
  let offset = 0;
  for (let i = 0; i < members.length; i++) {
    const info = STD140_LAYOUT[members[i].type] || { align: 16, size: 16 };
    const count = members[i].size;
    if (count > 1) {
      const stride = Math.ceil(info.size / 16) * 16;
      offset = Math.ceil(offset / 16) * 16;
      offset += stride * count;
    } else {
      offset = Math.ceil(offset / info.align) * info.align;
      offset += info.size;
    }
  }
  return Math.ceil(offset / 16) * 16;
}

/**
 * Parse the interface (attributes, uniforms, uniform blocks) of a GLSL source.
 * @param {string} source
 * @returns {{attributes:Array, uniforms:Array, blocks:Array}}
 */
export function parseGLSLInterface(source) {
  const attributes = [];
  const uniforms = [];
  const blocks = [];
  if (!source) return { attributes, uniforms, blocks };

  const clean = stripComments(source);
  const defines = collectDefines(clean);

  // Uniform blocks first (their bodies must not be scanned for plain uniforms).
  let rest = '';
  let index = 0;
  const blockRe = /(?:layout\s*\([^)]*\)\s*)?uniform\s+([A-Za-z_]\w*)\s*\{/g;
  for (let m = blockRe.exec(clean); m; m = blockRe.exec(clean)) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < clean.length && depth > 0) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') depth--;
      i++;
    }
    const body = clean.slice(bodyStart, Math.max(bodyStart, i - 1));
    const members = [];
    const memberRe = /(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*;/g;
    for (let mm = memberRe.exec(body); mm; mm = memberRe.exec(body)) {
      members.push({ type: mm[1], name: mm[2], size: resolveArrayLength(mm[3], defines) });
    }
    blocks.push({ name: m[1], members, dataSize: std140BlockSize(members) });
    rest += clean.slice(index, m.index);
    index = i;
    blockRe.lastIndex = i;
  }
  rest += clean.slice(index);

  // Vertex attributes: layout(location = N) in <type> <name>;
  const attribRe = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([A-Za-z_]\w*)/g;
  for (let m = attribRe.exec(rest); m; m = attribRe.exec(rest)) {
    attributes.push({
      name: m[3],
      location: Number(m[1]),
      type: GLSL_TYPE_TO_ENUM[m[2]] !== undefined ? GLSL_TYPE_TO_ENUM[m[2]] : GL_CONSTANTS.FLOAT_VEC4,
      size: 1
    });
  }

  // Plain uniforms (samplers included).
  const uniformRe = /(?:layout\s*\([^)]*\)\s*)?uniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_]\w*)\s+([^;{]+);/g;
  for (let m = uniformRe.exec(rest); m; m = uniformRe.exec(rest)) {
    const type = m[1];
    if (GLSL_TYPE_TO_ENUM[type] === undefined) continue;
    const declarators = m[2].split(',');
    for (let d = 0; d < declarators.length; d++) {
      const declaration = /^\s*([A-Za-z_]\w*)\s*(?:\[([^\]]*)\])?\s*$/.exec(declarators[d]);
      if (!declaration) continue;
      const count = declaration[2] !== undefined ? resolveArrayLength(declaration[2], defines) : 1;
      uniforms.push({
        name: declaration[2] !== undefined ? declaration[1] + '[0]' : declaration[1],
        type: GLSL_TYPE_TO_ENUM[type],
        size: count
      });
    }
  }

  return { attributes, uniforms, blocks };
}

/* ------------------------------------------------------------------------- *
 * Mock GL objects
 * ------------------------------------------------------------------------- */

let nextObjectId = 1;

/** A generic fake WebGL object handle. */
class MockGLObject {
  /**
   * @param {string} kind object family, used in debug output
   */
  constructor(kind) {
    this.kind = kind;
    this.id = nextObjectId++;
    this.deleted = false;
  }
}

/** A fake WebGLUniformLocation. */
class MockUniformLocation {
  /**
   * @param {string} name uniform name
   * @param {number} programId owning program id
   */
  constructor(name, programId) {
    this.name = name;
    this.programId = programId;
  }
}

/* ------------------------------------------------------------------------- *
 * The context itself
 * ------------------------------------------------------------------------- */

/**
 * A fake WebGL2RenderingContext good enough to run the whole engine headlessly.
 */
export class MockWebGL2RenderingContext {
  /**
   * @param {object} [options]
   * @param {object} [options.canvas] owning canvas
   * @param {boolean} [options.log] record every call into `calls`
   * @param {number} [options.maxLog] maximum recorded calls (default 100000)
   * @param {string[]} [options.disabledExtensions] extensions that must return null
   */
  constructor(options = {}) {
    /** @type {object} */
    this.canvas = options.canvas || null;
    this.drawingBufferWidth = (this.canvas && this.canvas.width) || 1280;
    this.drawingBufferHeight = (this.canvas && this.canvas.height) || 720;
    this.drawingBufferColorSpace = 'srgb';
    this.unpackColorSpace = 'srgb';

    /** Recorded calls (only when logging is enabled). */
    this.calls = [];
    this.logging = !!options.log;
    this.maxLog = options.maxLog || 100000;
    this.disabledExtensions = new Set(options.disabledExtensions || []);

    /** Aggregate counters, handy for smoke tests. */
    this.stats = {
      calls: 0,
      drawCalls: 0,
      instancedDrawCalls: 0,
      triangles: 0,
      lines: 0,
      points: 0,
      shaders: 0,
      programs: 0,
      textures: 0,
      buffers: 0,
      framebuffers: 0,
      renderbuffers: 0,
      vertexArrays: 0,
      samplers: 0,
      queries: 0,
      bufferBytes: 0,
      textureBytes: 0,
      clears: 0,
      uniformUpdates: 0
    };

    /** Currently bound state (mirrors what a driver would track). */
    this.state = {
      program: null,
      vertexArray: null,
      framebuffer: null,
      readFramebuffer: null,
      renderbuffer: null,
      activeTexture: GL_CONSTANTS.TEXTURE0,
      textures: new Map(),
      buffers: new Map(),
      uniformBufferBindings: new Map(),
      enabled: new Set(),
      viewport: [0, 0, this.drawingBufferWidth, this.drawingBufferHeight],
      scissor: [0, 0, this.drawingBufferWidth, this.drawingBufferHeight],
      clearColor: [0, 0, 0, 0]
    };

    /** @type {Map<number, object>} program id -> reflection data */
    this._programData = new Map();
    /** @type {Map<number, object>} shader id -> source data */
    this._shaderData = new Map();
    /** @type {Map<string, object>} extension cache */
    this._extensions = new Map();
    this._contextLost = false;

    if (this.logging) this._installLogging();
  }

  /* --------------------------------------------------------------------- *
   * Bookkeeping helpers
   * --------------------------------------------------------------------- */

  /**
   * Wrap every prototype method so calls are recorded.
   * @private
   */
  _installLogging() {
    const proto = Object.getPrototypeOf(this);
    const names = Object.getOwnPropertyNames(proto);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name === 'constructor' || name.startsWith('_')) continue;
      const fn = proto[name];
      if (typeof fn !== 'function') continue;
      Object.defineProperty(this, name, {
        value: (...args) => {
          if (this.calls.length < this.maxLog) this.calls.push({ name, args });
          return fn.apply(this, args);
        },
        writable: true,
        configurable: true,
        enumerable: false
      });
    }
  }

  /** Clear the recorded call log. */
  clearLog() {
    this.calls.length = 0;
  }

  /**
   * Return the recorded call log, optionally filtered by name.
   * @param {string} [name]
   * @returns {Array<{name:string, args:any[]}>}
   */
  getLog(name) {
    if (!name) return this.calls;
    return this.calls.filter((entry) => entry.name === name);
  }

  /** Reset every counter. */
  resetStats() {
    const stats = this.stats;
    for (const key of Object.keys(stats)) stats[key] = 0;
  }

  /**
   * Number of times a given entry point was called (requires logging).
   * @param {string} name
   * @returns {number}
   */
  countCalls(name) {
    let total = 0;
    for (let i = 0; i < this.calls.length; i++) if (this.calls[i].name === name) total++;
    return total;
  }

  /* --------------------------------------------------------------------- *
   * Context level
   * --------------------------------------------------------------------- */

  /** @returns {boolean} */
  isContextLost() {
    return this._contextLost;
  }

  /** @returns {number} */
  getError() {
    return GL_CONSTANTS.NO_ERROR;
  }

  /** @returns {string[]} */
  getSupportedExtensions() {
    return [
      'EXT_color_buffer_float',
      'OES_texture_float_linear',
      'EXT_texture_filter_anisotropic',
      'EXT_disjoint_timer_query_webgl2',
      'KHR_parallel_shader_compile',
      'WEBGL_compressed_texture_s3tc',
      'WEBGL_compressed_texture_s3tc_srgb',
      'WEBGL_compressed_texture_etc',
      'WEBGL_compressed_texture_astc',
      'WEBGL_debug_renderer_info',
      'WEBGL_lose_context',
      'EXT_float_blend',
      'EXT_texture_norm16',
      'OES_draw_buffers_indexed'
    ].filter((name) => !this.disabledExtensions.has(name));
  }

  /**
   * @param {string} name
   * @returns {object|null}
   */
  getExtension(name) {
    if (this.disabledExtensions.has(name)) return null;
    if (this._extensions.has(name)) return this._extensions.get(name);
    let ext = null;
    switch (name) {
      case 'EXT_color_buffer_float':
      case 'OES_texture_float_linear':
      case 'EXT_float_blend':
      case 'EXT_texture_norm16':
      case 'OES_draw_buffers_indexed':
        ext = {};
        break;
      case 'EXT_texture_filter_anisotropic':
        ext = {
          TEXTURE_MAX_ANISOTROPY_EXT: GL_CONSTANTS.TEXTURE_MAX_ANISOTROPY_EXT,
          MAX_TEXTURE_MAX_ANISOTROPY_EXT: GL_CONSTANTS.MAX_TEXTURE_MAX_ANISOTROPY_EXT
        };
        break;
      case 'EXT_disjoint_timer_query_webgl2':
        ext = {
          TIME_ELAPSED_EXT: GL_CONSTANTS.TIME_ELAPSED_EXT,
          TIMESTAMP_EXT: GL_CONSTANTS.TIMESTAMP_EXT,
          GPU_DISJOINT_EXT: GL_CONSTANTS.GPU_DISJOINT_EXT,
          QUERY_COUNTER_BITS_EXT: GL_CONSTANTS.QUERY_COUNTER_BITS_EXT,
          queryCounterEXT: () => {}
        };
        break;
      case 'KHR_parallel_shader_compile':
        ext = { COMPLETION_STATUS_KHR: GL_CONSTANTS.COMPLETION_STATUS_KHR };
        break;
      case 'WEBGL_compressed_texture_s3tc':
        ext = {
          COMPRESSED_RGB_S3TC_DXT1_EXT: GL_CONSTANTS.COMPRESSED_RGB_S3TC_DXT1_EXT,
          COMPRESSED_RGBA_S3TC_DXT1_EXT: GL_CONSTANTS.COMPRESSED_RGBA_S3TC_DXT1_EXT,
          COMPRESSED_RGBA_S3TC_DXT3_EXT: GL_CONSTANTS.COMPRESSED_RGBA_S3TC_DXT3_EXT,
          COMPRESSED_RGBA_S3TC_DXT5_EXT: GL_CONSTANTS.COMPRESSED_RGBA_S3TC_DXT5_EXT
        };
        break;
      case 'WEBGL_compressed_texture_s3tc_srgb':
        ext = {
          COMPRESSED_SRGB_S3TC_DXT1_EXT: 0x8c4c,
          COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT: 0x8c4d,
          COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT: 0x8c4e,
          COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT: 0x8c4f
        };
        break;
      case 'WEBGL_compressed_texture_etc':
        ext = {
          COMPRESSED_RGB8_ETC2: 0x9274,
          COMPRESSED_SRGB8_ETC2: 0x9275,
          COMPRESSED_RGBA8_ETC2_EAC: 0x9278,
          COMPRESSED_SRGB8_ALPHA8_ETC2_EAC: 0x9279,
          COMPRESSED_R11_EAC: 0x9270,
          COMPRESSED_RG11_EAC: 0x9272
        };
        break;
      case 'WEBGL_compressed_texture_astc':
        ext = {
          COMPRESSED_RGBA_ASTC_4x4_KHR: 0x93b0,
          COMPRESSED_RGBA_ASTC_6x6_KHR: 0x93b4,
          COMPRESSED_RGBA_ASTC_8x8_KHR: 0x93b7,
          COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR: 0x93d0,
          getSupportedProfiles: () => ['ldr']
        };
        break;
      case 'WEBGL_debug_renderer_info':
        ext = {
          UNMASKED_VENDOR_WEBGL: GL_CONSTANTS.UNMASKED_VENDOR_WEBGL,
          UNMASKED_RENDERER_WEBGL: GL_CONSTANTS.UNMASKED_RENDERER_WEBGL
        };
        break;
      case 'WEBGL_lose_context':
        ext = {
          loseContext: () => {
            this._contextLost = true;
          },
          restoreContext: () => {
            this._contextLost = false;
          }
        };
        break;
      default:
        ext = null;
    }
    this._extensions.set(name, ext);
    return ext;
  }

  /**
   * @param {number} pname
   * @returns {*}
   */
  getParameter(pname) {
    const C = GL_CONSTANTS;
    switch (pname) {
      case C.MAX_TEXTURE_SIZE:
        return 16384;
      case C.MAX_CUBE_MAP_TEXTURE_SIZE:
        return 16384;
      case C.MAX_3D_TEXTURE_SIZE:
        return 2048;
      case C.MAX_RENDERBUFFER_SIZE:
        return 16384;
      case C.MAX_TEXTURE_IMAGE_UNITS:
        return 16;
      case C.MAX_VERTEX_TEXTURE_IMAGE_UNITS:
        return 16;
      case C.MAX_COMBINED_TEXTURE_IMAGE_UNITS:
        return 32;
      case C.MAX_VERTEX_ATTRIBS:
        return 16;
      case C.MAX_UNIFORM_BUFFER_BINDINGS:
        return 24;
      case C.MAX_UNIFORM_BLOCK_SIZE:
        return 65536;
      case C.UNIFORM_BUFFER_OFFSET_ALIGNMENT:
        return 256;
      case C.MAX_ARRAY_TEXTURE_LAYERS:
        return 256;
      case C.MAX_COLOR_ATTACHMENTS:
        return 8;
      case C.MAX_DRAW_BUFFERS:
        return 8;
      case C.MAX_SAMPLES:
        return 4;
      case C.SAMPLES:
        return 0;
      case C.MAX_VARYING_VECTORS:
        return 30;
      case C.MAX_VERTEX_UNIFORM_VECTORS:
        return 4096;
      case C.MAX_FRAGMENT_UNIFORM_VECTORS:
        return 4096;
      case C.MAX_VERTEX_UNIFORM_COMPONENTS:
        return 16384;
      case C.MAX_FRAGMENT_UNIFORM_COMPONENTS:
        return 16384;
      case C.MAX_VERTEX_OUTPUT_COMPONENTS:
        return 128;
      case C.MAX_FRAGMENT_INPUT_COMPONENTS:
        return 128;
      case C.MAX_ELEMENT_INDEX:
        return 4294967294;
      case C.MAX_ELEMENTS_INDICES:
        return 150000;
      case C.MAX_ELEMENTS_VERTICES:
        return 1048576;
      case C.MAX_TEXTURE_LOD_BIAS:
        return 2;
      case C.MAX_VIEWPORT_DIMS:
        return new Int32Array([16384, 16384]);
      case C.ALIASED_LINE_WIDTH_RANGE:
        return new Float32Array([1, 1]);
      case C.ALIASED_POINT_SIZE_RANGE:
        return new Float32Array([1, 1024]);
      case C.SUBPIXEL_BITS:
        return 4;
      case C.VIEWPORT:
        return new Int32Array(this.state.viewport);
      case C.SCISSOR_BOX:
        return new Int32Array(this.state.scissor);
      case C.COLOR_CLEAR_VALUE:
        return new Float32Array(this.state.clearColor);
      case C.VERSION:
        return 'WebGL 2.0 (MockGL 1.0)';
      case C.SHADING_LANGUAGE_VERSION:
        return 'WebGL GLSL ES 3.00 (MockGL 1.0)';
      case C.VENDOR:
        return 'AICoders';
      case C.RENDERER:
        return 'MockGL Headless Renderer';
      case C.UNMASKED_VENDOR_WEBGL:
        return 'AICoders Software';
      case C.UNMASKED_RENDERER_WEBGL:
        return 'MockGL Headless Renderer (node)';
      case C.MAX_TEXTURE_MAX_ANISOTROPY_EXT:
        return 16;
      case C.CURRENT_PROGRAM:
        return this.state.program;
      case C.FRAMEBUFFER_BINDING:
        return this.state.framebuffer;
      case C.VERTEX_ARRAY_BINDING:
        return this.state.vertexArray;
      case C.ACTIVE_TEXTURE:
        return this.state.activeTexture;
      case C.ARRAY_BUFFER_BINDING:
        return this.state.buffers.get(C.ARRAY_BUFFER) || null;
      case C.ELEMENT_ARRAY_BUFFER_BINDING:
        return this.state.buffers.get(C.ELEMENT_ARRAY_BUFFER) || null;
      case C.DEPTH_TEST:
      case C.BLEND:
      case C.CULL_FACE:
      case C.SCISSOR_TEST:
      case C.STENCIL_TEST:
      case C.POLYGON_OFFSET_FILL:
      case C.RASTERIZER_DISCARD:
        return this.state.enabled.has(pname);
      case C.DEPTH_WRITEMASK:
        return true;
      case C.GPU_DISJOINT_EXT:
        return false;
      default:
        return 0;
    }
  }

  /**
   * @param {number} shaderType
   * @param {number} precisionType
   * @returns {{rangeMin:number, rangeMax:number, precision:number}}
   */
  getShaderPrecisionFormat() {
    return { rangeMin: 127, rangeMax: 127, precision: 23 };
  }

  /** @returns {object} */
  getContextAttributes() {
    return {
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
      desynchronized: false
    };
  }

  /* --------------------------------------------------------------------- *
   * Shaders and programs
   * --------------------------------------------------------------------- */

  /**
   * @param {number} type
   * @returns {object}
   */
  createShader(type) {
    const shader = new MockGLObject('shader');
    shader.type = type;
    this._shaderData.set(shader.id, { type, source: '' });
    this.stats.shaders++;
    return shader;
  }

  /**
   * @param {object} shader
   * @param {string} source
   */
  shaderSource(shader, source) {
    if (!shader) return;
    const data = this._shaderData.get(shader.id);
    if (data) data.source = String(source == null ? '' : source);
  }

  /** @param {object} shader */
  compileShader(shader) {
    if (!shader) return;
    const data = this._shaderData.get(shader.id);
    if (data) data.compiled = true;
  }

  /**
   * @param {object} shader
   * @param {number} pname
   * @returns {*}
   */
  getShaderParameter(shader, pname) {
    if (pname === GL_CONSTANTS.COMPILE_STATUS) return true;
    if (pname === GL_CONSTANTS.DELETE_STATUS) return !!(shader && shader.deleted);
    if (pname === GL_CONSTANTS.SHADER_TYPE) return shader ? shader.type : 0;
    return true;
  }

  /** @returns {string} */
  getShaderInfoLog() {
    return '';
  }

  /**
   * @param {object} shader
   * @returns {string}
   */
  getShaderSource(shader) {
    const data = shader && this._shaderData.get(shader.id);
    return data ? data.source : '';
  }

  /** @param {object} shader */
  deleteShader(shader) {
    if (!shader) return;
    shader.deleted = true;
    this._shaderData.delete(shader.id);
  }

  /** @returns {object} */
  createProgram() {
    const program = new MockGLObject('program');
    this._programData.set(program.id, {
      shaders: [],
      attributes: [],
      uniforms: [],
      blocks: [],
      locations: new Map(),
      blockBindings: new Map(),
      linked: false
    });
    this.stats.programs++;
    return program;
  }

  /**
   * @param {object} program
   * @param {object} shader
   */
  attachShader(program, shader) {
    if (!program || !shader) return;
    const data = this._programData.get(program.id);
    const shaderData = this._shaderData.get(shader.id);
    if (data && shaderData) data.shaders.push(shaderData);
  }

  /**
   * @param {object} program
   * @param {object} shader
   */
  detachShader(program, shader) {
    if (!program || !shader) return;
    const data = this._programData.get(program.id);
    const shaderData = this._shaderData.get(shader.id);
    if (!data || !shaderData) return;
    const index = data.shaders.indexOf(shaderData);
    if (index !== -1) data.shaders.splice(index, 1);
  }

  /** @param {object} program */
  linkProgram(program) {
    if (!program) return;
    const data = this._programData.get(program.id);
    if (!data) return;
    const attributes = [];
    const uniforms = [];
    const blocks = [];
    const seenUniforms = new Set();
    const seenAttributes = new Set();
    const seenBlocks = new Set();
    for (let i = 0; i < data.shaders.length; i++) {
      const parsed = parseGLSLInterface(data.shaders[i].source);
      for (let k = 0; k < parsed.attributes.length; k++) {
        const attribute = parsed.attributes[k];
        if (seenAttributes.has(attribute.name)) continue;
        seenAttributes.add(attribute.name);
        attributes.push(attribute);
      }
      for (let k = 0; k < parsed.uniforms.length; k++) {
        const uniform = parsed.uniforms[k];
        if (seenUniforms.has(uniform.name)) continue;
        seenUniforms.add(uniform.name);
        uniforms.push(uniform);
      }
      for (let k = 0; k < parsed.blocks.length; k++) {
        const block = parsed.blocks[k];
        if (seenBlocks.has(block.name)) continue;
        seenBlocks.add(block.name);
        blocks.push(block);
      }
    }
    data.attributes = attributes;
    data.uniforms = uniforms;
    data.blocks = blocks;
    data.linked = true;
  }

  /**
   * @param {object} program
   * @param {number} pname
   * @returns {*}
   */
  getProgramParameter(program, pname) {
    const data = program ? this._programData.get(program.id) : null;
    const C = GL_CONSTANTS;
    switch (pname) {
      case C.LINK_STATUS:
      case C.VALIDATE_STATUS:
      case C.COMPLETION_STATUS_KHR:
        return true;
      case C.DELETE_STATUS:
        return !!(program && program.deleted);
      case C.ACTIVE_UNIFORMS:
        return data ? data.uniforms.length : 0;
      case C.ACTIVE_ATTRIBUTES:
        return data ? data.attributes.length : 0;
      case C.ACTIVE_UNIFORM_BLOCKS:
        return data ? data.blocks.length : 0;
      case C.ATTACHED_SHADERS:
        return data ? data.shaders.length : 0;
      default:
        return 0;
    }
  }

  /** @returns {string} */
  getProgramInfoLog() {
    return '';
  }

  /** @param {object} program */
  validateProgram() {}

  /** @param {object} program */
  useProgram(program) {
    this.state.program = program || null;
  }

  /** @param {object} program */
  deleteProgram(program) {
    if (!program) return;
    program.deleted = true;
    this._programData.delete(program.id);
  }

  /**
   * @param {object} program
   * @param {number} index
   * @returns {{name:string, size:number, type:number}|null}
   */
  getActiveUniform(program, index) {
    const data = program ? this._programData.get(program.id) : null;
    if (!data || index < 0 || index >= data.uniforms.length) return null;
    const uniform = data.uniforms[index];
    return { name: uniform.name, size: uniform.size, type: uniform.type };
  }

  /**
   * @param {object} program
   * @param {number} index
   * @returns {{name:string, size:number, type:number}|null}
   */
  getActiveAttrib(program, index) {
    const data = program ? this._programData.get(program.id) : null;
    if (!data || index < 0 || index >= data.attributes.length) return null;
    const attribute = data.attributes[index];
    return { name: attribute.name, size: attribute.size, type: attribute.type };
  }

  /**
   * @param {object} program
   * @param {string} name
   * @returns {number}
   */
  getAttribLocation(program, name) {
    const data = program ? this._programData.get(program.id) : null;
    if (!data) return -1;
    for (let i = 0; i < data.attributes.length; i++) {
      if (data.attributes[i].name === name) return data.attributes[i].location;
    }
    return -1;
  }

  /** @param {object} program @param {number} index @param {string} name */
  bindAttribLocation() {}

  /**
   * Returns a stable location object per (program, name) pair. Unknown names
   * still get a location so an engine querying a stripped uniform does not
   * crash the headless run.
   * @param {object} program
   * @param {string} name
   * @returns {MockUniformLocation|null}
   */
  getUniformLocation(program, name) {
    const data = program ? this._programData.get(program.id) : null;
    if (!data) return null;
    let location = data.locations.get(name);
    if (!location) {
      location = new MockUniformLocation(name, program.id);
      data.locations.set(name, location);
    }
    return location;
  }

  /**
   * @param {object} program
   * @param {string} name
   * @returns {number}
   */
  getUniformBlockIndex(program, name) {
    const data = program ? this._programData.get(program.id) : null;
    if (!data) return GL_CONSTANTS.INVALID_INDEX;
    for (let i = 0; i < data.blocks.length; i++) if (data.blocks[i].name === name) return i;
    return GL_CONSTANTS.INVALID_INDEX;
  }

  /**
   * @param {object} program
   * @param {number} index
   * @returns {string|null}
   */
  getActiveUniformBlockName(program, index) {
    const data = program ? this._programData.get(program.id) : null;
    if (!data || index < 0 || index >= data.blocks.length) return null;
    return data.blocks[index].name;
  }

  /**
   * @param {object} program
   * @param {number} index
   * @param {number} pname
   * @returns {*}
   */
  getActiveUniformBlockParameter(program, index, pname) {
    const data = program ? this._programData.get(program.id) : null;
    const block = data && data.blocks[index] ? data.blocks[index] : null;
    const C = GL_CONSTANTS;
    switch (pname) {
      case C.UNIFORM_BLOCK_DATA_SIZE:
        return block ? block.dataSize : 0;
      case C.UNIFORM_BLOCK_ACTIVE_UNIFORMS:
        return block ? block.members.length : 0;
      case C.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: {
        if (!block) return new Uint32Array(0);
        const indices = new Uint32Array(block.members.length);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
        return indices;
      }
      case C.UNIFORM_BLOCK_BINDING:
        return data && data.blockBindings.has(index) ? data.blockBindings.get(index) : 0;
      case C.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER:
      case C.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER:
        return true;
      default:
        return 0;
    }
  }

  /**
   * @param {object} program
   * @param {string[]} names
   * @returns {number[]}
   */
  getUniformIndices(program, names) {
    const data = program ? this._programData.get(program.id) : null;
    const out = [];
    for (let i = 0; i < names.length; i++) {
      let found = GL_CONSTANTS.INVALID_INDEX;
      if (data) {
        for (let k = 0; k < data.uniforms.length; k++) {
          if (data.uniforms[k].name === names[i] || data.uniforms[k].name === names[i] + '[0]') found = k;
        }
      }
      out.push(found);
    }
    return out;
  }

  /**
   * @param {object} program
   * @param {number[]} indices
   * @param {number} pname
   * @returns {number[]}
   */
  getActiveUniforms(program, indices, pname) {
    const data = program ? this._programData.get(program.id) : null;
    const out = [];
    let offset = 0;
    for (let i = 0; i < indices.length; i++) {
      const uniform = data ? data.uniforms[indices[i]] : null;
      switch (pname) {
        case GL_CONSTANTS.UNIFORM_TYPE:
          out.push(uniform ? uniform.type : 0);
          break;
        case GL_CONSTANTS.UNIFORM_SIZE:
          out.push(uniform ? uniform.size : 0);
          break;
        case GL_CONSTANTS.UNIFORM_OFFSET:
          out.push(offset);
          offset += 16;
          break;
        case GL_CONSTANTS.UNIFORM_ARRAY_STRIDE:
          out.push(16);
          break;
        case GL_CONSTANTS.UNIFORM_MATRIX_STRIDE:
          out.push(16);
          break;
        case GL_CONSTANTS.UNIFORM_IS_ROW_MAJOR:
          out.push(0);
          break;
        case GL_CONSTANTS.UNIFORM_BLOCK_INDEX:
          out.push(-1);
          break;
        default:
          out.push(0);
      }
    }
    return out;
  }

  /**
   * @param {object} program
   * @param {number} blockIndex
   * @param {number} binding
   */
  uniformBlockBinding(program, blockIndex, binding) {
    const data = program ? this._programData.get(program.id) : null;
    if (data) data.blockBindings.set(blockIndex, binding);
  }

  /**
   * @param {object} program
   * @param {string} name
   * @returns {number}
   */
  getFragDataLocation() {
    return 0;
  }

  /** @returns {*} */
  getUniform() {
    return 0;
  }

  /* --------------------------------------------------------------------- *
   * Buffers
   * --------------------------------------------------------------------- */

  /** @returns {object} */
  createBuffer() {
    this.stats.buffers++;
    return new MockGLObject('buffer');
  }

  /**
   * @param {number} target
   * @param {object|null} buffer
   */
  bindBuffer(target, buffer) {
    this.state.buffers.set(target, buffer || null);
  }

  /**
   * @param {number} target
   * @param {number} index
   * @param {object|null} buffer
   */
  bindBufferBase(target, index, buffer) {
    this.state.uniformBufferBindings.set(index, buffer || null);
  }

  /**
   * @param {number} target
   * @param {number} index
   * @param {object|null} buffer
   */
  bindBufferRange(target, index, buffer) {
    this.state.uniformBufferBindings.set(index, buffer || null);
  }

  /**
   * @param {number} target
   * @param {ArrayBufferView|number} data
   */
  bufferData(target, data) {
    const buffer = this.state.buffers.get(target);
    const bytes = typeof data === 'number' ? data : data && data.byteLength ? data.byteLength : 0;
    if (buffer) buffer.byteLength = bytes;
    this.stats.bufferBytes += bytes;
  }

  /** @param {number} target */
  bufferSubData() {}

  /** @param {object} buffer */
  deleteBuffer(buffer) {
    if (buffer) buffer.deleted = true;
  }

  /**
   * @param {number} target
   * @param {number} pname
   * @returns {number}
   */
  getBufferParameter(target, pname) {
    const buffer = this.state.buffers.get(target);
    if (pname === GL_CONSTANTS.BUFFER_SIZE) return buffer && buffer.byteLength ? buffer.byteLength : 0;
    return 0;
  }

  /** @returns {boolean} */
  isBuffer(buffer) {
    return !!buffer && buffer.kind === 'buffer' && !buffer.deleted;
  }

  /** @param {number} readTarget */
  copyBufferSubData() {}

  /** @param {number} target */
  getBufferSubData() {}

  /* --------------------------------------------------------------------- *
   * Vertex arrays and attributes
   * --------------------------------------------------------------------- */

  /** @returns {object} */
  createVertexArray() {
    this.stats.vertexArrays++;
    return new MockGLObject('vertexArray');
  }

  /** @param {object|null} vao */
  bindVertexArray(vao) {
    this.state.vertexArray = vao || null;
  }

  /** @param {object} vao */
  deleteVertexArray(vao) {
    if (vao) vao.deleted = true;
  }

  /** @returns {boolean} */
  isVertexArray(vao) {
    return !!vao && vao.kind === 'vertexArray' && !vao.deleted;
  }

  /** @param {number} index */
  enableVertexAttribArray() {}

  /** @param {number} index */
  disableVertexAttribArray() {}

  /** @param {number} index */
  vertexAttribPointer() {}

  /** @param {number} index */
  vertexAttribIPointer() {}

  /** @param {number} index */
  vertexAttribDivisor() {}

  /** @param {number} index */
  vertexAttrib1f() {}

  /** @param {number} index */
  vertexAttrib2f() {}

  /** @param {number} index */
  vertexAttrib3f() {}

  /** @param {number} index */
  vertexAttrib4f() {}

  /** @param {number} index */
  vertexAttrib4fv() {}

  /** @param {number} index */
  vertexAttribI4i() {}

  /** @param {number} index */
  vertexAttribI4ui() {}

  /** @returns {*} */
  getVertexAttrib() {
    return null;
  }

  /* --------------------------------------------------------------------- *
   * Textures
   * --------------------------------------------------------------------- */

  /** @returns {object} */
  createTexture() {
    this.stats.textures++;
    return new MockGLObject('texture');
  }

  /**
   * @param {number} target
   * @param {object|null} texture
   */
  bindTexture(target, texture) {
    const unit = this.state.activeTexture - GL_CONSTANTS.TEXTURE0;
    this.state.textures.set(unit + ':' + target, texture || null);
  }

  /** @param {number} unit */
  activeTexture(unit) {
    this.state.activeTexture = unit;
  }

  /** @param {object} texture */
  deleteTexture(texture) {
    if (texture) texture.deleted = true;
  }

  /** @returns {boolean} */
  isTexture(texture) {
    return !!texture && texture.kind === 'texture' && !texture.deleted;
  }

  /**
   * @param {number} target
   * @param {number} level
   * @param {number} internalFormat
   * @param {number} width
   * @param {number} height
   */
  texImage2D(target, level, internalFormat, width, height) {
    if (typeof width === 'number' && typeof height === 'number') this.stats.textureBytes += width * height * 4;
  }

  /**
   * @param {number} target
   * @param {number} level
   * @param {number} internalFormat
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   */
  texImage3D(target, level, internalFormat, width, height, depth) {
    if (typeof width === 'number' && typeof height === 'number' && typeof depth === 'number') {
      this.stats.textureBytes += width * height * depth * 4;
    }
  }

  /** @param {number} target */
  texSubImage2D() {}

  /** @param {number} target */
  texSubImage3D() {}

  /**
   * @param {number} target
   * @param {number} levels
   * @param {number} internalFormat
   * @param {number} width
   * @param {number} height
   */
  texStorage2D(target, levels, internalFormat, width, height) {
    this.stats.textureBytes += (width || 0) * (height || 0) * 4;
  }

  /**
   * @param {number} target
   * @param {number} levels
   * @param {number} internalFormat
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   */
  texStorage3D(target, levels, internalFormat, width, height, depth) {
    this.stats.textureBytes += (width || 0) * (height || 0) * (depth || 0) * 4;
  }

  /** @param {number} target */
  compressedTexImage2D() {}

  /** @param {number} target */
  compressedTexImage3D() {}

  /** @param {number} target */
  compressedTexSubImage2D() {}

  /** @param {number} target */
  compressedTexSubImage3D() {}

  /** @param {number} target */
  copyTexImage2D() {}

  /** @param {number} target */
  copyTexSubImage2D() {}

  /** @param {number} target */
  copyTexSubImage3D() {}

  /** @param {number} target */
  texParameteri() {}

  /** @param {number} target */
  texParameterf() {}

  /** @returns {*} */
  getTexParameter() {
    return 0;
  }

  /** @param {number} target */
  generateMipmap() {}

  /** @param {number} pname */
  pixelStorei() {}

  /* --------------------------------------------------------------------- *
   * Samplers
   * --------------------------------------------------------------------- */

  /** @returns {object} */
  createSampler() {
    this.stats.samplers++;
    return new MockGLObject('sampler');
  }

  /** @param {number} unit */
  bindSampler() {}

  /** @param {object} sampler */
  deleteSampler(sampler) {
    if (sampler) sampler.deleted = true;
  }

  /** @param {object} sampler */
  samplerParameteri() {}

  /** @param {object} sampler */
  samplerParameterf() {}

  /** @returns {*} */
  getSamplerParameter() {
    return 0;
  }

  /* --------------------------------------------------------------------- *
   * Framebuffers and renderbuffers
   * --------------------------------------------------------------------- */

  /** @returns {object} */
  createFramebuffer() {
    this.stats.framebuffers++;
    return new MockGLObject('framebuffer');
  }

  /**
   * @param {number} target
   * @param {object|null} framebuffer
   */
  bindFramebuffer(target, framebuffer) {
    if (target === GL_CONSTANTS.READ_FRAMEBUFFER) this.state.readFramebuffer = framebuffer || null;
    else this.state.framebuffer = framebuffer || null;
  }

  /** @param {object} framebuffer */
  deleteFramebuffer(framebuffer) {
    if (framebuffer) framebuffer.deleted = true;
  }

  /** @returns {boolean} */
  isFramebuffer(framebuffer) {
    return !!framebuffer && framebuffer.kind === 'framebuffer' && !framebuffer.deleted;
  }

  /** @param {number} target */
  framebufferTexture2D() {}

  /** @param {number} target */
  framebufferTextureLayer() {}

  /** @param {number} target */
  framebufferRenderbuffer() {}

  /** @returns {number} */
  checkFramebufferStatus() {
    return GL_CONSTANTS.FRAMEBUFFER_COMPLETE;
  }

  /** @returns {*} */
  getFramebufferAttachmentParameter() {
    return 0;
  }

  /** @param {number[]} buffers */
  drawBuffers() {}

  /** @param {number} src */
  readBuffer() {}

  /** @param {number} srcX0 */
  blitFramebuffer() {}

  /** @param {number} target */
  invalidateFramebuffer() {}

  /** @param {number} target */
  invalidateSubFramebuffer() {}

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} format
   * @param {number} type
   * @param {ArrayBufferView} pixels
   */
  readPixels(x, y, width, height, format, type, pixels) {
    if (pixels && typeof pixels.fill === 'function') pixels.fill(0);
  }

  /** @returns {object} */
  createRenderbuffer() {
    this.stats.renderbuffers++;
    return new MockGLObject('renderbuffer');
  }

  /**
   * @param {number} target
   * @param {object|null} renderbuffer
   */
  bindRenderbuffer(target, renderbuffer) {
    this.state.renderbuffer = renderbuffer || null;
  }

  /** @param {object} renderbuffer */
  deleteRenderbuffer(renderbuffer) {
    if (renderbuffer) renderbuffer.deleted = true;
  }

  /** @returns {boolean} */
  isRenderbuffer(renderbuffer) {
    return !!renderbuffer && renderbuffer.kind === 'renderbuffer' && !renderbuffer.deleted;
  }

  /** @param {number} target */
  renderbufferStorage() {}

  /** @param {number} target */
  renderbufferStorageMultisample() {}

  /** @returns {*} */
  getRenderbufferParameter() {
    return 0;
  }

  /* --------------------------------------------------------------------- *
   * Fixed function state
   * --------------------------------------------------------------------- */

  /** @param {number} cap */
  enable(cap) {
    this.state.enabled.add(cap);
  }

  /** @param {number} cap */
  disable(cap) {
    this.state.enabled.delete(cap);
  }

  /**
   * @param {number} cap
   * @returns {boolean}
   */
  isEnabled(cap) {
    return this.state.enabled.has(cap);
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  viewport(x, y, w, h) {
    this.state.viewport[0] = x;
    this.state.viewport[1] = y;
    this.state.viewport[2] = w;
    this.state.viewport[3] = h;
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  scissor(x, y, w, h) {
    this.state.scissor[0] = x;
    this.state.scissor[1] = y;
    this.state.scissor[2] = w;
    this.state.scissor[3] = h;
  }

  /** @param {number} r @param {number} g @param {number} b @param {number} a */
  clearColor(r, g, b, a) {
    this.state.clearColor[0] = r;
    this.state.clearColor[1] = g;
    this.state.clearColor[2] = b;
    this.state.clearColor[3] = a;
  }

  /** @param {number} depth */
  clearDepth() {}

  /** @param {number} stencil */
  clearStencil() {}

  /** @param {number} mask */
  clear() {
    this.stats.clears++;
  }

  /** @param {number} buffer */
  clearBufferfv() {
    this.stats.clears++;
  }

  /** @param {number} buffer */
  clearBufferiv() {
    this.stats.clears++;
  }

  /** @param {number} buffer */
  clearBufferuiv() {
    this.stats.clears++;
  }

  /** @param {number} buffer */
  clearBufferfi() {
    this.stats.clears++;
  }

  /** @param {number} func */
  depthFunc() {}

  /** @param {boolean} flag */
  depthMask() {}

  /** @param {number} near @param {number} far */
  depthRange() {}

  /** @param {number} mode */
  cullFace() {}

  /** @param {number} mode */
  frontFace() {}

  /** @param {number} sfactor @param {number} dfactor */
  blendFunc() {}

  /** @param {number} srcRGB */
  blendFuncSeparate() {}

  /** @param {number} mode */
  blendEquation() {}

  /** @param {number} modeRGB */
  blendEquationSeparate() {}

  /** @param {number} r */
  blendColor() {}

  /** @param {boolean} r */
  colorMask() {}

  /** @param {number} factor @param {number} units */
  polygonOffset() {}

  /** @param {number} width */
  lineWidth() {}

  /** @param {number} value @param {boolean} invert */
  sampleCoverage() {}

  /** @param {number} func */
  stencilFunc() {}

  /** @param {number} face */
  stencilFuncSeparate() {}

  /** @param {number} fail */
  stencilOp() {}

  /** @param {number} face */
  stencilOpSeparate() {}

  /** @param {number} mask */
  stencilMask() {}

  /** @param {number} face @param {number} mask */
  stencilMaskSeparate() {}

  /** @param {number} coord */
  hint() {}

  /** No-op: the mock has no command queue. */
  flush() {}

  /** No-op: the mock has no command queue. */
  finish() {}

  /* --------------------------------------------------------------------- *
   * Uniforms
   * --------------------------------------------------------------------- */

  /** @param {MockUniformLocation} location */
  uniform1f() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform2f() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform3f() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform4f() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform1i() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform2i() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform3i() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform4i() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform1ui() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform2ui() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform3ui() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform4ui() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform1fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform2fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform3fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform4fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform1iv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform2iv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform3iv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform4iv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform1uiv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform2uiv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform3uiv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniform4uiv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix2fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix3fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix4fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix2x3fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix3x2fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix2x4fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix4x2fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix3x4fv() {
    this.stats.uniformUpdates++;
  }

  /** @param {MockUniformLocation} location */
  uniformMatrix4x3fv() {
    this.stats.uniformUpdates++;
  }

  /* --------------------------------------------------------------------- *
   * Draw calls
   * --------------------------------------------------------------------- */

  /**
   * Update the primitive counters.
   * @private
   * @param {number} mode
   * @param {number} count
   * @param {number} instances
   */
  _countPrimitives(mode, count, instances) {
    const n = count * (instances || 1);
    const C = GL_CONSTANTS;
    if (mode === C.TRIANGLES) this.stats.triangles += Math.floor(n / 3);
    else if (mode === C.TRIANGLE_STRIP || mode === C.TRIANGLE_FAN) this.stats.triangles += Math.max(0, n - 2);
    else if (mode === C.LINES) this.stats.lines += Math.floor(n / 2);
    else if (mode === C.LINE_STRIP) this.stats.lines += Math.max(0, n - 1);
    else if (mode === C.LINE_LOOP) this.stats.lines += n;
    else if (mode === C.POINTS) this.stats.points += n;
  }

  /**
   * @param {number} mode
   * @param {number} first
   * @param {number} count
   */
  drawArrays(mode, first, count) {
    this.stats.drawCalls++;
    this._countPrimitives(mode, count, 1);
  }

  /**
   * @param {number} mode
   * @param {number} count
   * @param {number} type
   * @param {number} offset
   */
  drawElements(mode, count, type, offset) {
    this.stats.drawCalls++;
    this._countPrimitives(mode, count, 1);
  }

  /**
   * @param {number} mode
   * @param {number} start
   * @param {number} end
   * @param {number} count
   */
  drawRangeElements(mode, start, end, count) {
    this.stats.drawCalls++;
    this._countPrimitives(mode, count, 1);
  }

  /**
   * @param {number} mode
   * @param {number} first
   * @param {number} count
   * @param {number} instanceCount
   */
  drawArraysInstanced(mode, first, count, instanceCount) {
    this.stats.drawCalls++;
    this.stats.instancedDrawCalls++;
    this._countPrimitives(mode, count, instanceCount);
  }

  /**
   * @param {number} mode
   * @param {number} count
   * @param {number} type
   * @param {number} offset
   * @param {number} instanceCount
   */
  drawElementsInstanced(mode, count, type, offset, instanceCount) {
    this.stats.drawCalls++;
    this.stats.instancedDrawCalls++;
    this._countPrimitives(mode, count, instanceCount);
  }

  /* --------------------------------------------------------------------- *
   * Queries, sync objects, transform feedback
   * --------------------------------------------------------------------- */

  /** @returns {object} */
  createQuery() {
    this.stats.queries++;
    const query = new MockGLObject('query');
    query.result = 250000; // 0.25 ms in nanoseconds
    return query;
  }

  /** @param {number} target @param {object} query */
  beginQuery() {}

  /** @param {number} target */
  endQuery() {}

  /** @param {object} query */
  deleteQuery(query) {
    if (query) query.deleted = true;
  }

  /** @returns {boolean} */
  isQuery(query) {
    return !!query && query.kind === 'query' && !query.deleted;
  }

  /**
   * @param {object} query
   * @param {number} pname
   * @returns {*}
   */
  getQueryParameter(query, pname) {
    if (pname === GL_CONSTANTS.QUERY_RESULT_AVAILABLE) return true;
    if (pname === GL_CONSTANTS.QUERY_RESULT) return query && query.result ? query.result : 0;
    return 0;
  }

  /** @returns {null} */
  getQuery() {
    return null;
  }

  /** @returns {object} */
  fenceSync() {
    return new MockGLObject('sync');
  }

  /** @returns {number} */
  clientWaitSync() {
    return GL_CONSTANTS.ALREADY_SIGNALED;
  }

  /** @param {object} sync */
  deleteSync(sync) {
    if (sync) sync.deleted = true;
  }

  /** @returns {boolean} */
  isSync(sync) {
    return !!sync && sync.kind === 'sync' && !sync.deleted;
  }

  /** @returns {number} */
  getSyncParameter(sync, pname) {
    if (pname === GL_CONSTANTS.SYNC_STATUS) return GL_CONSTANTS.SIGNALED;
    return 0;
  }

  /** No-op. */
  waitSync() {}

  /** @returns {object} */
  createTransformFeedback() {
    return new MockGLObject('transformFeedback');
  }

  /** @param {number} target @param {object} tf */
  bindTransformFeedback() {}

  /** @param {object} tf */
  deleteTransformFeedback(tf) {
    if (tf) tf.deleted = true;
  }

  /** @param {number} primitiveMode */
  beginTransformFeedback() {}

  /** No-op. */
  endTransformFeedback() {}

  /** No-op. */
  pauseTransformFeedback() {}

  /** No-op. */
  resumeTransformFeedback() {}

  /** @param {object} program */
  transformFeedbackVaryings() {}

  /** @returns {null} */
  getTransformFeedbackVarying() {
    return null;
  }

  /** @returns {*} */
  getIndexedParameter() {
    return null;
  }

  /** @returns {*} */
  getInternalformatParameter() {
    return new Int32Array([4, 2, 1, 0]);
  }
}

// Numeric constants are exposed on the prototype exactly like a real context.
for (const key of Object.keys(GL_CONSTANTS)) {
  Object.defineProperty(MockWebGL2RenderingContext.prototype, key, {
    value: GL_CONSTANTS[key],
    writable: false,
    enumerable: true,
    configurable: false
  });
}

/**
 * Create a standalone mock WebGL2 context.
 * @param {object} [options] see MockWebGL2RenderingContext
 * @returns {MockWebGL2RenderingContext}
 */
export function createMockGL(options = {}) {
  return new MockWebGL2RenderingContext(options);
}

/* ------------------------------------------------------------------------- *
 * DOM shims
 * ------------------------------------------------------------------------- */

/** Minimal EventTarget replacement. */
class MockEventTarget {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
  }

  /**
   * @param {string} type
   * @param {Function} listener
   */
  addEventListener(type, listener) {
    if (typeof listener !== 'function') return;
    let list = this._listeners.get(type);
    if (!list) {
      list = [];
      this._listeners.set(type, list);
    }
    if (list.indexOf(listener) === -1) list.push(listener);
  }

  /**
   * @param {string} type
   * @param {Function} listener
   */
  removeEventListener(type, listener) {
    const list = this._listeners.get(type);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }

  /**
   * @param {object} event
   * @returns {boolean}
   */
  dispatchEvent(event) {
    const list = this._listeners.get(event && event.type);
    if (!list) return true;
    const copy = list.slice();
    for (let i = 0; i < copy.length; i++) copy[i].call(this, event);
    return true;
  }
}

/** Minimal 2D canvas context (used by the Stats overlay). */
class MockCanvasRenderingContext2D {
  /**
   * @param {object} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this.miterLimit = 10;
    this.font = '10px sans-serif';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = true;
    this.shadowBlur = 0;
    this.shadowColor = 'rgba(0,0,0,0)';
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.filter = 'none';
  }

  save() {}
  restore() {}
  scale() {}
  rotate() {}
  translate() {}
  transform() {}
  setTransform() {}
  resetTransform() {}
  clearRect() {}
  fillRect() {}
  strokeRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  arc() {}
  arcTo() {}
  rect() {}
  roundRect() {}
  ellipse() {}
  fill() {}
  stroke() {}
  clip() {}
  drawImage() {}
  putImageData() {}
  setLineDash() {}

  /** @returns {number[]} */
  getLineDash() {
    return [];
  }

  /** @returns {boolean} */
  isPointInPath() {
    return false;
  }

  /** @returns {boolean} */
  isPointInStroke() {
    return false;
  }

  /** @param {string} text */
  fillText() {}

  /** @param {string} text */
  strokeText() {}

  /**
   * @param {string} text
   * @returns {object}
   */
  measureText(text) {
    const width = String(text == null ? '' : text).length * 6;
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 9,
      fontBoundingBoxDescent: 3
    };
  }

  /**
   * @param {number} w
   * @param {number} h
   * @returns {{data:Uint8ClampedArray, width:number, height:number}}
   */
  createImageData(w, h) {
    const width = typeof w === 'number' ? w : 1;
    const height = typeof h === 'number' ? h : 1;
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @returns {{data:Uint8ClampedArray, width:number, height:number}}
   */
  getImageData(x, y, w, h) {
    return this.createImageData(w, h);
  }

  /** @returns {{addColorStop:Function}} */
  createLinearGradient() {
    return { addColorStop() {} };
  }

  /** @returns {{addColorStop:Function}} */
  createRadialGradient() {
    return { addColorStop() {} };
  }

  /** @returns {{addColorStop:Function}} */
  createConicGradient() {
    return { addColorStop() {} };
  }

  /** @returns {object|null} */
  createPattern() {
    return null;
  }
}

/** Minimal DOM element. */
class MockElement extends MockEventTarget {
  /**
   * @param {string} tagName
   */
  constructor(tagName) {
    super();
    this.tagName = String(tagName || 'div').toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.id = '';
    this.className = '';
    this.style = {
      setProperty() {},
      removeProperty() {},
      getPropertyValue() {
        return '';
      }
    };
    this.dataset = {};
    /** @type {MockElement[]} */
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.parentElement = null;
    this.textContent = '';
    this.innerHTML = '';
    this.clientWidth = 1280;
    this.clientHeight = 720;
    this.offsetWidth = 1280;
    this.offsetHeight = 720;
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this._attributes = new Map();
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      }
    };
  }

  /**
   * @param {MockElement} child
   * @returns {MockElement}
   */
  appendChild(child) {
    if (child) {
      this.children.push(child);
      child.parentNode = this;
      child.parentElement = this;
    }
    return child;
  }

  /**
   * @param {MockElement} child
   * @returns {MockElement}
   */
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    if (child) {
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  /**
   * @param {MockElement} node
   * @returns {MockElement}
   */
  insertBefore(node) {
    return this.appendChild(node);
  }

  /** Remove this element from its parent. */
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  /**
   * @param {string} name
   * @param {*} value
   */
  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }

  /**
   * @param {string} name
   * @returns {string|null}
   */
  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  /** @param {string} name */
  removeAttribute(name) {
    this._attributes.delete(name);
  }

  /** @returns {boolean} */
  hasAttribute(name) {
    return this._attributes.has(name);
  }

  /** @returns {object} */
  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight
    };
  }

  /** @returns {null} */
  querySelector() {
    return null;
  }

  /** @returns {MockElement[]} */
  querySelectorAll() {
    return [];
  }

  /** No-op. */
  focus() {}

  /** No-op. */
  blur() {}

  /** No-op. */
  setPointerCapture() {}

  /** No-op. */
  releasePointerCapture() {}

  /** @returns {Promise<void>} */
  requestPointerLock() {
    if (this.ownerDocument) this.ownerDocument.pointerLockElement = this;
    return Promise.resolve();
  }

  /** @returns {Promise<void>} */
  requestFullscreen() {
    return Promise.resolve();
  }
}

/** Minimal HTMLCanvasElement. */
class MockCanvasElement extends MockElement {
  /**
   * @param {number} [width]
   * @param {number} [height]
   * @param {object} [glOptions] options forwarded to the mock GL context
   */
  constructor(width = 1280, height = 720, glOptions = {}) {
    super('canvas');
    this.width = width;
    this.height = height;
    this.clientWidth = width;
    this.clientHeight = height;
    this.offsetWidth = width;
    this.offsetHeight = height;
    this._glOptions = glOptions;
    this._contexts = new Map();
    this.ownerDocument = null;
  }

  /**
   * @param {string} type
   * @returns {object|null}
   */
  getContext(type) {
    if (this._contexts.has(type)) return this._contexts.get(type);
    let context = null;
    if (type === 'webgl2' || type === 'experimental-webgl2') {
      context = new MockWebGL2RenderingContext({ ...this._glOptions, canvas: this });
    } else if (type === '2d') {
      context = new MockCanvasRenderingContext2D(this);
    }
    this._contexts.set(type, context);
    return context;
  }

  /** @returns {string} */
  toDataURL() {
    return 'data:image/png;base64,';
  }

  /** @param {Function} callback */
  toBlob(callback) {
    if (typeof callback === 'function') callback(null);
  }

  /** @returns {object} */
  transferControlToOffscreen() {
    return this;
  }
}

/**
 * Create a canvas that can hand out a mock WebGL2 context.
 * @param {number} [width]
 * @param {number} [height]
 * @param {object} [glOptions] forwarded to MockWebGL2RenderingContext
 * @returns {MockCanvasElement}
 */
export function createMockCanvas(width = 1280, height = 720, glOptions = {}) {
  return new MockCanvasElement(width, height, glOptions);
}

/** Keys installed on globalThis by installDOMShims(), for clean removal. */
const INSTALLED_KEYS = [
  'window',
  'self',
  'document',
  'navigator',
  'screen',
  'devicePixelRatio',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'HTMLElement',
  'HTMLCanvasElement',
  'Element',
  'Image',
  'ImageBitmap',
  'createImageBitmap',
  'ResizeObserver',
  'MutationObserver',
  'IntersectionObserver',
  'WebGL2RenderingContext',
  'WebGLRenderingContext',
  'AudioContext',
  'webkitAudioContext',
  'OffscreenCanvas',
  'matchMedia',
  'getComputedStyle',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'XMLHttpRequest'
];

/** @type {Map<string, {had:boolean, descriptor:(PropertyDescriptor|undefined)}>} */
const savedGlobals = new Map();

/**
 * Install the minimal DOM globals the engine needs to run in Node.
 *
 * Idempotent: calling it twice returns the same objects. Everything it defines
 * can be removed again with `uninstallDOMShims()`.
 *
 * @param {object} [options]
 * @param {number} [options.width] canvas width (default 1280)
 * @param {number} [options.height] canvas height (default 720)
 * @param {number} [options.pixelRatio] devicePixelRatio (default 1)
 * @param {boolean} [options.log] record every GL call on the created context
 * @param {string[]} [options.disabledExtensions] extensions getExtension must refuse
 * @returns {{window:object, document:object, canvas:MockCanvasElement, gl:MockWebGL2RenderingContext, uninstall:Function}}
 */
export function installDOMShims(options = {}) {
  const width = options.width || 1280;
  const height = options.height || 720;
  const pixelRatio = options.pixelRatio || 1;

  const canvas = createMockCanvas(width, height, {
    log: !!options.log,
    disabledExtensions: options.disabledExtensions || []
  });

  const documentShim = new MockEventTarget();
  const documentElement = new MockElement('html');
  const body = new MockElement('body');
  documentElement.appendChild(body);

  /** @type {Map<string, MockElement>} */
  const elementsById = new Map();

  Object.assign(documentShim, {
    documentElement,
    body,
    head: new MockElement('head'),
    hidden: false,
    visibilityState: 'visible',
    pointerLockElement: null,
    fullscreenElement: null,
    readyState: 'complete',
    title: 'AICoders Engine (headless)',
    /**
     * @param {string} tagName
     * @returns {MockElement}
     */
    createElement(tagName) {
      const tag = String(tagName || '').toLowerCase();
      const element = tag === 'canvas' ? createMockCanvas(width, height, { log: !!options.log }) : new MockElement(tag);
      element.ownerDocument = documentShim;
      return element;
    },
    /**
     * @param {string} ns
     * @param {string} tagName
     * @returns {MockElement}
     */
    createElementNS(ns, tagName) {
      return documentShim.createElement(tagName);
    },
    /**
     * @param {string} text
     * @returns {object}
     */
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
    /**
     * @param {string} id
     * @returns {MockElement|null}
     */
    getElementById(id) {
      if (elementsById.has(id)) return elementsById.get(id);
      return null;
    },
    /**
     * @param {string} selector
     * @returns {MockElement|null}
     */
    querySelector(selector) {
      const key = String(selector || '');
      if (key === 'canvas' || key === '#canvas' || key === '#app' || key === '#glcanvas') return canvas;
      if (key.startsWith('#') && elementsById.has(key.slice(1))) return elementsById.get(key.slice(1));
      return null;
    },
    /** @returns {MockElement[]} */
    querySelectorAll() {
      return [];
    },
    /** @returns {MockElement[]} */
    getElementsByTagName(tagName) {
      return String(tagName).toLowerCase() === 'canvas' ? [canvas] : [];
    },
    /** Release a simulated pointer lock. */
    exitPointerLock() {
      documentShim.pointerLockElement = null;
    },
    /** @returns {Promise<void>} */
    exitFullscreen() {
      return Promise.resolve();
    },
    /**
     * Register an element so getElementById can find it (test helper).
     * @param {string} id
     * @param {MockElement} element
     */
    _register(id, element) {
      elementsById.set(id, element);
    }
  });

  canvas.id = 'canvas';
  canvas.ownerDocument = documentShim;
  documentShim._register('canvas', canvas);
  body.appendChild(canvas);

  const windowShim = new MockEventTarget();
  Object.assign(windowShim, {
    innerWidth: width,
    innerHeight: height,
    outerWidth: width,
    outerHeight: height,
    devicePixelRatio: pixelRatio,
    document: documentShim,
    performance: globalThis.performance,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    location: { href: 'http://localhost:8080/', origin: 'http://localhost:8080', protocol: 'http:', pathname: '/' },
    /** @returns {object} */
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    },
    /** @returns {object} */
    getComputedStyle() {
      return {
        getPropertyValue() {
          return '';
        }
      };
    }
  });
  windowShim.window = windowShim;
  windowShim.self = windowShim;
  windowShim.top = windowShim;
  windowShim.parent = windowShim;

  // --- animation frames --------------------------------------------------
  let frameHandle = 1;
  /** @type {Map<number, object>} */
  const frameTimers = new Map();
  const requestAnimationFrameShim = (callback) => {
    const handle = frameHandle++;
    const timer = setTimeout(() => {
      frameTimers.delete(handle);
      callback(globalThis.performance.now());
    }, 16);
    if (typeof timer.unref === 'function') timer.unref();
    frameTimers.set(handle, timer);
    return handle;
  };
  const cancelAnimationFrameShim = (handle) => {
    const timer = frameTimers.get(handle);
    if (timer) {
      clearTimeout(timer);
      frameTimers.delete(handle);
    }
  };
  windowShim.requestAnimationFrame = requestAnimationFrameShim;
  windowShim.cancelAnimationFrame = cancelAnimationFrameShim;

  // --- images ------------------------------------------------------------
  class MockImage extends MockEventTarget {
    /**
     * @param {number} [w]
     * @param {number} [h]
     */
    constructor(w = 4, h = 4) {
      super();
      this.width = w;
      this.height = h;
      this.naturalWidth = w;
      this.naturalHeight = h;
      this.complete = false;
      this.crossOrigin = null;
      this.onload = null;
      this.onerror = null;
      this._src = '';
    }

    /** @returns {string} */
    get src() {
      return this._src;
    }

    /** @param {string} value */
    set src(value) {
      this._src = String(value);
      const timer = setTimeout(() => {
        this.complete = true;
        if (typeof this.onload === 'function') this.onload({ type: 'load', target: this });
        this.dispatchEvent({ type: 'load', target: this });
      }, 0);
      if (typeof timer.unref === 'function') timer.unref();
    }

    /** @returns {Promise<void>} */
    decode() {
      return Promise.resolve();
    }
  }

  class MockImageBitmap {
    /**
     * @param {number} [w]
     * @param {number} [h]
     */
    constructor(w = 4, h = 4) {
      this.width = w;
      this.height = h;
    }

    /** No-op. */
    close() {}
  }

  class MockResizeObserver {
    /**
     * @param {Function} callback
     */
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
    }

    /** @param {object} target */
    observe(target) {
      this.targets.push(target);
    }

    /** @param {object} target */
    unobserve(target) {
      const index = this.targets.indexOf(target);
      if (index !== -1) this.targets.splice(index, 1);
    }

    /** Stop observing everything. */
    disconnect() {
      this.targets.length = 0;
    }
  }

  class MockObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe() {}

    unobserve() {}

    disconnect() {}

    /** @returns {any[]} */
    takeRecords() {
      return [];
    }
  }

  class MockAudioParam {
    constructor(value = 1) {
      this.value = value;
    }

    setValueAtTime(value) {
      this.value = value;
      return this;
    }

    linearRampToValueAtTime(value) {
      this.value = value;
      return this;
    }

    exponentialRampToValueAtTime(value) {
      this.value = value;
      return this;
    }

    setTargetAtTime(value) {
      this.value = value;
      return this;
    }

    cancelScheduledValues() {
      return this;
    }
  }

  class MockAudioNode {
    constructor() {
      this.gain = new MockAudioParam(1);
      this.detune = new MockAudioParam(0);
      this.playbackRate = new MockAudioParam(1);
      this.positionX = new MockAudioParam(0);
      this.positionY = new MockAudioParam(0);
      this.positionZ = new MockAudioParam(0);
      this.orientationX = new MockAudioParam(0);
      this.orientationY = new MockAudioParam(0);
      this.orientationZ = new MockAudioParam(-1);
      this.panningModel = 'HRTF';
      this.distanceModel = 'inverse';
      this.refDistance = 1;
      this.maxDistance = 10000;
      this.rolloffFactor = 1;
      this.coneInnerAngle = 360;
      this.coneOuterAngle = 360;
      this.coneOuterGain = 0;
      this.loop = false;
      this.buffer = null;
      this.onended = null;
    }

    /**
     * @param {object} destination
     * @returns {object}
     */
    connect(destination) {
      return destination;
    }

    disconnect() {}

    start() {}

    stop() {}

    setPosition() {}

    setOrientation() {}
  }

  class MockAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = new MockAudioNode();
      this.listener = new MockAudioNode();
      this.listener.forwardX = new MockAudioParam(0);
      this.listener.forwardY = new MockAudioParam(0);
      this.listener.forwardZ = new MockAudioParam(-1);
      this.listener.upX = new MockAudioParam(0);
      this.listener.upY = new MockAudioParam(1);
      this.listener.upZ = new MockAudioParam(0);
    }

    createGain() {
      return new MockAudioNode();
    }

    createPanner() {
      return new MockAudioNode();
    }

    createStereoPanner() {
      return new MockAudioNode();
    }

    createBufferSource() {
      return new MockAudioNode();
    }

    createAnalyser() {
      return new MockAudioNode();
    }

    createBiquadFilter() {
      return new MockAudioNode();
    }

    createDynamicsCompressor() {
      return new MockAudioNode();
    }

    createConvolver() {
      return new MockAudioNode();
    }

    /**
     * @param {number} channels
     * @param {number} length
     * @param {number} sampleRate
     * @returns {object}
     */
    createBuffer(channels, length, sampleRate) {
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length)
      };
    }

    /** @returns {Promise<object>} */
    decodeAudioData() {
      return Promise.resolve(this.createBuffer(2, 48000, 48000));
    }

    /** @returns {Promise<void>} */
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }

    /** @returns {Promise<void>} */
    suspend() {
      this.state = 'suspended';
      return Promise.resolve();
    }

    /** @returns {Promise<void>} */
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  const navigatorShim = {
    userAgent: 'MockGL/1.0 (Node headless; AICoders Engine)',
    platform: 'node',
    language: 'pt-BR',
    languages: ['pt-BR', 'en-US'],
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    onLine: true,
    /** @returns {any[]} */
    getGamepads() {
      return [];
    },
    clipboard: { writeText: () => Promise.resolve() },
    permissions: { query: () => Promise.resolve({ state: 'granted' }) }
  };

  // Some Node globals (navigator, performance, ...) are getter-only accessors,
  // so every shim is installed through a property descriptor.
  const define = (key, value) => {
    if (!savedGlobals.has(key)) {
      savedGlobals.set(key, { had: key in globalThis, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) });
    }
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
  };

  define('window', windowShim);
  define('self', windowShim);
  define('document', documentShim);
  define('navigator', navigatorShim);
  define('screen', { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, colorDepth: 24, pixelDepth: 24 });
  define('devicePixelRatio', pixelRatio);
  define('requestAnimationFrame', requestAnimationFrameShim);
  define('cancelAnimationFrame', cancelAnimationFrameShim);
  define('HTMLElement', MockElement);
  define('Element', MockElement);
  define('HTMLCanvasElement', MockCanvasElement);
  define('OffscreenCanvas', MockCanvasElement);
  define('Image', MockImage);
  define('ImageBitmap', MockImageBitmap);
  define('createImageBitmap', (source) => Promise.resolve(new MockImageBitmap(source && source.width, source && source.height)));
  define('ResizeObserver', MockResizeObserver);
  define('MutationObserver', MockObserver);
  define('IntersectionObserver', MockObserver);
  define('WebGL2RenderingContext', MockWebGL2RenderingContext);
  define('WebGLRenderingContext', MockWebGL2RenderingContext);
  define('AudioContext', MockAudioContext);
  define('webkitAudioContext', MockAudioContext);
  define('matchMedia', windowShim.matchMedia);
  define('getComputedStyle', windowShim.getComputedStyle);
  define('addEventListener', windowShim.addEventListener.bind(windowShim));
  define('removeEventListener', windowShim.removeEventListener.bind(windowShim));
  define('dispatchEvent', windowShim.dispatchEvent.bind(windowShim));

  windowShim.navigator = navigatorShim;
  windowShim.screen = globalThis.screen;
  windowShim.HTMLCanvasElement = MockCanvasElement;
  windowShim.Image = MockImage;
  windowShim.ResizeObserver = MockResizeObserver;
  windowShim.AudioContext = MockAudioContext;
  windowShim.WebGL2RenderingContext = MockWebGL2RenderingContext;
  windowShim.devicePixelRatio = pixelRatio;

  const gl = canvas.getContext('webgl2');

  return {
    window: windowShim,
    document: documentShim,
    canvas,
    gl,
    uninstall: uninstallDOMShims
  };
}

/**
 * Remove everything installDOMShims() defined on globalThis.
 */
export function uninstallDOMShims() {
  for (let i = 0; i < INSTALLED_KEYS.length; i++) {
    const key = INSTALLED_KEYS[i];
    const saved = savedGlobals.get(key);
    if (!saved) continue;
    if (saved.had && saved.descriptor) Object.defineProperty(globalThis, key, saved.descriptor);
    else delete globalThis[key];
    savedGlobals.delete(key);
  }
}
