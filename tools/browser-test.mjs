/**
 * browser-test.mjs - harness de teste da engine em CHROME REAL (WebGL2 de
 * verdade, via ANGLE/SwiftShader), usando SOMENTE Node puro + CDP sobre o
 * WebSocket nativo do Node 22. Zero dependencias, zero build step.
 *
 * COMO RODAR
 *
 *   node tools/browser-test.mjs
 *
 * Opcoes:
 *   --keep-open        nao fecha o Chrome no fim (debug)
 *   --verbose          ecoa o stderr do Chrome
 *   --headful          desliga o modo headless (precisa de display)
 *   --skip-demo        so roda a pagina de teste, nao abre a demo
 *   --timeout <ms>     prazo para window.__TEST_DONE (padrao 180000)
 *   --demo-time <ms>   tempo de execucao da demo (padrao 25000)
 *   --out <dir>        diretorio dos screenshots
 *
 * O que ele faz, em ordem:
 *   1. sobe tools/serve.mjs numa porta livre;
 *   2. abre o Chrome headless com SwiftShader e navega para
 *      /tools/browser-scene.html;
 *   3. espera window.__TEST_DONE, le window.__TEST_RESULT, imprime o relatorio
 *      e salva o screenshot engine-test.png;
 *   4. navega para /index.html (a demo real), deixa rodar, coleta erros de
 *      console e excecoes, salva engine-demo.png;
 *   5. mata tudo (chrome + servidor) mesmo em caso de erro ou timeout.
 *
 * Sai com codigo != 0 quando ha falha real.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const DEFAULT_OUT = '/tmp/claude-1000/-home-aicoders-workspace-aicoders-engine/b554dafd-658c-461a-9091-7005e2119357/scratchpad';

/* ========================================================================== *
 * argv
 * ========================================================================== */

/**
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv) {
  const options = {
    keepOpen: false,
    verbose: false,
    headful: false,
    skipDemo: false,
    timeout: 180000,
    demoTime: 25000,
    out: DEFAULT_OUT,
    quality: 'low'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--headful') options.headful = true;
    else if (arg === '--skip-demo') options.skipDemo = true;
    else if (arg === '--timeout') options.timeout = parseInt(argv[++i], 10);
    else if (arg === '--demo-time') options.demoTime = parseInt(argv[++i], 10);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--quality') options.quality = argv[++i];
  }
  return options;
}

/* ========================================================================== *
 * Servidor estatico
 * ========================================================================== */

/**
 * Descobre uma porta TCP livre.
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Sobe tools/serve.mjs como processo filho e espera ficar pronto.
 * @param {number} port
 * @param {boolean} verbose
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
async function startServer(port, verbose) {
  const child = spawn(process.execPath, [join(HERE, 'serve.mjs'), '--port', String(port), '--quiet'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let serverLog = '';
  child.stdout.on('data', (chunk) => {
    serverLog += chunk;
    if (verbose) process.stdout.write('[serve] ' + chunk);
  });
  child.stderr.on('data', (chunk) => {
    serverLog += chunk;
    if (verbose) process.stderr.write('[serve] ' + chunk);
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error('serve.mjs terminou antes de ficar pronto (code=' + child.exitCode + ')\n' + serverLog);
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/src/index.js', { method: 'HEAD' });
      if (response.ok || response.status === 405) break;
    } catch {
      /* ainda subindo */
    }
    if (Date.now() > deadline) {
      throw new Error('timeout esperando serve.mjs na porta ' + port + '\n' + serverLog);
    }
    await sleep(120);
  }
  return child;
}

/* ========================================================================== *
 * Relatorio
 * ========================================================================== */

const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const GREEN = '\u001b[32m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

const useColor = process.stdout.isTTY && !process.argv.includes('--no-color');
const c = (code, text) => (useColor ? code + text + RESET : text);

/**
 * @param {string} title
 */
function heading(title) {
  console.log('');
  console.log(c(BOLD, '=== ' + title + ' ' + '='.repeat(Math.max(0, 66 - title.length))));
}

/**
 * Imprime o relatorio legivel do resultado da pagina de teste.
 * @param {Object} result
 */
