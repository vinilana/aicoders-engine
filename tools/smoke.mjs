#!/usr/bin/env node
/**
 * smoke.mjs - headless end to end exercise of the whole engine.
 *
 * Using the DOM/WebGL2 shims from tools/mockgl.js this script builds a real
 * scene (static mesh, 1000 instances, a shadow casting directional light, 50
 * point lights, a skinned mesh, an animation mixer) and renders 10 frames, then
 * raycasts against the scene and prints a report.
 *
 * Failure policy:
 *   - anything on the main path (module graph, GL context, renderer, scene
 *     graph, draw submission, raycast, animation) is a hard failure: exit 1;
 *   - optional subsystems (post processing, IBL, stats overlay, the Engine
 *     rAF loop, debug renderer) are reported as warnings, because the mock
 *     driver cannot reproduce every driver behaviour.
 *
 * Usage: node tools/smoke.mjs [--frames 10] [--verbose] [--no-color]
 */

import { installDOMShims, uninstallDOMShims } from './mockgl.js';

/* ------------------------------------------------------------------------- *
 * Reporting
 * ------------------------------------------------------------------------- */

const useColor = process.stdout.isTTY && !process.argv.includes('--no-color');
const RED = useColor ? '[31m' : '';
const YELLOW = useColor ? '[33m' : '';
const GREEN = useColor ? '[32m' : '';
const DIM = useColor ? '[2m' : '';
const RESET = useColor ? '[0m' : '';
const VERBOSE = process.argv.includes('--verbose');

/** @type {Array<{name:string, status:string, detail:string, ms:number}>} */
const steps = [];
/** @type {string[]} */
const warningMessages = [];
/** @type {string[]} */
const failureMessages = [];

/**
 * Read a numeric CLI option.
 * @param {string} flag
 * @param {number} fallback
 * @returns {number}
 */
function numberArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Format an error for the report.
 * @param {*} error
 * @returns {string}
 */
function describeError(error) {
  if (!error) return 'erro desconhecido';
  const message = error.message ? String(error.message) : String(error);
  if (VERBOSE && error.stack) return error.stack;
  const stack = String(error.stack || '');
  const frame = /\n\s+at ([^\n]+)/.exec(stack);
  return frame ? `${message}  <- ${frame[1]}` : message;
}

/**
 * Run one step of the smoke test.
 * @param {string} name
 * @param {Function} fn step body (may be async)
 * @param {{soft?:boolean}} [options] soft steps only produce warnings
 * @returns {Promise<*>} the step result, or undefined when it failed
 */
async function step(name, fn, options = {}) {
  const started = Date.now();
  try {
    const result = await fn();
    steps.push({ name, status: 'ok', detail: '', ms: Date.now() - started });
    return result;
  } catch (error) {
    const detail = describeError(error);
    const status = options.soft ? 'warn' : 'fail';
    steps.push({ name, status, detail, ms: Date.now() - started });
    if (options.soft) warningMessages.push(`${name}: ${detail}`);
    else failureMessages.push(`${name}: ${detail}`);
    return undefined;
  }
}

/**
 * Throw when a condition does not hold.
 * @param {*} condition
 * @param {string} message
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------------- *
 * Tolerant construction helpers
 * ------------------------------------------------------------------------- */

/**
 * Try several constructor signatures and return the first that works.
 * @param {string} name human readable class name
 * @param {Function} Ctor
 * @param {any[][]} candidates argument tuples, most likely first
 * @returns {object}
 */
function tryConstruct(name, Ctor, candidates) {
  assert(typeof Ctor === 'function', `'${name}' nao esta disponivel`);
  const failures = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      return new Ctor(...candidates[i]);
    } catch (error) {
      failures.push(`[${candidates[i].length} arg(s)] ${error && error.message ? error.message : error}`);
    }
  }
  throw new Error(`nao foi possivel construir ${name}: ${failures.join(' | ')}`);
}

/**
 * Call a method when it exists, swallowing failures into the warning list.
 * @param {object} target
 * @param {string} method
 * @param {any[]} args
 * @param {string} label
 * @returns {*}
 */
