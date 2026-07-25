/**
 * AICoders Engine - showcase demo.
 *
 * Everything in this scene is generated at runtime: no textures, no models, no
 * network requests. The demo exercises, in one frame:
 *
 *   - a 384 x 384 fbm terrain split into 36 independently culled patches, shaded
 *     with a PBR material and procedural colour / normal maps
 *   - ~30k instanced rocks and trees spread with deterministic noise over a grid
 *     of InstancedMesh chunks (so the broadphase can cull them per cascade)
 *   - a 7x7 metallic/roughness sphere grid, a LOD torus knot and a UV capsule
 *   - a procedurally rigged character with GPU skinning and a hand authored walk
 *     cycle driven by the AnimationMixer
 *   - a shadow casting directional light (CSM) plus 200 animated point lights
 *     resolved by the clustered lighting pass
 *   - a procedural sky used both as background and as the IBL source
 *   - bloom, ACES tone mapping, FXAA, SSAO, vignette, grain
 *   - first person navigation over a CharacterController sweeping a CollisionWorld
 *     built from the terrain, an orbit camera, picking through the dynamic BVH,
 *     and a debug line overlay for the BVH / world bounds / a frozen frustum
 *
 * The module imports the engine file by file rather than through `src/index.js`:
 * the browser then fetches only the modules the demo actually uses, and the demo
 * keeps working no matter how the barrel evolves.
 *
 * Importing this module boots the demo (it is the page entry point). Every piece
 * is also exported by name, and the live instance is published on
 * `globalThis.aicodersDemo` so the whole scene can be poked from the console.
 */

import { Engine } from '../src/core/Engine.js';
import { Logger } from '../src/core/Logger.js';

import { clamp, lerp, smoothstep, seededRandom, DEG2RAD } from '../src/math/MathUtils.js';
import { Vec3 } from '../src/math/Vec3.js';
import { Quat } from '../src/math/Quat.js';
import { Mat4 } from '../src/math/Mat4.js';
import { Color } from '../src/math/Color.js';
import { Ray } from '../src/math/Ray.js';

import { Node3D } from '../src/scene/Node3D.js';
import { Mesh } from '../src/scene/Mesh.js';
import { InstancedMesh } from '../src/scene/InstancedMesh.js';
import { SkinnedMesh } from '../src/scene/SkinnedMesh.js';
import { Skeleton } from '../src/scene/Skeleton.js';
import { LOD } from '../src/scene/LOD.js';
import { DirectionalLight, PointLight } from '../src/scene/Light.js';

import {
  createTerrain, createIcosphere, createCone, createCylinder, createSphere,
  createCapsule, createTorusKnot, createBox, createDisc
} from '../src/geometry/Primitives.js';
import {
  fbm, noiseTexture, noiseHeightField, normalMapFromHeight, uvGridTexture
} from '../src/geometry/ProceduralTexture.js';

import { Geometry } from '../src/render/Geometry.js';
import { StandardMaterial } from '../src/render/materials/StandardMaterial.js';
import { UnlitMaterial } from '../src/render/materials/UnlitMaterial.js';
import { SkyMaterial } from '../src/render/materials/SkyMaterial.js';
import { WaterMaterial } from '../src/render/materials/WaterMaterial.js';

import { KeyframeTrack } from '../src/animation/KeyframeTrack.js';
import { AnimationClip } from '../src/animation/AnimationClip.js';
import { AnimationMixer } from '../src/animation/AnimationMixer.js';

import { CollisionWorld } from '../src/physics/CollisionWorld.js';
import { CharacterController } from '../src/physics/CharacterController.js';
import { RigidBody, BodyShape } from '../src/physics/RigidBody.js';
import { WaterVolume } from '../src/physics/WaterVolume.js';

import { FirstPersonControls } from '../src/input/FirstPersonControls.js';
import { OrbitControls } from '../src/input/OrbitControls.js';

/* ========================================================================== *
 * Configuration
 * ========================================================================== */

export const CONFIG = {
  /** Terrain extent along X and Z, world units. */
  terrainSize: 384,
  /** Patches per axis. Each one is an independently culled mesh. */
  terrainPatches: 6,
  /** Grid cells per patch axis. */
  patchSegments: 32,
  /** UV tiles across one patch (integer, so patch borders stay seamless). */
  patchUVTiles: 8,
  /** Peak terrain amplitude, world units. */
  terrainAmplitude: 30,
  /** Radius of the flattened plaza around the origin. */
  plazaRadius: 30,

  /** Scatter sites. A site is either a rock (1 instance) or a tree (2). */
  scatterSites: 24000,
  /** Instanced chunks per axis. */
  scatterChunks: 4,
  /**
   * Menor escala de instancia que vira colisor. Props minusculos ficam
   * atravessaveis de proposito: colidir com cada tufo de mato e tecnicamente
   * correto e horrivel de atravessar.
   */
  colliderMinScale: 0.85,
  /**
   * Teto de colisores de scatter. Os maiores props sao escolhidos primeiro:
   * cada um baka a propria BVH (a escala e nao uniforme), entao isso e um
   * orcamento de memoria, nao um detalhe de gosto.
   */
  colliderBudget: 4000,
  /** Fraction of the generated instances drawn at start up. */
  scatterDensity: 0.75,

  /** Animated coloured point lights. */
  pointLights: 200,

  /** Shadow map resolution and cascade count. */
  shadowMapSize: 2048,
  cascades: 4,
  /** Distance covered by the cascades. */
  shadowDistance: 140,

  /** Sun position, degrees. */
  sunElevation: 34,
  sunAzimuth: 138,

  /** Camera. */
  fov: 62,
  near: 0.12,
  far: 900,
  eyeHeight: 1.62,

  /** Maximum device pixel ratio (keeps the fragment cost sane on retina). */
  maxPixelRatio: 1.75,

  /** Grid resolution of the terrain collision proxy (one mesh, whole terrain). */
  collisionSegments: 128,

  /** Debug overlay capacity, in line segments. */
  debugLineCapacity: 12000,
  /** Picking markers kept alive at once. */
  markerCount: 24
};

/**
 * Presets de qualidade acionados por query string (`?quality=low|medium`).
 *
 * Puramente aditivo: sem o parametro, ou com um valor desconhecido, CONFIG fica
 * exatamente como esta acima. Serve para rodar a demo em GPUs de software
 * (SwiftShader, testes headless) sem tocar no comportamento padrao.
 */
export const QUALITY_PRESETS = {
  low: {
    terrainPatches: 4,
    patchSegments: 16,
    scatterSites: 4000,
    scatterDensity: 0.5,
    pointLights: 40,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 90,
    maxPixelRatio: 1,
    collisionSegments: 64,
    debugLineCapacity: 4000
  },
  medium: {
    scatterSites: 12000,
    scatterDensity: 0.6,
    pointLights: 100,
    shadowMapSize: 1536,
    cascades: 3,
    maxPixelRatio: 1.25
  }
};

/**
 * Applies `?quality=<preset>` on top of CONFIG, in place.
 * @param {Object} config The CONFIG object.
 * @param {string} [search] Query string; defaults to `location.search`.
 * @returns {string|null} The preset that was applied, or null.
 */
export function applyQualityPreset(config, search) {
  const query = search !== undefined
    ? search
    : (typeof location !== 'undefined' && location.search ? location.search : '');
  if (!query) return null;
  const match = /[?&]quality=([^&]+)/.exec(query);
  if (match === null) return null;
  const name = decodeURIComponent(match[1]).toLowerCase();
  const preset = QUALITY_PRESETS[name];
  if (preset === undefined) return null;
  for (const key in preset) config[key] = preset[key];
  return name;
}

/** Preset em vigor, ou null quando a demo roda na qualidade padrao. */
export const ACTIVE_QUALITY = applyQualityPreset(CONFIG);

/** Random stream seeds - everything in the scene is reproducible. */
const SEED_SCATTER = 0x51ed7a3;
const SEED_LIGHTS = 0x2b9f10d;

/* ========================================================================== *
 * Module scratch - never allocate in the frame loop
 * ========================================================================== */

const _v3a = new Vec3();
const _v3b = new Vec3();
const _v3c = new Vec3();
const _quat = new Quat();
const _scale = new Vec3(1, 1, 1);
const _mat = new Mat4();
const _color = new Color();
const _ray = new Ray();
const _pickRaycaster = { ray: _ray, near: 0.05, far: 600, layers: 0xffffffff };
const _pickHits = [];

/** Edge list of a unit cube in NDC corner order, used by the frustum overlay. */
const FRUSTUM_EDGES = new Int32Array([
  0, 1, 1, 3, 3, 2, 2, 0,
  4, 5, 5, 7, 7, 6, 6, 4,
  0, 4, 1, 5, 2, 6, 3, 7
]);

/** Above this half extent a BVH node is a "do not cull" proxy, not real geometry. */
const DEBUG_MAX_EXTENT = 1e6;

/** Circular path walked by the character: centre, radius and ground speed. */
const CHARACTER_PATH = { x: -6, z: 22, radius: 8, speed: 1.75 };

/* ========================================================================== *
 * Small helpers
 * ========================================================================== */

/**
 * Waits for the next animation frame so the browser can paint the loading bar.
 * @returns {Promise<void>}
 */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/**
 * Creates an element with an optional class and text.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Thousands separator, without touching Intl (cheap and locale stable).
 * @param {number} value
 * @returns {string}
 */
