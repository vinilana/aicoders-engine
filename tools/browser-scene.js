/**
 * browser-scene.js - pagina de teste determinística da engine, em Chrome REAL.
 *
 * Roda em cinco fases e publica o resultado em `window.__TEST_RESULT`, com
 * `window.__TEST_DONE = true` no fim (mesmo em caso de falha):
 *
 *   A  compila e LINKA todas as permutacoes relevantes de shader (o compilador
 *      GLSL do ANGLE e muito mais rigoroso que qualquer mock);
 *   B  monta uma cena real - terreno, 2000 instancias, grade PBR 5x5, skinning,
 *      CSM, 40 luzes pontuais, ceu procedural + IBL, bloom/ACES/FXAA/SSAO - e
 *      renderiza um numero FIXO de frames (nada de rAF infinito);
 *   C  le o framebuffer default com gl.readPixels e valida a imagem;
 *   D  gl.getError() apos cada etapa, com o nome simbolico da constante;
 *   E  raycast, DynamicBVH, AnimationMixer, CharacterController, GLTFLoader e
 *      o overlay de Stats.
 *
 * A pagina e propositalmente leve: SwiftShader e software puro.
 */

import {
  Engine,
  Vec3, Quat, Color, AABB,
  seededRandom, DEG2RAD, clamp,
  Node3D, Mesh, InstancedMesh, SkinnedMesh, Skeleton, LOD,
  DirectionalLight, PointLight,
  createTerrain, createSphere, createIcosphere, createCylinder, createTorusKnot,
  noiseTexture, noiseHeightField, normalMapFromHeight, checkerTexture,
  Geometry, RenderTarget, Texture,
  StandardMaterial, SkyMaterial,
  KeyframeTrack, AnimationClip, AnimationMixer,
  CollisionWorld, CharacterController, Raycaster, DynamicBVH,
  GLTFLoader, Stats, DebugRenderer,
  registerDebugShader, shaderModulesReady,
  POST_SHADER_NAMES, IBL_SHADER_NAMES
} from '../src/index.js';

/* ========================================================================== *
 * Resultado global
 * ========================================================================== */

/** @type {Object} */
const RESULT = {
  ok: false,
  phases: [],
  errors: [],
  glErrors: [],
  glErrorTraces: [],
  shaderFailures: [],
  shaderWarnings: [],
  pixelStats: {},
  metrics: {
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    frameMs: 0,
    frames: 0,
    shaderPermutations: 0,
    totalMs: 0
  },
  environment: {},
  notes: []
};

window.__TEST_RESULT = RESULT;
window.__TEST_DONE = false;

