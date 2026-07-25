/**
 * Testes de fisica em Node puro (a fisica da engine nao depende de WebGL).
 *
 * Cobre o que e facil de quebrar sem perceber: tunelamento em alta velocidade,
 * o equilibrio de Arquimedes, colisao de personagem contra geometria estatica,
 * nado, e o compartilhamento da BVH entre colisores instanciados.
 *
 * Uso: node tools/physics-test.mjs
 */

import { Vec3 } from '../src/math/Vec3.js';
import { Mat4 } from '../src/math/Mat4.js';
import { CollisionWorld } from '../src/physics/CollisionWorld.js';
import { RigidBody, BodyShape, BodyType } from '../src/physics/RigidBody.js';
import { CharacterController } from '../src/physics/CharacterController.js';
import { WaterVolume } from '../src/physics/WaterVolume.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    failed++;
    console.log('  FALHA ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function near(name, value, expected, tolerance, unit) {
  const ok = Math.abs(value - expected) <= tolerance;
  check(name, ok, value.toFixed(3) + (unit || '') + ' esperado ' + expected + ' +-' + tolerance);
}

/* ------------------------------------------------------------- geometria */

/**
 * Caixa triangulada centrada na origem.
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
function boxMesh(sx, sy, sz, cx = 0, cy = 0, cz = 0) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const p = [
    -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz,
    -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz,
  ];
  for (let i = 0; i < p.length; i += 3) { p[i] += cx; p[i + 1] += cy; p[i + 2] += cz; }
  const idx = [
    0, 2, 1, 0, 3, 2, // -Z
    4, 5, 6, 4, 6, 7, // +Z
    0, 1, 5, 0, 5, 4, // -Y
    3, 7, 6, 3, 6, 2, // +Y
    0, 4, 7, 0, 7, 3, // -X
    1, 2, 6, 1, 6, 5, // +X
  ];
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}

/** Plano horizontal grande em y = height. */
function groundMesh(size, height) {
  const h = size / 2;
  return {
    positions: new Float32Array([-h, height, -h, h, height, -h, h, height, h, -h, height, h]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}

function simulate(world, seconds, dt = 1 / 120) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) world.step(dt);
}

/* ------------------------------------------------------------ 1. empuxo */

console.log('\n=== FISICA — AICoders Engine ===\n');
console.log('1. Empuxo (principio de Arquimedes)');

function buoyancyCase(name, relativeDensity, expectedSubmersion, tolerance) {
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addWater(WaterVolume.fromBox(0, -5, 0, 40, 10, 40, { density: 1 }));

  const radius = 0.5;
  const volume = (4 / 3) * Math.PI * radius * radius * radius;

  const body = new RigidBody({
    shape: BodyShape.SPHERE,
    radius,
    // massa = densidade * volume, entao a densidade relativa e o unico parametro
    mass: relativeDensity * volume,
    allowSleep: false,
  });
  body.position.set(0, 1.5, 0);
  world.addDynamic(body);

  simulate(world, 14);

  const water = world.waters[0];
  const submersion = water.bodySubmergedFraction(body);
  near(name, submersion, expectedSubmersion, tolerance);
  return { body, submersion };
}

// Um corpo com metade da densidade do fluido deve parar com metade do volume
// submerso. Nao ha nada roteirizado aqui: e a consequencia de F = rho*V*g.
buoyancyCase('densidade 0.5 -> ~50% submerso', 0.5, 0.5, 0.06);
buoyancyCase('densidade 0.25 -> ~25% submerso', 0.25, 0.25, 0.06);
buoyancyCase('densidade 0.8 -> ~80% submerso', 0.8, 0.8, 0.07);

{
  // Mais denso que a agua: afunda ate o fundo em vez de estabilizar.
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addWater(WaterVolume.fromBox(0, -5, 0, 40, 10, 40, { density: 1 }));
  world.addStatic(groundMesh(40, -10), { friction: 0.8 });
  const r = 0.5;
  const v = (4 / 3) * Math.PI * r * r * r;
  const body = new RigidBody({ shape: BodyShape.SPHERE, radius: r, mass: 4 * v, allowSleep: false });
  body.position.set(0, 1.5, 0);
  world.addDynamic(body);
  simulate(world, 14);
  check('densidade 4 afunda ate o fundo', body.position.y < -8.5,
    'y=' + body.position.y.toFixed(2));
}

