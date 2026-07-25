/**
 * GPU skinning. Bone matrices live in an RGBA32F texture, 4 texels per bone
 * (one per matrix column), uploaded by Skeleton.computeBoneTexture(). The
 * indexing below wraps on the texture width, so both the flat 4*n x 1 layout and
 * a squarer multi row layout work unchanged.
 * Include with '#include <skinning>'. Vertex shader only.
 *
 * The chunk owns the declaration of the skinning vertex attributes (locations 6
 * and 7). A shader that prefers to declare them itself must define
 * 'SKINNING_ATTRIBUTES_DECLARED' before the include.
 */
export const skinning = `
#include <common>
#ifndef SKINNING_GLSL_INCLUDED
#define SKINNING_GLSL_INCLUDED

#ifdef USE_SKINNING

#ifndef SKINNING_ATTRIBUTES_DECLARED
#define SKINNING_ATTRIBUTES_DECLARED
layout(location = 6) in vec4 aJoints;
layout(location = 7) in vec4 aWeights;
#endif

// Texture unit 6.
uniform highp sampler2D uBoneTexture;
uniform mat4 uBindMatrix;
uniform mat4 uBindMatrixInverse;

/** Read one bone matrix (column major, 4 consecutive texels). */
mat4 getBoneMatrix(int boneIndex) {
  int width = textureSize(uBoneTexture, 0).x;
  int base = boneIndex * 4;

  int i0 = base;
  int i1 = base + 1;
  int i2 = base + 2;
  int i3 = base + 3;

  int y0 = i0 / width;
  int y1 = i1 / width;
  int y2 = i2 / width;
  int y3 = i3 / width;

  vec4 c0 = texelFetch(uBoneTexture, ivec2(i0 - y0 * width, y0), 0);
  vec4 c1 = texelFetch(uBoneTexture, ivec2(i1 - y1 * width, y1), 0);
  vec4 c2 = texelFetch(uBoneTexture, ivec2(i2 - y2 * width, y2), 0);
  vec4 c3 = texelFetch(uBoneTexture, ivec2(i3 - y3 * width, y3), 0);

  return mat4(c0, c1, c2, c3);
}

/** Weighted blend of the four influencing bones, in bind space. */
mat4 getSkinMatrix(vec4 joints, vec4 weights) {
  float total = weights.x + weights.y + weights.z + weights.w;
  vec4 w = total > 1e-5 ? weights / total : vec4(1.0, 0.0, 0.0, 0.0);
  return w.x * getBoneMatrix(int(joints.x)) +
         w.y * getBoneMatrix(int(joints.y)) +
         w.z * getBoneMatrix(int(joints.z)) +
         w.w * getBoneMatrix(int(joints.w));
}

/** Full skin matrix including the bind pose change of basis. */
mat4 getSkinningMatrix() {
  return uBindMatrixInverse * getSkinMatrix(aJoints, aWeights) * uBindMatrix;
}

/** Skin a position in object space. */
vec3 skinPosition(vec3 position, mat4 skinMatrix) {
  return (skinMatrix * vec4(position, 1.0)).xyz;
}

/** Skin a direction, ignoring translation. Non uniform bone scale is handled by
 *  the caller through the normal matrix, this keeps the vertex path cheap. */
vec3 skinDirection(vec3 direction, mat4 skinMatrix) {
  return mat3(skinMatrix) * direction;
}

/** Convenience: skin position, normal and tangent in one call. */
void applySkinning(inout vec3 position, inout vec3 normal, inout vec3 tangent) {
  mat4 skinMatrix = getSkinningMatrix();
  position = skinPosition(position, skinMatrix);
  mat3 skinRotation = mat3(skinMatrix);
  normal = skinRotation * normal;
  tangent = skinRotation * tangent;
}

#endif
#endif
`;