window.addEventListener('error', (event) => {
  RESULT.errors.push({
    stage: 'window.onerror',
    message: event.message || String(event.error || 'erro desconhecido'),
    stack: event.error && event.error.stack ? event.error.stack : '',
    source: (event.filename || '') + ':' + (event.lineno || 0)
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  RESULT.errors.push({
    stage: 'unhandledrejection',
    message: reason && reason.message ? reason.message : String(reason),
    stack: reason && reason.stack ? reason.stack : '',
    source: ''
  });
});

const LOG_NODE = document.getElementById('log');
const LOG_LINES = [];

/**
 * @param {string} text
 */
function log(text) {
  LOG_LINES.push(text);
  if (LOG_NODE) LOG_NODE.textContent = LOG_LINES.slice(-28).join('\n');
}

/* ========================================================================== *
 * gl.getError com nome simbolico
 * ========================================================================== */

const GL_ERROR_NAMES = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0503: 'STACK_OVERFLOW',
  0x0504: 'STACK_UNDERFLOW',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x9242: 'CONTEXT_LOST_WEBGL'
};

/** @type {WebGL2RenderingContext|null} */
let GL = null;

/**
 * Drena a fila de erros de GL e registra cada um com o estagio em que ocorreu.
 * @param {string} stage
 * @returns {number} quantos erros foram encontrados
 */
function checkGL(stage) {
  if (GL === null) return 0;
  let found = 0;
  for (let guard = 0; guard < 32; guard++) {
    const code = GL.getError();
    if (code === 0) break;
    found++;
    RESULT.glErrors.push({
      stage,
      code,
      name: GL_ERROR_NAMES[code] || ('0x' + code.toString(16)),
      hex: '0x' + code.toString(16)
    });
  }
  if (found > 0) log('  ! gl.getError em "' + stage + '": ' + found);
  return found;
}

/* ========================================================================== *
 * Fases
 * ========================================================================== */

/**
 * Executa uma fase, cronometrando e capturando qualquer excecao.
 * @param {string} name
 * @param {Function} fn
 * @returns {Promise<*>}
 */
async function phase(name, fn) {
  const started = performance.now();
  log('> ' + name);
  const entry = { name, ok: false, ms: 0, detail: null };
  RESULT.phases.push(entry);
  try {
    const value = await fn(entry);
    entry.ok = true;
    entry.ms = Math.round(performance.now() - started);
    log('  ok (' + entry.ms + 'ms)');
    return value;
  } catch (error) {
    entry.ok = false;
    entry.ms = Math.round(performance.now() - started);
    entry.error = error && error.message ? error.message : String(error);
    RESULT.errors.push({
      stage: name,
      message: entry.error,
      stack: error && error.stack ? error.stack : '',
      source: ''
    });
    log('  FALHOU: ' + entry.error);
    throw error;
  }
}

/* ========================================================================== *
 * FASE A - permutacoes de shader
 * ========================================================================== */

/** Defines sempre presentes na permutacao do 'standard' (o Material faz o mesmo). */
const STANDARD_BASE = { MAX_DIR_LIGHTS: 4, MAX_PUNCTUAL_LIGHTS: 512 };

/** Flags do 'standard' que valem a pena permutar. */
const STANDARD_FLAGS = [
  'USE_INSTANCING', 'USE_INSTANCE_COLOR', 'USE_SKINNING', 'USE_SHADOWS', 'USE_CLUSTERED',
  'USE_IBL', 'USE_FOG', 'USE_NORMAL_MAP', 'USE_BASECOLOR_MAP', 'USE_MR_MAP',
  'USE_OCCLUSION_MAP', 'USE_EMISSIVE_MAP', 'ALPHA_MODE_MASK', 'ALPHA_MODE_BLEND',
  'USE_VERTEX_COLOR', 'USE_TANGENT', 'DOUBLE_SIDED', 'USE_UV1', 'USE_UV_TRANSFORM',
  'MANUAL_SRGB_DECODE', 'USE_SPECULAR_AA', 'USE_TONEMAP', 'USE_MOTION_VECTORS'
];

/**
 * Completa uma permutacao com os defines que o Material sempre acompanha.
 * @param {Object} flags
 * @returns {Object}
 */
function standardDefines(flags) {
  const defines = Object.assign({}, STANDARD_BASE, flags);
  if (defines.USE_SHADOWS) defines.SHADOW_CASCADES = 4;
  if (defines.USE_CLUSTERED) {
    defines.CLUSTER_X = 16;
    defines.CLUSTER_Y = 9;
    defines.CLUSTER_Z = 24;
  }
  return defines;
}

/**
 * Conjunto representativo de permutacoes do 'standard': combinacoes escolhidas a
 * mao (as que a engine realmente usa e as arestas do preprocessador) mais uma
 * amostragem determinística do espaco de flags.
 * @returns {Array<Object>}
 */
function buildStandardPermutations() {
  const list = [];
  const seen = new Set();

  const push = (flags) => {
    const defines = standardDefines(flags);
    const key = Object.keys(defines).sort().map((k) => k + '=' + defines[k]).join(';');
    if (seen.has(key)) return;
    seen.add(key);
    list.push(defines);
  };

  // --- combinacoes escolhidas a mao ---------------------------------------
  push({});
  push({ USE_TONEMAP: 1 });
  push({ USE_FOG: 1 });
  push({ USE_SHADOWS: 1 });
  push({ USE_CLUSTERED: 1 });
  push({ USE_IBL: 1 });
  push({ USE_SHADOWS: 1, USE_CLUSTERED: 1, USE_IBL: 1, USE_FOG: 1 });
  push({ USE_BASECOLOR_MAP: 1 });
  push({ USE_NORMAL_MAP: 1 });                       // sem tangente: frame cotangente
  push({ USE_NORMAL_MAP: 1, USE_TANGENT: 1 });
  push({ USE_NORMAL_MAP: 1, USE_TANGENT: 1, DOUBLE_SIDED: 1 });
  push({ USE_NORMAL_MAP: 1, DOUBLE_SIDED: 1 });
  push({ USE_BASECOLOR_MAP: 1, USE_NORMAL_MAP: 1, USE_MR_MAP: 1, USE_OCCLUSION_MAP: 1, USE_EMISSIVE_MAP: 1 });
  push({ USE_BASECOLOR_MAP: 1, USE_UV1: 1, BASECOLOR_UV1: 1 });
  push({ USE_NORMAL_MAP: 1, USE_UV1: 1, NORMAL_UV1: 1, USE_TANGENT: 1 });
  push({ USE_MR_MAP: 1, USE_UV1: 1, MR_UV1: 1 });
  push({ USE_OCCLUSION_MAP: 1, USE_UV1: 1, OCCLUSION_UV1: 1 });
  push({ USE_EMISSIVE_MAP: 1, USE_UV1: 1, EMISSIVE_UV1: 1 });
  push({ ALPHA_MODE_MASK: 1 });
  push({ ALPHA_MODE_BLEND: 1 });
  push({ ALPHA_MODE_MASK: 1, ALPHA_MODE_BLEND: 1 });
  push({ ALPHA_MODE_MASK: 1, DEPTH_ONLY: 1 });
  push({ DEPTH_ONLY: 1 });
  push({ USE_VERTEX_COLOR: 1 });
  push({ USE_INSTANCING: 1 });
  push({ USE_INSTANCING: 1, USE_INSTANCE_COLOR: 1 });
  push({ USE_INSTANCING: 1, USE_INSTANCE_COLOR: 1, USE_VERTEX_COLOR: 1 });
  push({ USE_INSTANCING: 1, USE_INSTANCE_EXACT_NORMALS: 1 });
  push({ USE_SKINNING: 1 });
  push({ USE_SKINNING: 1, USE_TANGENT: 1, USE_NORMAL_MAP: 1 });
  push({ USE_SKINNING: 1, USE_SHADOWS: 1, USE_CLUSTERED: 1, USE_IBL: 1, USE_FOG: 1 });
  push({ USE_INSTANCING: 1, USE_SHADOWS: 1, USE_CLUSTERED: 1, USE_IBL: 1, USE_FOG: 1, USE_INSTANCE_COLOR: 1 });
  push({ USE_MOTION_VECTORS: 1 });
  push({ USE_MOTION_VECTORS: 1, USE_INSTANCING: 1 });
  push({ USE_MOTION_VECTORS: 1, DEPTH_ONLY: 1, ALPHA_MODE_MASK: 1 });
  push({ USE_UV_TRANSFORM: 1, USE_BASECOLOR_MAP: 1, USE_UV1: 1 });
  push({ MANUAL_SRGB_DECODE: 1, USE_BASECOLOR_MAP: 1, USE_EMISSIVE_MAP: 1 });
  push({ USE_SPECULAR_AA: 1, USE_NORMAL_MAP: 1, USE_TANGENT: 1 });
  push({ USE_SHADOWS: 1, SHADOW_CASCADES: 1 });
  push({ USE_SHADOWS: 1, SHADOW_CASCADES: 2 });
  push({ USE_SHADOWS: 1, SHADOW_CASCADES: 3 });
  push({ USE_CLUSTERED: 1, CLUSTER_X: 8, CLUSTER_Y: 4, CLUSTER_Z: 16 });
  // Tudo ligado ao mesmo tempo, o pior caso do compilador.
  const everything = {};
  for (const flag of STANDARD_FLAGS) everything[flag] = 1;
  push(everything);
  const everythingNoMotion = Object.assign({}, everything);
  delete everythingNoMotion.USE_MOTION_VECTORS;
  delete everythingNoMotion.ALPHA_MODE_BLEND;
  push(everythingNoMotion);

  // --- amostragem determinística ------------------------------------------
  const random = seededRandom(0x5eed1234);
  for (let i = 0; i < 24; i++) {
    const flags = {};
    for (let f = 0; f < STANDARD_FLAGS.length; f++) {
      if (random() < 0.35) flags[STANDARD_FLAGS[f]] = 1;
    }
    // USE_TANGENT sem mapa normal e inofensivo, mas o inverso e o caso interessante.
    push(flags);
  }

  return list;
}

/** Permutacoes por programa nao-standard. */
function buildOtherPrograms() {
  const list = [];
  const add = (name, defines) => list.push({ name, defines });

  // unlit
  add('unlit', null);
  add('unlit', { USE_BASECOLOR_MAP: 1, ALPHA_MODE_MASK: 1 });
  add('unlit', { USE_VERTEX_COLOR: 1, USE_INSTANCE_COLOR: 1, USE_FOG: 1, USE_TONEMAP: 1 });
  add('unlit', { USE_SKINNING: 1, USE_UV1: 1, BASECOLOR_UV1: 1, USE_BASECOLOR_MAP: 1 });
  add('unlit', { DEPTH_ONLY: 1, ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1 });
  add('unlit', { ALPHA_MODE_BLEND: 1, MANUAL_SRGB_DECODE: 1, USE_BASECOLOR_MAP: 1, USE_UV_TRANSFORM: 1 });

  // sky
  add('sky', null);
  add('sky', { USE_CLOUDS: 1 });
  add('sky', { USE_CLOUDS: 1, USE_TONEMAP: 1 });

  // depth / depthShadow
  add('depth', null);
  add('depth', { USE_INSTANCING: 1 });
  add('depth', { USE_SKINNING: 1 });
  add('depth', { ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1, USE_UV_TRANSFORM: 1 });
  add('depth', { WRITE_LINEAR_DEPTH: 1, WRITE_NORMALS: 1 });
  add('depthShadow', null);
  add('depthShadow', { USE_INSTANCING: 1, ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1 });

  // shadow
  add('shadow', null);
  add('shadow', { USE_INSTANCING: 1 });
  add('shadow', { USE_SKINNING: 1 });
  add('shadow', { ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1 });
  add('shadow', { SHADOW_CLAMP_NEAR: 1, USE_INSTANCING: 1, ALPHA_MODE_MASK: 1, USE_BASECOLOR_MAP: 1 });

  // debug
  add('debug_lines', null);
  add('debug_lines', { DEBUG_CAMERA_UBO: 1 });
  add('debug_lines', { DEBUG_CAMERA_UBO: 1, DEBUG_SRGB_OUTPUT: 1 });
  add('debug_lines', { DEBUG_ALPHA_TEST: 1, DEBUG_SRGB_OUTPUT: 1 });

  // post_*
  for (const name of POST_SHADER_NAMES) add(name, null);
  add('post_composite', { USE_BLOOM: 1 });
  add('post_composite', { USE_SSAO: 1 });
  add('post_composite', { USE_BLOOM: 1, USE_SSAO: 1 });
  add('post_fxaa', { USE_FXAA: 1 });
  add('post_fxaa', { USE_FXAA: 1, USE_VIGNETTE: 1, USE_CHROMATIC_ABERRATION: 1, USE_GRAIN: 1 });

  // ibl_*
  for (const name of IBL_SHADER_NAMES) add(name, null);

  return list;
}

/**
 * Recompila os fontes ja resolvidos para extrair o infoLog CRU do driver.
 * @param {WebGL2RenderingContext} gl
 * @param {Object} program instancia de Program
 * @returns {{vertex:string, fragment:string, link:string}}
 */
function rawInfoLogs(gl, program) {
  const out = { vertex: '', fragment: '', link: '' };
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    const infoLog = gl.getShaderInfoLog(shader) || '';
    return { shader, ok, infoLog };
  };

  const vs = compile(gl.VERTEX_SHADER, program.vertexSource);
  const fs = compile(gl.FRAGMENT_SHADER, program.fragmentSource);
  out.vertex = vs.infoLog;
  out.fragment = fs.infoLog;

  if (vs.ok && fs.ok) {
    const linked = gl.createProgram();
    gl.attachShader(linked, vs.shader);
    gl.attachShader(linked, fs.shader);
    gl.linkProgram(linked);
    out.link = gl.getProgramInfoLog(linked) || '';
    gl.deleteProgram(linked);
  }
  gl.deleteShader(vs.shader);
  gl.deleteShader(fs.shader);
  return out;
}