function fmt(value) {
  const n = Math.round(value);
  const s = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/* ========================================================================== *
 * Terrain height field
 * ========================================================================== */

/** Base frequency of the terrain noise. */
const TERRAIN_FREQ = 0.0062;

/**
 * Analytic terrain height. Deterministic (perlin based fbm), shared by the mesh
 * builder, the scatter pass, the character controller and the picking fallback.
 * @param {number} x World X.
 * @param {number} z World Z.
 * @returns {number} Height in world units.
 */
/**
 * The lake. Referenced by `terrainHeight` (which carves the basin), by the
 * water surface mesh and by the physics `WaterVolume`, so all three cannot
 * drift apart.
 */
export const LAKE = Object.freeze({
  x: 44,
  z: -30,
  /** Radius of the bowl at the rim. */
  radius: 17,
  /** Still water level in world units. */
  level: -1.4,
  /** How far the floor sits below the waterline at the centre. */
  depth: 5.2,
});

export function terrainHeight(x, z) {
  const nx = x * TERRAIN_FREQ;
  const nz = z * TERRAIN_FREQ;

  // Two fbm layers: broad hills plus a ridged mid frequency band.
  let h = fbm(nx, nz, 17.31, 5, 2.03, 0.5);
  const ridge = 1 - Math.abs(fbm(nx * 2.7, nz * 2.7, 91.7, 3, 2.11, 0.55));
  h = h * 0.78 + (ridge * ridge - 0.5) * 0.44;
  h *= CONFIG.terrainAmplitude;

  // Small scale detail so the surface is not perfectly smooth up close.
  h += fbm(nx * 11.3, nz * 11.3, 4.9, 3, 2.0, 0.5) * 0.9;

  // Flatten a plaza around the origin: the hero objects and the spawn point sit
  // on level ground, and the transition is smooth so normals stay continuous.
  const d = Math.sqrt(x * x + z * z);
  const flat = 1 - smoothstep(CONFIG.plazaRadius, CONFIG.plazaRadius * 2.1, d);
  h = lerp(h, 0.35, flat * flat);

  // Carve the lake basin into the height field itself rather than dropping a
  // water plane onto whatever the noise produced. This guarantees the bowl
  // actually holds the volume, that its rim sits above the waterline all the
  // way round, and that the collision proxy — built from this same function —
  // agrees with what is drawn.
  const lx = x - LAKE.x;
  const lz = z - LAKE.z;
  const ld = Math.sqrt(lx * lx + lz * lz);
  const basin = 1 - smoothstep(LAKE.radius * 0.30, LAKE.radius, ld);
  h = lerp(h, LAKE.level - LAKE.depth, basin * basin);

  // Rim. Carving the bowl is not enough: the noise around it can perfectly well
  // sit below the waterline, and then the lake bleeds out across the landscape
  // as a flat sheet. This raises a ring of ground just outside the bowl above
  // the surface, and only ever raises — `Math.max` leaves the rest of the
  // terrain untouched.
  const rim = smoothstep(LAKE.radius * 0.95, LAKE.radius * 1.15, ld) *
    (1 - smoothstep(LAKE.radius * 1.4, LAKE.radius * 2.4, ld));
  h = Math.max(h, lerp(h, LAKE.level + 1.2, rim));

  return h;
}

/**
 * Central difference normal of the height field.
 * @param {number} x
 * @param {number} z
 * @param {Vec3} out
 * @returns {Vec3} out
 */
export function terrainNormal(x, z, out) {
  const e = 0.6;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

/* ========================================================================== *
 * Debug line overlay
 *
 * One dynamic geometry, one unlit vertex coloured draw call. Enough to draw the
 * BVH, world bounds and a frozen frustum without a single per frame allocation.
 * ========================================================================== */

export class DebugLines {
  /**
   * @param {number} capacity Maximum line segments.
   */
  constructor(capacity) {
    /** @type {number} */
    this.capacity = capacity;
    /** @type {number} Segments written this frame. */
    this.count = 0;

    /** @type {Float32Array} */
    this.positions = new Float32Array(capacity * 6);
    /** @type {Float32Array} */
    this.colors = new Float32Array(capacity * 8);

    const geometry = new Geometry();
    geometry.setAttribute('aPosition', this.positions, 3, { usage: 'dynamic' });
    geometry.setAttribute('aColor', this.colors, 4, { usage: 'dynamic' });
    geometry.drawMode = 'lines';
    geometry.setDrawRange(0, 0);

    // Bounds are pinned by hand: the vertex data changes every frame, and a
    // batch that covers the whole world must never be culled away. Keeping them
    // finite (instead of opting out of culling) also keeps the broadphase, whose
    // nodes this very overlay draws, well conditioned.
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.boundingBox.min.set(-600, -600, -600);
    geometry.boundingBox.max.set(600, 600, 600);
    geometry.boundingSphere.center.set(0, 0, 0);
    geometry.boundingSphere.radius = 1040;

    /** @type {Geometry} */
    this.geometry = geometry;

    /** @type {Mesh} */
    this.mesh = new Mesh(geometry, new UnlitMaterial({
      name: 'DebugLines',
      baseColor: 0xffffff,
      depthTest: true,
      depthWrite: false,
      castShadow: false,
      receiveShadow: false,
      renderOrder: 8
    }));
    this.mesh.name = 'DebugLines';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this.mesh.userData.noPick = true;
  }

  /** Drops every segment written in the previous frame. */
  clear() {
    this.count = 0;
  }

  /**
   * Appends one segment.
   * @param {number} ax @param {number} ay @param {number} az
   * @param {number} bx @param {number} by @param {number} bz
   * @param {number} r @param {number} g @param {number} b @param {number} [a=1]
   */
  line(ax, ay, az, bx, by, bz, r, g, b, a) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const p = i * 6;
    const c = i * 8;
    const alpha = a === undefined ? 1 : a;
    const pos = this.positions;
    const col = this.colors;
    pos[p] = ax; pos[p + 1] = ay; pos[p + 2] = az;
    pos[p + 3] = bx; pos[p + 4] = by; pos[p + 5] = bz;
    col[c] = r; col[c + 1] = g; col[c + 2] = b; col[c + 3] = alpha;
    col[c + 4] = r; col[c + 5] = g; col[c + 6] = b; col[c + 7] = alpha;
  }

  /**
   * Appends the 12 edges of an axis aligned box.
   * @param {number} x0 @param {number} y0 @param {number} z0
   * @param {number} x1 @param {number} y1 @param {number} z1
   * @param {number} r @param {number} g @param {number} b @param {number} [a=1]
   */
  box(x0, y0, z0, x1, y1, z1, r, g, b, a) {
    this.line(x0, y0, z0, x1, y0, z0, r, g, b, a);
    this.line(x1, y0, z0, x1, y0, z1, r, g, b, a);
    this.line(x1, y0, z1, x0, y0, z1, r, g, b, a);
    this.line(x0, y0, z1, x0, y0, z0, r, g, b, a);

    this.line(x0, y1, z0, x1, y1, z0, r, g, b, a);
    this.line(x1, y1, z0, x1, y1, z1, r, g, b, a);
    this.line(x1, y1, z1, x0, y1, z1, r, g, b, a);
    this.line(x0, y1, z1, x0, y1, z0, r, g, b, a);

    this.line(x0, y0, z0, x0, y1, z0, r, g, b, a);
    this.line(x1, y0, z0, x1, y1, z0, r, g, b, a);
    this.line(x1, y0, z1, x1, y1, z1, r, g, b, a);
    this.line(x0, y0, z1, x0, y1, z1, r, g, b, a);
  }

  /**
   * Publishes the segments written this frame to the GPU.
   */
  commit() {
    const vertices = this.count * 2;
    this.geometry.setDrawRange(0, vertices);
    this.mesh.visible = vertices > 0;
    if (vertices === 0) return;
    this.geometry.markAttributeDirty('aPosition', 0, vertices);
    this.geometry.markAttributeDirty('aColor', 0, vertices);
  }
}

/* ========================================================================== *
 * Character controller over the height field
 *
 * Implements the same surface the engine CharacterController exposes
 * (`move(desiredVelocity, dt)` + `position` / `velocity` / `isGrounded` /
 * `groundNormal`), so it can be handed straight to FirstPersonControls.
 * ========================================================================== */

export class HeightfieldController {
  /**
   * @param {Object} [options]
   * @param {number} [options.radius=0.35] Capsule radius.
   * @param {number} [options.height=1.2] Capsule cylindrical height.
   * @param {number} [options.gravity=-26]
   * @param {number} [options.slopeLimit=52] Maximum walkable slope, degrees.
   * @param {number} [options.stepOffset=0.45] Height climbed without jumping.
   * @param {Function} [options.heightAt] Terrain sampler `(x, z) => y`.
   */
  constructor(options = {}) {
    /** @type {Vec3} Feet position. */
    this.position = new Vec3(0, 0, 0);
    /** @type {Vec3} */
    this.velocity = new Vec3();
    /** @type {boolean} */
    this.isGrounded = false;
    /** @type {Vec3} */
    this.groundNormal = new Vec3(0, 1, 0);
    /** @type {string} Reported in the overlay. */
    this.kind = 'HeightfieldController (fallback)';

    this.radius = options.radius !== undefined ? options.radius : 0.35;
    this.height = options.height !== undefined ? options.height : 1.2;
    this.gravity = options.gravity !== undefined ? options.gravity : -26;
    this.stepOffset = options.stepOffset !== undefined ? options.stepOffset : 0.45;
    this.slopeCos = Math.cos((options.slopeLimit !== undefined ? options.slopeLimit : 52) * DEG2RAD);
    this.bounds = options.bounds !== undefined ? options.bounds : 1e9;
    /** @private */
    this._heightAt = options.heightAt || terrainHeight;

    /** @private */
    this._normal = new Vec3(0, 1, 0);
    /** @private */
    this._move = new Vec3();
  }

  /**
   * Advances the capsule. `desired.y` is treated as a jump impulse on the frame
   * it is non zero, exactly like the engine controller does.
   * @param {Vec3} desired Desired world velocity.
   * @param {number} dt Seconds.
   * @returns {HeightfieldController} this
   */
  move(desired, dt) {
    const step = dt > 0.05 ? 0.05 : dt;
    if (step <= 0) return this;

    if (desired.y > 0 && this.isGrounded) {
      this.velocity.y = desired.y;
      this.isGrounded = false;
    }

    // Horizontal intent, projected on the ground plane while grounded so that
    // walking up a slope does not fight gravity (collide and slide, one plane).
    this._move.set(desired.x, 0, desired.z);
    if (this.isGrounded) {
      const n = this.groundNormal;
      const dot = this._move.x * n.x + this._move.y * n.y + this._move.z * n.z;
      this._move.x -= n.x * dot;
      this._move.y -= n.y * dot;
      this._move.z -= n.z * dot;
    }

    // Gravity.
    if (!this.isGrounded) this.velocity.y += this.gravity * step;
    else if (this.velocity.y < 0) this.velocity.y = 0;

    this.velocity.x = this._move.x;
    this.velocity.z = this._move.z;

    let nx = this.position.x + this.velocity.x * step;
    let nz = this.position.z + this.velocity.z * step;
    const ny = this.position.y + this.velocity.y * step;

    // World bounds: a soft wall around the terrain patch.
    const limit = this.bounds;
    if (nx > limit) nx = limit; else if (nx < -limit) nx = -limit;
    if (nz > limit) nz = limit; else if (nz < -limit) nz = -limit;

    // Ground probe at the destination. A step that is too steep or too tall is
    // rejected on the horizontal axis and the character slides along the wall.
    const groundY = this._heightAt(nx, nz);
    terrainNormal(nx, nz, this._normal);

    const climbing = groundY - this.position.y;
    const walkable = this._normal.y >= this.slopeCos;
    if (this.isGrounded && climbing > this.stepOffset && !walkable) {
      // Blocked: keep the component of the motion tangent to the wall.
      const wallX = this._normal.x;
      const wallZ = this._normal.z;
      const len = Math.hypot(wallX, wallZ);
      if (len > 1e-4) {
        const wx = wallX / len;
        const wz = wallZ / len;
        const into = this.velocity.x * wx + this.velocity.z * wz;
        if (into < 0) {
          this.velocity.x -= wx * into;
          this.velocity.z -= wz * into;
          nx = this.position.x + this.velocity.x * step;
          nz = this.position.z + this.velocity.z * step;
        }
      }
    }

    const finalGround = this._heightAt(nx, nz);
    this.position.x = nx;
    this.position.z = nz;

    if (ny <= finalGround + 0.001) {
      this.position.y = finalGround;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.isGrounded = true;
      terrainNormal(nx, nz, this.groundNormal);
    } else {
      this.position.y = ny;
      // Ground snap while walking downhill: keeps the camera glued to the slope.
      if (this.isGrounded && ny - finalGround < 0.35 && this.velocity.y <= 0) {
        this.position.y = finalGround;
        this.velocity.y = 0;
        terrainNormal(nx, nz, this.groundNormal);
      } else {
        this.isGrounded = false;
        this.groundNormal.set(0, 1, 0);
      }
    }

    return this;
  }

  /**
   * Teleports the capsule onto the terrain.
   * @param {number} x @param {number} z
   * @returns {HeightfieldController} this
   */
  warp(x, z) {
    this.position.set(x, this._heightAt(x, z), z);
    this.velocity.set(0, 0, 0);
    this.isGrounded = true;
    return this;
  }
}

/**
 * Bridges the engine CharacterController to what FirstPersonControls expects.
 *
 * The controller owns gravity, so it deliberately ignores the vertical part of
 * the requested velocity and exposes `jump(speed)` instead, while the first
 * person rig signals a jump by putting the launch speed in `velocity.y`. This
 * adapter is that one line of glue, and it keeps `position` / `isGrounded`
 * pointing at the real controller.
 */
export class CharacterControllerAdapter {
  /**
   * @param {CharacterController} controller
   * @param {CollisionWorld} world
   */
  constructor(controller, world) {
    /** @type {CharacterController} */
    this.controller = controller;
    /** @type {CollisionWorld} */
    this.world = world;
    /** @type {string} Reported in the overlay. */
    this.kind = 'CharacterController + CollisionWorld';
  }

  /** @returns {Vec3} Feet position, live. */
  get position() {
    return this.controller.position;
  }

  /** @returns {Vec3} Controller velocity, live. */
  get velocity() {
    return this.controller.velocity;
  }

  /** @returns {boolean} Ground contact. */
  get isGrounded() {
    return this.controller.isGrounded;
  }

  /** @returns {Vec3} Contact normal. */
  get groundNormal() {
    return this.controller.groundNormal;
  }

  /**
   * @param {Vec3} desired Desired world velocity (`y` doubles as jump impulse).
   * @param {number} dt Seconds.
   * @returns {CharacterControllerAdapter} this
   */
  move(desired, dt) {
    if (desired.y > 0 && this.controller.isGrounded === true) this.controller.jump(desired.y);
    this.controller.move(desired, dt);
    return this;
  }

  /**
   * @param {number} x @param {number} z
   * @returns {CharacterControllerAdapter} this
   */
  warp(x, z) {
    _v3a.set(x, terrainHeight(x, z) + 0.25, z);
    this.controller.teleport(_v3a);
    this.controller.velocity.set(0, 0, 0);
    return this;
  }
}

/* ========================================================================== *
 * Demo
 * ========================================================================== */

export class Demo {
  constructor() {
    /** @type {Engine|null} */
    this.engine = null;
    /** @type {Object|null} */
    this.scene = null;
    /** @type {Object|null} */
    this.camera = null;
    /** @type {Object|null} */
    this.renderer = null;

    /** Scene content. */
    this.sky = null;
    this.sun = null;
    this.ibl = null;
    this.terrainPatches = [];
    this.scatterChunks = [];
    /** @type {WaterVolume|null} */
    this.waterVolume = null;
    /** @type {Mesh|null} */
    this.waterSurface = null;
    /** @type {WaterMaterial|null} */
    this.waterMaterial = null;
    /** @type {Array<{body: RigidBody, mesh: Mesh, density: number}>} */
    this.floaters = [];
    /** @type {number} Colisores estaticos registrados. */
    this.colliderCount = 0;
    /** @type {Array<Object>} */
    this.scatterColliders = [];
    /** @type {number} Props ignorados por estourar o orcamento de colisores. */
    this.scatterColliderSkipped = 0;
    this.scatterFilled = 0;
    this.scatterDrawn = 0;
    this.knot = null;
    this.capsule = null;
    this.characterBones = null;
    this.characterPhase = 0;
    this.bloomIntensity = 0.18;
    this.heroRoot = null;
    this.character = null;
    this.characterRoot = null;
    this.mixer = null;
    this.walkAction = null;
    this.bulbs = null;
    this.markers = [];
    this.markerCursor = 0;
    this.textures = {};
    this.materials = {};

    /** Lights. */
    this.pointLights = [];
    this.lightParams = null;
    this.activeLightCount = CONFIG.pointLights;

    /** Controls. */
    this.fpsControls = null;
    this.orbitControls = null;
    this.controller = null;
    this.collisionWorld = null;
    this.cameraMode = 'fps';

    /** Debug. */
    this.debug = null;
    this._debugAttached = false;
    this.showBVH = false;
    this.showBounds = false;
    this.frustumLocked = false;
    this.lockedCorners = new Float32Array(24);
    this.paused = false;
    this.uiVisible = true;
    this.wireframe = false;

    /** UI. */
    this.dom = {};
    this.statFields = {};
    this.controlRefs = {};
    this._hudTimer = 0;

    /** Frame bookkeeping. */
    this.sunElevation = CONFIG.sunElevation;
    this.sunAzimuth = CONFIG.sunAzimuth;
    this._iblTimer = -1;
    this._pickPointer = { x: 0, y: 0, time: 0, id: -1, moved: false };
  }

  /* ---------------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------------- */

  /**
   * Full asynchronous boot with a progress bar. Every stage yields to the
   * browser so the loading screen actually animates.
   * @returns {Promise<void>}
   */
  async boot() {
    this.collectDom();

    try {
      this.progress(0.03, 'Criando contexto WebGL2...');
      await nextFrame();
      this.createEngine();

      this.progress(0.10, 'Gerando texturas procedurais...');
      await nextFrame();
      this.createTextures();

      this.progress(0.22, 'Construindo o ceu e o ambiente...');
      await nextFrame();
      this.createSkyAndLightRig();

      this.progress(0.34, 'Gerando o terreno (fbm)...');
      await nextFrame();
      this.createTerrain();

      this.progress(0.52, 'Espalhando ' + fmt(CONFIG.scatterSites) + ' objetos instanciados...');
      await nextFrame();
      this.createScatter();

      this.progress(0.66, 'Montando os objetos hero (PBR)...');
      await nextFrame();
      this.createHeroObjects();

      this.progress(0.74, 'Riggando o personagem e a animacao...');
      await nextFrame();
      this.createCharacter();

      this.progress(0.82, 'Acendendo ' + CONFIG.pointLights + ' luzes pontuais...');
      await nextFrame();
      this.createPointLights();

      this.progress(0.88, 'Pre-integrando o IBL do ceu...');
      await nextFrame();
      this.createEnvironment();

      this.progress(0.92, 'Configurando pos-processamento e controles...');
      await nextFrame();
      this.createDebugOverlay();
      this.createControls();

      // Colliders and water need the collision world, which createControls
      // builds together with the character controller.
      this.progress(0.93, 'Registrando colisores...');
      await nextFrame();
      this.createColliders();

      this.progress(0.94, 'Enchendo o lago...');
      await nextFrame();
      this.createWater();

      this.configurePostProcessing();
      this.buildUI();

      this.progress(0.96, 'Compilando shaders...');
      await nextFrame();
      this.renderer.compile(this.scene, this.camera);

      this.progress(1, 'Pronto.');
      await nextFrame();

      this.installLoop();
      this.engine.start();
      this.hideLoading();
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  /** Caches the static DOM nodes used by the overlay. */
  collectDom() {
    this.dom.canvas = document.getElementById('viewport');
    this.dom.hud = document.getElementById('hud');
    this.dom.loading = document.getElementById('loading');
    this.dom.loadingBar = document.getElementById('loading-bar');
    this.dom.loadingStep = document.getElementById('loading-step');
    this.dom.error = document.getElementById('error');
    this.dom.errorTitle = document.getElementById('error-title');
    this.dom.errorMessage = document.getElementById('error-message');
    this.dom.errorDetail = document.getElementById('error-detail');
    this.dom.statRows = document.getElementById('stat-rows');
    this.dom.statMode = document.getElementById('stat-mode');
    this.dom.controlRows = document.getElementById('control-rows');
    this.dom.controls = document.getElementById('controls');
    this.dom.collapse = document.getElementById('controls-collapse');
    this.dom.pickInfo = document.getElementById('pick-info');
    this.dom.crosshair = document.getElementById('crosshair');
  }

  /**
   * Updates the loading bar.
   * @param {number} ratio 0..1
   * @param {string} label
   */
  progress(ratio, label) {
    if (this.dom.loadingBar) this.dom.loadingBar.style.width = (ratio * 100).toFixed(1) + '%';
    if (this.dom.loadingStep) this.dom.loadingStep.textContent = label;
  }

  /** Fades the loading screen out. */
  hideLoading() {
    const node = this.dom.loading;
    if (!node) return;
    node.classList.add('fade');
    setTimeout(() => node.classList.add('hidden'), 420);
  }

  /**
   * Shows the friendly failure screen.
   * @param {Error|string} error
   */
  showError(error) {
    const message = error && error.message ? error.message : String(error);
    const webgl = /webgl2/i.test(message);
    if (this.dom.loading) this.dom.loading.classList.add('hidden');
    if (this.dom.hud) this.dom.hud.classList.add('hidden');
    if (this.dom.errorTitle) {
      this.dom.errorTitle.textContent = webgl
        ? 'WebGL2 nao suportado'
        : 'Falha ao iniciar a demo';
    }
    if (this.dom.errorMessage) {
      this.dom.errorMessage.textContent = webgl
        ? 'Este navegador ou dispositivo nao expoe um contexto WebGL2, e a engine nao possui fallback para WebGL1.'
        : 'A engine iniciou o contexto, mas a cena nao pode ser construida.';
    }
    if (this.dom.errorDetail) {
      this.dom.errorDetail.textContent = message + (error && error.stack ? '\n\n' + error.stack : '');
    }
    if (this.dom.error) this.dom.error.classList.remove('hidden');
    console.error('[demo]', error);
  }

  /* ---------------------------------------------------------------------- *
   * Engine
   * ---------------------------------------------------------------------- */

  /** Creates the engine, the renderer and the base scene settings. */
  createEngine() {
    this.engine = new Engine({
      canvas: 'viewport',
      antialias: false,          // the post chain resolves aliasing with FXAA
      shadows: true,
      hdr: true,
      clustered: true,
      postprocessing: true,
      toneMapping: 'aces',
      exposure: 1.0,
      shadowMapSize: CONFIG.shadowMapSize,
      cascades: CONFIG.cascades,
      maxLights: 512,
      maxPixelRatio: CONFIG.maxPixelRatio,
      fov: CONFIG.fov,
      near: CONFIG.near,
      far: CONFIG.far,
      stats: { position: 'bottom-left' }
    });

    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.renderer = this.engine.renderer;
    this.scene.name = 'DemoScene';

    // The graph overlay would otherwise sit on top of the loading screen.
    if (this.engine.stats !== null && this.engine.stats !== undefined) this.engine.stats.hide();

    // The environment carries the ambient term once the IBL is generated.
    this.scene.ambientLight.setHex(0x8fb4e8);
    this.scene.ambientIntensity = 0.35;

    // Aerial perspective: thin enough that the terrain silhouette survives out to
    // the far plane, capped so distant geometry never dissolves into flat fog, and
    // thinned with altitude so the hills stay readable against the sky.
    const fogColor = new Color(0x93b4d6);
    this.scene.setFogExp2(fogColor, 0.0014);
    this.scene.fog.maxOpacity = 0.82;
    this.scene.fog.heightFalloff = 0.018;

    const mapper = this.renderer.shadowMapper;
    if (mapper !== null) {
      mapper.shadowDistance = CONFIG.shadowDistance;
      mapper.softness = 1.15;
    }

    this.camera.position.set(0, terrainHeight(0, 26) + CONFIG.eyeHeight, 26);
  }

  /* ---------------------------------------------------------------------- *
   * Procedural textures
   * ---------------------------------------------------------------------- */

  /** Builds every texture used by the demo on the CPU. */
  createTextures() {
    const gl = this.engine.gl;

    // Terrain: a tiling colour breakup plus a matching detail normal map. The
    // height field feeding the normal map is the very same fbm implementation
    // used by the terrain mesh, one octave band higher.
    this.textures.terrainColor = noiseTexture(gl, 512, 5, { frequency: 7 });
    const detail = noiseHeightField(512, 9, 5, 3.5);
    this.textures.terrainNormal = normalMapFromHeight(gl, detail, 512, 2.4);

    // Rock / bark breakup, reused by the instanced meshes.
    this.textures.rockColor = noiseTexture(gl, 256, 4, { frequency: 5, ridged: true });
    this.textures.rockNormal = normalMapFromHeight(gl, noiseHeightField(256, 7, 4, 11.5), 256, 3.0);

    // Foliage: high frequency, ridged breakup so a canopy reads as clumps of
    // leaves instead of a flat painted cone. Without a map at all — which is
    // what this was — the instance colour is the only variation there is.
    this.textures.foliageColor = noiseTexture(gl, 256, 5, { frequency: 13, ridged: true });
    this.textures.foliageNormal = normalMapFromHeight(gl, noiseHeightField(256, 15, 5, 9.0), 256, 2.2);

    // UV calibration grid for the capsule, so the UV pipeline is visible.
    this.textures.uvGrid = uvGridTexture(gl, 512, { cells: 8 });
  }

  /* ---------------------------------------------------------------------- *
   * Sky, sun and environment
   * ---------------------------------------------------------------------- */

  /** Creates the procedural sky material and the shadow casting sun. */
  createSkyAndLightRig() {
    this.sky = new SkyMaterial({
      name: 'ProceduralSky',
      turbidity: 2.6,
      rayleigh: 1.15,
      mie: 0.0055,
      mieDirectionalG: 0.82,
      sunIntensity: 1.0,
      sunDiscIntensity: 26,
      multipleScattering: 0.16,
      clouds: true,
      cloudCoverage: 0.42,
      cloudScale: 1.35,
      cloudSpeed: 0.006,
      cloudOpacity: 0.85,
      groundColor: new Color(0.10, 0.11, 0.09)
    });
    this.sky.setSunPosition(this.sunElevation, this.sunAzimuth);
    this.scene.background = this.sky;

    this.sun = new DirectionalLight(0xfff3df, 3.4);
    this.sun.name = 'Sun';
    this.sun.castShadow = true;
    this.sun.useTarget = true;
    this.sun.target.set(0, 0, 0);
    this.sun.shadow.bias = 0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);

    this.applySunPosition();
  }

  /** Pushes the current sun angles into the sky, the light and the fog. */
  applySunPosition() {
    this.sky.setSunPosition(this.sunElevation, this.sunAzimuth);
    this.sky.getSunDirection(_v3a);                 // unit vector towards the sun
    this.sun.position.set(_v3a.x * 320, Math.max(_v3a.y, 0.06) * 320, _v3a.z * 320);
    this.sun.target.set(0, 0, 0);

    // Warm and dim the sunlight as it approaches the horizon.
    const t = clamp(this.sunElevation / 45, 0, 1);
    this.sun.intensity = lerp(0.9, 3.6, t);
    this.sun.color.set(1.0, lerp(0.62, 0.95, t), lerp(0.35, 0.87, t));

    if (this.scene.fog !== null) {
      // Linear-space haze. These stay well below the sky radiance on purpose: the
      // fog colour is tone mapped along with everything else, so a value near 0.6
      // linear reads as almost white on screen and flattens the whole horizon.
      this.scene.fog.color.set(
        lerp(0.20, 0.31, t),
        lerp(0.19, 0.38, t),
        lerp(0.23, 0.52, t)
      );
    }
  }

  /** Generates the irradiance / prefiltered / BRDF maps from the sky. */
  createEnvironment() {
    const ibl = typeof this.renderer.createIBL === 'function' ? this.renderer.createIBL() : null;
    if (ibl === null || ibl === undefined) {
      this.scene.ambientIntensity = 0.4;
      return;
    }
    this.ibl = ibl;
    this.regenerateIBL();
  }

  /** Rebuilds the environment probe for the current sun position. */
  regenerateIBL() {
    if (this.ibl === null) return;
    this.sky.getSunDirection(_v3a);
    this.ibl.fromProceduralSky({
      sunDirection: { x: _v3a.x, y: _v3a.y, z: _v3a.z },
      turbidity: this.sky.turbidity,
      rayleigh: this.sky.rayleigh,
      mieCoefficient: this.sky.mie,
      mieDirectionalG: this.sky.mieDirectionalG,
      luminance: 1.0,
      sunDiskIntensity: 0.0,   // the DirectionalLight already represents the sun
      cloudCoverage: 0.0
    });
    this.ibl.intensity = 1.0;
    this.scene.environment = this.ibl;
    // With a real environment the flat ambient term would double count.
    this.scene.ambientIntensity = this.ibl.ready === false ? 0.35 : 0.04;
  }

  /* ---------------------------------------------------------------------- *
   * Terrain
   * ---------------------------------------------------------------------- */

  /**
   * Builds the terrain as a grid of patches. Every patch is an independent mesh
   * with its own world bounds, which is what lets the broadphase reject most of
   * the terrain both for the camera and for every shadow cascade.
   */
  createTerrain() {
    const grid = CONFIG.terrainPatches;
    const patchSize = CONFIG.terrainSize / grid;
    const half = (grid - 1) * 0.5;

    const material = new StandardMaterial({
      name: 'Terrain',
      baseColor: new Color(0.30, 0.38, 0.20),
      roughness: 0.94,
      metallic: 0.0,
      normalScale: 0.85,
      uvScale: { x: 1, y: 1 }
    });
    material.baseColorMap = this.textures.terrainColor;
    material.normalMap = this.textures.terrainNormal;
    this.materials.terrain = material;

    const root = new Node3D('Terrain');
    this.scene.add(root);

    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const cx = (i - half) * patchSize;
        const cz = (j - half) * patchSize;
        // createTerrain centers the patch on the origin, so the sampler is
        // offset by the patch center: neighbouring patches then share the exact
        // same height and normal along their border.
        const geometry = createTerrain(
          patchSize,
          CONFIG.patchSegments,
          (x, z) => terrainHeight(x + cx, z + cz),
          CONFIG.patchUVTiles
        );
        const patch = new Mesh(geometry, material);
        patch.name = 'TerrainPatch_' + i + '_' + j;
        patch.position.set(cx, 0, cz);
        patch.castShadow = true;
        patch.receiveShadow = true;
        patch.matrixAutoUpdate = false;
        patch.updateMatrix();
        root.add(patch);
        this.terrainPatches.push(patch);
      }
    }
  }

  /* ---------------------------------------------------------------------- *
   * Instanced scatter
   * ---------------------------------------------------------------------- */

  /**
   * Spreads rocks and stylised trees over the terrain with a deterministic
   * random stream. Instances are bucketed into a grid of InstancedMesh chunks so
   * the broadphase can cull them; each chunk owns a clone of the base geometry,
   * because the per instance streams live on the geometry itself.
   */
  createScatter() {
    const chunks = CONFIG.scatterChunks;
    const chunkCount = chunks * chunks;
    const half = CONFIG.terrainSize * 0.5 - 6;
    const chunkSize = CONFIG.terrainSize / chunks;

    const rockGeometry = createIcosphere(0.5, 0);
    const foliageGeometry = createCone(0.5, 1, 7, 1, false);
    const trunkGeometry = createCylinder(0.5, 0.62, 1, 5, 1, true);

    const rockMaterial = new StandardMaterial({
      name: 'Rocks',
      baseColor: new Color(1, 1, 1),
      roughness: 0.88,
      metallic: 0.02,
      normalScale: 0.7
    });
    rockMaterial.baseColorMap = this.textures.rockColor;
    rockMaterial.normalMap = this.textures.rockNormal;

    const foliageMaterial = new StandardMaterial({
      name: 'Foliage',
      baseColor: new Color(1, 1, 1),
      roughness: 0.88,
      metallic: 0.0
    });
    foliageMaterial.baseColorMap = this.textures.foliageColor;
    foliageMaterial.normalMap = this.textures.foliageNormal;
    foliageMaterial.normalScale = 0.8;
    // Canopies are lit from every direction by bounce; a touch of double sided
    // shading keeps the shaded half from going flat black.
    foliageMaterial.side = 'double';

    const trunkMaterial = new StandardMaterial({
      name: 'Trunks',
      baseColor: new Color(1, 1, 1),
      roughness: 0.92,
      metallic: 0.0
    });
    trunkMaterial.baseColorMap = this.textures.rockColor;

    this.materials.rock = rockMaterial;
    this.materials.foliage = foliageMaterial;
    this.materials.trunk = trunkMaterial;

    const root = new Node3D('Scatter');
    this.scene.add(root);

    // Generous per chunk capacity: the distribution is uniform but noisy, and a
    // chunk that fills up would silently drop instances.
    const rockCapacity = Math.ceil((CONFIG.scatterSites * 0.62 / chunkCount) * 1.9);
    const treeCapacity = Math.ceil((CONFIG.scatterSites * 0.38 / chunkCount) * 1.9);

    const buckets = [];
    for (let c = 0; c < chunkCount; c++) {
      const bucket = {
        rocks: this.makeInstancedChunk(root, rockGeometry, rockMaterial, rockCapacity, 'Rocks_' + c),
        foliage: this.makeInstancedChunk(root, foliageGeometry, foliageMaterial, treeCapacity, 'Foliage_' + c),
        trunks: this.makeInstancedChunk(root, trunkGeometry, trunkMaterial, treeCapacity, 'Trunks_' + c),
        rockCount: 0,
        treeCount: 0
      };
      buckets.push(bucket);
      this.scatterChunks.push(bucket);
    }

    const random = seededRandom(SEED_SCATTER);
    const position = new Vec3();
    const quat = new Quat();
    const scale = new Vec3();
    const normal = new Vec3();
    const color = new Color();
    let filled = 0;

    for (let i = 0, n = CONFIG.scatterSites; i < n; i++) {
      const x = (random() * 2 - 1) * half;
      const z = (random() * 2 - 1) * half;

      // Keep the hero plaza clear.
      const distance = Math.sqrt(x * x + z * z);
      if (distance < CONFIG.plazaRadius * 0.92) continue;

      const y = terrainHeight(x, z);
      terrainNormal(x, z, normal);

      const cx = clamp(Math.floor((x + CONFIG.terrainSize * 0.5) / chunkSize), 0, chunks - 1);
      const cz = clamp(Math.floor((z + CONFIG.terrainSize * 0.5) / chunkSize), 0, chunks - 1);
      const bucket = buckets[cz * chunks + cx];

      const isTree = random() < 0.38 && normal.y > 0.88;

      if (isTree) {
        const slot = bucket.treeCount;
        if (slot >= treeCapacity) continue;
        bucket.treeCount++;

        const treeHeight = 3.2 + random() * 4.6;
        const treeRadius = 0.85 + random() * 0.75;
        const tilt = (random() - 0.5) * 0.08;

        // Foliage cone.
        quat.setFromAxisAngle(Vec3.RIGHT, tilt);
        position.set(x, y + treeHeight * 0.52, z);
        scale.set(treeRadius * 2, treeHeight, treeRadius * 2);
        bucket.foliage.setTransformAt(slot, position, quat, scale);
        color.setHSL(0.24 + random() * 0.07, 0.42 + random() * 0.22, 0.18 + random() * 0.12);
        bucket.foliage.setColorAt(slot, color, 1);

        // Trunk cylinder.
        const trunkHeight = treeHeight * 0.42;
        position.set(x, y + trunkHeight * 0.5, z);
        scale.set(treeRadius * 0.34, trunkHeight, treeRadius * 0.34);
        bucket.trunks.setTransformAt(slot, position, quat, scale);
        color.setHSL(0.08, 0.34, 0.10 + random() * 0.06);
        bucket.trunks.setColorAt(slot, color, 1);

        filled += 2;
      } else {
        const slot = bucket.rockCount;
        if (slot >= rockCapacity) continue;
        bucket.rockCount++;

        const size = 0.35 + random() * random() * 2.6;
        quat.setFromAxisAngle(
          _v3a.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize(),
          random() * Math.PI * 2
        );
        position.set(x, y + size * 0.34, z);
        scale.set(size * (0.8 + random() * 0.5), size * (0.6 + random() * 0.5), size * (0.8 + random() * 0.5));
        bucket.rocks.setTransformAt(slot, position, quat, scale);
        const grey = 0.30 + random() * 0.42;
        color.set(grey * (0.92 + random() * 0.16), grey * (0.94 + random() * 0.1), grey * 0.94);
        bucket.rocks.setColorAt(slot, color, 1);

        filled += 1;
      }
    }

    this.scatterFilled = filled;
    this.applyScatterDensity(CONFIG.scatterDensity);
  }

  /**
   * Creates one instanced chunk with its own geometry clone.
   * @param {Node3D} parent
   * @param {Geometry} geometry Base geometry (cloned).
   * @param {Object} material
   * @param {number} capacity
   * @param {string} name
   * @returns {InstancedMesh}
   */
  makeInstancedChunk(parent, geometry, material, capacity, name) {
    const mesh = new InstancedMesh(geometry.clone(), material, capacity, { useColor: true, count: 0 });
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    parent.add(mesh);
    return mesh;
  }

  /**
   * Applies the density slider: every chunk draws a prefix of its instances,
   * which is a uniform random subset because generation order is random.
   * @param {number} ratio 0..1
   * @returns {number} Instances currently drawn.
   */
  applyScatterDensity(ratio) {
    const r = clamp(ratio, 0, 1);
    let drawn = 0;
    const chunks = this.scatterChunks;
    for (let i = 0, n = chunks.length; i < n; i++) {
      const bucket = chunks[i];
      const rocks = Math.round(bucket.rockCount * r);
      const trees = Math.round(bucket.treeCount * r);
      // setCount() also raises `matrixWorldNeedsUpdate`, so the next
      // `Scene.updateMatrices()` reports the mesh as moved and the broadphase
      // proxy is refreshed with the new instance bounds.
      bucket.rocks.setCount(rocks);
      bucket.foliage.setCount(trees);
      bucket.trunks.setCount(trees);
      drawn += rocks + trees * 2;
    }
    this.scatterDrawn = drawn;
    return drawn;
  }

  /* ---------------------------------------------------------------------- *
   * Hero objects
   * ---------------------------------------------------------------------- */

  /** The high quality PBR showcase: sphere grid, LOD torus knot, UV capsule. */
  createHeroObjects() {
    const root = new Node3D('Hero');
    this.scene.add(root);
    this.heroRoot = root;

    const groundY = terrainHeight(0, 0);

    // --- 7x7 metallic / roughness grid -----------------------------------
    const sphereGeometry = createSphere(0.62, 32, 20);
    const grid = 7;
    const spacing = 1.85;
    const gridRoot = new Node3D('MetallicRoughnessGrid');
    gridRoot.position.set(-1.5, groundY + 1.15, -9.5);
    root.add(gridRoot);

    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const metallic = i / (grid - 1);
        const roughness = clamp(j / (grid - 1), 0.045, 1);
        const material = new StandardMaterial({
          name: 'PBR_' + i + '_' + j,
          baseColor: new Color(0.92, 0.74, 0.36),
          metallic: metallic,
          roughness: roughness
        });
        const sphere = new Mesh(sphereGeometry, material);
        sphere.name = material.name;
        sphere.position.set((i - (grid - 1) * 0.5) * spacing, (grid - 1 - j) * spacing, 0);
        sphere.castShadow = true;
        sphere.receiveShadow = true;
        gridRoot.add(sphere);
      }
    }

    // --- LOD torus knot ---------------------------------------------------
    const lod = new LOD('TorusKnotLOD');
    lod.position.set(9.5, groundY + 2.6, 2.5);
    root.add(lod);

    const knotMaterial = new StandardMaterial({
      name: 'PolishedMetal',
      baseColor: new Color(0.94, 0.95, 0.98),
      metallic: 1.0,
      roughness: 0.12
    });
    this.materials.knot = knotMaterial;

    const knotHigh = new Mesh(createTorusKnot(1.5, 0.42, 220, 28, 2, 3), knotMaterial);
    knotHigh.name = 'TorusKnot_HD';
    knotHigh.castShadow = true;
    const knotMid = new Mesh(createTorusKnot(1.5, 0.42, 110, 14, 2, 3), knotMaterial);
    knotMid.name = 'TorusKnot_MD';
    knotMid.castShadow = true;
    const knotLow = new Mesh(createTorusKnot(1.5, 0.42, 48, 8, 2, 3), knotMaterial);
    knotLow.name = 'TorusKnot_LD';
    knotLow.castShadow = true;

    lod.addLevel(knotHigh, 0);
    lod.addLevel(knotMid, 26, 0.08);
    lod.addLevel(knotLow, 70, 0.08);
    this.knot = lod;

    // --- UV capsule -------------------------------------------------------
    const capsuleMaterial = new StandardMaterial({
      name: 'UVCapsule',
      baseColor: new Color(1, 1, 1),
      metallic: 0.1,
      roughness: 0.42,
      uvScale: { x: 1, y: 1 }
    });
    capsuleMaterial.baseColorMap = this.textures.uvGrid;
    const capsule = new Mesh(createCapsule(0.85, 1.9, 12, 28), capsuleMaterial);
    capsule.name = 'Capsule';
    capsule.position.set(-10.5, groundY + 1.85, 2.5);
    capsule.castShadow = true;
    capsule.receiveShadow = true;
    root.add(capsule);
    this.capsule = capsule;

    // --- Emissive pedestal ring ------------------------------------------
    const pedestal = new Mesh(createCylinder(13.5, 13.5, 0.35, 64, 1, false), new StandardMaterial({
      name: 'Pedestal',
      baseColor: new Color(0.06, 0.07, 0.09),
      metallic: 0.25,
      roughness: 0.35
    }));
    pedestal.name = 'Pedestal';
    pedestal.position.set(0, groundY + 0.14, 0);
    pedestal.castShadow = false;
    pedestal.receiveShadow = true;
    root.add(pedestal);

    // --- Picking markers (pooled, recycled round robin) -------------------
    const markerGeometry = createIcosphere(0.16, 2);
    for (let i = 0; i < CONFIG.markerCount; i++) {
      const material = new UnlitMaterial({
        name: 'Marker_' + i,
        baseColor: new Color(3.2, 0.55, 0.15),
        depthTest: true,
        castShadow: false
      });
      const marker = new Mesh(markerGeometry, material);
      marker.name = 'Marker_' + i;
      marker.visible = false;
      marker.userData.noPick = true;
      marker.castShadow = false;
      marker.receiveShadow = false;
      root.add(marker);
      this.markers.push(marker);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Character: procedural rig, skinned geometry and walk cycle
   * ---------------------------------------------------------------------- */

  /**
   * Builds the bone hierarchy, the skinned geometry welded to it and the walk
   * animation, all in code. Every bone keeps an identity rotation in bind pose,
   * which means the skinned vertices can be generated directly in bind space and
   * the animation can rotate bones around plain world axes.
   */
  createCharacter() {
    // name, parent index, offset from the parent (bind pose)
    const bones = [
      ['Hips', -1, 0, 1.02, 0],
      ['Spine', 0, 0, 0.22, 0],
      ['Chest', 1, 0, 0.24, 0],
      ['Head', 2, 0, 0.30, 0],
      ['ArmL', 2, 0.21, 0.19, 0],
      ['ForeArmL', 4, 0, -0.29, 0],
      ['HandL', 5, 0, -0.27, 0],
      ['ArmR', 2, -0.21, 0.19, 0],
      ['ForeArmR', 7, 0, -0.29, 0],
      ['HandR', 8, 0, -0.27, 0],
      ['LegL', 0, 0.12, -0.07, 0],
      ['ShinL', 10, 0, -0.44, 0],
      ['FootL', 11, 0, -0.42, 0],
      ['LegR', 0, -0.12, -0.07, 0],
      ['ShinR', 13, 0, -0.44, 0],
      ['FootR', 14, 0, -0.42, 0]
    ];

    const root = new Node3D('Character');
    root.position.set(
      CHARACTER_PATH.x + CHARACTER_PATH.radius,
      terrainHeight(CHARACTER_PATH.x + CHARACTER_PATH.radius, CHARACTER_PATH.z),
      CHARACTER_PATH.z
    );
    this.characterRoot = root;
    this.scene.add(root);

    const nodes = [];
    const world = new Float32Array(bones.length * 3);

    for (let i = 0; i < bones.length; i++) {
      const def = bones[i];
      const node = new Node3D('Bone' + def[0]);
      node.position.set(def[2], def[3], def[4]);
      if (def[1] < 0) root.add(node);
      else nodes[def[1]].add(node);
      nodes.push(node);

      const px = def[1] < 0 ? 0 : world[def[1] * 3];
      const py = def[1] < 0 ? 0 : world[def[1] * 3 + 1];
      const pz = def[1] < 0 ? 0 : world[def[1] * 3 + 2];
      world[i * 3] = px + def[2];
      world[i * 3 + 1] = py + def[3];
      world[i * 3 + 2] = pz + def[4];
    }

    // --- skinned geometry -------------------------------------------------
    // A limb spans a bone joint and its child joint, and is driven by the bone
    // itself; only the vertices close to the child joint blend into the child,
    // which is what makes elbows and knees deform instead of tearing.
    const builder = new SkinBuilder();
    const seg = (bone, child, radius, capSeg, radialSeg) => {
      builder.addSegment(
        world[bone * 3], world[bone * 3 + 1], world[bone * 3 + 2],
        world[child * 3], world[child * 3 + 1], world[child * 3 + 2],
        radius, bone, child, capSeg, radialSeg
      );
    };

    // Torso chain (pelvis -> spine -> chest -> neck).
    seg(0, 1, 0.175, 6, 12);
    seg(1, 2, 0.185, 6, 12);
    seg(2, 3, 0.115, 6, 10);
    // Arms: upper arm then forearm, both sides.
    seg(4, 5, 0.070, 5, 9);
    seg(5, 6, 0.058, 5, 9);
    seg(7, 8, 0.070, 5, 9);
    seg(8, 9, 0.058, 5, 9);
    // Legs: thigh then shin, both sides.
    seg(10, 11, 0.095, 6, 10);
    seg(11, 12, 0.078, 6, 10);
    seg(13, 14, 0.095, 6, 10);
    seg(14, 15, 0.078, 6, 10);

    // Head, hands, shoulders and feet as solids attached to a single bone. A
    // sphere centred on its own joint is invariant under the bone rotation, so
    // shoulders and hands stay welded whatever the animation does.
    builder.addBall(world[9], world[10] + 0.10, world[11], 0.145, 3, 2);
    builder.addBall(world[18], world[19], world[20], 0.062, 6, 2);
    builder.addBall(world[27], world[28], world[29], 0.062, 6, 2);
    builder.addFoot(world[36], world[37], world[38], 12, 0.07);
    builder.addFoot(world[45], world[46], world[47], 15, 0.07);
    // Shoulders, so the arms do not detach from the chest.
    builder.addBall(world[12], world[13], world[14], 0.095, 4, 2);
    builder.addBall(world[21], world[22], world[23], 0.095, 7, 2);

    const geometry = builder.build();

    const material = new StandardMaterial({
      name: 'Character',
      baseColor: new Color(0.58, 0.22, 0.16),
      metallic: 0.08,
      roughness: 0.55
    });
    this.materials.character = material;

    const mesh = new SkinnedMesh(geometry, material);
    mesh.name = 'CharacterMesh';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.boundsPadding = 0.6;
    root.add(mesh);

    // Bind pose: world matrices have to be current before the inverse binds are
    // derived, and the bind matrix is the mesh world matrix at this instant.
    root.updateWorldMatrix(true);
    const skeleton = new Skeleton(nodes);
    mesh.bind(skeleton, mesh.worldMatrix);
    this.character = mesh;
    this.characterBones = nodes;

    // --- walk cycle --------------------------------------------------------
    this.mixer = new AnimationMixer(root);
    const clip = buildWalkClip();
    this.walkAction = this.mixer.clipAction(clip);
    this.walkAction.setLoop('repeat');
    this.walkAction.timeScale = 1;
    this.walkAction.play();

    /** @private Path state of the character walk. */
    this.characterPhase = 0;
  }

  /* ---------------------------------------------------------------------- *
   * Point lights
   * ---------------------------------------------------------------------- */

  /**
   * 200 coloured point lights orbiting over the terrain plus a single instanced
   * mesh drawing their bulbs (one draw call, incrementally uploaded).
   */
  createPointLights() {
    const random = seededRandom(SEED_LIGHTS);
    const count = CONFIG.pointLights;
    const root = new Node3D('PointLights');
    this.scene.add(root);

    // orbitX, orbitZ, radius, speed, phase, baseY, hue
    this.lightParams = new Float32Array(count * 7);
    const color = new Color();

    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const spread = 26 + Math.sqrt(random()) * 128;
      const ox = Math.cos(angle) * spread;
      const oz = Math.sin(angle) * spread;
      const radius = 3 + random() * 9;
      const speed = (0.25 + random() * 0.7) * (random() < 0.5 ? -1 : 1);
      const phase = random() * Math.PI * 2;
      const baseY = terrainHeight(ox, oz) + 1.4 + random() * 2.6;
      const hue = random();

      const o = i * 7;
      this.lightParams[o] = ox;
      this.lightParams[o + 1] = oz;
      this.lightParams[o + 2] = radius;
      this.lightParams[o + 3] = speed;
      this.lightParams[o + 4] = phase;
      this.lightParams[o + 5] = baseY;
      this.lightParams[o + 6] = hue;

      color.setHSL(hue, 0.85, 0.55);
      const light = new PointLight(color, 9.5 + random() * 7, 13 + random() * 7);
      light.name = 'PointLight_' + i;
      light.castShadow = false;
      light.position.set(ox + radius, baseY, oz);
      root.add(light);
      this.pointLights.push(light);
    }

    // Visible bulbs: one instanced unlit mesh with a per instance colour.
    const bulbMaterial = new UnlitMaterial({ name: 'Bulbs', baseColor: new Color(1, 1, 1) });
    const bulbs = new InstancedMesh(createIcosphere(0.13, 1), bulbMaterial, count, {
      useColor: true,
      count: count
    });
    bulbs.name = 'LightBulbs';
    bulbs.castShadow = false;
    bulbs.receiveShadow = false;
    bulbs.matrixAutoUpdate = false;
    bulbs.updateMatrix();
    root.add(bulbs);
    this.bulbs = bulbs;

    _quat.identity();
    _scale.set(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const o = i * 7;
      color.setHSL(this.lightParams[o + 6], 0.9, 0.62);
      // Unlit bulbs are pushed well above 1 so bloom picks them up.
      _color.set(color.r * 5.5, color.g * 5.5, color.b * 5.5);
      bulbs.setColorAt(i, _color, 1);
      _v3a.set(this.lightParams[o] + this.lightParams[o + 2], this.lightParams[o + 5], this.lightParams[o + 1]);
      bulbs.setTransformAt(i, _v3a, _quat, _scale);
    }

    this.setActiveLightCount(count);
  }

  /**
   * Enables the first `n` point lights (and their bulbs).
   * @param {number} n
   */
  setActiveLightCount(n) {
    const count = clamp(n | 0, 0, this.pointLights.length);
    this.activeLightCount = count;
    for (let i = 0, total = this.pointLights.length; i < total; i++) {
      this.pointLights[i].visible = i < count;
    }
    if (this.bulbs !== null) this.bulbs.setCount(count);
  }

  /* ---------------------------------------------------------------------- *
   * Debug overlay, controls, post processing
   * ---------------------------------------------------------------------- */

  /** Creates the debug line batch (attached to the scene only while in use). */
  createDebugOverlay() {
    this.debug = new DebugLines(CONFIG.debugLineCapacity);
    this._debugAttached = false;
  }

  /**
   * Attaches or detaches the debug batch. Keeping it out of the graph while it
   * is off means the broadphase and the render list never see it at all.
   * @param {boolean} active
   */
  setDebugAttached(active) {
    if (active === this._debugAttached) return;
    this._debugAttached = active;
    if (active) this.scene.add(this.debug.mesh);
    else this.scene.remove(this.debug.mesh);
  }

  /**
   * Builds the terrain collision proxy and the character controller.
   *
   * The proxy is a single coarser terrain mesh (3 unit cells instead of 2) that
   * never reaches the scene graph: it exists purely as a StaticCollider, so the
   * triangle BVH the sweeps run against stays small.
   * @returns {Object} An object exposing `move(velocity, dt)`, `position`,
   *   `isGrounded` and `warp(x, z)`.
   */
  /**
   * Registers every solid object in the scene with the collision world.
   *
   * Until this ran the demo only collided with the terrain, so the player
   * walked straight through the hero objects and the scattered props. The
   * interesting half is the scatter: thousands of instances share one triangle
   * BVH via `addStaticInstanced`, because building a BVH per instance would
   * spend exactly the memory instancing exists to save.
   *
   * @returns {number} how many colliders were registered
   */
  createColliders() {
    const world = this.collisionWorld;
    if (world === null || world === undefined) return 0;

    let count = 0;

    // --- hero objects: real geometry, one collider each ---------------------
    const solids = [];
    if (this.heroRoot !== null && this.heroRoot !== undefined) {
      this.heroRoot.traverse((node) => {
        if (node.isMesh !== true || node.geometry === null) return;
        // Skip the LOD levels that are not the one being drawn and the little
        // pick markers, which are feedback rather than scenery.
        if (node.userData !== undefined && node.userData.noCollision === true) return;
        if (node.name.indexOf('KnotLOD') === 0 && node.name !== 'KnotLOD0') return;
        if (node.name.indexOf('Marker') === 0) return;
        solids.push(node);
      });
    }

    for (let i = 0; i < solids.length; i++) {
      const node = solids[i];
      node.updateWorldMatrix(true);
      try {
        world.addStatic(node, { friction: 0.55 });
        count++;
      } catch (error) {
        // A mesh without usable triangles is not fatal: log and carry on so one
        // odd object cannot take the whole demo down.
        Logger.warn('Demo: objeto "' + node.name + '" nao virou colisor - ' + error.message);
      }
    }

    // --- scattered props ----------------------------------------------------
    //
    // Two constraints shape this. The instances carry non uniform scale (a tree
    // is tall and thin, a rock is squashed), which rules out sharing one BVH:
    // a collider can only map a query into shared local space when the scale is
    // uniform, so each of these bakes its own copy. And there are tens of
    // thousands of them.
    //
    // The answer is to collide against dedicated low poly proxies rather than
    // the drawn geometry — a 32 triangle cylinder instead of the rendered trunk
    // — and to spend a fixed budget on the largest props. A pebble you can walk
    // through is not a bug anyone reports; a tree you can walk through is.
    this.scatterColliders = [];
    const buckets = this.scatterChunks;
    if (buckets !== undefined && buckets !== null && buckets.length > 0) {
      const proxies = {
        trunks: this._collisionProxy('trunk'),
        rocks: this._collisionProxy('rock'),
      };

      // Collect every candidate with its size, so the budget buys the props
      // that matter most instead of whichever chunk happened to come first.
      const candidates = [];
      const m = new Mat4();
      for (let b = 0; b < buckets.length; b++) {
        const bucket = buckets[b];
        for (const kind of ['trunks', 'rocks']) {
          const mesh = bucket[kind];
          if (mesh === null || mesh === undefined || mesh.isInstancedMesh !== true) continue;
          for (let i = 0; i < mesh.count; i++) {
            mesh.getMatrixAt(i, m);
            const size = m.getMaxScaleOnAxis();
            if (size < CONFIG.colliderMinScale) continue;
            candidates.push({ kind: kind, size: size, matrix: m.clone() });
          }
        }
      }

      candidates.sort((a, b2) => b2.size - a.size);
      const budget = Math.min(candidates.length, CONFIG.colliderBudget);

      const byKind = { trunks: [], rocks: [] };
      for (let i = 0; i < budget; i++) byKind[candidates[i].kind].push(candidates[i].matrix);

      for (const kind of ['trunks', 'rocks']) {
        if (byKind[kind].length === 0) continue;
        const result = world.addStaticInstanced(proxies[kind], byKind[kind], { friction: 0.6 });
        this.scatterColliders.push(result);
        count += result.colliders.length;
      }

      this.scatterColliderSkipped = candidates.length - budget;
    }

    this.colliderCount = count;
    return count;
  }

  /**
   * Low poly collision proxy for a scatter kind, built once and cached.
   *
   * Colliding against the rendered geometry would bake a full BVH per instance;
   * these stand-ins are a couple of dozen triangles each, which is what makes a
   * few thousand baked colliders affordable.
   *
   * @param {string} kind `'trunk'` or `'rock'`.
   * @returns {{positions: Float32Array, indices: *}}
   * @private
   */
  _collisionProxy(kind) {
    if (this._proxyCache === undefined) this._proxyCache = {};
    if (this._proxyCache[kind] !== undefined) return this._proxyCache[kind];

    // Unit sized: the instance matrix supplies the real dimensions.
    const geometry = kind === 'trunk'
      ? createCylinder(0.5, 0.5, 1, 8, 1, false)
      : createIcosphere(0.5, 0);

    const position = geometry.getAttribute('aPosition');
    const index = geometry.index;
    const proxy = {
      positions: position.data,
      indices: index !== null ? index.data : null,
    };
    this._proxyCache[kind] = proxy;
    return proxy;
  }

  /**
   * Builds the lake: a rendered surface, a physics fluid volume that matches it
   * exactly, and a handful of buoyant bodies to make the behaviour visible.
   */
  createWater() {
    const world = this.collisionWorld;

    // --- physics volume -----------------------------------------------------
    // The box spans the basin and stops at the still water level; buoyancy and
    // the surface mesh therefore agree by construction.
    if (world !== null && world !== undefined) {
      this.waterVolume = new WaterVolume({
        name: 'lake',
        min: { x: LAKE.x - LAKE.radius, y: LAKE.level - LAKE.depth - 2, z: LAKE.z - LAKE.radius },
        max: { x: LAKE.x + LAKE.radius, y: LAKE.level, z: LAKE.z + LAKE.radius },
        surfaceY: LAKE.level,
        density: 1,
        linearDrag: 1.5,
        quadraticDrag: 0.85,
        angularDrag: 2.4,
        // Ondas de verdade: o material de agua desloca a superficie com esta
        // mesma funcao, entao a crista que voce ve e a crista que empurra os
        // corpos. Amplitude modesta de proposito — ondas altas fazem tudo que
        // boia balancar mais do que qualquer lago real.
        waveAmplitude: 0.16,
        waveLength: 7.5,
        waveSpeed: 1.05,
      });
      world.addWater(this.waterVolume);
    }

    // --- rendered surface ---------------------------------------------------
    // A disc, not a quad: the shoreline is round, and a square sheet leaves
    // corners hanging over the rim wherever the terrain dips.
    const waterMaterial = new WaterMaterial({
      deepColor: new Color(0.016, 0.075, 0.115),
      skyColor: new Color(0.34, 0.52, 0.74),
      opacity: 0.66,
      fresnelPower: 4.2,
      specular: 2.2,
      shininess: 300,
      rippleStrength: 0.07,
      rippleScale: 2.2,
    });
    this.waterMaterial = waterMaterial;

    // A ring tessellated disc, not a cylinder cap. A cap is a triangle fan: it
    // has one vertex in the middle and the rest on the rim, so displacing it
    // produces a radial star instead of waves.
    const surface = new Mesh(createDisc(LAKE.radius * 1.02, 96, 28), waterMaterial);
    surface.name = 'LakeSurface';
    // createCylinder is already built around the Y axis, so its caps lie flat.
    surface.position.set(LAKE.x, LAKE.level, LAKE.z);
    surface.castShadow = false;
    surface.receiveShadow = false;
    surface.userData.noCollision = true;
    this.scene.add(surface);
    this.waterSurface = surface;

    // --- buoyant bodies -----------------------------------------------------
    // Densities are relative to the fluid's, so each crate settles at a
    // different, predictable waterline: 0.35 rides high, 0.85 barely floats.
    this.floaters = [];
    if (world === null || world === undefined) return;

    const crateGeometry = createBox(1.1, 1.1, 1.1);
    const buoyGeometry = createSphere(0.6, 24, 16);
    const densities = [0.35, 0.5, 0.65, 0.85, 0.45, 0.7, 0.3, 0.55];

    for (let i = 0; i < densities.length; i++) {
      const isCrate = (i % 2) === 0;
      const angle = (i / densities.length) * Math.PI * 2;
      const dist = LAKE.radius * 0.42;
      const px = LAKE.x + Math.cos(angle) * dist;
      const pz = LAKE.z + Math.sin(angle) * dist;

      const hue = 0.08 + (i / densities.length) * 0.55;
      const material = new StandardMaterial({
        name: 'Floater_' + i,
        baseColor: new Color().setHSL(hue, 0.62, 0.5),
        roughness: 0.55,
        metallic: 0.05,
      });

      const mesh = new Mesh(isCrate ? crateGeometry : buoyGeometry, material);
      mesh.name = 'Floater_' + i;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.noCollision = true;
      this.scene.add(mesh);

      const radius = isCrate ? 0.55 : 0.6;
      const volume = isCrate
        ? 1.1 * 1.1 * 1.1
        : (4 / 3) * Math.PI * radius * radius * radius;

      const body = new RigidBody({
        name: 'Floater_' + i,
        shape: isCrate ? BodyShape.BOX : BodyShape.SPHERE,
        radius: radius,
        mass: densities[i] * volume,
        restitution: 0.15,
        friction: 0.4,
        linearDamping: 0.02,
        angularDamping: 0.08,
      });
      if (isCrate) body.setShape(BodyShape.BOX, { halfExtents: new Vec3(0.55, 0.55, 0.55) });
      // Dropped from just above the surface: enough to show the splash and the
      // settle, close enough that they reach equilibrium in the first second
      // instead of pogoing while someone is trying to look at them.
      body.position.set(px, LAKE.level + 0.8 + i * 0.22, pz);
      body.node = mesh;
      world.addDynamic(body);

      this.floaters.push({ body: body, mesh: mesh, density: densities[i] });
    }
  }

  createCharacterController() {
    const spawn = new Vec3(0, terrainHeight(0, 30) + 0.25, 30);
    try {
      const proxy = createTerrain(CONFIG.terrainSize, CONFIG.collisionSegments, terrainHeight, 1);
      const positions = proxy.getAttribute('aPosition').data;
      const indices = proxy.index.data;

      const world = new CollisionWorld({ gravity: new Vec3(0, -26, 0) });
      world.addStatic({ positions: positions, indices: indices }, { friction: 0.7 });
      this.collisionWorld = world;

      const controller = new CharacterController(world, {
        radius: 0.34,
        height: 1.75,
        stepOffset: 0.5,
        slopeLimit: 52,
        contactOffset: 0.02,
        maxIterations: 4,
        position: spawn
      });
      return new CharacterControllerAdapter(controller, world);
    } catch (error) {
      console.warn('[demo] fisica indisponivel, usando o controlador de heightfield:', error);
      const fallback = new HeightfieldController({
        radius: 0.34,
        height: 1.75,
        gravity: -26,
        slopeLimit: 52,
        stepOffset: 0.5,
        bounds: CONFIG.terrainSize * 0.5 - 4,
        heightAt: terrainHeight
      });
      fallback.warp(spawn.x, spawn.z);
      return fallback;
    }
  }

  /** Creates both camera rigs and the character controller. */
  createControls() {
    const spawnX = 0;
    const spawnZ = 30;

    this.controller = this.createCharacterController();

    this.fpsControls = new FirstPersonControls(this.camera, this.engine.input, {
      controller: this.controller,
      moveSpeed: 6.2,
      sprintMultiplier: 2.6,
      lookSensitivity: 0.0021,
      eyeHeight: CONFIG.eyeHeight,
      jumpSpeed: 8.2,
      fly: false,
      requirePointerLock: true,
      dragToLook: true
    });
    this.camera.position.set(spawnX, this.controller.position.y + CONFIG.eyeHeight, spawnZ);
    this.fpsControls.setRotation(0, -0.06);

    this.orbitControls = new OrbitControls(this.camera, this.dom.canvas);
    this.orbitControls.enabled = false;
    this.orbitControls.target.set(0, terrainHeight(0, 0) + 3.5, 0);
    this.orbitControls.minDistance = 4;
    this.orbitControls.maxDistance = 180;
    this.orbitControls.maxPolarAngle = Math.PI * 0.495;
    this.orbitControls.dampingFactor = 0.12;

    this.installPointerHandlers();
  }

  /** Enables the post processing effects the demo ships with. */
  configurePostProcessing() {
    const post = this.renderer.post;
    if (post === null || post === undefined) return;
    post.setBloom(true, 0.18, 1.9, 1.0);
    post.setToneMapping('aces', 1.0);
    post.setFXAA(true);
    post.setSSAO(true, 0.65, 0.85);
    if (typeof post.setVignette === 'function') post.setVignette(true, 0.35, 0.55, 1.0);
    if (typeof post.setChromaticAberration === 'function') post.setChromaticAberration(true, 0.0016);
    if (typeof post.setGrain === 'function') post.setGrain(true, 0.022, 0.6);
  }

  /* ---------------------------------------------------------------------- *
   * Pointer handling: pointer lock, picking
   * ---------------------------------------------------------------------- */

  /** Installs the click / pointer lock handlers on the canvas. */
  /**
   * Enters play mode: fullscreen, pointer lock and keyboard lock.
   *
   * The keyboard lock is what actually stops Ctrl+W and Ctrl+T, and the browser
   * only grants it in fullscreen. Everything else — Ctrl+S, Ctrl+D, Space, Tab —
   * is already suppressed by the capture list without any of this.
   *
   * @returns {Promise<void>}
   */
  async enterGameMode() {
    const input = this.engine.input;
    if (input === null || input === undefined) return;

    input.captureAllShortcuts = true;
    const result = await input.enterGameMode(this.dom.canvas);

    if (result.keyboard === true) {
      this.setPickInfo('Modo de jogo: atalhos do navegador desativados. ' +
        'Segure Esc para sair.');
    } else if (input.canLockKeyboard() === false) {
      this.setPickInfo('Atalhos comuns bloqueados. Ctrl+W / Ctrl+T seguem ' +
        'reservados: este navegador nao tem Keyboard Lock.');
    } else {
      this.setPickInfo('Atalhos comuns bloqueados. Sem tela cheia o navegador ' +
        'nao libera Ctrl+W / Ctrl+T.');
    }
  }

  installPointerHandlers() {
    const canvas = this.dom.canvas;
    const state = this._pickPointer;

    canvas.addEventListener('pointerdown', (event) => {
      state.x = event.clientX;
      state.y = event.clientY;
      state.time = event.timeStamp;
      state.id = event.pointerId;
      state.moved = false;
    });

    canvas.addEventListener('pointermove', (event) => {
      if (state.id !== event.pointerId) return;
      if (Math.abs(event.clientX - state.x) > 5 || Math.abs(event.clientY - state.y) > 5) {
        state.moved = true;
      }
    });

    canvas.addEventListener('pointerup', (event) => {
      if (state.id !== event.pointerId) return;
      state.id = -1;
      if (state.moved || event.timeStamp - state.time > 450) return;
      if (event.button !== 0) return;

      const input = this.engine.input;
      const locked = input !== null && input.pointerLocked === true;

      if (this.cameraMode === 'fps' && !locked) {
        // First click grabs the mouse; picking starts from the second one.
        //
        // enterGameMode also goes fullscreen and takes the keyboard lock, which
        // is the only way a page gets Ctrl+W, Ctrl+T and friends. It must run
        // from this user gesture: all three requests require one.
        this.enterGameMode();
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const x = locked ? rect.width * 0.5 : event.clientX - rect.left;
      const y = locked ? rect.height * 0.5 : event.clientY - rect.top;
      this.pick(x, y, rect.width, rect.height);
    });
  }

  /**
   * Casts a ray through the scene broadphase and marks the closest hit.
   * @param {number} x Canvas relative X, CSS pixels.
   * @param {number} y Canvas relative Y, CSS pixels.
   * @param {number} width Canvas CSS width.
   * @param {number} height Canvas CSS height.
   */
  pick(x, y, width, height) {
    const camera = this.camera;
    camera.screenPointToRay(x, y, width, height, _ray);

    _pickHits.length = 0;
    _pickRaycaster.far = 600;

    const bvh = this.scene.bvh;
    let best = null;

    if (bvh !== null && bvh !== undefined && typeof bvh.raycast === 'function') {
      bvh.raycast(_ray, 600, (mesh) => {
        if (mesh === null || mesh === undefined || mesh.visible === false) return;
        if (mesh === this.debug.mesh || mesh.userData.noPick === true) return;
        if (typeof mesh.raycast !== 'function') return;
        const before = _pickHits.length;
        mesh.raycast(_pickRaycaster, _pickHits);
        for (let i = before, n = _pickHits.length; i < n; i++) {
          const hit = _pickHits[i];
          if (best === null || hit.distance < best.distance) best = hit;
        }
        // Narrow the traversal: nothing further than the current best matters.
        return best !== null ? best.distance : undefined;
      });
    }

    if (best === null) {
      this.setPickInfo('Nenhum objeto atingido.');
      return;
    }

    const marker = this.markers[this.markerCursor];
    this.markerCursor = (this.markerCursor + 1) % this.markers.length;
    marker.visible = true;
    marker.position.copy(best.point);
    // Lift the marker along the surface normal so it never z-fights.
    marker.position.x += best.normal.x * 0.08;
    marker.position.y += best.normal.y * 0.08;
    marker.position.z += best.normal.z * 0.08;
    marker.matrixWorldNeedsUpdate = true;

    const name = best.object && best.object.name ? best.object.name : 'objeto';
    const instance = best.instanceId >= 0 ? ' #' + best.instanceId : '';
    this.setPickInfo(
      'Hit: ' + name + instance +
      ' | d=' + best.distance.toFixed(2) + 'm' +
      ' | (' + best.point.x.toFixed(1) + ', ' + best.point.y.toFixed(1) + ', ' + best.point.z.toFixed(1) + ')'
    );
  }

  /**
   * @param {string} text
   */
  setPickInfo(text) {
    if (this.dom.pickInfo) this.dom.pickInfo.textContent = text;
  }

  /* ---------------------------------------------------------------------- *
   * UI
   * ---------------------------------------------------------------------- */

  /** Builds the stats readout and the control panel with plain DOM. */
  buildUI() {
    this.buildStats();
    this.buildControlPanel();

    if (this.dom.collapse) {
      this.dom.collapse.addEventListener('click', () => {
        const collapsed = this.dom.controls.classList.toggle('collapsed');
        this.dom.collapse.textContent = collapsed ? '+' : '−';
      });
    }
  }

  /** Creates every statistics row once and caches the value nodes. */
  buildStats() {
    const rows = this.dom.statRows;
    const add = (key, label, cls) => {
      const row = el('div', 'stat' + (cls ? ' ' + cls : ''));
      row.appendChild(el('span', null, label));
      const value = el('span', null, '-');
      row.appendChild(value);
      rows.appendChild(row);
      this.statFields[key] = { row: row, value: value };
    };
    const head = (label) => {
      const row = el('div', 'stat head');
      row.appendChild(el('span', null, label));
      row.appendChild(el('span', null, ''));
      rows.appendChild(row);
    };

    add('fps', 'FPS');
    add('cpu', 'CPU');
    add('gpu', 'GPU');
    head('Frame');
    add('draws', 'Draw calls');
    add('tris', 'Triangulos');
    add('meshes', 'Malhas vis./total');
    add('cull', 'Culling');
    add('instances', 'Instancias');
    add('lights', 'Luzes pontuais');
    head('Recursos');
    add('programs', 'Programas');
    add('memory', 'Memoria GPU');
    add('bvh', 'Nos do BVH');
    head('Jogador');
    add('position', 'Posicao');
    add('ground', 'Solo');
    add('physics', 'Colisao');
  }

  /** Creates the interactive control panel. */
  buildControlPanel() {
    const rows = this.dom.controlRows;
    const refs = this.controlRefs;

    const group = (title) => rows.appendChild(el('div', 'group', title));

    const check = (label, initial, onChange) => {
      const wrap = el('label', 'check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!initial;
      wrap.appendChild(input);
      wrap.appendChild(el('span', null, label));
      rows.appendChild(wrap);
      input.addEventListener('change', () => onChange(input.checked));
      return input;
    };

    const slider = (label, min, max, step, value, format, onInput, onChange) => {
      const wrap = el('div', 'slider');
      const head = el('div', 'slabel');
      head.appendChild(el('span', null, label));
      const readout = el('b', null, format(value));
      head.appendChild(readout);
      wrap.appendChild(head);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      wrap.appendChild(input);
      rows.appendChild(wrap);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        readout.textContent = format(v);
        onInput(v);
      });
      if (onChange) input.addEventListener('change', () => onChange(parseFloat(input.value)));
      return { input: input, readout: readout, format: format };
    };

    // ---------------------------------------------------------------- render
    group('Renderizacao');

    refs.shadows = check('Sombras (CSM)', true, (on) => this.setShadows(on));
    refs.clustered = check('Clustered lighting', true, (on) => this.setClustered(on));
    refs.fog = check('Nevoa', true, (on) => this.setFog(on));
    refs.wireframe = check('Wireframe (F)', false, (on) => this.setWireframe(on));

    refs.exposure = slider('Exposicao', 0.2, 3, 0.01, 1, (v) => v.toFixed(2), (v) => {
      this.renderer.setToneMapping(this.renderer.toneMapping, v);
    });

    // ------------------------------------------------------------------ post
    group('Pos-processamento');

    const post = this.renderer.post;
    const hasPost = post !== null && post !== undefined;

    refs.bloom = check('Bloom', hasPost, (on) => {
      if (hasPost) post.setBloom(on, this.bloomIntensity, 1.9, 1.0);
    });
    this.bloomIntensity = 0.18;
    refs.bloomIntensity = slider('Intensidade do bloom', 0, 1.5, 0.01, 0.18, (v) => v.toFixed(2), (v) => {
      this.bloomIntensity = v;
      if (hasPost) post.setBloom(refs.bloom.checked, v, 1.9, 1.0);
    });
    refs.ssao = check('SSAO', hasPost, (on) => {
      if (hasPost) post.setSSAO(on, 0.65, 0.85);
    });
    refs.fxaa = check('FXAA', hasPost, (on) => {
      if (hasPost) post.setFXAA(on);
    });
    if (!hasPost) {
      refs.bloom.disabled = true;
      refs.ssao.disabled = true;
      refs.fxaa.disabled = true;
      refs.bloomIntensity.input.disabled = true;
    }

    // ----------------------------------------------------------------- scene
    group('Cena');

    refs.density = slider(
      'Instancias', 0, 100, 1, Math.round(CONFIG.scatterDensity * 100),
      (v) => fmt(this.scatterFilled * v * 0.01),
      (v) => this.applyScatterDensity(v * 0.01)
    );

    refs.lights = slider(
      'Luzes pontuais', 0, CONFIG.pointLights, 1, CONFIG.pointLights,
      (v) => String(v | 0),
      (v) => this.setActiveLightCount(v)
    );

    refs.sun = slider(
      'Elevacao do sol', 2, 88, 0.5, CONFIG.sunElevation,
      (v) => v.toFixed(0) + '°',
      (v) => { this.sunElevation = v; this.applySunPosition(); },
      () => this.scheduleIBLRebuild()
    );

    refs.azimuth = slider(
      'Azimute do sol', 0, 360, 1, CONFIG.sunAzimuth,
      (v) => v.toFixed(0) + '°',
      (v) => { this.sunAzimuth = v; this.applySunPosition(); },
      () => this.scheduleIBLRebuild()
    );

    // ----------------------------------------------------------------- debug
    group('Depuracao');

    refs.bvh = check('Mostrar BVH (B)', false, (on) => { this.showBVH = on; });
    refs.bounds = check('Bounding boxes', false, (on) => { this.showBounds = on; });
    refs.frustum = check('Travar frustum (L)', false, (on) => this.setFrustumLock(on));
    refs.pause = check('Pausar (P)', false, (on) => this.setPaused(on));

    const buttons = el('div', 'buttons');
    const camButton = el('button', null, 'Camera: FPS');
    camButton.type = 'button';
    camButton.addEventListener('click', () => this.toggleCameraMode());
    buttons.appendChild(camButton);
    refs.cameraButton = camButton;

    const resetButton = el('button', null, 'Voltar ao spawn');
    resetButton.type = 'button';
    resetButton.addEventListener('click', () => this.respawn());
    buttons.appendChild(resetButton);

    rows.appendChild(buttons);
  }

  /* ---------------------------------------------------------------------- *
   * Toggles
   * ---------------------------------------------------------------------- */

  /**
   * @param {boolean} enabled
   */
  setShadows(enabled) {
    const renderer = this.renderer;
    if (enabled) {
      if (renderer.shadowMapper === null && this._savedShadowMapper) {
        renderer.shadowMapper = this._savedShadowMapper;
      }
    } else if (renderer.shadowMapper !== null) {
      this._savedShadowMapper = renderer.shadowMapper;
      renderer.shadowMapper = null;
    }
    renderer.shadowsEnabled = renderer.shadowMapper !== null;
  }

  /**
   * @param {boolean} enabled
   */
  setClustered(enabled) {
    const renderer = this.renderer;
    if (enabled) {
      if (renderer.clustered === null && this._savedClustered) {
        renderer.clustered = this._savedClustered;
      }
    } else if (renderer.clustered !== null) {
      this._savedClustered = renderer.clustered;
      renderer.clustered = null;
    }
    renderer.clusteredEnabled = renderer.clustered !== null;
  }

  /**
   * @param {boolean} enabled
   */
  setFog(enabled) {
    if (enabled) {
      if (this.scene.fog === null) {
        if (this._savedFog) this.scene.fog = this._savedFog;
        else {
          this.scene.setFogExp2(new Color(0.22, 0.27, 0.38), 0.0014);
          this.scene.fog.maxOpacity = 0.82;
          this.scene.fog.heightFalloff = 0.018;
        }
        this.applySunPosition();
      }
    } else {
      this._savedFog = this.scene.fog;
      this.scene.clearFog();
    }
  }

  /**
   * @param {boolean} enabled
   */
  setWireframe(enabled) {
    this.wireframe = enabled;
    const materials = this.materials;
    for (const key in materials) {
      const material = materials[key];
      if (material && material.wireframe !== undefined) material.wireframe = enabled;
    }
    // The hero spheres own one material each.
    this.scene.traverse((node) => {
      if (node.isMesh !== true) return;
      const material = node.material;
      if (material === null || material === undefined) return;
      if (node === this.debug.mesh) return;
      if (Array.isArray(material)) {
        for (let i = 0; i < material.length; i++) material[i].wireframe = enabled;
      } else {
        material.wireframe = enabled;
      }
    });
    if (this.controlRefs.wireframe) this.controlRefs.wireframe.checked = enabled;
  }

  /**
   * Freezes (or releases) the frustum used for culling, by neutralising
   * `camera.updateFrustum` while the lock is active.
   * @param {boolean} enabled
   */
  setFrustumLock(enabled) {
    const camera = this.camera;
    if (enabled === this.frustumLocked) return;
    this.frustumLocked = enabled;

    if (enabled) {
      camera.updateFrustum();
      this.captureFrustumCorners();
      // Own property shadowing the prototype method: culling keeps using the
      // frustum captured right now, while the camera keeps moving freely.
      camera.updateFrustum = function lockedUpdateFrustum() { return this.frustum; };
    } else if (Object.prototype.hasOwnProperty.call(camera, 'updateFrustum')) {
      delete camera.updateFrustum;
      camera.updateFrustum();
    }
    if (this.controlRefs.frustum) this.controlRefs.frustum.checked = enabled;
  }

  /** Stores the 8 world space corners of the frozen frustum. */
  captureFrustumCorners() {
    const camera = this.camera;
    const out = this.lockedCorners;
    let w = 0;
    for (let i = 0; i < 8; i++) {
      const x = (i & 1) ? 1 : -1;
      const y = (i & 2) ? 1 : -1;
      const z = (i & 4) ? 1 : -1;
      camera.unproject(x, y, z, _v3a);
      out[w++] = _v3a.x;
      out[w++] = _v3a.y;
      out[w++] = _v3a.z;
    }
  }

  /**
   * @param {boolean} paused
   */
  setPaused(paused) {
    this.paused = paused;
    this.engine.time.timeScale = paused ? 0 : 1;
    if (this.controlRefs.pause) this.controlRefs.pause.checked = paused;
    if (this.dom.statMode) {
      this.dom.statMode.textContent = paused ? 'PAUSA' : (this.cameraMode === 'fps' ? 'FPS' : 'ORBIT');
    }
  }

  /** Switches between the first person rig and the orbit camera. */
  toggleCameraMode() {
    const toOrbit = this.cameraMode === 'fps';
    this.cameraMode = toOrbit ? 'orbit' : 'fps';

    this.fpsControls.enabled = !toOrbit;
    this.orbitControls.enabled = toOrbit;

    if (toOrbit) {
      const input = this.engine.input;
      if (input !== null && input.pointerLocked) input.exitPointerLock();

      const orbit = this.orbitControls;
      orbit.target.set(0, terrainHeight(0, 0) + 3.5, 0);

      // Derive the spherical goals from wherever the first person camera is, then
      // let one undamped step snap the current values onto them: the orbit rig
      // takes over exactly where the walk ended, with no fly-in.
      const dx = this.camera.position.x - orbit.target.x;
      const dy = this.camera.position.y - orbit.target.y;
      const dz = this.camera.position.z - orbit.target.z;
      const radius = Math.max(Math.hypot(dx, dy, dz), 4);
      orbit.setDistance(radius);
      orbit.setAngles(Math.atan2(dx, dz), Math.acos(clamp(dy / radius, -1, 1)));

      const damping = orbit.enableDamping;
      orbit.enableDamping = false;
      orbit.update(1 / 60);
      orbit.enableDamping = damping;
      orbit.saveState();
    } else {
      this.controller.warp(this.camera.position.x, this.camera.position.z);
      this.fpsControls.syncFromCamera();
    }

    if (this.controlRefs.cameraButton) {
      this.controlRefs.cameraButton.textContent = toOrbit ? 'Camera: Orbit' : 'Camera: FPS';
    }
    if (this.dom.statMode && !this.paused) this.dom.statMode.textContent = toOrbit ? 'ORBIT' : 'FPS';
    if (this.dom.crosshair) this.dom.crosshair.classList.toggle('hidden', toOrbit);
  }

  /** Puts the character back on the spawn point. */
  respawn() {
    this.controller.warp(0, 30);
    this.camera.position.set(0, this.controller.position.y + CONFIG.eyeHeight, 30);
    if (this.cameraMode === 'fps') this.fpsControls.setRotation(0, -0.06);
  }

  /**
   * Debounces the environment regeneration: dragging the sun slider must not
   * re-integrate the cube maps on every input event.
   */
  scheduleIBLRebuild() {
    this._iblTimer = 0.25;
  }

  /* ---------------------------------------------------------------------- *
   * Frame loop
   * ---------------------------------------------------------------------- */

  /** Wires the per frame callbacks. */
  installLoop() {
    this.engine.onUpdate((dt) => this.update(dt));
    if (this.dom.crosshair) this.dom.crosshair.classList.remove('hidden');
    if (this.engine.stats !== null && this.engine.stats !== undefined) this.engine.stats.show();
    this.setPickInfo('Clique para capturar o mouse; clique de novo para marcar um ponto.');
  }

  /**
   * Per frame logic. Allocation free.
   * @param {number} dt Scaled delta, seconds.
   */
  update(dt) {
    this.handleHotkeys();

    // Navigation runs on the unscaled clock: pausing freezes the world but the
    // camera keeps moving, which is the whole point of inspecting a paused frame.
    const look = this.engine.time.unscaledDelta;
    if (this.cameraMode === 'fps') this.fpsControls.update(look);
    else this.orbitControls.update(look);

    if (dt > 0) {
      this.updateLights(dt);
      this.updateCharacter(dt);
      this.updateHeroObjects(dt);
      this.mixer.update(dt);

      // Rigid bodies: the floating crates. The character controller sweeps the
      // same world but is kinematic, so it is driven separately above.
      if (this.collisionWorld !== null && this.collisionWorld !== undefined) {
        this.collisionWorld.step(dt);
      }

      // O volume avanca o proprio relogio dentro de step(); copiar dali em vez
      // de manter um segundo contador garante que a onda desenhada e a mesma
      // que a fisica acabou de usar.
      if (this.waterMaterial !== null && this.waterVolume !== null) {
        this.waterMaterial.syncFromVolume(this.waterVolume);
      }

      if (this._iblTimer > 0) {
        this._iblTimer -= dt;
        if (this._iblTimer <= 0) {
          this._iblTimer = -1;
          this.regenerateIBL();
        }
      }
    }

    this.updateDebugOverlay();

    this._hudTimer -= this.engine.time.unscaledDelta;
    if (this._hudTimer <= 0) {
      this._hudTimer = 0.2;
      this.updateHUD();
    }
  }

  /** Reads the keyboard shortcuts through the engine input layer. */
  handleHotkeys() {
    const input = this.engine.input;
    if (input === null || input === undefined) return;

    if (input.isKeyPressed('KeyH')) {
      this.uiVisible = !this.uiVisible;
      this.dom.hud.classList.toggle('hidden', !this.uiVisible);
      const stats = this.engine.stats;
      if (stats !== null && stats !== undefined) {
        if (this.uiVisible) stats.show();
        else stats.hide();
      }
    }
    if (input.isKeyPressed('KeyP')) this.setPaused(!this.paused);
    if (input.isKeyPressed('KeyF')) this.setWireframe(!this.wireframe);
    if (input.isKeyPressed('KeyB')) {
      this.showBVH = !this.showBVH;
      if (this.controlRefs.bvh) this.controlRefs.bvh.checked = this.showBVH;
    }
    if (input.isKeyPressed('KeyL')) this.setFrustumLock(!this.frustumLocked);
    if (input.isKeyPressed('KeyC')) this.toggleCameraMode();
    if (input.isKeyPressed('KeyR')) this.respawn();
  }

  /**
   * Moves the point lights along their orbits and refreshes the bulb instances.
   * @param {number} dt
   */
  updateLights(dt) {
    const params = this.lightParams;
    const lights = this.pointLights;
    const bulbs = this.bulbs;
    const time = this.engine.time.elapsed;
    const count = this.activeLightCount;

    _quat.identity();
    _scale.set(1, 1, 1);

    for (let i = 0; i < count; i++) {
      const o = i * 7;
      const angle = params[o + 4] + time * params[o + 3];
      const radius = params[o + 2];
      const x = params[o] + Math.cos(angle) * radius;
      const z = params[o + 1] + Math.sin(angle) * radius;
      const y = params[o + 5] + Math.sin(time * 0.9 + params[o + 4]) * 0.55;

      const light = lights[i];
      light.position.set(x, y, z);

      if (bulbs !== null) {
        _v3a.set(x, y, z);
        bulbs.setTransformAt(i, _v3a, _quat, _scale);
      }
    }

    // The bulbs move every frame, so their instance bounds (and with them the
    // broadphase proxy) have to be rebuilt: setCount() flags both.
    if (bulbs !== null) bulbs.setCount(count);
  }

  /**
   * Walks the character along a circular path over the terrain.
   * @param {number} dt
   */
  updateCharacter(dt) {
    const root = this.characterRoot;
    if (root === null) return;

    const speed = CHARACTER_PATH.speed;
    const radius = CHARACTER_PATH.radius;
    this.characterPhase += (speed / radius) * dt;

    const cx = CHARACTER_PATH.x;
    const cz = CHARACTER_PATH.z;
    const x = cx + Math.cos(this.characterPhase) * radius;
    const z = cz + Math.sin(this.characterPhase) * radius;
    const y = terrainHeight(x, z);

    // Tangent of the circle, so the character faces where it walks (-Z forward).
    const fx = -Math.sin(this.characterPhase);
    const fz = Math.cos(this.characterPhase);
    const yaw = Math.atan2(-fx, -fz);

    root.position.set(x, y, z);
    root.quaternion.set(0, Math.sin(yaw * 0.5), 0, Math.cos(yaw * 0.5));
    root.matrixWorldNeedsUpdate = true;

    // Keep the stride in sync with the ground speed.
    if (this.walkAction !== null) this.walkAction.timeScale = speed / 1.6;
  }

  /**
   * Spins the hero props so the PBR response is readable while standing still.
   * @param {number} dt
   */
  updateHeroObjects(dt) {
    if (this.knot !== null && this.knot !== undefined) {
      this.knot.rotateY(dt * 0.35);
      this.knot.rotateOnAxis(Vec3.RIGHT, dt * 0.12);
    }
    if (this.capsule !== null && this.capsule !== undefined) {
      this.capsule.rotateY(dt * 0.6);
    }
  }

  /** Rebuilds the debug line batch for this frame. */
  updateDebugOverlay() {
    const active = this.showBVH || this.showBounds || this.frustumLocked;
    this.setDebugAttached(active);
    if (!active) {
      this.debug.clear();
      this.debug.mesh.visible = false;
      return;
    }

    const debug = this.debug;
    debug.clear();

    if (this.showBVH) this.drawBVH(debug);
    if (this.showBounds) this.drawBounds(debug);
    if (this.frustumLocked) this.drawLockedFrustum(debug);

    debug.commit();
  }

  /**
   * Draws the internal nodes of the scene broadphase.
   * @param {DebugLines} debug
   */
  drawBVH(debug) {
    const bvh = this.scene.bvh;
    if (bvh === null || bvh === undefined) return;

    // The overlay reads the SoA node arrays directly: the public surface exposes
    // the bounds of a proxy, not those of the internal nodes, and drawing the
    // internal levels is the whole point of a tree visualisation. Every access is
    // feature detected and falls back to the public per mesh bounds.
    const bounds = bvh._bounds;
    const tight = bvh._tight;
    const child1 = bvh._child1;
    const child2 = bvh._child2;
    const root = bvh.root;

    if (bounds === undefined || child1 === undefined || root === undefined || root < 0) {
      // No access to the internal layout: fall back to the leaf bounds we own.
      this.drawBounds(debug);
      return;
    }

    // Iterative traversal with a stack kept on the instance (no allocation once
    // it has grown to the tree height).
    let stack = this._bvhStack;
    if (stack === undefined || stack === null) {
      stack = new Int32Array(256);
      this._bvhStack = stack;
      this._bvhDepth = new Int32Array(256);
    }
    const depths = this._bvhDepth;
    let sp = 0;
    stack[sp] = root;
    depths[sp] = 0;
    sp++;

    while (sp > 0) {
      sp--;
      const node = stack[sp];
      const depth = depths[sp];
      const o = node * 6;
      const leaf = child1[node] < 0;
      // Leaves show their tight bounds, internal nodes the fat ones they store.
      const box = leaf && tight !== undefined ? tight : bounds;

      // A node that opted out of culling carries a huge sentinel box; drawing it
      // would swamp the overlay, so only real geometry is outlined.
      if (Math.abs(box[o]) < DEBUG_MAX_EXTENT && Math.abs(box[o + 3]) < DEBUG_MAX_EXTENT) {
        if (leaf) {
          debug.box(
            box[o], box[o + 1], box[o + 2],
            box[o + 3], box[o + 4], box[o + 5],
            0.25, 1.0, 0.45, 0.85
          );
        } else {
          const t = clamp(depth / 9, 0, 1);
          debug.box(
            box[o], box[o + 1], box[o + 2],
            box[o + 3], box[o + 4], box[o + 5],
            lerp(0.25, 1.0, t), lerp(0.55, 0.35, t), lerp(1.0, 0.2, t), 0.35
          );
        }
      }

      if (!leaf && sp + 2 < stack.length) {
        stack[sp] = child1[node];
        depths[sp] = depth + 1;
        sp++;
        stack[sp] = child2[node];
        depths[sp] = depth + 1;
        sp++;
      }
    }
  }

  /**
   * Draws the world bounding box of every mesh in the scene.
   * @param {DebugLines} debug
   */
  drawBounds(debug) {
    const meshes = this.scene.meshes;
    for (let i = 0, n = meshes.length; i < n; i++) {
      const mesh = meshes[i];
      if (mesh.visible === false || mesh === this.debug.mesh) continue;
      const box = mesh.boundingBoxWorld;
      if (box === undefined || box.isEmpty()) continue;
      const min = box.min;
      const max = box.max;
      if (!isFinite(min.x) || Math.abs(min.x) > 1e6) continue;
      debug.box(min.x, min.y, min.z, max.x, max.y, max.z, 1.0, 0.72, 0.15, 0.8);
    }
  }

  /**
   * Draws the frozen culling frustum.
   * @param {DebugLines} debug
   */
  drawLockedFrustum(debug) {
    const c = this.lockedCorners;
    const edges = FRUSTUM_EDGES;
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i] * 3;
      const b = edges[i + 1] * 3;
      debug.line(c[a], c[a + 1], c[a + 2], c[b], c[b + 1], c[b + 2], 1.0, 0.25, 0.85, 1);
    }
  }

  /* ---------------------------------------------------------------------- *
   * HUD
   * ---------------------------------------------------------------------- */

  /** Refreshes the textual statistics, at 5 Hz. */
  updateHUD() {
    if (!this.uiVisible) return;

    const info = this.renderer.info;
    const stats = this.engine.stats;
    const time = this.engine.time;

    const fps = stats !== null && stats !== undefined && stats.fps > 0 ? stats.fps : time.fps;
    this.setStat('fps', fps.toFixed(0), fps >= 55 ? 'good' : (fps >= 30 ? 'warn' : 'bad'));

    const cpu = stats !== null && stats !== undefined ? stats.cpuMs : info.cpuTimeMs;
    this.setStat('cpu', cpu.toFixed(2) + ' ms', cpu < 8 ? 'good' : (cpu < 16 ? 'warn' : 'bad'));

    const gpu = info.gpuTimeMs > 0
      ? info.gpuTimeMs
      : (stats !== null && stats !== undefined ? stats.gpuMs : 0);
    this.setStat('gpu', gpu > 0 ? gpu.toFixed(2) + ' ms' : 'n/d',
      gpu === 0 ? '' : (gpu < 12 ? 'good' : (gpu < 16 ? 'warn' : 'bad')));

    this.setStat('draws', fmt(info.calls));
    this.setStat('tris', fmt(info.triangles));
    this.setStat('meshes', info.visibleMeshes + ' / ' + this.scene.meshes.length);
    this.setStat('cull', info.cullTimeMs.toFixed(2) + ' ms');
    this.setStat('instances', fmt(this.scatterDrawn) + ' / ' + fmt(this.scatterFilled));

    const manager = this.renderer.lightManager;
    const visible = manager !== null && manager !== undefined && manager.punctualLights
      ? manager.punctualLights.length
      : 0;
    this.setStat('lights', visible + ' / ' + this.activeLightCount);

    this.setStat('programs', String(info.programs));
    this.setStat('memory', (info.memoryBytes / 1048576).toFixed(1) + ' MB');
    this.setStat('bvh', String(this.scene.bvh ? this.scene.bvh.nodeCount : 0));

    const p = this.camera.position;
    this.setStat('position', p.x.toFixed(1) + ', ' + p.y.toFixed(1) + ', ' + p.z.toFixed(1));
    this.setStat('ground', this.controller.isGrounded ? 'apoiado' : 'no ar');
    this.setStat('physics', this.controller.kind === undefined ? 'n/d' : this.controller.kind);
  }

  /**
   * @param {string} key
   * @param {string} text
   * @param {string} [cls] 'good' | 'warn' | 'bad'
   */
  setStat(key, text, cls) {
    const field = this.statFields[key];
    if (field === undefined) return;
    if (field.value.textContent !== text) field.value.textContent = text;
    const wanted = 'stat' + (cls ? ' ' + cls : '') + (field.row.classList.contains('head') ? ' head' : '');
    if (field.row.className !== wanted) field.row.className = wanted;
  }
}

