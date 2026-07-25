/**
 * Prova que o template starter roda de verdade, em Chrome com WebGL2.
 *
 * O starter e a primeira coisa que alguem copia. Ele importa pelo NOME do
 * pacote, resolvido por import map — um caminho de resolucao que nenhum outro
 * teste exercita, e que quebra de um jeito silencioso se o exports map ou os
 * barris sairem do lugar.
 *
 * Uso: node tools/starter-test.mjs [--shots <dir>] [--verbose]
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
const PORT = 8255;

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
      const res = await fetch('http://127.0.0.1:' + PORT + '/templates/starter/index.html');
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

    console.log('\n=== TEMPLATE STARTER — Chrome real ===\n');

    await page.navigate('http://127.0.0.1:' + PORT + '/templates/starter/index.html');
    await page.waitForFunction('globalThis.app !== undefined', 120000, 400);
    console.log('  starter iniciou.\n');

    await sleep(2000);

    const report = await page.evaluate(`(() => {
      const a = globalThis.app;

      // Avanca a fisica de forma deterministica. Em SwiftShader o starter roda a
      // poucos frames por segundo e o mundo clampa dt, entao esperar no relogio
      // adianta quase nada de simulacao — a caixa ainda estaria quicando.
      for (let i = 0; i < 600; i++) a.world.step(1 / 60);
      const info = a.engine.renderer.info;
      return {
        running: a.engine.running === true,
        frames: a.engine.time.frame,
        drawCalls: info.calls,
        triangles: info.triangles,
        meshes: a.scene.meshes ? a.scene.meshes.length : -1,
        bodyY: a.body.position.y,
        bodySettled: Math.abs(a.body.velocity.y) < 1.5,
        bodies: a.world.bodies.length,
        colliders: a.world.colliders.length,
        errorVisible: document.getElementById('fatal').style.display === 'flex',
      };
    })()`);

    check('engine esta rodando', report.running === true, report.frames + ' frames');
    check('desenhou geometria', report.drawCalls > 0 && report.triangles > 0,
      report.drawCalls + ' draw calls, ' + report.triangles + ' triangulos');
    check('cena montada', report.meshes >= 3, report.meshes + ' malhas');
    check('fisica registrada', report.bodies === 1 && report.colliders === 1);
    check('a caixa caiu e assentou no chao',
      report.bodyY > 0 && report.bodyY < 2 && report.bodySettled,
      'y=' + report.bodyY.toFixed(2));
    check('sem tela de erro', report.errorVisible === false);

    await page.screenshot(join(SHOTS, 'starter.png'));
    console.log('\n  screenshot: ' + join(SHOTS, 'starter.png'));

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