/**
 * @param {Object|null} defines
 * @returns {string}
 */
function definesToString(defines) {
  if (!defines) return '(nenhum)';
  const keys = Object.keys(defines).sort();
  if (keys.length === 0) return '(nenhum)';
  return keys.map((k) => k + '=' + defines[k]).join(' ');
}

/**
 * Compila e linka um programa, registrando a falha com o infoLog completo.
 * @param {Object} shaderLib
 * @param {WebGL2RenderingContext} gl
 * @param {string} name
 * @param {Object|null} defines
 * @returns {boolean} true quando o programa linkou
 */
function compileOne(shaderLib, gl, name, defines) {
  let program = null;
  try {
    program = shaderLib.get(name, defines);
  } catch (error) {
    RESULT.shaderFailures.push({
      program: name,
      defines: definesToString(defines),
      infoLog: 'excecao ao resolver o programa: ' + (error && error.message ? error.message : String(error)),
      stack: error && error.stack ? error.stack : ''
    });
    return false;
  }

  const linked = program.isLinked();
  if (!linked) {
    const raw = rawInfoLogs(gl, program);
    RESULT.shaderFailures.push({
      program: name,
      defines: definesToString(defines),
      infoLog: [
        raw.vertex ? 'VERTEX infoLog:\n' + raw.vertex : '',
        raw.fragment ? 'FRAGMENT infoLog:\n' + raw.fragment : '',
        raw.link ? 'LINK infoLog:\n' + raw.link : ''
      ].filter(Boolean).join('\n'),
      report: program.error || ''
    });
    return false;
  }

  const linkLog = gl.getProgramInfoLog(program.program);
  if (linkLog && linkLog.trim().length > 0) {
    RESULT.shaderWarnings.push({
      program: name,
      defines: definesToString(defines),
      infoLog: linkLog.trim()
    });
  }
  return true;
}

/* ========================================================================== *
 * FASE D - instrumentacao de gl.getError chamada a chamada
 * ========================================================================== */

/** Nomes das constantes GL mais comuns, para deixar os argumentos legiveis. */
const GL_ENUM_NAMES = new Map();

/**
 * Preenche a tabela de nomes de constantes a partir do proprio contexto.
 * @param {WebGL2RenderingContext} gl
 */
function buildEnumTable(gl) {
  if (GL_ENUM_NAMES.size > 0) return;
  const proto = Object.getPrototypeOf(gl);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    const value = gl[key];
    if (typeof value !== 'number') continue;
    if (!GL_ENUM_NAMES.has(value)) GL_ENUM_NAMES.set(value, key);
  }
}

/**
 * @param {*} value
 * @returns {string}
 */
function formatArg(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0x0100 && GL_ENUM_NAMES.has(value)) {
      return GL_ENUM_NAMES.get(value);
    }
    return String(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (ArrayBuffer.isView(value)) return value.constructor.name + '(' + value.length + ')';
  if (Array.isArray(value)) return '[' + value.length + ']';
  if (typeof value === 'object') return value.constructor ? value.constructor.name : 'object';
  return String(value);
}

/**
 * Envolve TODOS os metodos do contexto para chamar getError logo apos cada um,
 * capturando funcao, argumentos e o stack de quem chamou. Devolve uma funcao
 * que restaura o contexto.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Array<Object>} sink lista onde os erros sao acumulados
 * @param {number} limit numero maximo de erros capturados
 * @returns {Function} restore()
 */
function instrumentGL(gl, sink, limit) {
  buildEnumTable(gl);
  const proto = Object.getPrototypeOf(gl);
  const patched = [];
  const getError = proto.getError.bind(gl);
  let hits = 0;

  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'getError' || key === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (!descriptor || typeof descriptor.value !== 'function') continue;

    const original = descriptor.value;
    patched.push(key);
    gl[key] = function instrumented(...args) {
      const value = original.apply(gl, args);
      if (hits < limit) {
        const code = getError();
        if (code !== 0) {
          hits++;
          const stack = new Error().stack || '';
          sink.push({
            call: key + '(' + args.map(formatArg).join(', ') + ')',
            error: GL_ERROR_NAMES[code] || ('0x' + code.toString(16)),
            code,
            stack: stack.split('\n').slice(2, 8).join('\n')
          });
        }
      }
      return value;
    };
  }

  return () => {
    for (const key of patched) delete gl[key];
  };
}

/* ========================================================================== *
 * Construcao da cena
 * ========================================================================== */

const TERRAIN_SIZE = 120;
const TERRAIN_AMPLITUDE = 7;

/**
 * Altura determinística do terreno, tambem usada pelo mundo de colisao.
 * @param {number} x
 * @param {number} z
 * @returns {number}
 */
function terrainHeight(x, z) {
  const a = Math.sin(x * 0.06) * Math.cos(z * 0.055);
  const b = Math.sin(x * 0.017 + z * 0.021) * 0.6;
  const c = Math.sin((x + z) * 0.13) * 0.18;
  return (a + b + c) * TERRAIN_AMPLITUDE * 0.5;
}

/**
 * Constroi um SkinnedMesh simples: um cilindro em 3 ossos ao longo de Y, com os
 * pesos derivados da altura do vertice.
 * @returns {{mesh:SkinnedMesh, root:Node3D, bones:Node3D[], mixer:AnimationMixer, action:Object}}
 */