/* ========================================================================== *
 * Skinned geometry builder
 *
 * Generates capsule / sphere solids directly in bind pose space and welds every
 * vertex to one or two bones. Keeping the bind pose rotation free means the
 * animation can rotate bones around plain world axes.
 * ========================================================================== */

export class SkinBuilder {
  constructor() {
    /** @type {number[]} */
    this.positions = [];
    /** @type {number[]} */
    this.normals = [];
    /** @type {number[]} */
    this.uvs = [];
    /** @type {number[]} */
    this.joints = [];
    /** @type {number[]} */
    this.weights = [];
    /** @type {number[]} */
    this.indices = [];
    /** @private Reused `[jointA, jointB, weightA, weightB]` tuple. */
    this._weightScratch = [0, 0, 1, 0];
    /** @private Rigid attachment tuple. */
    this._rigidScratch = [0, 0, 1, 0];
  }

  /**
   * Appends a capsule spanning a bone joint and its child joint. The solid is
   * driven by `bone`; only the end sitting on the child joint blends into
   * `childBone`, so the joint bends smoothly.
   * @param {number} ax @param {number} ay @param {number} az Bone joint.
   * @param {number} bx @param {number} by @param {number} bz Child joint.
   * @param {number} radius
   * @param {number} bone Bone index owning the limb.
   * @param {number} childBone Bone index of the far joint.
   * @param {number} capSegments
   * @param {number} radialSegments
   */
  addSegment(ax, ay, az, bx, by, bz, radius, bone, childBone, capSegments, radialSegments) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-4) return;

    const cylinder = Math.max(length - radius * 1.1, 0.02);
    const geometry = createCapsule(radius, cylinder, capSegments, radialSegments);

    _v3a.set(dx / length, dy / length, dz / length);
    buildBasis(_v3a, _mat);
    _mat.setPosition((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);

    const out = this._weightScratch;
    const invLength = 1 / length;
    this.append(geometry, _mat, (localY) => {
      // localY runs from -half..+half along the bone; convert to 0..1 from A to B.
      const t = clamp(localY * invLength + 0.5, 0, 1);
      const blend = smoothstep(0.55, 1.0, t) * 0.5;
      out[0] = bone;
      out[1] = childBone;
      out[2] = 1 - blend;
      out[3] = blend;
      return out;
    });
  }

  /**
   * Appends a sphere rigidly attached to one bone.
   * @param {number} x @param {number} y @param {number} z
   * @param {number} radius
   * @param {number} bone
   * @param {number} [subdivisions=2]
   */
  addBall(x, y, z, radius, bone, subdivisions = 2) {
    const geometry = createIcosphere(radius, subdivisions);
    _mat.identity();
    _mat.setPosition(x, y, z);
    const out = this._rigidScratch;
    out[0] = bone;
    out[1] = bone;
    out[2] = 1;
    out[3] = 0;
    this.append(geometry, _mat, () => out);
  }

  /**
   * Appends a foot box pointing forward (-Z), attached to one bone.
   * @param {number} x @param {number} y @param {number} z
   * @param {number} bone
   * @param {number} height
   */
  addFoot(x, y, z, bone, height) {
    const geometry = createBox(0.13, height, 0.28, 1, 1, 1);
    _mat.identity();
    _mat.setPosition(x, y + height * 0.5, z - 0.06);
    const out = this._rigidScratch;
    out[0] = bone;
    out[1] = bone;
    out[2] = 1;
    out[3] = 0;
    this.append(geometry, _mat, () => out);
  }

  /**
   * Transforms a primitive into bind space and appends it with skin weights.
   * @param {Geometry} geometry
   * @param {Mat4} matrix
   * @param {function(number, number, number): number[]} weightFn
   *   Receives the local y (and x, z) of the vertex and returns
   *   `[jointA, jointB, weightA, weightB]`.
   */
  append(geometry, matrix, weightFn) {
    const position = geometry.getAttribute('aPosition');
    const normal = geometry.getAttribute('aNormal');
    const uv = geometry.getAttribute('aUV0');
    const index = geometry.index;
    if (position === null || position === undefined) return;

    const base = this.positions.length / 3;
    const count = position.count;
    const src = position.data;
    const nrm = normal ? normal.data : null;
    const tex = uv ? uv.data : null;

    for (let i = 0; i < count; i++) {
      const lx = src[i * 3];
      const ly = src[i * 3 + 1];
      const lz = src[i * 3 + 2];

      _v3b.set(lx, ly, lz).applyMat4(matrix);
      this.positions.push(_v3b.x, _v3b.y, _v3b.z);

      if (nrm !== null) {
        _v3c.set(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]).transformDirection(matrix);
        this.normals.push(_v3c.x, _v3c.y, _v3c.z);
      } else {
        this.normals.push(0, 1, 0);
      }

      if (tex !== null) this.uvs.push(tex[i * 2], tex[i * 2 + 1]);
      else this.uvs.push(0, 0);

      const w = weightFn(ly, lx, lz);
      this.joints.push(w[0], w[1], 0, 0);
      this.weights.push(w[2], w[3], 0, 0);
    }

    if (index !== null && index !== undefined) {
      const data = index.data;
      for (let i = 0, n = data.length; i < n; i++) this.indices.push(base + data[i]);
    } else {
      for (let i = 0; i < count; i++) this.indices.push(base + i);
    }
  }

  /**
   * Packs everything into a Geometry ready for GPU skinning.
   * @returns {Geometry}
   */
  build() {
    const geometry = new Geometry();
    geometry.setAttribute('aPosition', new Float32Array(this.positions), 3);
    geometry.setAttribute('aNormal', new Float32Array(this.normals), 3);
    geometry.setAttribute('aUV0', new Float32Array(this.uvs), 2);
    geometry.setAttribute('aJoints', new Float32Array(this.joints), 4);
    geometry.setAttribute('aWeights', new Float32Array(this.weights), 4);
    const vertexCount = this.positions.length / 3;
    geometry.setIndex(vertexCount > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices));
    geometry.drawMode = 'triangles';
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * Builds an orthonormal basis whose +Y axis is `dir`, written into `out`.
 * @param {Vec3} dir Unit direction.
 * @param {Mat4} out
 * @returns {Mat4} out
 */