{
  // Arrasto: um corpo largado na agua nao pode continuar acelerando.
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addWater(WaterVolume.fromBox(0, -50, 0, 40, 100, 40, { density: 1 }));
  const r = 0.5;
  const v = (4 / 3) * Math.PI * r * r * r;
  const body = new RigidBody({ shape: BodyShape.SPHERE, radius: r, mass: 3 * v, allowSleep: false });
  body.position.set(0, -2, 0);
  world.addDynamic(body);
  simulate(world, 6);
  const terminal = Math.abs(body.velocity.y);
  check('arrasto produz velocidade terminal', terminal < 6 && terminal > 0.05,
    'v=' + terminal.toFixed(2) + ' m/s');
}

/* --------------------------------------------------------- 2. tunelamento */

console.log('\n2. Objetos nao atravessaveis');

{
  const world = new CollisionWorld({ gravity: new Vec3(0, 0, 0), subSteps: 2 });
  // Parede fina: o caso dificil para deteccao discreta.
  world.addStatic(boxMesh(0.25, 20, 20, 5, 0, 0), { friction: 0.5 });

  const body = new RigidBody({ shape: BodyShape.SPHERE, radius: 0.4, mass: 1, allowSleep: false });
  body.position.set(0, 0, 0);
  body.velocity.set(60, 0, 0); // 60 m/s contra uma parede de 25 cm
  world.addDynamic(body);

  simulate(world, 1.5, 1 / 60);
  check('esfera a 60 m/s nao atravessa parede de 25 cm', body.position.x < 5,
    'x=' + body.position.x.toFixed(2));
}

{
  // Personagem contra uma caixa estatica.
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addStatic(groundMesh(80, 0), { friction: 0.8 });
  world.addStatic(boxMesh(4, 4, 4, 6, 2, 0), { friction: 0.6 });

  const controller = new CharacterController(world, { radius: 0.35, height: 1.8 });
  controller.teleport(new Vec3(0, 0.05, 0));

  const desired = new Vec3(8, 0, 0);
  for (let i = 0; i < 300; i++) controller.move(desired, 1 / 60);

  check('personagem e barrado pela caixa', controller.position.x < 4.0,
    'x=' + controller.position.x.toFixed(2));
  check('personagem detecta a parede', controller.hitWall === true);
  check('personagem fica no chao', controller.isGrounded === true,
    'y=' + controller.position.y.toFixed(3));
}

{
  // Sem obstaculo o mesmo movimento tem que percorrer a distancia inteira:
  // prova que o teste acima mede a colisao e nao um personagem travado.
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addStatic(groundMesh(80, 0), { friction: 0.8 });
  const controller = new CharacterController(world, { radius: 0.35, height: 1.8 });
  controller.teleport(new Vec3(0, 0.05, 0));
  const desired = new Vec3(8, 0, 0);
  for (let i = 0; i < 300; i++) controller.move(desired, 1 / 60);
  check('sem obstaculo o personagem avanca', controller.position.x > 30,
    'x=' + controller.position.x.toFixed(1));
}

/* -------------------------------------------------------------- 3. nado */

console.log('\n3. Nado do personagem');

{
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addStatic(groundMesh(120, -12), { friction: 0.8 });
  world.addWater(WaterVolume.fromBox(0, -6, 0, 100, 12, 100, { density: 1 }));

  const controller = new CharacterController(world, { radius: 0.35, height: 1.8 });
  controller.teleport(new Vec3(0, -8, 0)); // fundo do lago

  const still = new Vec3(0, 0, 0);
  for (let i = 0; i < 900; i++) controller.move(still, 1 / 60);

  const surface = 0; // topo do volume
  check('personagem sobe ate a superficie', controller.position.y > -3,
    'y=' + controller.position.y.toFixed(2));
  check('estabiliza perto da linha d\'agua',
    Math.abs(controller.position.y + controller.height * 0.5 - surface) < 1.4,
    'centro=' + (controller.position.y + controller.height * 0.5).toFixed(2));
  check('reporta que esta na agua', controller.inWater === true,
    'submersao=' + controller.submersion.toFixed(2));
}

