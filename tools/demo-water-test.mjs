/**
 * Valida colisao e agua NA DEMO REAL, em Chrome com WebGL2 (ANGLE).
 *
 * O teste em Node (tools/physics-test.mjs) prova a fisica isolada; este prova
 * que ela esta de fato ligada na cena: colisores registrados, corpos flutuando
 * na linha d'agua correspondente a sua densidade, e o personagem nadando.
 *
 * Uso: node tools/demo-water-test.mjs [--shots <dir>] [--verbose]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const si = args.indexOf('--shots');
const SHOTS = si >= 0 ? args[si + 1] : join(ROOT, '.shots');
const PORT = 8244;

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { failed++; console.log('  FALHA ' + name + (detail ? '  (' + detail + ')' : '')); }
}

async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), '--port', String(PORT), '--quiet'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; if (verbose) process.stdout.write('[serve] ' + c); });
  child.stderr.on('data', (c) => { log += c; if (verbose) process.stderr.write('[serve] ' + c); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/index.html');
      if (res.ok) return child;
    } catch { /* subindo */ }
    await sleep(150);
  }
  child.kill('SIGKILL');
  throw new Error('servidor nao subiu\n' + log);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  let server = null;
  let browser = null;

  try {
    server = await startServer();
    browser = await launch({ verbose });
    const page = await browser.newPage();

    console.log('\n=== COLISAO E AGUA NA DEMO — Chrome real ===\n');

    await page.navigate('http://127.0.0.1:' + PORT + '/index.html?quality=low');
    await page.waitForFunction(
      'globalThis.aicodersDemo !== undefined && globalThis.aicodersDemo.collisionWorld !== null && ' +
      'globalThis.aicodersDemo.floaters !== undefined && globalThis.aicodersDemo.floaters.length > 0',
      180000, 500,
    );
    console.log('  demo carregada.\n');

    // --- 1. colisores registrados
    const colliders = await page.evaluate(`(() => {
      const d = globalThis.aicodersDemo;
      const w = d.collisionWorld;
      return {
        total: d.colliderCount,
        worldColliders: w.colliders.length,
        instancedGroups: d.scatterColliders.length,
        sharedAll: d.scatterColliders.every((r) => r.shared === true),
        bakedTotal: d.scatterColliders.reduce((a, r) => a + r.baked, 0),
      };
    })()`);

    console.log('1. Colisores');
    check('cena tem colisores alem do terreno', colliders.total > 50,
      colliders.total + ' registrados, ' + colliders.worldColliders + ' no mundo');
    check('scatter virou colisor', colliders.instancedGroups > 0,
      colliders.instancedGroups + ' grupos, ' + colliders.bakedTotal + ' bakeados');

    // --- 2. objeto hero e solido
    console.log('\n2. Objetos nao atravessaveis');
    const solid = await page.evaluate(`(() => {
      const d = globalThis.aicodersDemo;
      const c = d.controller.controller || d.controller;
      const V = c.position.constructor;

      // O pedestal fica na origem; caminha contra ele a partir de fora.
      const start = new V(0, 0, -22);
      c.teleport(start);
      const desired = new V(0, 0, 9);
      for (let i = 0; i < 400; i++) c.move(desired, 1 / 60);
      const blockedZ = c.position.z;

      // Mesmo movimento numa direcao livre, para provar que nao esta travado.
      c.teleport(new V(-120, 40, -120));
      for (let i = 0; i < 400; i++) c.move(desired, 1 / 60);
      const freeZ = c.position.z;

      return { blockedZ, freeZ, hitWall: c.hitWall };
    })()`);
    const blockedRun = solid.blockedZ - (-22);
    const freeRun = solid.freeZ - (-120);
    check('em area livre o movimento avanca', freeRun > 30, 'avancou ' + freeRun.toFixed(1) + ' m');
    check('objetos hero barram o personagem', blockedRun < freeRun * 0.7,
      'com obstaculo andou ' + blockedRun.toFixed(1) + ' m contra ' + freeRun.toFixed(1) + ' m livres');

    // --- 3. flutuacao por densidade
    console.log('\n3. Flutuacao (Arquimedes)');

    // Avanca a simulacao de forma deterministica em vez de esperar o relogio:
    // sob SwiftShader a demo roda a ~3 fps, e como o mundo clampa dt em 0.1 s,
    // esperar 10 s reais adiantaria menos de 3 s de fisica — os corpos ainda
    // estariam oscilando na queda.
    const floaters = await page.evaluate(`(() => {
      const d = globalThis.aicodersDemo;
      const water = d.waterVolume;
      for (let i = 0; i < 1800; i++) d.collisionWorld.step(1 / 60);
      return d.floaters.map((f) => ({
        density: f.density,
        submersion: water.bodySubmergedFraction(f.body),
        y: f.body.position.y,
        sleeping: f.body.sleeping,
        shape: f.body.shape,
      }));
    })()`);

    let worst = 0;
    for (const f of floaters) {
      const err = Math.abs(f.submersion - f.density);
      if (err > worst) worst = err;
      if (verbose) {
        console.log('     densidade ' + f.density.toFixed(2) + ' -> submersao ' +
          f.submersion.toFixed(2) + '  (' + f.shape + ', y=' + f.y.toFixed(2) + ')');
      }
    }
    check('submersao segue a densidade em todos os corpos', worst < 0.14,
      'maior erro ' + worst.toFixed(3) + ' em ' + floaters.length + ' corpos');
    check('corpos leves ficam mais para fora que os pesados',
      floaters[0].submersion < floaters[3].submersion,
      'd=0.35 -> ' + floaters[0].submersion.toFixed(2) +
      ' | d=0.85 -> ' + floaters[3].submersion.toFixed(2));
    check('nenhum corpo afundou ate o fundo',
      floaters.every((f) => f.y > -6), 'menor y=' +
      Math.min.apply(null, floaters.map((f) => f.y)).toFixed(2));

    // --- 4. nado
    console.log('\n4. Nado');
    const swim = await page.evaluate(`(() => {
      const d = globalThis.aicodersDemo;
      const c = d.controller.controller || d.controller;
      const V = c.position.constructor;
      const lake = d.waterVolume;
      const cx = (lake.aabb.min.x + lake.aabb.max.x) / 2;
      const cz = (lake.aabb.min.z + lake.aabb.max.z) / 2;

      // Larga o personagem no fundo do lago.
      c.teleport(new V(cx, lake.surfaceY - 4.5, cz));
      const still = new V(0, 0, 0);
      let sawWater = false;
      for (let i = 0; i < 600; i++) {
        c.move(still, 1 / 60);
        if (c.inWater === true) sawWater = true;
      }
      const floatY = c.position.y;
      const sub = c.submersion;

      // Mergulhar tem que vencer o empuxo.
      const dive = new V(0, -4, 0);
      for (let i = 0; i < 240; i++) c.move(dive, 1 / 60);
      const diveY = c.position.y;

      return { sawWater, floatY, sub, diveY, surface: lake.surfaceY, swimming: c.swimming };
    })()`);

    check('personagem detecta a agua', swim.sawWater === true);
    check('sobe do fundo ate a superficie', swim.floatY > swim.surface - 2.2,
      'y=' + swim.floatY.toFixed(2) + ', superficie=' + swim.surface);
    check('estabiliza parcialmente submerso', swim.sub > 0.4 && swim.sub < 0.95,
      'submersao=' + swim.sub.toFixed(2));
    check('consegue mergulhar', swim.diveY < swim.floatY - 1.0,
      'y=' + swim.diveY.toFixed(2));

    // --- 5. captura de teclas
    console.log('\n5. Teclas do jogo x atalhos do browser');
    const keys = await page.evaluate(`(() => {
      const input = globalThis.aicodersDemo.engine.input;
      const make = (code, mods) => Object.assign(
        { code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
          preventDefault() { this.__prevented = true; }, __prevented: false }, mods || {});

      const probe = (code, mods) => {
        const e = make(code, mods);
        input._shouldCapture(e, code);
        return input._shouldCapture(e, code);
      };

      input.captureMode = 'always';
      const captured = {
        space: probe('Space'),
        tab: probe('Tab'),
        ctrlS: probe('KeyS', { ctrlKey: true }),
        ctrlF: probe('KeyF', { ctrlKey: true }),
        slash: probe('Slash'),
      };
      const reserved = {
        escape: probe('Escape'),
        f5: probe('F5'),
        f12: probe('F12'),
        ctrlW: probe('KeyW', { ctrlKey: true }),
        ctrlT: probe('KeyT', { ctrlKey: true }),
      };

      input.captureMode = 'off';
      const whenOff = probe('Space');

      input.captureMode = 'pointerlock';
      return { captured, reserved, whenOff, mode: input.captureMode };
    })()`);

    check('captura Space/Tab/Ctrl+S/Ctrl+F//',
      keys.captured.space && keys.captured.tab && keys.captured.ctrlS &&
      keys.captured.ctrlF && keys.captured.slash);
    check('NUNCA captura Esc/F5/F12/Ctrl+W/Ctrl+T',
      !keys.reserved.escape && !keys.reserved.f5 && !keys.reserved.f12 &&
      !keys.reserved.ctrlW && !keys.reserved.ctrlT);
    check('modo off nao captura nada', keys.whenOff === false);

    // --- screenshot do lago
    await page.evaluate(`(() => {
      const d = globalThis.aicodersDemo;
      const lake = d.waterVolume;
      const cx = (lake.aabb.min.x + lake.aabb.max.x) / 2;
      const cz = (lake.aabb.min.z + lake.aabb.max.z) / 2;
      const c = d.controller.controller || d.controller;
      const V = c.position.constructor;
      c.teleport(new V(cx - 26, lake.surfaceY + 7, cz - 24));
      d.camera.position.set(cx - 26, lake.surfaceY + 8, cz - 24);
      d.camera.lookAt(cx, lake.surfaceY, cz);
      d.camera.updateMatrix();
      d.camera.updateWorldMatrix(true);
      if (d.cameraMode !== undefined) d.cameraMode = 'orbit';
    })()`);
    await sleep(6000);
    await page.screenshot(join(SHOTS, 'demo-water.png'));
    console.log('\n  screenshot: ' + join(SHOTS, 'demo-water.png'));

    const consoleErrors = page.collectConsole({ errorsOnly: true })
      .filter((m) => String(m.text || '').indexOf('favicon.ico') === -1);
    check('sem erro de console', consoleErrors.length === 0,
      consoleErrors.length + ' erro(s)');
    for (const e of consoleErrors.slice(0, 5)) console.log('     ' + e.text);

    console.log('\n' + (failed === 0 ? 'PASSOU' : 'FALHOU') +
      ' — ' + passed + ' ok, ' + failed + ' falha(s)\n');
  } catch (error) {
    failed++;
    console.error('\nerro fatal: ' + (error && error.stack ? error.stack : error) + '\n');
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignora */ } }
    if (server && server.exitCode === null) server.kill('SIGTERM');
  }

  process.exit(failed === 0 ? 0 : 1);
}

main();