function buildBasis(dir, out) {
  const refX = Math.abs(dir.y) > 0.99 ? 1 : 0;
  const refY = Math.abs(dir.y) > 0.99 ? 0 : 1;
  const rx = refX;
  const ry = refY;
  const rz = 0;

  // x = normalize(ref x y)
  let xx = ry * dir.z - rz * dir.y;
  let xy = rz * dir.x - rx * dir.z;
  let xz = rx * dir.y - ry * dir.x;
  let len = Math.hypot(xx, xy, xz);
  if (len < 1e-5) {
    xx = 1; xy = 0; xz = 0;
    len = 1;
  }
  xx /= len; xy /= len; xz /= len;

  // z = x x y
  const zx = xy * dir.z - xz * dir.y;
  const zy = xz * dir.x - xx * dir.z;
  const zz = xx * dir.y - xy * dir.x;

  const e = out.elements;
  e[0] = xx; e[1] = xy; e[2] = xz; e[3] = 0;
  e[4] = dir.x; e[5] = dir.y; e[6] = dir.z; e[7] = 0;
  e[8] = zx; e[9] = zy; e[10] = zz; e[11] = 0;
  e[12] = 0; e[13] = 0; e[14] = 0; e[15] = 1;
  return out;
}

/* ========================================================================== *
 * Walk cycle
 * ========================================================================== */

