/**
 * Valida o kart em Chrome real (WebGL2 via ANGLE).
 *
 * Este exemplo existe para exercitar quatro caminhos que nenhum outro toca, e o
 * teste cobre justamente esses: render-to-texture com camera ortografica, audio
 * posicional sintetizado, entrada analogica e dinamica de corpo rigido em
 * velocidade. A checagem mais forte le pixels de DENTRO do RenderTarget do
 * minimapa: e a unica prova de que o segundo passe realmente desenhou algo.
 *
 * Uso: node tools/kart-test.mjs [--shots <dir>] [--verbose]
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
const PORT = 8266;

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
      const res = await fetch('http://127.0.0.1:' + PORT + '/games/kart/index.html');
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

    console.log('\n=== CIRCUITO (kart) — Chrome real ===\n');

    await page.navigate('http://127.0.0.1:' + PORT + '/games/kart/');
    await page.waitForFunction('globalThis.kart !== undefined', 180000, 500);
    console.log('  jogo iniciou.\n');
    await sleep(3000);

    /* ---------------------------------------------------- 1. pista */
    console.log('1. Circuito');
    const track = await page.evaluate(`(() => {
      const g = globalThis.kart;
      return {
        samples: g.track.samples.length,
        length: g.track.length,
        checkpoints: g.track.checkpoints.length,
        colliders: g.world.colliders.length,
        meshes: g.scene.meshes ? g.scene.meshes.length : -1,
      };
    })()`);
    check('traçado amostrado', track.samples === 720, track.samples + ' amostras');
    check('volta tem comprimento plausivel', track.length > 400 && track.length < 2000,
      Math.round(track.length) + ' m');
    check('colisao registrada', track.colliders >= 3, track.colliders + ' colisores');

    /* ------------------------------------------------- 2. dinamica */
    console.log('\n2. Dinamica do kart');
    const drive = await page.evaluate(`(() => {
      const g = globalThis.kart;
      const v = g.vehicle;

      // Libera a largada e conduz a simulacao de forma deterministica: sob
      // SwiftShader o jogo roda a poucos fps e o mundo clampa dt, entao esperar
      // no relogio quase nao adianta fisica.
      g.race.state = 'racing';
      g.race.countdown = 0;

      const startPos = v.body.position.clone();

      // Acelera em linha reta.
      let maxGrounded = 0;
      for (let i = 0; i < 240; i++) {
        v.setControls(1, 0, 0, false);
        v.update(1 / 120);
        g.world.step(1 / 120);
        if (v.groundedWheels > maxGrounded) maxGrounded = v.groundedWheels;
      }
      const afterThrottle = { speed: v.speed, rpm: v.rpm,
        moved: v.body.position.distanceTo(startPos) };

      // Vira. Reposiciona antes: correndo a partir de onde a aceleracao parou,
      // o kart pode estar encostado numa barreira, e ai nao gira por colisao e
      // nao por falta de direcao. O teste tem que medir a direcao, so ela.
      const V = v.body.position.constructor;
      const gridPos = new V();
      const gridHeading = g.track.gridSlot(0, gridPos);
      v.reset(gridPos, gridHeading);
      for (let i = 0; i < 120; i++) {
        v.setControls(1, 0, 0, false);
        v.update(1 / 120);
        g.world.step(1 / 120);
      }

      // Rumo a partir do vetor forward: imune a inclinacao e rolagem, ao
      // contrario de extrair o yaw direto do quaternion.
      const fwd = new V();
      const headingOf = () => {
        fwd.set(0, 0, 1).applyQuat(v.body.quaternion);
        return Math.atan2(fwd.x, fwd.z);
      };
      const headingBefore = headingOf();
      for (let i = 0; i < 180; i++) {
        v.setControls(0.6, 0, 1, false);
        v.update(1 / 120);
        g.world.step(1 / 120);
      }
      let delta = headingOf() - headingBefore;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const headingAfter = headingBefore + delta;

      // Freia ate parar.
      for (let i = 0; i < 300; i++) {
        v.setControls(0, 1, 0, false);
        v.update(1 / 120);
        g.world.step(1 / 120);
      }
      const afterBrake = Math.abs(v.speed);

      return {
        maxGrounded,
        speed: afterThrottle.speed,
        rpm: afterThrottle.rpm,
        moved: afterThrottle.moved,
        turned: Math.abs(headingAfter - headingBefore),
        stopped: afterBrake,
        upright: v.body.position.y,
      };
    })()`);

    check('a suspensao encontra o chao', drive.maxGrounded === 4, drive.maxGrounded + '/4 rodas');
    check('acelera de parado', drive.speed > 6,
      drive.speed.toFixed(1) + ' m/s (' + (drive.speed * 3.6).toFixed(0) + ' km/h)');
    check('percorreu distancia', drive.moved > 15, drive.moved.toFixed(1) + ' m');
    check('rpm acompanha a velocidade', drive.rpm > 0.15, drive.rpm.toFixed(2));
    check('a direcao muda o rumo', drive.turned > 0.25, drive.turned.toFixed(2) + ' rad');
    check('o freio para o kart', drive.stopped < 1.5, drive.stopped.toFixed(2) + ' m/s');

    /* ------------------------------- 3. render-to-texture do minimapa */
    console.log('\n3. Minimapa (RenderTarget + camera ortografica)');
    const minimap = await page.evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const g = globalThis.kart;
        const gl = g.gl;
        const rt = g.minimap.target;

        // Le direto do framebuffer do RenderTarget: a unica prova de que o
        // segundo passe desenhou de fato, e nao apenas rodou sem erro.
        gl.bindFramebuffer(gl.FRAMEBUFFER, rt.id);
        const w = rt.width, h = rt.height;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const readError = gl.getError();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        let nonBlack = 0, sum = 0, alphaSum = 0, opaquePixels = 0;
        const n = w * h;
        for (let i = 0; i < n; i++) {
          const l = 0.2126 * buf[i*4] + 0.7152 * buf[i*4+1] + 0.0722 * buf[i*4+2];
          if (l > 8) nonBlack++;
          sum += l;
          alphaSum += buf[i*4+3];
          if (buf[i*4+3] > 200) opaquePixels++;
        }
        resolve({
          width: w, height: h,
          nonBlackRatio: nonBlack / n,
          mean: sum / n,
          meanAlpha: alphaSum / n,
          opaqueRatio: opaquePixels / n,
          readError,
          isOrtho: g.minimap.camera.isCamera === true &&
                   g.minimap.camera.left !== undefined,
          layerMask: g.minimap.camera.layers,
          overlayInScene: g.minimap.overlayScene.children.length,
        });
      }));
    })`, true);

    check('render target tem tamanho', minimap.width === 256 && minimap.height === 256,
      minimap.width + 'x' + minimap.height);
    check('camera do minimapa e ortografica', minimap.isOrtho === true,
      'mascara de layer ' + minimap.layerMask);
    check('o segundo passe desenhou na textura', minimap.nonBlackRatio > 0.05,
      (minimap.nonBlackRatio * 100).toFixed(1) + '% de pixels com conteudo, luma media ' +
      minimap.mean.toFixed(1));
    check('sem erro ao ler o render target', minimap.readError === 0);
    check('a textura do minimapa tem alfa utilizavel', minimap.opaqueRatio > 0.5,
      'alfa medio ' + minimap.meanAlpha.toFixed(1) + ', ' +
      (minimap.opaqueRatio * 100).toFixed(1) + '% opaco');

    /* ------------------------------------------------- 4. voltas */
    console.log('\n4. Cronometragem');
    const laps = await page.evaluate(`(() => {
      const g = globalThis.kart;
      const race = g.race;
      race.reset();
      race.state = 'racing';

      // Percorre os checkpoints na ordem, como um kart faria.
      const cps = g.track.checkpoints;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < cps.length; i++) {
          const cp = cps[(i + 1) % cps.length];
          const p = cp.position.clone().addScaled(cp.forward, 2.0);
          race.update(0.05, p, cp.forward);
        }
      }
      const afterOrder = { lap: race.lap, best: race.bestLap };

      // Agora tenta pular checkpoints: nao pode contar volta.
      race.reset();
      race.state = 'racing';
      const first = cps[0];
      for (let i = 0; i < 40; i++) {
        const p = first.position.clone().addScaled(first.forward, 2.0);
        race.update(0.05, p, first.forward);
      }
      const afterCheat = race.lap;

      return { laps: afterOrder.lap, best: afterOrder.best, cheatLaps: afterCheat };
    })()`);

    check('completar os checkpoints em ordem fecha voltas', laps.laps === 2,
      laps.laps + ' voltas');
    check('tempo de melhor volta registrado', Number.isFinite(laps.best),
      laps.best.toFixed(2) + ' s');
    check('cruzar so a linha nao conta volta', laps.cheatLaps === 0,
      laps.cheatLaps + ' voltas');

    /* -------------------------------------------------- 5. fantasma */
    console.log('\n5. Fantasma da melhor volta');
    const ghost = await page.evaluate(`(() => {
      const g = globalThis.kart;
      const gh = g.ghost;
      const V = g.vehicle.body.position.constructor;
      const Q = g.vehicle.body.quaternion.constructor;

      gh.beginLap();
      for (let i = 0; i < 400; i++) {
        const t = i / 400;
        const p = new V(Math.sin(t * 6.28) * 20, 1, Math.cos(t * 6.28) * 20);
        const q = new Q(); q.setFromAxisAngle(new V(0, 1, 0), t * 6.28);
        gh.record(1 / 20, p, q);
      }
      const promoted = gh.endLap(20, true);
      gh.restart();

      const samples = [];
      for (let i = 0; i < 60; i++) { gh.update(0.1); samples.push(gh.position.clone()); }
      let moved = 0;
      for (let i = 1; i < samples.length; i++) moved += samples[i].distanceTo(samples[i-1]);

      const rejected = gh.endLap(30, false);
      return { promoted, count: gh.count, duration: gh.duration, moved, rejected };
    })()`);

    check('a melhor volta vira fantasma', ghost.promoted === true,
      ghost.count + ' amostras, ' + ghost.duration + ' s');
    check('o fantasma se move ao reproduzir', ghost.moved > 10,
      ghost.moved.toFixed(1) + ' m');
    check('volta mais lenta nao substitui o fantasma', ghost.rejected === false);

    /* ---------------------------------------------------- 6. audio */
    console.log('\n6. Audio');
    const audio = await page.evaluate(`(() => {
      const g = globalThis.kart;
      const ctx = g.audioEngine ? g.audioEngine.context : null;
      // O buffer do motor e sintetizado: da para conferir sem gesto do usuario.
      const mod = g.audio;
      // O contexto existe assim que a AudioEngine e construida; start() so
      // monta o grafo, e um contexto suspenso ainda aceita createBuffer.
      if (!mod.ready && ctx) mod.start();

      // O buffer do motor e sintetizado, entao da para conferir o resultado sem
      // depender de gesto do usuario: basta o contexto existir.
      let peak = 0, length = 0;
      if (ctx) {
        const buf = mod.engineBuffer || null;
        if (buf) {
          const d = buf.getChannelData(0);
          length = d.length;
          for (let i = 0; i < d.length; i += 17) {
            const a = Math.abs(d[i]); if (a > peak) peak = a;
          }
        }
      }
      return {
        hasContext: ctx !== null && ctx !== undefined,
        supported: g.audioEngine ? g.audioEngine.supported : false,
        sampleRate: ctx ? ctx.sampleRate : 0,
        bufferSamples: length,
        bufferPeak: peak,
        started: mod.ready,
      };
    })()`);
    check('contexto de audio existe', audio.hasContext === true,
      audio.sampleRate + ' Hz, supported=' + audio.supported);
    check('nota do motor foi sintetizada', audio.bufferSamples > 1000 &&
      audio.bufferPeak > 0.3 && audio.bufferPeak <= 1.0,
      audio.bufferSamples + ' amostras, pico ' + audio.bufferPeak.toFixed(2));

    /* ------------------------------------------------- screenshot */
    await sleep(2500);
    await page.screenshot(join(SHOTS, 'kart.png'));
    console.log('\n  screenshot: ' + join(SHOTS, 'kart.png'));

    const state = await page.evaluate(`(() => {
      const g = globalThis.kart;
      const info = g.engine.renderer.info;
      const gl = g.gl;
      return {
        drawCalls: info.calls, triangles: info.triangles,
        glError: gl.getError(),
        fatal: document.getElementById('fatal').style.display === 'flex',
      };
    })()`);
    console.log('  ' + state.drawCalls + ' draw calls, ' +
      state.triangles.toLocaleString('pt-BR') + ' triangulos');
    check('sem erro de GL', state.glError === 0);
    check('sem tela de erro', state.fatal === false);

    const consoleErrors = page.collectConsole({ errorsOnly: true })
      .filter((m) => String(m.text || '').indexOf('favicon.ico') === -1);
    check('sem erro de console', consoleErrors.length === 0, consoleErrors.length + ' erro(s)');
    for (const e of consoleErrors.slice(0, 6)) console.log('     ' + e.text);

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
