/**
 * Tangent space normal mapping. Uses the vertex tangent (attribute 3, vec4 with the
 * bitangent sign in w) when the geometry provides one, and falls back to a screen
 * space derivative cotangent frame otherwise so that normal maps still work on
 * geometry without tangents.
 * Include with '#include <normal_mapping>'. Fragment shader only.
 */
export const normal_mapping = `
#include <common>
#ifndef NORMAL_MAPPING_GLSL_INCLUDED
#define NORMAL_MAPPING_GLSL_INCLUDED

/** Decode a tangent space normal map sample, applying the artist facing scale. */
vec3 decodeNormalMap(vec3 sampled, float scale) {
  vec3 n = sampled * 2.0 - 1.0;
#ifdef FLIP_NORMAL_Y
  n.y = -n.y;
#endif
  n.xy *= scale;
  // Reconstruct z so that scaling xy keeps the vector normalized.
  n.z = sqrt(max(1.0 - dot(n.xy, n.xy), 1e-6));
  return n;
}

/** Two channel (RG) normal map variant, e.g. BC5 compressed maps. */
vec3 decodeNormalMapRG(vec2 sampled, float scale) {
  vec3 n;
  n.xy = (sampled * 2.0 - 1.0) * scale;
#ifdef FLIP_NORMAL_Y
  n.y = -n.y;
#endif
  n.z = sqrt(max(1.0 - dot(n.xy, n.xy), 1e-6));
  return n;
}

/** Orthonormal TBN from an interpolated normal and a vec4 tangent (w = handedness). */
mat3 computeTBN(vec3 N, vec4 tangent) {
  vec3 n = normalize(N);
  // Gram-Schmidt: interpolation is not guaranteed to keep T perpendicular to N.
  vec3 t = normalize(tangent.xyz - n * dot(n, tangent.xyz));
  vec3 b = cross(n, t) * (tangent.w < 0.0 ? -1.0 : 1.0);
  return mat3(t, b, n);
}

/** Orthonormal TBN from separate tangent and bitangent vectors. */
mat3 computeTBNFromVectors(vec3 N, vec3 T, vec3 B) {
  vec3 n = normalize(N);
  vec3 t = normalize(T - n * dot(n, T));
  vec3 b = normalize(B - n * dot(n, B) - t * dot(t, B));
  return mat3(t, b, n);
}

#ifdef FRAGMENT_SHADER

/**
 * Screen space derivative TBN (Mikkelsen). Works without vertex tangents at the
 * cost of two extra derivative pairs, and matches the vertex tangent frame closely
 * enough that materials can mix both paths.
 */
mat3 cotangentFrame(vec3 N, vec3 position, vec2 uv) {
  vec3 dp1 = dFdx(position);
  vec3 dp2 = dFdy(position);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);

  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;

  float invMax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  return mat3(T * invMax, B * invMax, N);
}

/**
 * Perturb the shading normal with a tangent space normal map.
 * 'mapNormal' must already be decoded with decodeNormalMap().
 */
vec3 perturbNormal(vec3 N, vec3 worldPos, vec2 uv, vec3 mapNormal) {
  return normalize(cotangentFrame(normalize(N), worldPos, uv) * mapNormal);
}

#endif

/** Perturb the shading normal using the interpolated vertex tangent. */
vec3 perturbNormalTangent(vec3 N, vec4 tangent, vec3 mapNormal) {
  return normalize(computeTBN(N, tangent) * mapNormal);
}

/**
 * Flip the interpolated normal for back faces of double sided materials.
 * 'frontFacing' is gl_FrontFacing.
 */
vec3 faceForwardNormal(vec3 N, bool frontFacing) {
#ifdef DOUBLE_SIDED
  return frontFacing ? N : -N;
#else
  return N;
#endif
}

/** Blend a detail normal on top of a base normal (reoriented normal mapping). */
vec3 blendNormalsRNM(vec3 baseNormal, vec3 detailNormal) {
  vec3 t = baseNormal + vec3(0.0, 0.0, 1.0);
  vec3 u = detailNormal * vec3(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) - u * t.z);
}

#endif
`;