/**
 * Encodes a list of X axis rotations (degrees) as a quaternion track.
 * @param {string} path Binding path, e.g. `'BoneLegL.quaternion'`.
 * @param {Float32Array} times
 * @param {number[]} anglesX Rotation about X, degrees, one per keyframe.
 * @param {number[]} [anglesY] Optional rotation about Y, degrees.
 * @param {number[]} [anglesZ] Optional rotation about Z, degrees.
 * @returns {KeyframeTrack}
 */
function rotationTrack(path, times, anglesX, anglesY, anglesZ) {
  const frames = times.length;
  const values = new Float32Array(frames * 4);
  const q = new Quat();
  const tmp = new Quat();
  const axisX = new Vec3(1, 0, 0);
  const axisY = new Vec3(0, 1, 0);
  const axisZ = new Vec3(0, 0, 1);

  for (let i = 0; i < frames; i++) {
    q.setFromAxisAngle(axisX, (anglesX ? anglesX[i] : 0) * DEG2RAD);
    if (anglesY) {
      tmp.setFromAxisAngle(axisY, anglesY[i] * DEG2RAD);
      q.premultiply(tmp);
    }
    if (anglesZ) {
      tmp.setFromAxisAngle(axisZ, anglesZ[i] * DEG2RAD);
      q.premultiply(tmp);
    }
    q.normalize();
    q.toArray(values, i * 4);
  }
  return new KeyframeTrack(path, times, values, 4, 'linear');
}

