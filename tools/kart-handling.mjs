/**
 * Banco de prova de pilotagem do kart, em Node puro.
 *
 * A fisica do veiculo nao depende de WebGL, entao dirigibilidade pode ser
 * medida sem navegador nenhum — o que a torna ajustavel por numero em vez de
 * por impressao. Cada teste isola uma qualidade que se sente ao dirigir:
 * retomada, frenagem, se a traseira solta, se a direcao oscila, e se um piloto
 * ingenuo consegue dar uma volta inteira.
 *
 * Uso: node tools/kart-handling.mjs [--verbose]
 */

import { Vec3 } from '../src/math/Vec3.js';
import { CollisionWorld } from '../src/physics/CollisionWorld.js';
import { Track } from '../games/kart/src/Track.js';
import { Vehicle } from '../games/kart/src/Vehicle.js';

const verbose = process.argv.includes('--verbose');
const DT = 1 / 120;

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed++; console.log('  FALHA ' + name + (detail ? '  (' + detail + ')' : '')); }
}

/** Monta pista + colisores + kart, tudo headless. */
function makeRig() {
  const track = new Track();
  const world = new CollisionWorld({
    gravity: new Vec3(0, -11.5, 0),
    maxSubStepTime: 1 / 180,
    maxSubSteps: 8,
  });

  const road = track.buildRoadGeometry();
  world.addStatic({
    positions: road.getAttribute('aPosition').data,
    indices: road.index.data,
  }, { friction: 1.0 });

  const barriers = track.buildBarrierGeometry();
  world.addStatic({
    positions: barriers.getAttribute('aPosition').data,
    indices: barriers.index.data,
  }, { friction: 0.25, restitution: 0.32 });

  const ground = track.buildGroundGeometry(340, 64);
  const groundCollider = world.addStatic({
    positions: ground.getAttribute('aPosition').data,
    indices: ground.index.data,
  }, { friction: 0.75 });
  groundCollider.userData.offTrack = true;

  const vehicle = new Vehicle({ world, mass: 180 });
  return { track, world, vehicle };
}

/**
 * Patio de testes: um plano grande e liso.
 *
 * Aceleracao, frenagem, curva em regime e estabilidade sao qualidades DO
 * VEICULO. Medi-las na pista mede a pista: com esterco fixo o kart sai do
 * traçado, sobe no terreno e roda, e o numero que sai fala do circuito. O
 * circuito tem o seu proprio teste, que e a volta completa.
 */