function printReport(result) {
  heading('AMBIENTE');
  const env = result.environment || {};
  console.log('  renderer   : ' + env.renderer);
  console.log('  version    : ' + env.version + '   GLSL: ' + env.glsl);
  console.log('  drawBuffer : ' + (env.drawingBuffer ? env.drawingBuffer.join('x') : '?') +
    '   maxTexture: ' + env.maxTextureSize + '   maxSamples: ' + env.maxSamples);
  console.log('  extensoes  : EXT_color_buffer_float=' + env.colorBufferFloat +
    '  OES_texture_float_linear=' + env.floatLinear);
  if (env.subsystems) {
    console.log('  subsistemas: ' + Object.keys(env.subsystems)
      .map((k) => k + '=' + env.subsystems[k]).join('  '));
  }

  heading('FASES');
  for (const phase of result.phases || []) {
    const mark = phase.ok ? c(GREEN, 'ok  ') : c(RED, 'FALHA');
    console.log('  ' + mark + ' ' + String(phase.ms).padStart(6) + 'ms  ' + phase.name);
    if (phase.error) console.log('        ' + c(RED, phase.error));
    if (phase.detail !== null && phase.detail !== undefined) {
      const text = typeof phase.detail === 'string' ? phase.detail : JSON.stringify(phase.detail);
      console.log('        ' + c(DIM, text.length > 400 ? text.slice(0, 400) + '...' : text));
    }
  }

  heading('METRICAS');
  const metrics = result.metrics || {};
  for (const key of Object.keys(metrics)) {
    console.log('  ' + key.padEnd(20) + metrics[key]);
  }

  heading('PIXELS');
  const pixels = result.pixelStats || {};
  if (pixels.pixels) {
    console.log('  resolucao      : ' + pixels.width + 'x' + pixels.height + ' (' + pixels.pixels + ' px)');
    console.log('  nao-pretos     : ' + (pixels.nonBlackRatio * 100).toFixed(2) + '%');
    console.log('  brancos sat.   : ' + (pixels.whiteRatio * 100).toFixed(2) + '%');
    console.log('  luma media     : ' + pixels.meanLuma.toFixed(2) +
      '   desvio: ' + pixels.stdDevLuma.toFixed(2) +
      '   min: ' + pixels.minLuma.toFixed(1) + '   max: ' + pixels.maxLuma.toFixed(1));
    console.log('  media RGB      : ' + pixels.meanRGB.map((v) => v.toFixed(1)).join(' / '));
    console.log('  histograma luma: [' + pixels.histogram.join(', ') + ']  (8 faixas de 32)');
  } else {
    console.log('  ' + c(YELLOW, 'nenhum readPixels capturado'));
  }

  const failures = result.shaderFailures || [];
  heading('SHADERS (' + failures.length + ' falha(s))');
  if (failures.length === 0) {
    console.log('  ' + c(GREEN, 'todas as permutacoes compilaram e linkaram.'));
  }
  for (const failure of failures) {
    console.log('  ' + c(RED, failure.program) + '  defines: ' + failure.defines);
    for (const line of String(failure.infoLog || '').split('\n')) console.log('      ' + line);
    if (failure.report) {
      console.log('      ' + c(DIM, '--- relatorio da engine ---'));
      for (const line of String(failure.report).split('\n').slice(0, 40)) console.log('      ' + c(DIM, line));
    }
  }

  const warnings = result.shaderWarnings || [];
  if (warnings.length > 0) {
    heading('SHADERS - infoLog de link nao vazio (' + warnings.length + ')');
    for (const warning of warnings.slice(0, 20)) {
      console.log('  ' + c(YELLOW, warning.program) + '  ' + warning.defines);
      for (const line of String(warning.infoLog).split('\n')) console.log('      ' + line);
    }
  }

  const glErrors = result.glErrors || [];
  heading('gl.getError (' + glErrors.length + ')');
  if (glErrors.length === 0) console.log('  ' + c(GREEN, 'nenhum erro de GL.'));
  const stages = new Map();
  for (const error of glErrors) {
    const key = error.name + ' em "' + error.stage.replace(/frame \d+/, 'frame N') + '"';
    stages.set(key, (stages.get(key) || 0) + 1);
  }
  for (const [key, count] of stages) {
    console.log('  ' + c(RED, key) + (count > 1 ? '  x' + count : ''));
  }

  const traces = result.glErrorTraces || [];
  if (traces.length > 0) {
    heading('ORIGEM DOS gl.getError (frame instrumentado)');
    for (const trace of traces) {
      console.log('  ' + c(RED, trace.error) + ' apos ' + trace.call);
      for (const line of String(trace.stack || '').split('\n')) {
        if (line.trim().length > 0) console.log('      ' + c(DIM, line.trim()));
      }
    }
  }

  const errors = result.errors || [];
  heading('ERROS / EXCECOES (' + errors.length + ')');
  if (errors.length === 0) console.log('  ' + c(GREEN, 'nenhuma excecao.'));
  for (const error of errors) {
    console.log('  ' + c(RED, '[' + error.stage + '] ') + error.message);
    if (error.source) console.log('      ' + c(DIM, error.source));
    if (error.stack) {
      for (const line of String(error.stack).split('\n').slice(0, 8)) console.log('      ' + c(DIM, line));
    }
  }

  if (result.notes && result.notes.length > 0) {
    heading('NOTAS');
    for (const note of result.notes) console.log('  ' + c(YELLOW, note));
  }
}

