/**
 * Teste do Voxel Core em Chrome real (WebGL2 via ANGLE/SwiftShader).
 *
 * Sobe o servidor estatico, carrega o jogo, espera o mundo aparecer, exercita
 * quebrar/colocar bloco e raycast, e valida os pixels da tela.
 *
 * Uso: node tools/voxel-test.mjs [--shots <dir>] [--verbose]
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
const shotsIndex = args.indexOf('--shots');
const SHOTS = shotsIndex >= 0 ? args[shotsIndex + 1] : join(ROOT, '.shots');

const PORT = 8231;

async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), '--port', String(PORT), '--quiet'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; if (verbose) process.stdout.write('[serve] ' + c); });
  child.stderr.on('data', (c) => { log += c; if (verbose) process.stderr.write('[serve] ' + c); });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/games/voxel/index.html');
      if (res.ok) return child;
    } catch { /* ainda subindo */ }
    await sleep(150);
  }
  child.kill('SIGKILL');
  throw new Error('servidor nao subiu\n' + log);
}

function line(label, value) {
  console.log('  ' + label.padEnd(26, '.') + ' ' + value);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  let server = null;
  let browser = null;
  let failed = false;

  try {
    server = await startServer();
    browser = await launch({ verbose });
    const page = await browser.newPage();

    console.log('\n=== VOXEL CORE — Chrome real ===\n');

    await page.navigate('http://127.0.0.1:' + PORT + '/games/voxel/?seed=1337&distance=5');

    // O mundo precisa de tempo: geracao + luz + meshing, tudo em SwiftShader.
    await page.waitForFunction(
      'window.game !== undefined && window.game.chunks.stats.sectionsDrawn > 0',
      180000,
      500,
    );
    console.log('  mundo carregado.\n');

    // Deixa a simulacao rodar um pouco para assentar luz e malhas.
    await sleep(12000);

    const report = await page.evaluate(`(() => {
      const g = window.game;
      const w = g.world;
      const p = g.player;

      // --- exercita o raycast olhando para baixo
      const before = g.interaction.hit.hit;

      // --- exercita edicao: quebra e recoloca um bloco sob o jogador
      const bx = Math.floor(p.body.x);
      const by = Math.floor(p.body.y) - 1;
      const bz = Math.floor(p.body.z);
      const original = w.getBlock(bx, by, bz);
      const brokeOk = w.setBlock(bx, by, bz, 0);
      const afterBreak = w.getBlock(bx, by, bz);
      const placedOk = w.setBlock(bx, by, bz, original);
      const afterPlace = w.getBlock(bx, by, bz);

      // --- amostra a coluna para conferir que o terreno tem estrutura
      let solidCount = 0;
      for (let y = 0; y < 128; y++) if (w.getBlock(bx, y, bz) !== 0) solidCount++;

      // --- luz: o ceu deve estar iluminado acima da superficie
      const surface = w.surfaceY(bx, bz);
      const skyAbove = w.getSkyLight(bx, surface + 2, bz);
      const skyDeep = w.getSkyLight(bx, 4, bz);

      const info = g.engine.renderer.info;
      return {
        chunks: w.chunkCount,
        sections: g.chunks.stats.sectionsDrawn,
        triangles: Math.round(g.chunks.stats.trianglesResident),
        drawCalls: info.calls,
        drawnTriangles: info.triangles,
        playerY: p.body.y,
        grounded: p.grounded,
        suspended: p.suspended,
        surface,
        solidCount,
        skyAbove,
        skyDeep,
        brokeOk, afterBreak, placedOk, afterPlace, original,
        raycastHit: before,
        lightQueue: g.chunks.stats.lightQueue,
        pendingGenerate: g.chunks.stats.pendingGenerate,
        fps: Math.round(g.engine.time.fps),
        error: g.chunks.lastError,
      };
    })()`);

    line('chunks carregados', report.chunks);
    line('secoes com malha', report.sections);
    line('triangulos residentes', report.triangles.toLocaleString('pt-BR'));
    line('draw calls', report.drawCalls);
    line('triangulos desenhados', report.drawnTriangles.toLocaleString('pt-BR'));
    line('jogador Y / solo', report.playerY.toFixed(2) + ' / ' + report.grounded);
    line('superficie da coluna', report.surface);
    line('blocos solidos na coluna', report.solidCount);
    line('skylight (acima/fundo)', report.skyAbove + ' / ' + report.skyDeep);
    line('quebrar/colocar', report.brokeOk + ' -> ' + report.afterBreak + ' | ' +
      report.placedOk + ' -> ' + report.afterPlace + ' (orig ' + report.original + ')');
    line('raycast acertou', report.raycastHit);
    line('fila de luz', report.lightQueue);
    line('fps (SwiftShader)', report.fps);

    // --- validacao de pixels
    // O framebuffer padrao e limpo apos a apresentacao quando
    // preserveDrawingBuffer e false, entao a leitura precisa acontecer dentro do
    // mesmo callback de rAF em que o frame foi desenhado.
    const pixels = await page.evaluate(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
      const gl = window.game.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let nonBlack = 0, sum = 0, min = 255, max = 0;
      const hist = new Array(8).fill(0);
      const n = w * h;
      for (let i = 0; i < n; i++) {
        const r = buf[i*4], g2 = buf[i*4+1], b = buf[i*4+2];
        const l = 0.2126*r + 0.7152*g2 + 0.0722*b;
        if (l > 6) nonBlack++;
        sum += l; if (l < min) min = l; if (l > max) max = l;
        hist[Math.min(7, l >> 5)]++;
      }
      const mean = sum / n;
      let varSum = 0;
      for (let i = 0; i < n; i++) {
        const r = buf[i*4], g2 = buf[i*4+1], b = buf[i*4+2];
        const l = 0.2126*r + 0.7152*g2 + 0.0722*b;
        varSum += (l - mean) * (l - mean);
      }
      resolve({ w, h, nonBlackRatio: nonBlack / n, mean, std: Math.sqrt(varSum / n),
                min, max, hist, glError: gl.getError() });
      }));
    })`, true);

    console.log('');
    line('resolucao', pixels.w + 'x' + pixels.h);
    line('pixels nao-pretos', (pixels.nonBlackRatio * 100).toFixed(2) + '%');
    line('luma media / desvio', pixels.mean.toFixed(1) + ' / ' + pixels.std.toFixed(1));
    line('luma min / max', pixels.min.toFixed(1) + ' / ' + pixels.max.toFixed(1));
    line('histograma', '[' + pixels.hist.join(', ') + ']');
    line('gl.getError', pixels.glError);

    await page.screenshot(join(SHOTS, 'voxel.png'));
    console.log('\n  screenshot: ' + join(SHOTS, 'voxel.png'));

    // --- veredito
    // O 404 de favicon.ico e ruido do navegador, nao um erro do jogo.
    const consoleErrors = page.collectConsole({ errorsOnly: true })
      .filter((m) => String(m.text || '').indexOf('favicon.ico') === -1);
    const exceptions = page.exceptions || [];

    console.log('\n=== VEREDITO ===');
    const checks = [
      ['mundo gerou chunks', report.chunks > 0],
      ['malhas foram criadas', report.sections > 0],
      ['geometria foi desenhada', report.drawCalls > 0 && report.drawnTriangles > 0],
      ['coluna tem terreno', report.solidCount > 10],
      ['skylight na superficie', report.skyAbove === 15],
      ['skylight bloqueado no fundo', report.skyDeep < 15],
      ['edicao de bloco funciona', report.brokeOk === true && report.afterBreak === 0 &&
        report.placedOk === true && report.afterPlace === report.original],
      ['jogador assentou no solo', report.suspended === false],
      ['tela nao esta preta', pixels.nonBlackRatio > 0.5],
      ['tela tem variacao', pixels.std > 8],
      ['sem erro de GL', pixels.glError === 0],
      ['sem excecao', exceptions.length === 0],
      ['sem erro de console', consoleErrors.length === 0],
    ];

    for (const [label, ok] of checks) {
      console.log('  ' + (ok ? 'ok  ' : 'FALHA') + ' ' + label);
      if (!ok) failed = true;
    }

    if (consoleErrors.length > 0) {
      console.log('\n  erros de console:');
      for (const e of consoleErrors.slice(0, 10)) console.log('    ' + (e.text || JSON.stringify(e)));
    }
    if (exceptions.length > 0) {
      console.log('\n  excecoes:');
      for (const e of exceptions.slice(0, 10)) console.log('    ' + (e.text || JSON.stringify(e)));
    }
    if (report.error) console.log('\n  erro do ChunkManager: ' + report.error);

    console.log('\n  resultado: ' + (failed ? 'FALHOU' : 'PASSOU') + '\n');
  } catch (error) {
    failed = true;
    console.error('\nerro fatal: ' + (error && error.stack ? error.stack : error) + '\n');
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignora */ } }
    if (server && server.exitCode === null) server.kill('SIGTERM');
  }

  process.exit(failed ? 1 : 0);
}

main();