function makePad() {
  const world = new CollisionWorld({
    gravity: new Vec3(0, -11.5, 0),
    maxSubStepTime: 1 / 180,
    maxSubSteps: 8,
  });
  const S = 900;
  world.addStatic({
    positions: new Float32Array([-S, 0, -S, S, 0, -S, S, 0, S, -S, 0, S]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  }, { friction: 1.0 });
  const vehicle = new Vehicle({ world, mass: 180 });
  vehicle.reset(new Vec3(0, 0.9, 0), 0);
  return { world, vehicle, track: null };
}

/** Coloca o kart no centro da pista a uma distancia da largada. */
function placeAt(rig, distance) {
  const s = rig.track.sampleAtDistance(distance);
  const p = s.position.clone().addScaled(s.normal, 0.9);
  rig.vehicle.reset(p, Math.atan2(s.forward.x, s.forward.z));
  return s;
}

function step(rig, throttle, brake, steer, handbrake) {
  rig.vehicle.setControls(throttle, brake, steer, handbrake === true);
  rig.vehicle.update(DT);
  rig.world.step(DT);
}

console.log('\n=== PILOTAGEM DO KART ===\n');

/* --------------------------------------------------------- 1. retomada */

console.log('1. Aceleracao e frenagem');
{
  const rig = makePad();

  let t50 = -1;
  let t = 0;
  let top = 0;
  for (let i = 0; i < 120 * 25; i++) {
    step(rig, 1, 0, 0, false);
    t += DT;
    if (t50 < 0 && rig.vehicle.speedKmh >= 50) t50 = t;
    if (rig.vehicle.speedKmh > top) top = rig.vehicle.speedKmh;
  }

  check('0 a 50 km/h em tempo de kart', t50 > 1.2 && t50 < 6.0,
    t50 > 0 ? t50.toFixed(2) + ' s' : 'nao chegou a 50');
  check('velocidade maxima plausivel', top > 70 && top < 140, top.toFixed(0) + ' km/h');

}
{
  // Frenagem em cenario proprio: apos 20 s a todo gas o kart esta em qualquer
  // lugar, e medir a partir dali mede o lugar, nao o freio.
  const rig = makePad();
  for (let i = 0; i < 120 * 6; i++) step(rig, 1, 0, 0, false);
  const v0 = rig.vehicle.speedKmh;
  const before = rig.vehicle.body.position.clone();
  let stopTime = -1;
  let t = 0;
  for (let i = 0; i < 120 * 12; i++) {
    step(rig, 0, 1, 0, false);
    t += DT;
    if (rig.vehicle.speedKmh < 3) { stopTime = t; break; }
  }
  const dist = rig.vehicle.body.position.distanceTo(before);
  check('freia ate parar', stopTime > 0 && stopTime < 6,
    stopTime > 0 ? 'de ' + v0.toFixed(0) + ' km/h em ' + stopTime.toFixed(2) + ' s / ' +
      dist.toFixed(1) + ' m' : 'nao parou (de ' + v0.toFixed(0) + ' km/h)');
}

/* ------------------------------------------------- 2. curva em regime */

console.log('\n2. Curva em regime permanente');
{
  const rig = makeRig();
  placeAt(rig, 60);
  // ganha velocidade em linha reta
  for (let i = 0; i < 120 * 4; i++) step(rig, 1, 0, 0, false);

  // steer fixo: o kart deve descrever um circulo estavel, nao rodar
  // Duas qualidades opostas, e as duas importam.
  //
  // Numa curva NORMAL o kart nao pode rodar: e o que separa "dirigivel" de
  // "horrivel". Mas em esterco total ele PRECISA quebrar aderencia, senao o
  // modelo de pneu nao tem limite e o carro anda sobre trilhos.
  function corner(steer, gas, seconds) {
    const rig2 = makePad();
    for (let i = 0; i < 120 * 4; i++) step(rig2, 1, 0, 0, false);
    let maxDrift = 0;
    let maxSlip = 0;
    let turned = 0;
    for (let i = 0; i < 120 * seconds; i++) {
      step(rig2, gas, 0, steer, false);
      const f = new Vec3(0, 0, 1).applyQuat(rig2.vehicle.body.quaternion);
      const v = rig2.vehicle.body.velocity;
      const vh = Math.hypot(v.x, v.z);
      if (vh > 3) {
        const cos = (f.x * v.x + f.z * v.z) / vh;
        const drift = Math.acos(Math.max(-1, Math.min(1, cos)));
        if (drift > maxDrift) maxDrift = drift;
      }
      if (rig2.vehicle.slip > maxSlip) maxSlip = rig2.vehicle.slip;
      turned += Math.abs(rig2.vehicle.body.angularVelocity.y) * DT;
    }
    return { drift: maxDrift, slip: maxSlip, turned, grounded: rig2.vehicle.groundedWheels };
  }

  const normal = corner(0.45, 0.5, 5);
  const total = corner(1.0, 1.0, 5);

  check('curva normal nao roda o kart', normal.drift < 0.65,
    (normal.drift * 57.3).toFixed(0) + ' graus de deriva');
  check('curva normal vira de verdade', normal.turned > 1.5,
    normal.turned.toFixed(1) + ' rad girados');
  check('curva normal mantem as rodas no chao', normal.grounded >= 3,
    normal.grounded + '/4');
  check('esterco total quebra aderencia', total.slip > 0.35,
    'slip ' + total.slip.toFixed(2) + ', deriva ' + (total.drift * 57.3).toFixed(0) + ' graus');
}

/* --------------------------------------------- 2b. lado e forca g */

console.log('\n2b. Sentido da direcao e forca lateral');
{
  const rig = makePad();
  for (let i = 0; i < 120 * 4; i++) step(rig, 1, 0, 0, false);

  // Direita do kart no instante em que a curva comeca.
  const f0 = new Vec3(0, 0, 1).applyQuat(rig.vehicle.body.quaternion);
  const up = new Vec3(0, 1, 0);
  const right0 = new Vec3().crossVectors(f0, up).normalize();
  const p0 = rig.vehicle.body.position.clone();

  let maxLatG = 0;
  const vPrev = rig.vehicle.body.velocity.clone();
  let prev = vPrev;
  for (let i = 0; i < 120 * 3; i++) {
    const before = rig.vehicle.body.velocity.clone();
    step(rig, 0.5, 0, 1, false);
    const after = rig.vehicle.body.velocity;
    // Aceleracao lateral: componente perpendicular ao movimento, em g.
    const f = new Vec3(0, 0, 1).applyQuat(rig.vehicle.body.quaternion);
    const r = new Vec3().crossVectors(f, up).normalize();
    const dv = after.clone().sub(before);
    const lat = Math.abs(dv.dot(r)) / DT / 9.81;
    if (lat > maxLatG) maxLatG = lat;
  }

  const desloc = rig.vehicle.body.position.clone().sub(p0);
  const paraDireita = desloc.dot(right0);

  check('esterco positivo vira para a DIREITA do kart', paraDireita > 1.0,
    paraDireita.toFixed(1) + ' m para a direita');
  check('forca lateral em faixa de kart', maxLatG > 0.6 && maxLatG < 2.2,
    maxLatG.toFixed(2) + ' g de pico');
}

{
  // Peso aparente: quanto o solo empurra o kart para cima em relacao ao peso.
  const rig = makePad();
  for (let i = 0; i < 120 * 6; i++) step(rig, 1, 0, 0, false);
  const g = 11.5;
  const peso = rig.vehicle.body.mass * g;
  const down = rig.vehicle.downforce * rig.vehicle.speed * rig.vehicle.speed * 0.5;
  const razao = (peso + down) / peso;
  check('downforce nao esmaga o kart', razao < 1.5,
    (razao).toFixed(2) + 'x o peso a ' + rig.vehicle.speedKmh.toFixed(0) + ' km/h');
}

/* ----------------------------------------- 3. estabilidade em reta */

console.log('\n3. Estabilidade em linha reta');
{
  const rig = makePad();
  for (let i = 0; i < 120 * 5; i++) step(rig, 1, 0, 0, false);

  // solta a direcao: o rumo nao pode oscilar
  const start = Math.atan2(
    new Vec3(0, 0, 1).applyQuat(rig.vehicle.body.quaternion).x,
    new Vec3(0, 0, 1).applyQuat(rig.vehicle.body.quaternion).z);
  let maxDev = 0;
  let crossings = 0;
  let prevSign = 0;
  for (let i = 0; i < 120 * 4; i++) {
    step(rig, 0.8, 0, 0, false);
    const f = new Vec3(0, 0, 1).applyQuat(rig.vehicle.body.quaternion);
    let d = Math.atan2(f.x, f.z) - start;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) > maxDev) maxDev = Math.abs(d);
    const sign = Math.sign(d);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++;
    prevSign = sign;
  }
  // No plano, com a direcao no centro, o rumo tem que ficar praticamente parado.
  check('nao oscila com a direcao solta', crossings < 6, crossings + ' inversoes de rumo');
  check('segue reto com a direcao no centro', maxDev < 0.25,
    (maxDev * 57.3).toFixed(1) + ' graus de desvio');
}