/**
 * Filtra o console da pagina para o que interessa como erro.
 * @param {Array<Object>} messages
 * @returns {Array<Object>}
 */
function realConsoleErrors(messages) {
  return messages.filter((message) => {
    if (message.type !== 'error' && message.type !== 'assert') return false;
    const text = message.text || '';
    // Favicon ausente e ruido do browser, nao da engine.
    if (/favicon\.ico/.test(text)) return false;
    return true;
  });
}

/* ========================================================================== *
 * Main
 * ========================================================================== */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.out, { recursive: true });

  const summary = {
    ok: false,
    testResult: null,
    demo: { consoleErrors: [], exceptions: [], screenshot: null, frames: null },
    screenshots: [],
    fatal: null
  };

  let server = null;
  let browser = null;

  const hardKill = () => {
    try {
      if (server && server.exitCode === null) server.kill('SIGKILL');
    } catch { /* nada */ }
    try {
      if (browser && browser.process && browser.process.exitCode === null) browser.process.kill('SIGKILL');
    } catch { /* nada */ }
  };
  process.on('exit', hardKill);
  process.on('SIGINT', () => { hardKill(); process.exit(130); });
  process.on('SIGTERM', () => { hardKill(); process.exit(143); });

  try {
    const port = await freePort();
    console.log(c(DIM, 'servidor estatico: http://127.0.0.1:' + port + '/  (raiz ' + ROOT + ')'));
    server = await startServer(port, options.verbose);

    const launchOptions = { verbose: options.verbose };
    if (options.headful) launchOptions.headless = false;
    browser = await launch(launchOptions);
    console.log(c(DIM, 'chrome: ' + browser.binary + '  perfil GL: ' + browser.profile));

    /* ------------------------------------------------ 1. pagina de teste */
    const page = await browser.newPage();
    const testURL = 'http://127.0.0.1:' + port + '/tools/browser-scene.html';
    console.log(c(DIM, 'navegando para ' + testURL));

    const started = Date.now();
    await page.navigate(testURL, { timeout: 60000 });
    await page.waitForFunction('window.__TEST_DONE === true', options.timeout, 500);
    console.log(c(DIM, 'teste concluido em ' + ((Date.now() - started) / 1000).toFixed(1) + 's'));

    const result = await page.evaluate('window.__TEST_RESULT');
    summary.testResult = result;

    const shotPath = join(options.out, 'engine-test.png');
    await page.screenshot(shotPath);
    summary.screenshots.push(shotPath);

    printReport(result);

    heading('CONSOLE DA PAGINA DE TESTE');
    const pageErrors = realConsoleErrors(page.consoleMessages);
    if (pageErrors.length === 0 && page.exceptions.length === 0) {
      console.log('  ' + c(GREEN, 'sem erros de console.'));
    }
    for (const message of pageErrors.slice(0, 30)) {
      console.log('  ' + c(RED, 'console.' + message.type) + ' ' + message.text.slice(0, 900));
    }
    for (const exception of page.exceptions.slice(0, 10)) {
      console.log('  ' + c(RED, 'excecao ') + exception.text.split('\n')[0]);
      if (exception.stack) console.log(c(DIM, exception.stack));
    }
    console.log('  screenshot: ' + shotPath);

    /* -------------------------------------------------------- 2. a demo */
    if (!options.skipDemo) {
      const demoPage = await browser.newPage();
      const demoURL = 'http://127.0.0.1:' + port + '/index.html?quality=' + options.quality;
      heading('DEMO REAL');
      console.log('  ' + demoURL);

      await demoPage.navigate(demoURL, { timeout: 90000 });
      const demoStart = Date.now();
      // Deixa a demo rodar. Nao ha "pronto" observavel garantido, entao o
      // criterio e tempo de execucao mais um poll do estado exposto.
      while (Date.now() - demoStart < options.demoTime) {
        await sleep(1000);
      }

      const demoState = await demoPage.evaluate(`(() => {
        const demo = globalThis.aicodersDemo || null;
        if (!demo) return { booted: false };
        const info = demo.renderer && demo.renderer.info ? demo.renderer.info : {};
        return {
          booted: true,
          running: demo.engine ? demo.engine.running : null,
          frames: info.frame || 0,
          drawCalls: info.drawCalls || 0,
          triangles: info.triangles || 0,
          visibleMeshes: info.visibleMeshes || 0,
          errorVisible: !!(document.getElementById('error') && !document.getElementById('error').classList.contains('hidden')),
          errorDetail: (document.getElementById('error-detail') || {}).textContent || ''
        };
      })()`);

      const demoShot = join(options.out, 'engine-demo.png');
      await demoPage.screenshot(demoShot);
      summary.screenshots.push(demoShot);
      summary.demo.screenshot = demoShot;
      summary.demo.frames = demoState;

      const demoErrors = realConsoleErrors(demoPage.consoleMessages);
      summary.demo.consoleErrors = demoErrors;
      summary.demo.exceptions = demoPage.exceptions.slice();

      console.log('  estado     : ' + JSON.stringify(demoState));
      console.log('  screenshot : ' + demoShot);
      if (demoErrors.length === 0 && demoPage.exceptions.length === 0) {
        console.log('  ' + c(GREEN, 'sem erros de console na demo.'));
      }
      for (const message of demoErrors.slice(0, 30)) {
        console.log('  ' + c(RED, 'console.' + message.type) + ' ' + message.text.slice(0, 900));
      }
      for (const exception of demoPage.exceptions.slice(0, 10)) {
        console.log('  ' + c(RED, 'excecao ') + exception.text.split('\n')[0]);
        if (exception.stack) console.log(c(DIM, exception.stack));
      }
    }

    /* -------------------------------------------------------- veredito */
    const testOk = result && result.ok === true;
    const demoOk = options.skipDemo ||
      (summary.demo.consoleErrors.length === 0 &&
       summary.demo.exceptions.length === 0 &&
       summary.demo.frames && summary.demo.frames.booted === true &&
       summary.demo.frames.errorVisible !== true);
    const pageOk = pageErrors.length === 0 && page.exceptions.length === 0;

    summary.ok = testOk && demoOk && pageOk;

    heading('VEREDITO');
    console.log('  pagina de teste : ' + (testOk ? c(GREEN, 'OK') : c(RED, 'FALHOU')));
    console.log('  console da pagina: ' + (pageOk ? c(GREEN, 'OK') : c(RED, 'ERROS')));
    if (!options.skipDemo) console.log('  demo real       : ' + (demoOk ? c(GREEN, 'OK') : c(RED, 'FALHOU')));
    console.log('  resultado       : ' + (summary.ok ? c(GREEN, 'PASSOU') : c(RED, 'FALHOU')));
  } catch (error) {
    summary.fatal = error && error.stack ? error.stack : String(error);
    console.error('');
    console.error(c(RED, 'ERRO FATAL DO HARNESS: ') + (error && error.message ? error.message : error));
    if (error && error.stack) console.error(c(DIM, error.stack));
  } finally {
    writeFileSync(join(options.out, 'engine-test-result.json'), JSON.stringify(summary, null, 2));
    if (!options.keepOpen) {
      if (browser) await browser.close().catch(() => {});
      if (server && server.exitCode === null) server.kill('SIGTERM');
    }
  }

  return summary.ok ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
  // O Chrome ja morreu; nada deve segurar o event loop, mas garantimos a saida.
  setTimeout(() => process.exit(code), 250).unref();
});