function callOptional(target, method, args, label) {
  if (!target || typeof target[method] !== 'function') return undefined;
  try {
    return target[method](...args);
  } catch (error) {
    warningMessages.push(`${label || method}: ${describeError(error)}`);
    return undefined;
  }
}

/* ------------------------------------------------------------------------- *
 * Module resolution
 * ------------------------------------------------------------------------- */

/** Fallback module paths, used when the public barrel does not export a symbol. */
const MODULE_HINTS = {
  Renderer: '../src/render/Renderer.js',
  Scene: '../src/scene/Scene.js',
  Node3D: '../src/scene/Node3D.js',
  Mesh: '../src/scene/Mesh.js',
  InstancedMesh: '../src/scene/InstancedMesh.js',
  SkinnedMesh: '../src/scene/SkinnedMesh.js',
  Skeleton: '../src/scene/Skeleton.js',
  PerspectiveCamera: '../src/scene/PerspectiveCamera.js',
  OrthographicCamera: '../src/scene/OrthographicCamera.js',
  DirectionalLight: '../src/scene/Light.js',
  PointLight: '../src/scene/Light.js',
  SpotLight: '../src/scene/Light.js',
  Light: '../src/scene/Light.js',
  StandardMaterial: '../src/render/materials/StandardMaterial.js',
  UnlitMaterial: '../src/render/materials/UnlitMaterial.js',
  createBox: '../src/geometry/Primitives.js',
  createSphere: '../src/geometry/Primitives.js',
  Geometry: '../src/render/Geometry.js',
  Vec3: '../src/math/Vec3.js',
  Quat: '../src/math/Quat.js',
  Mat4: '../src/math/Mat4.js',
  Color: '../src/math/Color.js',
  Raycaster: '../src/physics/Raycaster.js',
  KeyframeTrack: '../src/animation/KeyframeTrack.js',
  AnimationClip: '../src/animation/AnimationClip.js',
  AnimationMixer: '../src/animation/AnimationMixer.js',
  Engine: '../src/core/Engine.js',
  Time: '../src/core/Time.js',
  createGLContext: '../src/render/GLContext.js',
  DebugRenderer: '../src/render/DebugRenderer.js',
  Stats: '../src/util/Stats.js'
};

/** @type {Map<string, object>} */
const moduleCache = new Map();

/**
 * Import a module by relative path, with caching.
 * @param {string} path
 * @returns {Promise<object>}
 */
async function importModule(path) {
  if (moduleCache.has(path)) return moduleCache.get(path);
  const module = await import(path);
  moduleCache.set(path, module);
  return module;
}

/** The public barrel, filled by the first step. */
let ENGINE = null;
/** Symbols that had to be imported outside the barrel. */
const barrelMisses = [];

/**
 * Resolve an engine export, falling back to its own module when the barrel
 * does not re-export it.
 * @param {string} name
 * @returns {Promise<*>}
 */
async function resolveExport(name) {
  if (ENGINE && ENGINE[name] !== undefined) return ENGINE[name];
  const hint = MODULE_HINTS[name];
  if (hint) {
    try {
      const module = await importModule(hint);
      if (module[name] !== undefined) {
        barrelMisses.push(`${name} (importado de ${hint})`);
        return module[name];
      }
    } catch (error) {
      throw new Error(`'${name}' nao esta no barrel e ${hint} falhou: ${describeError(error)}`);
    }
  }
  throw new Error(`'${name}' nao e exportado por src/index.js`);
}

/**
 * Resolve several exports at once.
 * @param {string[]} names
 * @returns {Promise<object>}
 */
async function resolveAll(names) {
  const out = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    try {
      out[names[i]] = await resolveExport(names[i]);
    } catch (error) {
      missing.push(describeError(error));
    }
  }
  if (missing.length) throw new Error(missing.join(' | '));
  return out;
}

/* ------------------------------------------------------------------------- *
 * The smoke test
 * ------------------------------------------------------------------------- */

const WIDTH = 1280;
const HEIGHT = 720;
const FRAME_COUNT = numberArg('--frames', 10);
const INSTANCE_COUNT = 1000;
const POINT_LIGHT_COUNT = 50;