function buildSkinnedCharacter() {
  const height = 4;
  const geometry = createCylinder(0.42, 0.55, height, 14, 10, false);

  const position = geometry.getAttribute('aPosition');
  const positions = position.data;
  const count = positions.length / 3;
  const joints = new Float32Array(count * 4);
  const weights = new Float32Array(count * 4);

  // O cilindro e centrado na origem: y vai de -h/2 a +h/2.
  for (let i = 0; i < count; i++) {
    const y = positions[i * 3 + 1] + height * 0.5;   // 0..h
    const t = clamp(y / height, 0, 1) * 2;           // 0..2, um por segmento
    const lower = Math.min(1, Math.floor(t));
    const blend = clamp(t - lower, 0, 1);
    joints[i * 4] = lower;
    joints[i * 4 + 1] = lower + 1;
    weights[i * 4] = 1 - blend;
    weights[i * 4 + 1] = blend;
  }

  geometry.setAttribute('aJoints', joints, 4);
  geometry.setAttribute('aWeights', weights, 4);

  const root = new Node3D('CharacterRoot');
  const bone0 = new Node3D('BoneRoot');
  const bone1 = new Node3D('BoneMid');
  const bone2 = new Node3D('BoneTop');
  bone0.position.set(0, -height * 0.5, 0);
  bone1.position.set(0, height * 0.5, 0);
  bone2.position.set(0, height * 0.5, 0);
  root.add(bone0);
  bone0.add(bone1);
  bone1.add(bone2);

  const material = new StandardMaterial({
    name: 'Character',
    baseColor: new Color(0.72, 0.26, 0.2),
    metallic: 0.1,
    roughness: 0.48
  });

  const mesh = new SkinnedMesh(geometry, material);
  mesh.name = 'CharacterMesh';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.boundsPadding = 1.5;
  root.add(mesh);

  root.updateWorldMatrix(true);
  const skeleton = new Skeleton([bone0, bone1, bone2]);
  mesh.bind(skeleton, mesh.worldMatrix);

  // Animacao: balanco dos dois ossos superiores.
  const times = new Float32Array([0, 0.5, 1.0]);
  const track = (path, angles) => {
    const values = new Float32Array(angles.length * 4);
    const q = new Quat();
    const axis = new Vec3(0, 0, 1);
    for (let i = 0; i < angles.length; i++) {
      q.setFromAxisAngle(axis, angles[i] * DEG2RAD);
      q.normalize();
      q.toArray(values, i * 4);
    }
    return new KeyframeTrack(path, times, values, 4, 'linear');
  };

  const clip = new AnimationClip('sway', 1.0, [
    track('BoneMid.quaternion', [18, -18, 18]),
    track('BoneTop.quaternion', [-24, 24, -24])
  ]);

  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop('repeat');
  action.play();

  return { mesh, root, bones: [bone0, bone1, bone2], mixer, action };
}

/** glTF minimo (um triangulo com material PBR) embutido como data URI. */
function minimalGLTF() {
  // POSITION: 3 vec3 float; NORMAL: 3 vec3; TEXCOORD_0: 3 vec2; indices: 3 ushort.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);

  const posBytes = new Uint8Array(positions.buffer);
  const nrmBytes = new Uint8Array(normals.buffer);
  const uvBytes = new Uint8Array(uvs.buffer);
  const idxBytes = new Uint8Array(indices.buffer);

  const total = posBytes.length + nrmBytes.length + uvBytes.length + idxBytes.length;
  const blob = new Uint8Array(total);
  let offset = 0;
  blob.set(posBytes, offset); const posOffset = offset; offset += posBytes.length;
  blob.set(nrmBytes, offset); const nrmOffset = offset; offset += nrmBytes.length;
  blob.set(uvBytes, offset); const uvOffset = offset; offset += uvBytes.length;
  blob.set(idxBytes, offset); const idxOffset = offset; offset += idxBytes.length;

  let binary = '';
  for (let i = 0; i < blob.length; i++) binary += String.fromCharCode(blob[i]);
  const base64 = btoa(binary);

  return {
    asset: { version: '2.0', generator: 'browser-scene.js' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'GLTFTriangle' }],
    meshes: [{
      name: 'Triangle',
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        material: 0,
        mode: 4
      }]
    }],
    materials: [{
      name: 'PBR',
      pbrMetallicRoughness: {
        baseColorFactor: [0.8, 0.3, 0.2, 1.0],
        metallicFactor: 0.25,
        roughnessFactor: 0.6
      },
      emissiveFactor: [0.02, 0.02, 0.02],
      doubleSided: true
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: nrmOffset, byteLength: nrmBytes.length, target: 34962 },
      { buffer: 0, byteOffset: uvOffset, byteLength: uvBytes.length, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.length, target: 34963 }
    ],
    buffers: [{ byteLength: total, uri: 'data:application/octet-stream;base64,' + base64 }]
  };
}

/* ========================================================================== *
 * Validacao de pixels
 * ========================================================================== */

/**
 * @param {Uint8Array} pixels RGBA8
 * @returns {Object}
 */
function analysePixels(pixels) {
  const count = pixels.length / 4;
  let nonBlack = 0;
  let white = 0;
  let sumL = 0;
  let sumL2 = 0;
  let minL = 255;
  let maxL = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  const histogram = new Array(8).fill(0);

  for (let i = 0; i < count; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    sumR += r; sumG += g; sumB += b;
    if (r > 8 || g > 8 || b > 8) nonBlack++;
    if (r >= 250 && g >= 250 && b >= 250) white++;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumL += luma;
    sumL2 += luma * luma;
    if (luma < minL) minL = luma;
    if (luma > maxL) maxL = luma;
    histogram[Math.min(7, luma / 32 | 0)]++;
  }

  const mean = sumL / count;
  const variance = Math.max(0, sumL2 / count - mean * mean);
  return {
    pixels: count,
    nonBlackRatio: nonBlack / count,
    whiteRatio: white / count,
    meanLuma: mean,
    stdDevLuma: Math.sqrt(variance),
    minLuma: minL,
    maxLuma: maxL,
    meanRGB: [sumR / count, sumG / count, sumB / count],
    histogram
  };
}

/* ========================================================================== *
 * Main
 * ========================================================================== */