/**
 * Hand authored one second walk cycle.
 * @returns {AnimationClip}
 */
export function buildWalkClip() {
  const times = new Float32Array([0, 0.25, 0.5, 0.75, 1.0]);
  const tracks = [];

  // Legs: left leads, right follows half a cycle later.
  tracks.push(rotationTrack('BoneLegL.quaternion', times, [30, 4, -28, -6, 30]));
  tracks.push(rotationTrack('BoneLegR.quaternion', times, [-28, -6, 30, 4, -28]));
  tracks.push(rotationTrack('BoneShinL.quaternion', times, [-6, -46, -10, -20, -6]));
  tracks.push(rotationTrack('BoneShinR.quaternion', times, [-10, -20, -6, -46, -10]));
  tracks.push(rotationTrack('BoneFootL.quaternion', times, [10, 16, 6, -6, 10]));
  tracks.push(rotationTrack('BoneFootR.quaternion', times, [6, -6, 10, 16, 6]));

  // Arms swing opposite to the legs.
  tracks.push(rotationTrack('BoneArmL.quaternion', times, [-26, -3, 26, 3, -26], null, [7, 7, 7, 7, 7]));
  tracks.push(rotationTrack('BoneArmR.quaternion', times, [26, 3, -26, -3, 26], null, [-7, -7, -7, -7, -7]));
  tracks.push(rotationTrack('BoneForeArmL.quaternion', times, [-18, -12, -26, -12, -18]));
  tracks.push(rotationTrack('BoneForeArmR.quaternion', times, [-26, -12, -18, -12, -26]));

  // Torso counter rotation and head stabilisation.
  tracks.push(rotationTrack('BoneSpine.quaternion', times, [2, 0, 2, 0, 2], [7, 0, -7, 0, 7]));
  tracks.push(rotationTrack('BoneChest.quaternion', times, [-1, 0, -1, 0, -1], [-9, 0, 9, 0, -9]));
  tracks.push(rotationTrack('BoneHead.quaternion', times, [3, 1, 3, 1, 3], [4, 0, -4, 0, 4]));

  // Hip bob: a plain vec3 position track, sampled with linear interpolation.
  const bobTimes = new Float32Array([0, 0.25, 0.5, 0.75, 1.0]);
  const bobValues = new Float32Array([
    0, 1.02, 0,
    0, 1.06, 0,
    0, 1.02, 0,
    0, 1.06, 0,
    0, 1.02, 0
  ]);
  tracks.push(new KeyframeTrack('BoneHips.position', bobTimes, bobValues, 3, 'linear'));
  tracks.push(rotationTrack('BoneHips.quaternion', times, [-3, -3, -3, -3, -3], [-4, 0, 4, 0, -4]));

  return new AnimationClip('Walk', 1.0, tracks);
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

export const demo = new Demo();
demo.boot().catch(() => { /* the error screen already reported it */ });

// Handy for poking at the scene from the devtools console.
globalThis.aicodersDemo = demo;