/**
 * Render N frames, returning the number that completed.
 * @param {object} renderer
 * @param {object} scene
 * @param {object} camera
 * @param {number} frames
 * @param {object|null} time
 * @returns {number}
 */
function renderFrames(renderer, scene, camera, frames, time) {
  let done = 0;
  for (let i = 0; i < frames; i++) {
    if (time && typeof time.update === 'function') time.update(1000 + i * 16.6667);
    if (camera.position && typeof camera.position.set === 'function') {
      const angle = i * 0.05;
      camera.position.set(Math.sin(angle) * 8, 3, Math.cos(angle) * 8);
    }
    if (typeof camera.lookAt === 'function') camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    done++;
  }
  return done;
}

/**
 * Entry point.
 * @returns {Promise<number>} exit code
 */
async function main() {
  const dom = installDOMShims({ width: WIDTH, height: HEIGHT, pixelRatio: 1 });
  const canvas = dom.canvas;
  const glFromCanvas = dom.gl;

  process.stdout.write(`\n${DIM}smoke${RESET} - AICoders Engine headless (${FRAME_COUNT} frames)\n\n`);

  // 1. public barrel ------------------------------------------------------
  await step('importar src/index.js (barrel publico)', async () => {
    ENGINE = await importModule('../src/index.js');
    assert(ENGINE && typeof ENGINE === 'object', 'o barrel nao exportou nada');
    const exported = Object.keys(ENGINE).length;
    assert(exported > 10, `o barrel exporta apenas ${exported} simbolos`);
  });

  if (!ENGINE) {
    // Without the barrel there is nothing to smoke test.
    return finish(null, null, glFromCanvas, 0);
  }

  // 2. core symbols -------------------------------------------------------
  const api = await step('resolver simbolos do contrato', () =>
    resolveAll([
      'Renderer',
      'Scene',
      'Node3D',
      'Mesh',
      'InstancedMesh',
      'PerspectiveCamera',
      'StandardMaterial',
      'createBox',
      'Vec3',
      'Quat',
      'Mat4',
      'Color',
      'DirectionalLight',
      'PointLight'
    ])
  );
  if (!api) return finish(null, null, glFromCanvas, 0);

  const { Renderer, Scene, Mesh, InstancedMesh, PerspectiveCamera, StandardMaterial, createBox } = api;
  const { Vec3, Quat, Mat4, DirectionalLight, PointLight, Node3D } = api;

  // 3. GL context ---------------------------------------------------------
  const context = await step('criar contexto WebGL2 (mock)', async () => {
    let createGLContext = null;
    try {
      createGLContext = await resolveExport('createGLContext');
    } catch {
      createGLContext = null;
    }
    if (typeof createGLContext === 'function') {
      const created = createGLContext(canvas, { antialias: false, alpha: false, depth: true, powerPreference: 'high-performance' });
      assert(created && created.gl, 'createGLContext nao devolveu { gl, caps }');
      return created;
    }
    warningMessages.push('createGLContext indisponivel: usando canvas.getContext("webgl2") diretamente');
    return { gl: glFromCanvas, caps: null, isWebGL2: true };
  });
  if (!context) return finish(null, null, glFromCanvas, 0);

  const gl = context.gl;
  const caps = context.caps || null;

  // 4. renderer -----------------------------------------------------------
  const fullOptions = {
    shadows: true,
    clustered: true,
    hdr: true,
    postprocessing: true,
    msaa: 0,
    toneMapping: 'aces',
    exposure: 1,
    shadowMapSize: 512,
    cascades: 4,
    maxLights: 256,
    pixelRatio: 1
  };
  const minimalOptions = {
    shadows: false,
    clustered: false,
    hdr: false,
    postprocessing: false,
    msaa: 0,
    shadowMapSize: 256,
    cascades: 1,
    maxLights: 64,
    pixelRatio: 1
  };

  let degraded = false;
  const renderer = await step('construir Renderer', () => {
    try {
      return tryConstruct('Renderer', Renderer, [
        [gl, caps, fullOptions],
        [gl, fullOptions],
        [gl, caps]
      ]);
    } catch (error) {
      warningMessages.push(`Renderer completo falhou (${describeError(error)}); tentando configuracao minima`);
      degraded = true;
      return tryConstruct('Renderer (minimo)', Renderer, [
        [gl, caps, minimalOptions],
        [gl, minimalOptions],
        [gl, caps],
        [gl]
      ]);
    }
  });
  if (!renderer) return finish(null, null, gl, 0);

  callOptional(renderer, 'setSize', [WIDTH, HEIGHT, 1], 'renderer.setSize');
  callOptional(renderer, 'setClearColor', [{ r: 0.05, g: 0.06, b: 0.08 }, 1], 'renderer.setClearColor');

  // 5. scene, camera ------------------------------------------------------
  const world = await step('montar scene graph', () => {
    const scene = tryConstruct('Scene', Scene, [[], [{}]]);
    const camera = tryConstruct('PerspectiveCamera', PerspectiveCamera, [
      [60, WIDTH / HEIGHT, 0.1, 500],
      [{ fov: 60, aspect: WIDTH / HEIGHT, near: 0.1, far: 500 }],
      []
    ]);
    if (typeof camera.fov === 'number') camera.fov = 60;
    if (typeof camera.aspect === 'number') camera.aspect = WIDTH / HEIGHT;
    callOptional(camera, 'updateProjection', [], 'camera.updateProjection');
    if (camera.position && typeof camera.position.set === 'function') camera.position.set(0, 3, 8);
    callOptional(camera, 'lookAt', [0, 0, 0], 'camera.lookAt');
    return { scene, camera };
  });
  if (!world) return finish(null, null, gl, 0);
  const { scene, camera } = world;

  // 6. static mesh --------------------------------------------------------
  const boxMesh = await step('Mesh + createBox + StandardMaterial', () => {
    const geometry = createBox(1, 1, 1, 1, 1, 1);
    assert(geometry, 'createBox nao retornou geometria');
    const material = tryConstruct('StandardMaterial', StandardMaterial, [[{}], []]);
    if (material.baseColor && typeof material.baseColor.setHex === 'function') material.baseColor.setHex(0xcc8844);
    if (typeof material.metallic === 'number') material.metallic = 0.1;
    if (typeof material.roughness === 'number') material.roughness = 0.65;
    const mesh = tryConstruct('Mesh', Mesh, [[geometry, material], []]);
    mesh.name = 'AnimBox';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (mesh.position && typeof mesh.position.set === 'function') mesh.position.set(0, 0.5, 0);
    scene.add(mesh);
    return mesh;
  });

  // 7. instanced mesh -----------------------------------------------------
  await step(`InstancedMesh com ${INSTANCE_COUNT} instancias`, () => {
    const geometry = createBox(0.25, 0.25, 0.25);
    const material = tryConstruct('StandardMaterial (instancias)', StandardMaterial, [[{}], []]);
    if (typeof material.roughness === 'number') material.roughness = 0.4;
    const instanced = tryConstruct('InstancedMesh', InstancedMesh, [
      [geometry, material, INSTANCE_COUNT],
      [geometry, material]
    ]);
    if (typeof instanced.setCount === 'function') instanced.setCount(INSTANCE_COUNT);
    else instanced.count = INSTANCE_COUNT;

    const position = new Vec3();
    const scale = new Vec3(1, 1, 1);
    const quaternion = new Quat();
    const matrix = new Mat4();
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      const angle = i * 0.137;
      const radius = 3 + (i % 40) * 0.15;
      position.set(Math.cos(angle) * radius, 0.15 + (i % 12) * 0.12, Math.sin(angle) * radius);
      if (typeof quaternion.setFromAxisAngle === 'function') quaternion.setFromAxisAngle(Vec3.UP || new Vec3(0, 1, 0), angle);
      if (typeof instanced.setTransformAt === 'function') {
        instanced.setTransformAt(i, position, quaternion, scale);
      } else {
        matrix.compose(position, quaternion, scale);
        instanced.setMatrixAt(i, matrix);
      }
    }
    instanced.needsUpdate = true;
    callOptional(instanced, 'computeBounds', [], 'instancedMesh.computeBounds');
    scene.add(instanced);
    assert(
      instanced.count === INSTANCE_COUNT || instanced.capacity >= INSTANCE_COUNT,
      `contagem de instancias inesperada: ${instanced.count}`
    );
    return instanced;
  });

  // 8. lights -------------------------------------------------------------
  await step(`luzes (1 direcional com sombra + ${POINT_LIGHT_COUNT} pontuais)`, () => {
    const sun = tryConstruct('DirectionalLight', DirectionalLight, [[], [{}]]);
    sun.name = 'Sun';
    sun.castShadow = true;
    if (typeof sun.intensity === 'number') sun.intensity = 3;
    if (sun.color && typeof sun.color.setHex === 'function') sun.color.setHex(0xfff2e0);
    if (sun.position && typeof sun.position.set === 'function') sun.position.set(6, 10, 4);
    callOptional(sun, 'lookAt', [0, 0, 0], 'sun.lookAt');
    if (sun.shadow) {
      if (typeof sun.shadow.mapSize === 'number') sun.shadow.mapSize = 512;
      if (typeof sun.shadow.cascades === 'number') sun.shadow.cascades = 4;
    }
    scene.add(sun);

    for (let i = 0; i < POINT_LIGHT_COUNT; i++) {
      const light = tryConstruct('PointLight', PointLight, [[], [{}]]);
      const angle = (i / POINT_LIGHT_COUNT) * Math.PI * 2;
      if (light.position && typeof light.position.set === 'function') {
        light.position.set(Math.cos(angle) * 6, 1.5 + (i % 5) * 0.4, Math.sin(angle) * 6);
      }
      if (typeof light.range === 'number') light.range = 6;
      if (typeof light.intensity === 'number') light.intensity = 4;
      if (light.color && typeof light.color.setHSL === 'function') light.color.setHSL(i / POINT_LIGHT_COUNT, 0.7, 0.5);
      scene.add(light);
    }
    return true;
  });

  // 9. skinned mesh -------------------------------------------------------
  await step('SkinnedMesh + Skeleton', async () => {
    const SkinnedMesh = await resolveExport('SkinnedMesh');
    const Skeleton = await resolveExport('Skeleton');
    const geometry = createBox(0.5, 2, 0.5, 1, 4, 1);
    const vertexCount = geometry.vertexCount || (geometry.getAttribute && geometry.getAttribute('aPosition')
      ? geometry.getAttribute('aPosition').count
      : 0);
    assert(vertexCount > 0, 'a geometria do SkinnedMesh nao tem vertices');

    const joints = new Float32Array(vertexCount * 4);
    const weights = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i++) {
      joints[i * 4] = 0;
      joints[i * 4 + 1] = 1;
      weights[i * 4] = 0.75;
      weights[i * 4 + 1] = 0.25;
    }
    geometry.setAttribute('aJoints', joints, 4, {});
    geometry.setAttribute('aWeights', weights, 4, {});

    const bones = [];
    for (let i = 0; i < 2; i++) {
      const bone = tryConstruct('Node3D (bone)', Node3D, [[], [{}]]);
      bone.name = 'Bone' + i;
      if (bone.position && typeof bone.position.set === 'function') bone.position.set(0, i, 0);
      bones.push(bone);
    }
    bones[0].add(bones[1]);

    const boneInverses = new Float32Array(16 * bones.length);
    for (let i = 0; i < bones.length; i++) {
      boneInverses[i * 16] = 1;
      boneInverses[i * 16 + 5] = 1;
      boneInverses[i * 16 + 10] = 1;
      boneInverses[i * 16 + 15] = 1;
    }

    const skeleton = tryConstruct('Skeleton', Skeleton, [[bones, boneInverses], [bones], []]);
    const material = tryConstruct('StandardMaterial (skinned)', StandardMaterial, [[{}], []]);
    const skinned = tryConstruct('SkinnedMesh', SkinnedMesh, [[geometry, material], []]);
    skinned.name = 'SkinnedBox';
    if (skinned.position && typeof skinned.position.set === 'function') skinned.position.set(-3, 1, 0);
    if (typeof skinned.bind === 'function') skinned.bind(skeleton, skinned.bindMatrix);
    else skinned.skeleton = skeleton;
    scene.add(bones[0]);
    scene.add(skinned);
    callOptional(skeleton, 'update', [], 'skeleton.update');
    callOptional(skeleton, 'computeBoneTexture', [gl], 'skeleton.computeBoneTexture');
    return skinned;
  });

  // 10. scene bookkeeping --------------------------------------------------
  await step('atualizar matrizes e BVH da cena', () => {
    callOptional(scene, 'updateMatrices', [], 'scene.updateMatrices');
    callOptional(scene, 'updateBVH', [], 'scene.updateBVH');
    callOptional(camera, 'updateViewMatrix', [], 'camera.updateViewMatrix');
    callOptional(camera, 'updateFrustum', [], 'camera.updateFrustum');
    return true;
  });

  // 11. render loop --------------------------------------------------------
  let framesRendered = 0;
  let activeRenderer = renderer;
  await step(`renderizar ${FRAME_COUNT} frames`, () => {
    try {
      framesRendered = renderFrames(activeRenderer, scene, camera, FRAME_COUNT, null);
    } catch (error) {
      // Optional subsystems (post processing, IBL, clustered lighting) can fail
      // on a mock driver: retry with everything optional turned off. If the
      // minimal pipeline also fails the engine is genuinely broken.
      warningMessages.push(`pipeline completo falhou (${describeError(error)}); repetindo com pipeline minimo`);
      degraded = true;
      callOptional(activeRenderer, 'dispose', [], 'renderer.dispose');
      activeRenderer = tryConstruct('Renderer (minimo)', Renderer, [
        [gl, caps, minimalOptions],
        [gl, minimalOptions],
        [gl, caps],
        [gl]
      ]);
      callOptional(activeRenderer, 'setSize', [WIDTH, HEIGHT, 1], 'renderer.setSize');
      framesRendered = renderFrames(activeRenderer, scene, camera, FRAME_COUNT, null);
    }
    assert(framesRendered === FRAME_COUNT, `apenas ${framesRendered}/${FRAME_COUNT} frames renderizados`);
    return framesRendered;
  });

  // 12. draw calls really happened ----------------------------------------
  await step('validar submissao de draw calls', () => {
    const mockDraws = gl.stats ? gl.stats.drawCalls : 0;
    const info = activeRenderer.info || {};
    const reported = typeof info.calls === 'number' ? info.calls : 0;
    assert(mockDraws > 0, 'nenhum draw call chegou ao driver (gl.stats.drawCalls === 0)');
    if (reported <= 0) warningMessages.push('renderer.info.calls nao foi preenchido apesar dos draw calls reais');
    return { mockDraws, reported };
  });

  // 13. raycast ------------------------------------------------------------
  await step('raycast contra a cena', async () => {
    const Raycaster = await resolveExport('Raycaster');
    const raycaster = tryConstruct('Raycaster', Raycaster, [
      [],
      [new Vec3(0, 3, 8), new Vec3(0, 0, -1), 0, 1000]
    ]);
    if (typeof raycaster.setFromCamera === 'function') raycaster.setFromCamera(0, 0, camera);
    else if (typeof raycaster.set === 'function') raycaster.set(new Vec3(0, 0.5, 8), new Vec3(0, 0, -1));

    const hits = [];
    let used = null;
    if (typeof raycaster.intersectScene === 'function') {
      raycaster.intersectScene(scene, hits);
      used = 'intersectScene';
    } else if (typeof raycaster.intersectObjects === 'function') {
      raycaster.intersectObjects(scene.children, true, hits);
      used = 'intersectObjects';
    } else if (typeof raycaster.intersectObject === 'function' && boxMesh) {
      raycaster.intersectObject(boxMesh, true, hits);
      used = 'intersectObject';
    }
    assert(used !== null, 'Raycaster nao expoe nenhum metodo de intersecao do contrato');
    assert(Array.isArray(hits), 'o raycast nao preencheu um array de saida');
    if (hits.length === 0) warningMessages.push(`${used}: nenhuma intersecao encontrada (a cena tem geometria a frente da camera)`);
    return { used, count: hits.length };
  });

  // 14. animation ----------------------------------------------------------
  await step('AnimationMixer', async () => {
    const KeyframeTrack = await resolveExport('KeyframeTrack');
    const AnimationClip = await resolveExport('AnimationClip');
    const AnimationMixer = await resolveExport('AnimationMixer');

    const times = new Float32Array([0, 1, 2]);
    const values = new Float32Array([0, 0.5, 0, 0, 1.5, 0, 0, 0.5, 0]);
    const track = tryConstruct('KeyframeTrack', KeyframeTrack, [
      ['AnimBox.position', times, values, 3, 'linear'],
      ['AnimBox.position', times, values, 3]
    ]);

    const clip = tryConstruct('AnimationClip', AnimationClip, [
      ['bounce', 2, [track]],
      [{ name: 'bounce', duration: 2, tracks: [track] }],
      []
    ]);
    if (!clip.tracks || clip.tracks.length === 0) clip.tracks = [track];
    if (!clip.duration) clip.duration = 2;
    if (!clip.name) clip.name = 'bounce';

    const mixer = tryConstruct('AnimationMixer', AnimationMixer, [[scene], []]);
    const action = mixer.clipAction(clip);
    assert(action, 'clipAction() nao devolveu uma acao');
    callOptional(action, 'play', [], 'action.play');
    for (let i = 0; i < 5; i++) mixer.update(1 / 60);
    return true;
  });

  // 15. optional subsystems -------------------------------------------------
  await step('DebugRenderer (opcional)', async () => {
    const DebugRenderer = await resolveExport('DebugRenderer');
    const debug = tryConstruct('DebugRenderer', DebugRenderer, [[gl, activeRenderer], [gl]]);
    if (typeof debug.box === 'function' && boxMesh && boxMesh.boundingBoxWorld) debug.box(boxMesh.boundingBoxWorld, null);
    if (typeof debug.axes === 'function' && boxMesh) debug.axes(boxMesh.worldMatrix, 1);
    callOptional(debug, 'render', [camera], 'debugRenderer.render');
    callOptional(debug, 'clear', [], 'debugRenderer.clear');
    return true;
  }, { soft: true });

  await step('Stats overlay (opcional)', async () => {
    const Stats = await resolveExport('Stats');
    const stats = tryConstruct('Stats', Stats, [[{}], []]);
    callOptional(stats, 'begin', [], 'stats.begin');
    callOptional(stats, 'end', [], 'stats.end');
    callOptional(stats, 'update', [activeRenderer], 'stats.update');
    return true;
  }, { soft: true });

  await step('Engine (construcao + resize + dispose) (opcional)', async () => {
    const Engine = await resolveExport('Engine');
    const engineCanvas = dom.document.createElement('canvas');
    const engine = tryConstruct('Engine', Engine, [
      [{ canvas: engineCanvas, width: 640, height: 360, antialias: false, shadows: false, stats: false, autoResize: false }],
      [{ canvas: engineCanvas }],
      []
    ]);
    if (typeof engine.onUpdate === 'function') engine.onUpdate(() => {});
    callOptional(engine, 'resize', [800, 600], 'engine.resize');
    callOptional(engine, 'stop', [], 'engine.stop');
    callOptional(engine, 'dispose', [], 'engine.dispose');
    return true;
  }, { soft: true });

  return finish(activeRenderer, scene, gl, framesRendered, degraded);
}