async function main() {
  const startedAll = performance.now();

  /* ---------------------------------------------------------------- setup */
  const engine = await phase('setup: Engine + contexto WebGL2', (entry) => {
    const instance = new Engine({
      canvas: 'viewport',
      width: 960,
      height: 600,
      pixelRatio: 1,
      antialias: false,
      shadows: true,
      hdr: true,
      clustered: true,
      postprocessing: true,
      toneMapping: 'aces',
      exposure: 1.0,
      shadowMapSize: 1024,
      cascades: 4,
      maxLights: 256,
      fov: 62,
      near: 0.1,
      far: 600,
      autoResize: false,
      pauseWhenHidden: false,
      stats: false
    });

    GL = instance.gl;
    // Publicado so para inspecao manual/CDP; nada no teste depende disso.
    window.__ENGINE = instance;
    const debugInfo = GL.getExtension('WEBGL_debug_renderer_info');
    RESULT.environment = {
      version: GL.getParameter(GL.VERSION),
      glsl: GL.getParameter(GL.SHADING_LANGUAGE_VERSION),
      vendor: GL.getParameter(GL.VENDOR),
      renderer: debugInfo ? GL.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : GL.getParameter(GL.RENDERER),
      maxTextureSize: GL.getParameter(GL.MAX_TEXTURE_SIZE),
      maxSamples: GL.getParameter(GL.MAX_SAMPLES),
      colorBufferFloat: !!GL.getExtension('EXT_color_buffer_float'),
      floatLinear: !!GL.getExtension('OES_texture_float_linear'),
      drawingBuffer: [GL.drawingBufferWidth, GL.drawingBufferHeight]
    };
    entry.detail = RESULT.environment.renderer;

    const subsystems = {
      shadowMapper: instance.renderer.shadowMapper !== null,
      clustered: instance.renderer.clustered !== null,
      post: instance.renderer.post !== null,
      lightManager: instance.renderer.lightManager !== null
    };
    RESULT.environment.subsystems = subsystems;
    for (const key in subsystems) {
      if (!subsystems[key]) {
        RESULT.errors.push({
          stage: 'setup',
          message: 'subsistema "' + key + '" nao pode ser construido pelo Renderer (degradou para null)',
          stack: '',
          source: ''
        });
      }
    }

    checkGL('setup');
    return instance;
  });

  const renderer = engine.renderer;
  const scene = engine.scene;
  const camera = engine.camera;
  const shaderLib = renderer.shaderLib;

  /* ------------------------------------------------- FASE A: permutacoes */
  await phase('fase A: compilacao exaustiva de shaders', async (entry) => {
    // Os modulos opcionais (shadow, post, ibl) sao carregados de forma assincrona.
    await shaderModulesReady();
    registerDebugShader(shaderLib);

    const registered = shaderLib.shaderNames.slice().sort();
    entry.detail = { registered };

    const permutations = buildStandardPermutations();
    let compiled = 0;
    let failed = 0;

    for (const defines of permutations) {
      if (compileOne(shaderLib, GL, 'standard', defines)) compiled++;
      else failed++;
    }
    log('  standard: ' + permutations.length + ' permutacoes, ' + failed + ' falhas');

    const others = buildOtherPrograms();
    const missing = [];
    for (const item of others) {
      if (!shaderLib.has(item.name)) {
        if (missing.indexOf(item.name) < 0) missing.push(item.name);
        continue;
      }
      if (compileOne(shaderLib, GL, item.name, item.defines)) compiled++;
      else failed++;
    }
    if (missing.length > 0) {
      RESULT.errors.push({
        stage: 'fase A',
        message: 'programas nao registrados na ShaderLib: ' + missing.join(', '),
        stack: '',
        source: ''
      });
    }

    RESULT.metrics.shaderPermutations = compiled + failed;
    RESULT.metrics.programs = shaderLib.programCount;
    entry.detail = {
      registered,
      permutations: compiled + failed,
      compiled,
      failed,
      missing
    };
    log('  total: ' + (compiled + failed) + ' programas, ' + failed + ' falhas');
    checkGL('fase A');
  });

  /* --------------------------------------------------- FASE B: cena real */
  const world = {};

  await phase('fase B: montagem da cena', () => {
    scene.name = 'BrowserTestScene';
    scene.setAmbient(new Color(0.55, 0.68, 0.9), 0.25);
    scene.setFogExp2(new Color(0.55, 0.66, 0.8), 0.0038);
    checkGL('cena: scene setup');

    // --- texturas procedurais ---------------------------------------------
    world.colorMap = noiseTexture(GL, 128, 4, { frequency: 6 });
    world.normalMap = normalMapFromHeight(GL, noiseHeightField(128, 7, 4, 2.5), 128, 2.0);
    world.checker = checkerTexture(GL, 128, 0xffffff, 0x606060);
    checkGL('cena: texturas');

    // --- terreno (64x64) ---------------------------------------------------
    const terrainMaterial = new StandardMaterial({
      name: 'Terrain',
      baseColor: new Color(0.32, 0.4, 0.22),
      roughness: 0.92,
      metallic: 0.0,
      normalScale: 0.8
    });
    terrainMaterial.baseColorMap = world.colorMap;
    terrainMaterial.normalMap = world.normalMap;

    const terrain = new Mesh(createTerrain(TERRAIN_SIZE, 64, terrainHeight, 8), terrainMaterial);
    terrain.name = 'Terrain';
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    scene.add(terrain);
    world.terrain = terrain;
    world.terrainMaterial = terrainMaterial;

    // --- ~2000 instancias ---------------------------------------------------
    const instanceCount = 2000;
    const instanceMaterial = new StandardMaterial({
      name: 'Rocks',
      baseColor: new Color(1, 1, 1),
      roughness: 0.78,
      metallic: 0.05
    });
    instanceMaterial.baseColorMap = world.checker;

    const instances = new InstancedMesh(createIcosphere(0.42, 1), instanceMaterial, instanceCount, {
      useColor: true,
      count: instanceCount
    });
    instances.name = 'Instances';
    instances.castShadow = true;
    instances.receiveShadow = true;

    const random = seededRandom(0x1a2b3c4d);
    const position = new Vec3();
    const rotation = new Quat();
    const scaleVec = new Vec3();
    const instanceColor = new Color();
    const axis = new Vec3(0, 1, 0);

    for (let i = 0; i < instanceCount; i++) {
      const x = (random() - 0.5) * TERRAIN_SIZE * 0.92;
      const z = (random() - 0.5) * TERRAIN_SIZE * 0.92;
      const s = 0.5 + random() * 1.4;
      position.set(x, terrainHeight(x, z) + s * 0.35, z);
      rotation.setFromAxisAngle(axis, random() * Math.PI * 2);
      scaleVec.set(s, s * (0.7 + random() * 0.6), s);
      instances.setTransformAt(i, position, rotation, scaleVec);
      instanceColor.set(0.4 + random() * 0.6, 0.4 + random() * 0.5, 0.35 + random() * 0.4);
      instances.setColorAt(i, instanceColor, 1);
    }
    scene.add(instances);
    world.instances = instances;

    // --- grade 5x5 de esferas PBR ------------------------------------------
    const sphereGeometry = createSphere(0.85, 24, 16);
    const grid = new Node3D('PBRGrid');
    grid.position.set(0, terrainHeight(0, 0) + 3.2, 0);
    scene.add(grid);
    world.spheres = [];

    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) {
        const material = new StandardMaterial({
          name: 'PBR_' + i + '_' + j,
          baseColor: new Color(0.95, 0.78, 0.4),
          metallic: i / 4,
          roughness: Math.max(0.06, j / 4)
        });
        const sphere = new Mesh(sphereGeometry, material);
        sphere.position.set((i - 2) * 2.3, (j - 2) * 2.3, 0);
        sphere.castShadow = true;
        sphere.receiveShadow = true;
        grid.add(sphere);
        world.spheres.push(sphere);
      }
    }

    // --- LOD, para exercitar a selecao de nivel ----------------------------
    const lod = new LOD('KnotLOD');
    lod.position.set(-12, terrainHeight(-12, 8) + 2.4, 8);
    const knotMaterial = new StandardMaterial({
      name: 'Knot', baseColor: new Color(0.9, 0.92, 0.98), metallic: 0.85, roughness: 0.22
    });
    lod.addLevel(new Mesh(createTorusKnot(1.1, 0.32, 96, 16, 2, 3), knotMaterial), 0);
    lod.addLevel(new Mesh(createTorusKnot(1.1, 0.32, 40, 8, 2, 3), knotMaterial), 24);
    scene.add(lod);
    world.lod = lod;

    // --- personagem com skinning -------------------------------------------
    const character = buildSkinnedCharacter();
    character.root.position.set(7, terrainHeight(7, 6) + 2.0, 6);
    scene.add(character.root);
    world.character = character;
    engine.addMixer(character.mixer);

    // --- ceu procedural + sol com sombra -----------------------------------
    const sky = new SkyMaterial({
      name: 'Sky',
      turbidity: 2.6,
      rayleigh: 1.2,
      mie: 0.006,
      mieDirectionalG: 0.8,
      sunIntensity: 1.0,
      sunDiscIntensity: 22,
      clouds: true,
      cloudCoverage: 0.4
    });
    sky.setSunPosition(38, 130);
    scene.background = sky;
    world.sky = sky;

    const sun = new DirectionalLight(0xfff2e0, 3.2);
    sun.name = 'Sun';
    sun.castShadow = true;
    sun.useTarget = true;
    sun.target.set(0, 0, 0);
    sun.shadow.bias = 0.0007;
    sun.shadow.normalBias = 0.05;
    const sunDirection = new Vec3();
    sky.getSunDirection(sunDirection);
    sun.position.set(sunDirection.x * 200, Math.max(sunDirection.y, 0.1) * 200, sunDirection.z * 200);
    scene.add(sun);
    world.sun = sun;

    // --- 40 luzes pontuais --------------------------------------------------
    const lightRoot = new Node3D('PointLights');
    scene.add(lightRoot);
    world.pointLights = [];
    const lightRandom = seededRandom(0x77aa33);
    const lightColor = new Color();

    for (let i = 0; i < 40; i++) {
      const angle = lightRandom() * Math.PI * 2;
      const radius = 6 + Math.sqrt(lightRandom()) * 40;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      lightColor.setHSL(lightRandom(), 0.85, 0.55);
      const light = new PointLight(lightColor, 8 + lightRandom() * 6, 14 + lightRandom() * 8);
      light.position.set(x, terrainHeight(x, z) + 1.6 + lightRandom() * 2.4, z);
      lightRoot.add(light);
      world.pointLights.push(light);
    }

    // --- camera --------------------------------------------------------------
    camera.position.set(0, terrainHeight(0, 26) + 7.5, 26);
    camera.lookAt(new Vec3(0, terrainHeight(0, 0) + 3, 0));
    camera.updateProjection();

    checkGL('cena: construcao');
  });

  await phase('fase B: IBL a partir do ceu procedural', () => {
    const ibl = renderer.createIBL();
    if (ibl === null || ibl === undefined) {
      throw new Error('renderer.createIBL() devolveu null - o subsistema de IBL nao pode ser construido.');
    }
    const sunDirection = new Vec3();
    world.sky.getSunDirection(sunDirection);
    ibl.fromProceduralSky({
      sunDirection: { x: sunDirection.x, y: sunDirection.y, z: sunDirection.z },
      turbidity: world.sky.turbidity,
      rayleigh: world.sky.rayleigh,
      mieCoefficient: world.sky.mie,
      mieDirectionalG: world.sky.mieDirectionalG,
      luminance: 1.0,
      sunDiskIntensity: 0.0,
      cloudCoverage: 0.0
    });
    ibl.intensity = 1.0;
    scene.environment = ibl;
    scene.ambientIntensity = 0.06;
    world.ibl = ibl;
    checkGL('IBL');
  });

  await phase('fase B: post processing (bloom + ACES + FXAA + SSAO)', (entry) => {
    const post = renderer.post;
    if (post === null) throw new Error('renderer.post e null: o post processing nao pode ser construido.');
    if (typeof post.setSSAO === 'function') post.setSSAO(true);
    else post.ssao.enabled = true;
    entry.detail = {
      bloom: post.bloom ? post.bloom.enabled : null,
      fxaa: post.fxaa ? post.fxaa.enabled : null,
      ssao: post.ssao ? post.ssao.enabled : null,
      toneMapping: post.toneMapping !== undefined ? post.toneMapping : renderer.toneMapping
    };
    if (!post.bloom || post.bloom.enabled !== true) {
      RESULT.notes.push('bloom nao esta habilitado no PostProcessing');
    }
    if (!post.ssao || post.ssao.enabled !== true) {
      RESULT.notes.push('SSAO nao pode ser habilitado no PostProcessing');
    }
    checkGL('post setup');
  });

  await phase('fase B: renderer.compile (pre-aquecimento)', () => {
    if (typeof renderer.compile === 'function') renderer.compile(scene, camera);
    checkGL('renderer.compile');
  });

  /* ------------------------------------------------------- FASE B: frames */
  const FRAME_COUNT = 30;
  let lastPixels = null;

  await phase('fase B: renderizar ' + FRAME_COUNT + ' frames', async (entry) => {
    const frameTimes = [];
    let time = 0;

    for (let frame = 0; frame < FRAME_COUNT; frame++) {
      time += 1000 / 60;

      // Movimento determinístico: camera orbitando e luzes subindo/descendo.
      const angle = frame * 0.03;
      camera.position.set(Math.sin(angle) * 30, terrainHeight(0, 26) + 8 + Math.sin(angle * 2) * 1.5, Math.cos(angle) * 30);
      camera.lookAt(new Vec3(0, terrainHeight(0, 0) + 3, 0));
      for (let i = 0; i < world.pointLights.length; i++) {
        const light = world.pointLights[i];
        light.position.y += Math.sin(frame * 0.2 + i) * 0.05;
      }

      const t0 = performance.now();
      engine.tick(time);
      const isLast = frame === FRAME_COUNT - 1;

      if (isLast) {
        // Sem preserveDrawingBuffer, o conteudo so e valido antes de voltar ao
        // event loop: le AGORA, na mesma tarefa do ultimo draw.
        const width = GL.drawingBufferWidth;
        const height = GL.drawingBufferHeight;
        const pixels = new Uint8Array(width * height * 4);
        GL.bindFramebuffer(GL.FRAMEBUFFER, null);
        GL.readPixels(0, 0, width, height, GL.RGBA, GL.UNSIGNED_BYTE, pixels);
        lastPixels = { pixels, width, height };
      }

      frameTimes.push(performance.now() - t0);
      checkGL('frame ' + frame);
      if (!isLast) await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    frameTimes.sort((a, b) => a - b);
    const info = renderer.info;
    RESULT.metrics.drawCalls = info.drawCalls;
    RESULT.metrics.triangles = info.triangles;
    RESULT.metrics.programs = shaderLib.programCount;
    RESULT.metrics.frames = FRAME_COUNT;
    RESULT.metrics.frameMs = Math.round(frameTimes[frameTimes.length >> 1] * 100) / 100;
    RESULT.metrics.frameMsMax = Math.round(frameTimes[frameTimes.length - 1] * 100) / 100;
    RESULT.metrics.visibleMeshes = info.visibleMeshes;
    RESULT.metrics.culledMeshes = info.culledMeshes;
    RESULT.metrics.shadowDrawCalls = info.shadowDrawCalls;
    entry.detail = Object.assign({}, RESULT.metrics);
  });

  /* --------------------------------------------- FASE C: validacao de saida */
  await phase('fase C: validacao dos pixels', (entry) => {
    if (lastPixels === null) throw new Error('nenhum readPixels foi capturado.');

    const stats = analysePixels(lastPixels.pixels);
    stats.width = lastPixels.width;
    stats.height = lastPixels.height;
    RESULT.pixelStats = stats;
    entry.detail = stats;

    const problems = [];
    if (stats.maxLuma <= 1) problems.push('a imagem esta totalmente preta (maxLuma=' + stats.maxLuma.toFixed(2) + ')');
    if (stats.minLuma >= 254) problems.push('a imagem esta totalmente branca (minLuma=' + stats.minLuma.toFixed(2) + ')');
    if (stats.nonBlackRatio <= 0.2) {
      problems.push('apenas ' + (stats.nonBlackRatio * 100).toFixed(1) + '% dos pixels sao nao-pretos (esperado > 20%)');
    }
    if (stats.stdDevLuma < 2) {
      problems.push('variancia de cor baixissima (stdDev=' + stats.stdDevLuma.toFixed(2) + '): a imagem parece uniforme');
    }
    if (stats.whiteRatio > 0.9) {
      problems.push((stats.whiteRatio * 100).toFixed(1) + '% dos pixels sao brancos saturados');
    }

    for (const problem of problems) {
      RESULT.errors.push({ stage: 'fase C', message: problem, stack: '', source: 'readPixels' });
    }
    checkGL('fase C: readPixels');
  });

  await phase('fase C: NaN/Inf em alvo float', (entry) => {
    if (!RESULT.environment.colorBufferFloat) {
      entry.detail = { skipped: 'EXT_color_buffer_float indisponivel' };
      RESULT.notes.push('checagem de NaN/Inf pulada: EXT_color_buffer_float indisponivel');
      return;
    }

    const target = new RenderTarget(GL, 320, 200, {
      colorFormat: 'rgba32f',
      depth: true,
      filter: 'nearest',
      state: renderer.state,
      name: 'nan-probe'
    });
    checkGL('fase C: criar RT float');

    camera.aspect = 320 / 200;
    camera.updateProjection();
    renderer.renderToTarget(scene, camera, target);
    checkGL('fase C: renderToTarget');

    const pixels = new Float32Array(320 * 200 * 4);
    target.bind(renderer.state);
    const readFormat = GL.getParameter(GL.IMPLEMENTATION_COLOR_READ_FORMAT);
    const readType = GL.getParameter(GL.IMPLEMENTATION_COLOR_READ_TYPE);
    GL.readPixels(0, 0, 320, 200, GL.RGBA, GL.FLOAT, pixels);
    const readErrors = checkGL('fase C: readPixels float');
    renderer.state.bindFramebuffer(0x8d40, null);

    camera.aspect = engine.width / engine.height;
    camera.updateProjection();

    let nan = 0;
    let inf = 0;
    let negative = 0;
    let maxValue = 0;
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i];
      if (Number.isNaN(v)) nan++;
      else if (!Number.isFinite(v)) inf++;
      else {
        if (v < 0) negative++;
        if (v > maxValue) maxValue = v;
      }
    }

    entry.detail = {
      nan, inf, negative, maxValue,
      readFormat: '0x' + readFormat.toString(16),
      readType: '0x' + readType.toString(16),
      readErrors
    };

    if (nan > 0 || inf > 0) {
      RESULT.errors.push({
        stage: 'fase C',
        message: 'o alvo float contem ' + nan + ' NaN e ' + inf + ' Inf de ' + pixels.length + ' componentes',
        stack: '',
        source: 'readPixels(FLOAT)'
      });
    }
    target.dispose(renderer.state);
    checkGL('fase C: dispose RT');
  });

  /* ------------------------------- FASE D: rastrear a origem dos gl errors */
  await phase('fase D: frame instrumentado (origem de cada gl.getError)', (entry) => {
    checkGL('fase D: pre-instrumentacao');
    const traces = [];
    const restore = instrumentGL(GL, traces, 24);
    try {
      engine.tick(2000);
    } finally {
      restore();
    }
    RESULT.glErrorTraces = traces;
    entry.detail = { captured: traces.length, first: traces.length > 0 ? traces[0].call : null };
    // Os erros ja foram consumidos pela instrumentacao; drena o que sobrou.
    checkGL('fase D: pos-instrumentacao');
  });

  await phase('fase D: coerencia do StateCache ao ligar textura para upload', (entry) => {
    checkGL('fase D2: inicio');
    const state = renderer.state;

    // Duas texturas RGBA8 identicas em formato: uma faz o papel do mapa de um
    // material, a outra o de uma textura atualizada todo frame.
    const victimData = new Uint8Array(4 * 4 * 4).fill(11);
    const dynamicData = new Uint8Array(4 * 4 * 4).fill(222);
    const options = {
      width: 4, height: 4, internalFormat: 'rgba8',
      minFilter: 'nearest', magFilter: 'nearest', generateMipmaps: false, state
    };
    const victim = new Texture(GL, Object.assign({ data: victimData }, options));
    const dynamic = new Texture(GL, Object.assign({ data: dynamicData }, options));

    const readFirstPixel = (texture) => {
      const framebuffer = GL.createFramebuffer();
      GL.bindFramebuffer(GL.FRAMEBUFFER, framebuffer);
      GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture.id, 0);
      const pixels = new Uint8Array(4 * 4 * 4);
      if (GL.checkFramebufferStatus(GL.FRAMEBUFFER) === GL.FRAMEBUFFER_COMPLETE) {
        GL.readPixels(0, 0, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, pixels);
      }
      GL.bindFramebuffer(GL.FRAMEBUFFER, null);
      GL.deleteFramebuffer(framebuffer);
      state.invalidateFramebuffer(framebuffer);
      while (GL.getError() !== 0) { /* limpa a fila do proprio teste */ }
      return pixels[0];
    };

    dynamic.upload(dynamicData);                 // 1o upload: liga de verdade
    const victimBefore = readFirstPixel(victim);

    victim.bind(state, 0);                       // um material liga a victim na unidade 0
    const activeUnit = GL.getParameter(GL.ACTIVE_TEXTURE) - GL.TEXTURE0;

    dynamicData.fill(99);
    dynamic.upload(dynamicData);                 // 2o upload: o cache acha que ja esta ligada
    const uploadError = GL.getError();
    const victimAfter = readFirstPixel(victim);
    const dynamicAfter = readFirstPixel(dynamic);

    entry.detail = {
      activeUnitAfterMaterialBind: activeUnit,
      scratchTextureUnit: state.scratchTextureUnit,
      victimBefore, victimAfter, dynamicAfter,
      uploadError: uploadError ? (GL_ERROR_NAMES[uploadError] || uploadError) : null
    };

    if (victimAfter !== victimBefore) {
      RESULT.errors.push({
        stage: 'fase D',
        message: 'StateCache/Texture: o upload de uma textura escreveu na TEXTURA ERRADA. ' +
          'A textura ligada pelo material na unidade ' + activeUnit + ' passou de ' + victimBefore +
          ' para ' + victimAfter + ' (valor da textura dinamica), enquanto a textura de destino ' +
          'continuou com ' + dynamicAfter + '. Causa: StateCache.bindTexture faz early-out quando o ' +
          'binding ja esta em cache e nao chama activeTexture(unit), entao texSubImage* atinge a ' +
          'textura ligada na unidade ativa corrente.',
        stack: '', source: 'StateCache.bindTextureForUpdate -> Texture.upload'
      });
    }

    victim.dispose(state);
    dynamic.dispose(state);
    checkGL('fase D2: fim');
  });

  /* ------------------------------------------------- FASE E: subsistemas */
  await phase('fase E: raycast contra a cena', (entry) => {
    const raycaster = new Raycaster();
    const origin = new Vec3(0, terrainHeight(0, 0) + 40, 0);
    const direction = new Vec3(0, -1, 0);
    raycaster.set(origin, direction);
    raycaster.far = 200;
    const hits = raycaster.intersectScene(scene, []);
    entry.detail = {
      hits: hits.length,
      first: hits.length > 0
        ? { object: hits[0].object ? hits[0].object.name : '?', distance: Math.round(hits[0].distance * 1000) / 1000 }
        : null
    };
    if (hits.length === 0) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'raycast vertical no centro da cena nao encontrou nenhuma interseccao (o terreno deveria ser atingido)',
        stack: '', source: 'Raycaster.intersectScene'
      });
    }
    raycaster.releaseIntersections(hits);

    // Raio a partir da camera, o caminho usado pelo picking.
    const picker = new Raycaster();
    picker.setFromCamera(0, 0, camera);
    const pickHits = picker.intersectScene(scene, []);
    entry.detail.cameraPickHits = pickHits.length;
    picker.releaseIntersections(pickHits);
    checkGL('fase E: raycast');
  });

  await phase('fase E: DynamicBVH', (entry) => {
    const bvh = new DynamicBVH({ margin: 0.2 });
    const box = new AABB();
    const random = seededRandom(0xbeef01);
    const proxies = [];
    for (let i = 0; i < 400; i++) {
      const x = (random() - 0.5) * 100;
      const y = (random() - 0.5) * 20;
      const z = (random() - 0.5) * 100;
      box.min.set(x - 0.5, y - 0.5, z - 0.5);
      box.max.set(x + 0.5, y + 0.5, z + 0.5);
      proxies.push(bvh.insert(box, { id: i }));
    }

    const queryBox = new AABB();
    queryBox.min.set(-20, -10, -20);
    queryBox.max.set(20, 10, 20);
    const inBox = [];
    const aabbCount = bvh.queryAABB(queryBox, inBox);

    camera.updateFrustum();
    const inFrustum = [];
    const frustumCount = bvh.query(camera.frustum, inFrustum);

    const sphereHits = [];
    const sphereCount = bvh.querySphere(0, 0, 0, 25, sphereHits);

    for (let i = 0; i < 100; i++) bvh.remove(proxies[i]);

    entry.detail = {
      inserted: proxies.length,
      aabbQuery: aabbCount,
      aabbOut: inBox.length,
      frustumQuery: frustumCount,
      sphereQuery: sphereCount,
      sceneBVHProxies: scene.bvh ? scene.bvh.proxyCount : null
    };
    if (aabbCount !== inBox.length) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'DynamicBVH.queryAABB devolveu ' + aabbCount + ' mas escreveu ' + inBox.length + ' itens em out',
        stack: '', source: 'DynamicBVH'
      });
    }
    if (aabbCount === 0) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'DynamicBVH.queryAABB nao devolveu nenhum proxy para uma caixa que cobre 40x20x40 do volume povoado',
        stack: '', source: 'DynamicBVH'
      });
    }
  });

  await phase('fase E: AnimationMixer', (entry) => {
    const character = world.character;
    const bone = character.bones[1];
    const before = { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w };
    character.mixer.update(0.35);
    character.root.updateWorldMatrix(true);
    const after = { x: bone.quaternion.x, y: bone.quaternion.y, z: bone.quaternion.z, w: bone.quaternion.w };
    const delta = Math.abs(after.x - before.x) + Math.abs(after.y - before.y) +
                  Math.abs(after.z - before.z) + Math.abs(after.w - before.w);
    entry.detail = { delta, time: character.action.time };
    if (!(delta > 1e-5)) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'AnimationMixer.update nao alterou a rotacao do osso animado (delta=' + delta + ')',
        stack: '', source: 'AnimationMixer'
      });
    }
    if (!Number.isFinite(delta)) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'a rotacao do osso virou NaN depois do AnimationMixer',
        stack: '', source: 'AnimationMixer'
      });
    }
  });

  await phase('fase E: CharacterController.move', (entry) => {
    const collisionWorld = new CollisionWorld({ gravity: new Vec3(0, -24, 0) });
    const proxy = new Mesh(createTerrain(TERRAIN_SIZE, 48, terrainHeight, 1), world.terrainMaterial);
    proxy.updateWorldMatrix(true);
    collisionWorld.addStatic(proxy);

    const controller = new CharacterController(collisionWorld, {
      radius: 0.35,
      height: 1.8,
      stepOffset: 0.4,
      slopeLimit: 52,
      position: new Vec3(0, terrainHeight(0, 0) + 4, 0)
    });

    const velocity = new Vec3(2.5, 0, 1.5);
    const start = new Vec3(controller.position.x, controller.position.y, controller.position.z);
    let grounded = false;
    for (let step = 0; step < 40; step++) {
      controller.move(velocity, 1 / 60);
      if (controller.isGrounded === true) grounded = true;
    }
    const end = controller.position;
    const travelled = Math.hypot(end.x - start.x, end.z - start.z);

    entry.detail = {
      start: [start.x, start.y, start.z],
      end: [end.x, end.y, end.z],
      travelled,
      grounded,
      colliders: collisionWorld.colliderCount !== undefined ? collisionWorld.colliderCount : null
    };

    if (!Number.isFinite(end.x) || !Number.isFinite(end.y) || !Number.isFinite(end.z)) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'CharacterController.move produziu uma posicao nao finita: ' + JSON.stringify(entry.detail.end),
        stack: '', source: 'CharacterController'
      });
    } else if (travelled < 0.2) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'CharacterController.move nao moveu o personagem em 40 passos (deslocamento horizontal=' +
          travelled.toFixed(4) + ')',
        stack: '', source: 'CharacterController'
      });
    }
    if (!grounded) {
      RESULT.notes.push('CharacterController nunca reportou contato com o solo em 40 passos');
    }
  });

  await phase('fase E: GLTFLoader.parse de um glTF minimo', async (entry) => {
    const loader = new GLTFLoader(GL, { loadTextures: false });
    const asset = await loader.parse(minimalGLTF(), '', 'browser-scene-inline.gltf');
    if (!asset || !asset.scene) throw new Error('GLTFLoader.parse devolveu um resultado sem cena.');

    let meshCount = 0;
    let triangleCount = 0;
    let materialName = null;
    asset.scene.traverse((node) => {
      if (node.geometry) {
        meshCount++;
        const index = node.geometry.index;
        const position = node.geometry.getAttribute('aPosition');
        const vertices = index ? index.data.length : (position ? position.data.length / 3 : 0);
        triangleCount += vertices / 3;
        if (node.material) materialName = node.material.name || '(sem nome)';
      }
    });

    entry.detail = {
      meshes: meshCount,
      triangles: triangleCount,
      material: materialName,
      materials: asset.materials ? asset.materials.length : 0,
      nodes: asset.nodes ? asset.nodes.length : 0
    };

    if (meshCount !== 1 || triangleCount !== 1) {
      RESULT.errors.push({
        stage: 'fase E',
        message: 'GLTFLoader.parse deveria produzir 1 mesh com 1 triangulo, produziu ' +
          meshCount + ' mesh(es) e ' + triangleCount + ' triangulo(s)',
        stack: '', source: 'GLTFLoader'
      });
    }

    // Renderiza o triangulo importado uma vez, para provar que os buffers sobem.
    scene.add(asset.scene);
    asset.scene.position.set(0, terrainHeight(0, 0) + 6, 0);
    engine.tick(1000);
    checkGL('fase E: draw do glTF');
    scene.remove(asset.scene);
  });

  await phase('fase E: DebugRenderer + Stats overlay', (entry) => {
    const debugRenderer = new DebugRenderer(GL, renderer);
    debugRenderer.clear();
    debugRenderer.line(new Vec3(-10, 10, 0), new Vec3(10, 10, 0), new Color(0.2, 1, 0.4));
    debugRenderer.box(world.terrain.boundingBoxWorld, new Color(1, 0.4, 0.1));
    debugRenderer.grid(40, 20, new Color(0.3, 0.4, 0.6), terrainHeight(0, 0));
    debugRenderer.drawBVH(scene.bvh, 6, new Color(0.9, 0.6, 0.2));
    debugRenderer.render(camera);
    checkGL('fase E: DebugRenderer');
    debugRenderer.dispose();

    const stats = new Stats({ gl: GL, position: 'bottom-left' });
    stats.begin();
    engine.tick(1100);
    stats.end();
    stats.update(renderer);
    entry.detail = { statsDom: !!stats.dom, panels: stats.panels ? stats.panels.length : null };
    checkGL('fase E: Stats');
    stats.dispose();
  });

  /* ---------------------------------------------------------- conclusao */
  RESULT.metrics.totalMs = Math.round(performance.now() - startedAll);
  RESULT.ok = RESULT.errors.length === 0 &&
              RESULT.glErrors.length === 0 &&
              RESULT.shaderFailures.length === 0;
  log(RESULT.ok ? '=== OK ===' : '=== FALHAS: ' + (RESULT.errors.length + RESULT.glErrors.length + RESULT.shaderFailures.length) + ' ===');
}

main()
  .catch((error) => {
    if (RESULT.errors.length === 0) {
      RESULT.errors.push({
        stage: 'main',
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack ? error.stack : '',
        source: ''
      });
    }
    RESULT.ok = false;
  })
  .finally(() => {
    RESULT.metrics.totalMs = RESULT.metrics.totalMs || 0;
    window.__TEST_DONE = true;
  });