{
  // Mergulhar: pedir velocidade para baixo tem que vencer o empuxo.
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addStatic(groundMesh(120, -12), { friction: 0.8 });
  world.addWater(WaterVolume.fromBox(0, -6, 0, 100, 12, 100, { density: 1 }));
  const controller = new CharacterController(world, { radius: 0.35, height: 1.8 });
  controller.teleport(new Vec3(0, -1, 0));
  const dive = new Vec3(0, -4, 0);
  for (let i = 0; i < 300; i++) controller.move(dive, 1 / 60);
  check('consegue mergulhar', controller.position.y < -2.5,
    'y=' + controller.position.y.toFixed(2));
}

{
  // Fora da agua nada muda: gravidade normal.
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addStatic(groundMesh(80, 0), { friction: 0.8 });
  world.addWater(WaterVolume.fromBox(60, -5, 0, 20, 10, 20, { density: 1 }));
  const controller = new CharacterController(world, { radius: 0.35, height: 1.8 });
  controller.teleport(new Vec3(0, 6, 0));
  const still = new Vec3(0, 0, 0);
  for (let i = 0; i < 240; i++) controller.move(still, 1 / 60);
  check('longe da agua cai e assenta no chao',
    controller.isGrounded === true && controller.submersion === 0,
    'y=' + controller.position.y.toFixed(3));
}

/* ------------------------------------ 3b. independencia de frame rate */

console.log('\n3b. Independencia de frame rate');

/**
 * Larga oito corpos de densidades diferentes e devolve o pior erro de
 * submersao mais o maior y — a assinatura de um corpo lancado pela correcao
 * de penetracao.
 */
function dropEight(dt, options) {
  const world = new CollisionWorld(Object.assign({ gravity: new Vec3(0, -26, 0) }, options || {}));
  world.addWater(WaterVolume.fromBox(0, -4, 0, 34, 10, 34, { density: 1, surfaceY: 1 }));
  const densities = [0.35, 0.5, 0.65, 0.85, 0.45, 0.7, 0.3, 0.55];
  const bodies = [];

  for (let i = 0; i < 8; i++) {
    const crate = (i % 2) === 0;
    const angle = (i / 8) * Math.PI * 2;
    const r = crate ? 0.55 : 0.6;
    const vol = crate ? 1.331 : (4 / 3) * Math.PI * r * r * r;
    const body = new RigidBody({
      shape: crate ? BodyShape.BOX : BodyShape.SPHERE,
      radius: r, mass: densities[i] * vol, restitution: 0.15, friction: 0.4,
    });
    if (crate) body.setShape(BodyShape.BOX, { halfExtents: new Vec3(0.55, 0.55, 0.55) });
    body.position.set(Math.cos(angle) * 7, 5 + i * 0.35, Math.sin(angle) * 7);
    world.addDynamic(body);
    bodies.push(body);
  }

  const frames = Math.round(30 / dt);
  for (let i = 0; i < frames; i++) world.step(dt);

  let worst = 0;
  let maxY = -Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const f = world.waters[0].bodySubmergedFraction(bodies[i]);
    worst = Math.max(worst, Math.abs(f - densities[i]));
    maxY = Math.max(maxY, bodies[i].position.y);
  }
  return { worst, maxY, subSteps: world.stats.subSteps };
}