/* --------------------------------------- 4. um piloto ingenuo da a volta */

console.log('\n4. Volta completa com piloto simples');
{
  const rig = makeRig();
  placeAt(rig, 0);

  // Perseguicao pura: mira um ponto adiante na linha central. E o controlador
  // mais ingenuo que existe; se ele completa a volta, um humano tambem completa.
  let bateu = 0;
  let foraPista = 0;
  let progresso = 0;
  let ultimaDist = 0;
  let travou = false;
  const total = 120 * 150;

  for (let i = 0; i < total; i++) {
    const pos = rig.vehicle.body.position;
    const near = rig.track.nearest(pos);
    // Lookahead proporcional a velocidade: mirar sempre 14 m adiante e curto
    // demais a 80 km/h, e o piloto corta a curva e bate. Isso e correcao do
    // piloto de teste, nao do jogo.
    const olhar = 9 + rig.vehicle.speedKmh * 0.22;
    const alvo = rig.track.sampleAtDistance(near.distance + olhar);

    const f = new Vec3(0, 0, 1).applyQuat(rig.vehicle.body.quaternion);
    const para = alvo.position.clone().sub(pos);
    para.y = 0;
    para.normalize();

    // atan2(x, z) cresce de +Z para +X. Como a direita do kart e -X, um alvo a
    // direita produz erro NEGATIVO — o esterco e o negativo do erro de rumo.
    let rumo = Math.atan2(para.x, para.z) - Math.atan2(f.x, f.z);
    while (rumo > Math.PI) rumo -= Math.PI * 2;
    while (rumo < -Math.PI) rumo += Math.PI * 2;

    const steer = Math.max(-1, Math.min(1, -rumo * 2.2));
    // solta o acelerador quando a curva aperta
    const gas = Math.max(0.35, 1 - Math.abs(steer) * 0.8);
    step(rig, gas, 0, steer, false);

    if (rig.vehicle.offTrack) foraPista++;
    if (Math.abs(near.lateral) > 9) bateu++;

    // progresso ao longo da volta
    let d = near.distance - ultimaDist;
    if (d < -rig.track.length * 0.5) d += rig.track.length;
    if (d > 0 && d < 30) progresso += d;
    ultimaDist = near.distance;

    if (i > 120 * 10 && rig.vehicle.speedKmh < 3) {
      travou = true;
      if (verbose) {
        const p2 = rig.vehicle.body.position;
        const alturaPista = near.sample.position.y;
        console.log('     travou aos ' + (i * DT).toFixed(0) + ' s, ' +
          near.distance.toFixed(0) + '/' + rig.track.length.toFixed(0) + ' m, lateral ' +
          near.lateral.toFixed(1) + ' m, rodas ' + rig.vehicle.groundedWheels +
          '/4, fora=' + rig.vehicle.offTrack);
        console.log('     kart y=' + p2.y.toFixed(2) + '  pista y=' + alturaPista.toFixed(2) +
          '  diferenca ' + (p2.y - alturaPista).toFixed(2) + ' m');
      }
      break;
    }
  }

  const voltas = progresso / rig.track.length;
  check('o piloto simples completa a volta', voltas >= 1.0,
    voltas.toFixed(2) + ' voltas em 150 s');
  check('nao trava no caminho', travou === false);
  check('fica na pista', foraPista / total < 0.25,
    (foraPista / total * 100).toFixed(0) + '% do tempo fora');
  check('nao raspa a barreira o tempo todo', bateu / total < 0.15,
    (bateu / total * 100).toFixed(0) + '% do tempo alem da borda');
  if (verbose) {
    console.log('     velocidade final ' + rig.vehicle.speedKmh.toFixed(0) + ' km/h');
  }
}

console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') +
  ' — ' + passed + ' ok, ' + failed + ' falha(s)\n');
process.exit(failed === 0 ? 0 : 1);
