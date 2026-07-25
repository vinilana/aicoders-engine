/**
 * Hardware instancing. The per instance model matrix occupies attribute locations
 * 8..11 (one vec4 column each), the optional tint is at 12 and a free vec4 of user
 * data at 13. All of them are declared with a vertex attribute divisor of 1 by
 * InstancedMesh.
 *
 * The chunk owns the declaration of the instance attributes. A shader that
 * prefers to declare them itself must define 'INSTANCE_ATTRIBUTES_DECLARED'
 * before the include.
 *
 * Include with '#include <instancing>'. Vertex shader only.
 */
export const instancing = `
#include <common>
#ifndef INSTANCING_GLSL_INCLUDED
#define INSTANCING_GLSL_INCLUDED

#ifdef USE_INSTANCING

#ifndef INSTANCE_ATTRIBUTES_DECLARED
#define INSTANCE_ATTRIBUTES_DECLARED
layout(location = 8) in mat4 aInstanceMatrix;   // occupies locations 8, 9, 10 and 11
#ifdef USE_INSTANCE_COLOR
layout(location = 12) in vec4 aInstanceColor;
#endif
#ifdef USE_INSTANCE_DATA
layout(location = 13) in vec4 aInstanceData;
#endif
#endif

/** Per instance object -> world matrix. */
mat4 getInstanceMatrix() {
  return aInstanceMatrix;
}

/** Per instance tint, opaque white when the attribute is not enabled. */
vec4 getInstanceColor() {
#ifdef USE_INSTANCE_COLOR
  return aInstanceColor;
#else
  return vec4(1.0);
#endif
}

/** Free per instance payload (animation phase, lod bias, ...). */
vec4 getInstanceData() {
#ifdef USE_INSTANCE_DATA
  return aInstanceData;
#else
  return vec4(0.0);
#endif
}

/** Inverse of a 3x3 matrix, needed for a correct normal matrix under non uniform scale. */
mat3 inverse3(mat3 m) {
  float a00 = m[0][0], a01 = m[0][1], a02 = m[0][2];
  float a10 = m[1][0], a11 = m[1][1], a12 = m[1][2];
  float a20 = m[2][0], a21 = m[2][1], a22 = m[2][2];

  float b01 =  a22 * a11 - a12 * a21;
  float b11 = -a22 * a10 + a12 * a20;
  float b21 =  a21 * a10 - a11 * a20;

  float det = a00 * b01 + a01 * b11 + a02 * b21;
  float invDet = 1.0 / (abs(det) < 1e-12 ? 1e-12 : det);

  return mat3(
    b01 * invDet,
    (-a22 * a01 + a02 * a21) * invDet,
    ( a12 * a01 - a02 * a11) * invDet,
    b11 * invDet,
    ( a22 * a00 - a02 * a20) * invDet,
    (-a12 * a00 + a02 * a10) * invDet,
    b21 * invDet,
    (-a21 * a00 + a01 * a20) * invDet,
    ( a11 * a00 - a01 * a10) * invDet
  );
}

/** Normal matrix (inverse transpose of the upper 3x3) for an instance matrix. */
mat3 getInstanceNormalMatrix(mat4 instanceMatrix) {
  return transpose(inverse3(mat3(instanceMatrix)));
}

/**
 * Cheap normal matrix that only removes the scale, valid when the instance
 * transform uses uniform scaling. Roughly 3x cheaper than the exact version.
 */
mat3 getInstanceNormalMatrixFast(mat4 instanceMatrix) {
  mat3 m = mat3(instanceMatrix);
  vec3 invScale = vec3(
    inversesqrt(max(dot(m[0], m[0]), 1e-12)),
    inversesqrt(max(dot(m[1], m[1]), 1e-12)),
    inversesqrt(max(dot(m[2], m[2]), 1e-12))
  );
  return mat3(m[0] * invScale.x, m[1] * invScale.y, m[2] * invScale.z);
}

#else

/** Identity fallbacks so the same shader body compiles in both permutations. */
mat4 getInstanceMatrix() { return mat4(1.0); }
vec4 getInstanceColor() { return vec4(1.0); }
vec4 getInstanceData() { return vec4(0.0); }
mat3 getInstanceNormalMatrix(mat4 instanceMatrix) { return mat3(instanceMatrix); }
mat3 getInstanceNormalMatrixFast(mat4 instanceMatrix) { return mat3(instanceMatrix); }

#endif

/**
 * Compose the final object -> world matrix. Pass uModelMatrix; when instancing is
 * active the per instance transform is applied first, exactly like the CPU path.
 */
mat4 getModelMatrix(mat4 modelMatrix) {
#ifdef USE_INSTANCING
  return modelMatrix * getInstanceMatrix();
#else
  return modelMatrix;
#endif
}

#endif
`;