{
  // O mesmo cenario em tres frame rates. Sem substep automatico, um quadro de
  // 0.33 s integra tao longe que a correcao de penetracao vira um canhao.
  const fast = dropEight(1 / 60);
  const slow = dropEight(1 / 10);
  const crawl = dropEight(0.33);
  const naive = dropEight(0.33, { autoSubSteps: false });

  near('60 fps: submersao correta', fast.worst, 0, 0.05);
  near('10 fps: mesmo resultado', slow.worst, 0, 0.05);
  near('3 fps: mesmo resultado', crawl.worst, 0, 0.05);
  check('nada e lancado a 3 fps', crawl.maxY < 3,
    'maior y=' + crawl.maxY.toFixed(2) + ', substeps=' + crawl.subSteps);
  check('sem substep automatico o solver explode (regressao)',
    naive.maxY > 10 || naive.worst > 0.2,
    'maior y=' + naive.maxY.toFixed(1) + ', erro=' + naive.worst.toFixed(2));
}

/* ------------------------------------------- 4. colisores instanciados */

console.log('\n4. Colisores instanciados');

{
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  const source = boxMesh(1, 1, 1);

  const count = 500;
  const matrices = [];
  for (let i = 0; i < count; i++) {
    const m = new Mat4();
    m.makeTranslation((i % 25) * 3 - 36, 0.5, Math.floor(i / 25) * 3 - 30);
    matrices.push(m);
  }

  const t0 = process.hrtime.bigint();
  const result = world.addStaticInstanced(source, matrices, { friction: 0.6 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  check('todas as instancias viraram colisores', result.colliders.length === count,
    result.colliders.length + '/' + count);
  check('a BVH e compartilhada', result.shared === true && result.baked === 0);

  const first = result.colliders[0].bvh;
  let allSame = true;
  for (let i = 1; i < result.colliders.length; i++) {
    if (result.colliders[i].bvh !== first) { allSame = false; break; }
  }
  check('todos referenciam a mesma BVH', allSame, ms.toFixed(1) + ' ms para ' + count);

  // E colidem de verdade.
  const controller = new CharacterController(world, { radius: 0.35, height: 1.8 });
  world.addStatic(groundMesh(200, 0), { friction: 0.8 });
  // Nasce ANTES da primeira coluna de caixas (a primeira esta em x = -36) e
  // caminha na direcao dela. Nascer em cima da caixa mediria depenetracao,
  // nao colisao.
  controller.teleport(new Vec3(-40, 0.05, -30));
  const desired = new Vec3(6, 0, 0);
  for (let i = 0; i < 180; i++) controller.move(desired, 1 / 60);
  check('instancia bloqueia o personagem', controller.position.x < -36.3,
    'x=' + controller.position.x.toFixed(2) + ' (caixa em -36)');
}

/* ------------------------------------------------------------ 5. estado */

console.log('\n5. Estado exposto');

{
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addWater(WaterVolume.fromBox(0, -5, 0, 40, 10, 40, { density: 1 }));
  const r = 0.5;
  const v = (4 / 3) * Math.PI * r * r * r;
  const body = new RigidBody({ shape: BodyShape.SPHERE, radius: r, mass: 0.5 * v, allowSleep: false });
  body.position.set(0, 0.2, 0);
  world.addDynamic(body);
  simulate(world, 3);
  check('body.inWater e body.submersion sao preenchidos',
    body.inWater === true && body.submersion > 0.1 && body.submersion <= 1,
    'submersao=' + body.submersion.toFixed(2));
  check('stats.submergedBodies conta', world.stats.submergedBodies === 1);
}

{
  // Corpos dormindo nao sao processados, senao nada que flutua para de custar.
  const world = new CollisionWorld({ gravity: new Vec3(0, -9.81, 0) });
  world.addWater(WaterVolume.fromBox(0, -5, 0, 40, 10, 40, { density: 1 }));
  const r = 0.5;
  const v = (4 / 3) * Math.PI * r * r * r;
  const body = new RigidBody({ shape: BodyShape.SPHERE, radius: r, mass: 0.5 * v });
  body.position.set(0, 0.0, 0);
  world.addDynamic(body);
  simulate(world, 25);
  check('corpo flutuando acaba dormindo', body.sleeping === true,
    'v=' + body.velocity.length().toFixed(4));
}

/* ----------------------------------------------------------- resultado */

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') +
  ' — ' + passed + ' ok, ' + failed + ' falha(s)\n');
process.exit(failed === 0 ? 0 : 1);