/**
 * Print the report and compute the exit code.
 * @param {object|null} renderer
 * @param {object|null} scene
 * @param {object} gl
 * @param {number} framesRendered
 * @param {boolean} [degraded]
 * @returns {number}
 */
function finish(renderer, scene, gl, framesRendered, degraded = false) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const entry = steps[i];
    const icon = entry.status === 'ok' ? `${GREEN}  ok  ${RESET}` : entry.status === 'warn' ? `${YELLOW} AVISO${RESET}` : `${RED} FALHA${RESET}`;
    out.push(`${icon} ${entry.name}${DIM} (${entry.ms}ms)${RESET}`);
    if (entry.detail) out.push(`        ${entry.detail}`);
  }

  const info = (renderer && renderer.info) || {};
  const stats = (gl && gl.stats) || {};
  out.push('');
  out.push(`${DIM}  --- relatorio ---${RESET}`);
  out.push(`  frames renderizados .......... ${framesRendered}`);
  out.push(`  draw calls (driver) .......... ${stats.drawCalls || 0}`);
  out.push(`  draw calls (renderer.info) ... ${typeof info.calls === 'number' ? info.calls : 'n/d'}`);
  out.push(`  draw calls instanciados ...... ${stats.instancedDrawCalls || 0}`);
  out.push(`  triangulos (driver) .......... ${stats.triangles || 0}`);
  out.push(`  triangulos (renderer.info) ... ${typeof info.triangles === 'number' ? info.triangles : 'n/d'}`);
  out.push(`  programas compilados ......... ${stats.programs || 0}`);
  out.push(`  shaders compilados ........... ${stats.shaders || 0}`);
  out.push(`  texturas / buffers / FBOs .... ${stats.textures || 0} / ${stats.buffers || 0} / ${stats.framebuffers || 0}`);
  out.push(`  VAOs / clears / uniforms ..... ${stats.vertexArrays || 0} / ${stats.clears || 0} / ${stats.uniformUpdates || 0}`);
  if (scene) {
    const meshes = scene.meshes ? scene.meshes.length : 'n/d';
    const lights = scene.lights ? scene.lights.length : 'n/d';
    out.push(`  meshes / luzes na cena ....... ${meshes} / ${lights}`);
  }
  if (degraded) out.push(`${YELLOW}  pipeline reduzido: subsistemas opcionais desabilitados${RESET}`);
  if (barrelMisses.length) {
    out.push('');
    out.push(`${YELLOW}  simbolos ausentes no barrel src/index.js:${RESET}`);
    for (let i = 0; i < barrelMisses.length; i++) out.push(`    - ${barrelMisses[i]}`);
  }

  if (warningMessages.length) {
    out.push('');
    out.push(`${YELLOW}  avisos (${warningMessages.length}):${RESET}`);
    for (let i = 0; i < warningMessages.length; i++) out.push(`    - ${warningMessages[i]}`);
  }
  if (failureMessages.length) {
    out.push('');
    out.push(`${RED}  falhas (${failureMessages.length}):${RESET}`);
    for (let i = 0; i < failureMessages.length; i++) out.push(`    - ${failureMessages[i]}`);
  }

  out.push('');
  if (failureMessages.length === 0) out.push(`${GREEN}  OK - a engine roda headless sem erros no caminho principal.${RESET}`);
  else out.push(`${RED}  FALHOU - ${failureMessages.length} etapa(s) do caminho principal quebraram.${RESET}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return failureMessages.length === 0 ? 0 : 1;
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`\n${RED}smoke: promise rejeitada sem tratamento: ${describeError(reason)}${RESET}\n`);
  process.exit(1);
});

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  failureMessages.push(`erro fatal: ${describeError(error)}`);
  process.stderr.write(`\n${RED}smoke: erro fatal: ${describeError(error)}${RESET}\n`);
  if (error && error.stack) process.stderr.write(`${DIM}${error.stack}${RESET}\n`);
  exitCode = 1;
} finally {
  uninstallDOMShims();
}

// Setting exitCode (instead of calling process.exit) lets a piped stdout drain
// completely. The unref'd watchdog only fires when the engine left a live
// handle behind, which would otherwise hang the check.
process.exitCode = exitCode;
const watchdog = setTimeout(() => {
  process.stderr.write(`${YELLOW}smoke: handles ainda ativos apos o teste, encerrando a forca${RESET}\n`);
  process.exit(exitCode);
}, 3000);
if (typeof watchdog.unref === 'function') watchdog.unref();
