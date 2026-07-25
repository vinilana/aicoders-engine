/**
 * cdp.mjs - cliente Chrome DevTools Protocol minimo, sem NENHUMA dependencia.
 *
 * Usa apenas o Node 22: `child_process.spawn` para subir o Chrome e o WebSocket
 * NATIVO (`globalThis.WebSocket`) para falar CDP. Nao existe playwright nem
 * puppeteer aqui e nada deve ser instalado.
 *
 * Uso tipico:
 *
 *   import { launch } from './cdp.mjs';
 *   const browser = await launch();
 *   const page = await browser.newPage();
 *   await page.navigate('http://127.0.0.1:8080/index.html');
 *   await page.waitForFunction('window.__TEST_DONE === true', 180000);
 *   const result = await page.evaluate('window.__TEST_RESULT', false);
 *   await page.screenshot('/tmp/shot.png');
 *   await browser.close();
 *
 * Regras de projeto:
 *  - `send()` correlaciona respostas por id e devolve uma Promise;
 *  - `evaluate()` devolve o valor SERIALIZADO e PROPAGA excecoes com stack;
 *  - `close()` mata o processo e limpa o `--user-data-dir` temporario;
 *  - toda sessao de pagina usa "flat mode" (sessionId no proprio envelope), de
 *    forma que um unico WebSocket atende browser e paginas.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Tempo maximo, em ms, esperando a linha "DevTools listening on ws://..." */
const LAUNCH_TIMEOUT_MS = 30000;

/** Flags base, aplicadas a qualquer perfil de lancamento. */
const BASE_ARGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--window-size=1280,800',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--hide-scrollbars',
  '--mute-audio'
];

/**
 * Perfis de GL tentados em ordem. O primeiro que subir e expuser WebGL2 vence.
 * @type {Array<{name:string, args:string[]}>}
 */
export const GL_PROFILES = [
  { name: 'angle-swiftshader', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  { name: 'swiftshader', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
  { name: 'angle-vulkan', args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] },
  { name: 'angle-swiftshader-single-process', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--single-process'] }
];

/* ========================================================================== *
 * Localizacao do binario
 * ========================================================================== */

/**
 * Expande um padrao simples `dir/<glob>/resto` procurando o primeiro diretorio
 * que casa com o prefixo dado.
 * @param {string} baseDir
 * @param {string} prefix
 * @param {string} tail
 * @returns {string[]}
 */
function globOneLevel(baseDir, prefix, tail) {
  if (!existsSync(baseDir)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(baseDir);
  } catch {
    return [];
  }
  entries.sort();
  for (const entry of entries) {
    if (prefix.length > 0 && !entry.startsWith(prefix)) continue;
    const candidate = join(baseDir, entry, tail);
    if (existsSync(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Lista, em ordem de preferencia, os binarios de Chrome/Chromium disponiveis.
 * @returns {string[]}
 */
export function findChromeBinaries() {
  const home = homedir();
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  const found = [];
  for (const path of candidates) {
    if (existsSync(path)) found.push(path);
  }
  for (const path of globOneLevel(join(home, '.cache', 'ms-playwright'), 'chromium', join('chrome-linux', 'chrome'))) {
    found.push(path);
  }
  for (const path of globOneLevel(join(home, '.cache', 'puppeteer', 'chrome'), '', join('chrome-linux64', 'chrome'))) {
    found.push(path);
  }
  return found;
}

/* ========================================================================== *
 * WebSocket / correlacao de mensagens
 * ========================================================================== */

/**
 * Conexao CDP sobre um unico WebSocket, em flat mode.
 */
export class CDPConnection {
  /**
   * @param {WebSocket} ws socket ja aberto
   */
  constructor(ws) {
    /** @type {WebSocket} */
    this.ws = ws;
    /** @private */
    this._nextId = 1;
    /** @private @type {Map<number,{resolve:Function,reject:Function,method:string}>} */
    this._pending = new Map();
    /** @private @type {Map<string,Function[]>} */
    this._listeners = new Map();
    /** @type {boolean} */
    this.closed = false;
    /** @type {Error|null} */
    this.closeError = null;

    ws.addEventListener('message', (event) => this._onMessage(event.data));
    ws.addEventListener('close', () => this._onClose(new Error('CDP: WebSocket fechado.')));
    ws.addEventListener('error', () => this._onClose(new Error('CDP: erro no WebSocket.')));
  }

  /** @private */
  _onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const entry = this._pending.get(message.id);
      if (entry === undefined) return;
      this._pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          'CDP ' + entry.method + ': ' + message.error.message +
          (message.error.data ? ' (' + message.error.data + ')' : '')
        );
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      this._emit(message.method, message.params || {}, message.sessionId);
      this._emit('*', message, message.sessionId);
    }
  }

  /** @private */
  _onClose(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const entry of this._pending.values()) entry.reject(error);
    this._pending.clear();
  }

  /** @private */
  _emit(event, params, sessionId) {
    const list = this._listeners.get(event);
    if (list === undefined) return;
    for (const cb of list.slice()) {
      try {
        cb(params, sessionId);
      } catch {
        /* um listener quebrado nunca derruba a conexao */
      }
    }
  }

  /**
   * Assina um evento CDP. Use '*' para receber tudo.
   * @param {string} event
   * @param {Function} cb `cb(params, sessionId)`
   * @returns {Function} o proprio callback (para `off`)
   */
  on(event, cb) {
    let list = this._listeners.get(event);
    if (list === undefined) {
      list = [];
      this._listeners.set(event, list);
    }
    list.push(cb);
    return cb;
  }

  /**
   * Remove um listener.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const list = this._listeners.get(event);
    if (list === undefined) return;
    const index = list.indexOf(cb);
    if (index >= 0) list.splice(index, 1);
  }

  /**
   * Envia um comando e resolve com o `result`.
   * @param {string} method
   * @param {Object} [params]
   * @param {string|null} [sessionId]
   * @returns {Promise<Object>}
   */
  send(method, params = {}, sessionId = null) {
    if (this.closed) {
      return Promise.reject(this.closeError || new Error('CDP: conexao fechada.'));
    }
    const id = this._nextId++;
    const envelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (error) {
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  /** Fecha o socket. */
  dispose() {
    try {
      this.ws.close();
    } catch {
      /* ja fechado */
    }
    this._onClose(new Error('CDP: conexao encerrada localmente.'));
  }
}

/* ========================================================================== *
 * Page
 * ========================================================================== */

/**
 * Uma pagina (target do tipo "page") com os helpers de teste.
 */
export class CDPPage {
  /**
   * @param {CDPConnection} connection
   * @param {string} sessionId
   * @param {string} targetId
   */
  constructor(connection, sessionId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    /** @type {Array<{type:string, text:string, url:string, line:number}>} */
    this.consoleMessages = [];
    /** @type {Array<{text:string, stack:string, url:string}>} */
    this.exceptions = [];
    /** @private */
    this._loadResolvers = [];
  }

  /**
   * Envia um comando nesta sessao.
   * @param {string} method
   * @param {Object} [params]
   * @returns {Promise<Object>}
   */
  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  /**
   * Assina um evento CDP filtrando por esta sessao.
   * @param {string} event
   * @param {Function} cb `cb(params)`
   * @returns {Function}
   */
  on(event, cb) {
    return this.connection.on(event, (params, sessionId) => {
      if (sessionId === this.sessionId) cb(params);
    });
  }

  /** Liga os dominios e comeca a coletar console + excecoes. @returns {Promise<void>} */
  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable').catch(() => {});

    this.on('Runtime.consoleAPICalled', (params) => {
      const parts = [];
      for (const arg of params.args || []) {
        if (arg.value !== undefined) parts.push(typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value));
        else if (arg.description !== undefined) parts.push(arg.description);
        else if (arg.unserializableValue !== undefined) parts.push(String(arg.unserializableValue));
        else parts.push(arg.type === 'undefined' ? 'undefined' : '[' + arg.type + ']');
      }
      const frame = params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0];
      this.consoleMessages.push({
        type: params.type || 'log',
        text: parts.join(' '),
        url: frame ? frame.url : '',
        line: frame ? frame.lineNumber + 1 : 0
      });
    });

    this.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const exception = details.exception || {};
      this.exceptions.push({
        text: exception.description || details.text || 'excecao desconhecida',
        stack: formatStackTrace(details.stackTrace),
        url: details.url || ''
      });
    });

    this.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      // `console.*` ja chega por Runtime.consoleAPICalled; aqui interessam os
      // erros do proprio browser (rede, CSP, WebGL, ...).
      if (entry.source === 'console-api') return;
      this.consoleMessages.push({
        type: entry.level === 'error' ? 'error' : (entry.level || 'log'),
        text: '[' + (entry.source || 'browser') + '] ' + (entry.text || '') +
          (entry.url ? ' <' + entry.url + '>' : ''),
        url: entry.url || '',
        line: entry.lineNumber ? entry.lineNumber + 1 : 0
      });
    });

    this.on('Page.loadEventFired', () => {
      const resolvers = this._loadResolvers;
      this._loadResolvers = [];
      for (const resolve of resolvers) resolve();
    });
  }

  /**
   * Navega e espera o evento `load`.
   * @param {string} url
   * @param {{timeout?:number, waitForLoad?:boolean}} [options]
   * @returns {Promise<void>}
   */
  async navigate(url, options = {}) {
    const timeout = options.timeout !== undefined ? options.timeout : 60000;
    const waitForLoad = options.waitForLoad !== false;

    const loaded = waitForLoad
      ? new Promise((resolve) => this._loadResolvers.push(resolve))
      : Promise.resolve();

    const result = await this.send('Page.navigate', { url });
    if (result && result.errorText) {
      throw new Error('Falha ao navegar para ' + url + ': ' + result.errorText);
    }
    if (!waitForLoad) return;

    let timer = null;
    await Promise.race([
      loaded,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout de ' + timeout + 'ms esperando o load de ' + url)), timeout);
      })
    ]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  }

  /**
   * Avalia uma expressao no contexto da pagina e devolve o valor serializado.
   * Excecoes do lado da pagina viram um Error aqui, com o stack preservado.
   *
   * @param {string} expression
   * @param {boolean} [awaitPromise=false]
   * @param {{timeout?:number}} [options]
   * @returns {Promise<*>}
   */
  async evaluate(expression, awaitPromise = false, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      allowUnsafeEvalBlockedByCSP: true,
      timeout: options.timeout
    });

    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const exception = details.exception || {};
      const message = exception.description || details.text || 'excecao sem descricao';
      const stack = formatStackTrace(details.stackTrace);
      const error = new Error(message + (stack ? '\n' + stack : ''));
      error.pageStack = stack;
      throw error;
    }

    const value = result.result;
    if (value === undefined) return undefined;
    if (value.type === 'undefined') return undefined;
    return value.value;
  }

  /**
   * Espera uma expressao virar truthy.
   * @param {string} expression
   * @param {number} [timeoutMs=30000]
   * @param {number} [pollMs=250]
   * @returns {Promise<*>} o valor que a expressao devolveu
   */
  async waitForFunction(expression, timeoutMs = 30000, pollMs = 250) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        const value = await this.evaluate('(function(){ try { return (' + expression + '); } catch (e) { return undefined; } })()');
        if (value) return value;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          'waitForFunction: timeout de ' + timeoutMs + 'ms esperando `' + expression + '`' +
          (lastError ? ' - ultimo erro: ' + lastError.message : '')
        );
      }
      await sleep(pollMs);
    }
  }

  /**
   * Captura a tela e grava em disco.
   * @param {string} path
   * @param {{format?:string, quality?:number}} [options]
   * @returns {Promise<string>} o mesmo path
   */
  async screenshot(path, options = {}) {
    const params = { format: options.format || 'png', captureBeyondViewport: false };
    if (params.format === 'jpeg' && options.quality !== undefined) params.quality = options.quality;
    const result = await this.send('Page.captureScreenshot', params);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    return path;
  }

  /**
   * Mensagens de console acumuladas ate agora.
   * @param {{errorsOnly?:boolean}} [options]
   * @returns {Array<Object>}
   */
  collectConsole(options = {}) {
    if (options.errorsOnly === true) {
      return this.consoleMessages.filter((m) => m.type === 'error' || m.type === 'assert');
    }
    return this.consoleMessages.slice();
  }

  /** Esvazia os buffers de console e excecoes. */
  clearConsole() {
    this.consoleMessages.length = 0;
    this.exceptions.length = 0;
  }
}

/**
 * Formata um stackTrace do CDP em texto legivel.
 * @param {Object|null|undefined} stackTrace
 * @returns {string}
 */
function formatStackTrace(stackTrace) {
  if (!stackTrace || !Array.isArray(stackTrace.callFrames)) return '';
  const lines = [];
  for (const frame of stackTrace.callFrames) {
    lines.push(
      '    at ' + (frame.functionName || '<anonymous>') +
      ' (' + (frame.url || '<unknown>') + ':' + (frame.lineNumber + 1) + ':' + (frame.columnNumber + 1) + ')'
    );
  }
  return lines.join('\n');
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========================================================================== *
 * Browser
 * ========================================================================== */

export class CDPBrowser {
  /**
   * @param {CDPConnection} connection
   * @param {import('node:child_process').ChildProcess} process
   * @param {string} userDataDir
   * @param {string} binary
   * @param {string} profile nome do perfil de GL usado
   */
  constructor(connection, process, userDataDir, binary, profile) {
    this.connection = connection;
    this.process = process;
    this.userDataDir = userDataDir;
    this.binary = binary;
    this.profile = profile;
    /** @type {CDPPage[]} */
    this.pages = [];
    this._closed = false;
  }

  /**
   * Envia um comando no nivel de browser.
   * @param {string} method
   * @param {Object} [params]
   * @returns {Promise<Object>}
   */
  send(method, params = {}) {
    return this.connection.send(method, params, null);
  }

  /**
   * Assina um evento no nivel de browser.
   * @param {string} event
   * @param {Function} cb
   * @returns {Function}
   */
  on(event, cb) {
    return this.connection.on(event, cb);
  }

  /**
   * Cria uma pagina nova e anexa uma sessao a ela.
   * @param {string} [url='about:blank']
   * @returns {Promise<CDPPage>}
   */
  async newPage(url = 'about:blank') {
    const created = await this.send('Target.createTarget', { url });
    const attached = await this.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const page = new CDPPage(this.connection, attached.sessionId, created.targetId);
    await page.init();
    this.pages.push(page);
    return page;
  }

  /** Mata o Chrome e limpa o diretorio de perfil. @returns {Promise<void>} */
  async close() {
    if (this._closed) return;
    this._closed = true;

    try {
      await Promise.race([this.send('Browser.close'), sleep(2000)]);
    } catch {
      /* o browser pode ja ter morrido */
    }
    this.connection.dispose();

    const child = this.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ja morreu */
      }
      const died = await waitForExit(child, 3000);
      if (!died) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* nada a fazer */
        }
        await waitForExit(child, 2000);
      }
    }

    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* diretorio temporario: falhar aqui nao invalida o teste */
      }
    }
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true se o processo terminou dentro do prazo
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Sobe um Chrome headless e conecta o CDP.
 *
 * @param {Object} [options]
 * @param {string}   [options.binary] caminho explicito do Chrome
 * @param {string[]} [options.glArgs] flags de GL (sobrescreve o perfil)
 * @param {string}   [options.profile] nome de um perfil de GL_PROFILES
 * @param {string[]} [options.extraArgs] flags adicionais
 * @param {number}   [options.timeout=30000]
 * @param {boolean}  [options.headless=true] passe false para abrir a janela
 * @param {boolean}  [options.verbose=false] ecoa o stderr do Chrome
 * @returns {Promise<CDPBrowser>}
 */
export async function launch(options = {}) {
  const binaries = options.binary ? [options.binary] : findChromeBinaries();
  if (binaries.length === 0) {
    throw new Error(
      'cdp.launch: nenhum binario de Chrome encontrado. Procurado em /usr/bin/google-chrome, ' +
      '/opt/google/chrome/chrome, ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome e ' +
      '~/.cache/puppeteer/chrome/*/chrome-linux64/chrome.'
    );
  }

  const profiles = options.glArgs
    ? [{ name: options.profile || 'custom', args: options.glArgs }]
    : (options.profile ? GL_PROFILES.filter((p) => p.name === options.profile) : GL_PROFILES);
  if (profiles.length === 0) {
    throw new Error('cdp.launch: perfil de GL desconhecido: ' + options.profile);
  }

  const failures = [];
  for (const binary of binaries) {
    for (const profile of profiles) {
      try {
        return await launchOnce(binary, profile, options);
      } catch (error) {
        failures.push(binary + ' [' + profile.name + ']: ' + error.message);
      }
    }
  }

  throw new Error('cdp.launch: nao foi possivel subir o Chrome.\n  ' + failures.join('\n  '));
}

/**
 * Uma tentativa de lancamento.
 * @private
 * @param {string} binary
 * @param {{name:string, args:string[]}} profile
 * @param {Object} options
 * @returns {Promise<CDPBrowser>}
 */
async function launchOnce(binary, profile, options) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cdp-chrome-'));
  const baseArgs = options.headless === false
    ? BASE_ARGS.filter((arg) => arg !== '--headless=new')
    : BASE_ARGS;
  const args = baseArgs.concat(
    profile.args,
    ['--user-data-dir=' + userDataDir],
    options.extraArgs || [],
    ['about:blank']
  );

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuffer = '';

  const cleanup = () => {
    try {
      if (child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* nada */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* nada */
    }
  };

  const wsUrl = await new Promise((resolve, reject) => {
    const timeout = options.timeout !== undefined ? options.timeout : LAUNCH_TIMEOUT_MS;
    const timer = setTimeout(() => {
      reject(new Error(
        'timeout de ' + timeout + 'ms esperando "DevTools listening on ws://".\n' +
        '  stderr: ' + stderrBuffer.trim().split('\n').slice(-8).join('\n          ')
      ));
    }, timeout);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
      if (options.verbose === true) process.stderr.write(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderrBuffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error('falha ao executar o binario: ' + error.message));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(
        'o processo terminou antes de abrir o DevTools (code=' + code + ', signal=' + signal + ').\n' +
        '  stderr: ' + stderrBuffer.trim().split('\n').slice(-8).join('\n          ')
      ));
    });
  }).catch((error) => {
    cleanup();
    throw error;
  });

  let ws;
  try {
    ws = await openWebSocket(wsUrl, 15000);
  } catch (error) {
    cleanup();
    throw error;
  }

  const connection = new CDPConnection(ws);
  const browser = new CDPBrowser(connection, child, userDataDir, binary, profile.name);

  // Um exit inesperado do Chrome tem de derrubar as promises pendentes.
  child.on('exit', () => connection.dispose());

  return browser;
}

/**
 * Abre um WebSocket nativo e espera o handshake.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<WebSocket>}
 */
function openWebSocket(url, timeoutMs) {
  if (typeof globalThis.WebSocket !== 'function') {
    return Promise.reject(new Error('cdp: este Node nao expoe globalThis.WebSocket (precisa de Node >= 22).'));
  }
  return new Promise((resolve, reject) => {
    const ws = new globalThis.WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* nada */
      }
      reject(new Error('timeout de ' + timeoutMs + 'ms conectando em ' + url));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    }, { once: true });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('erro conectando o WebSocket em ' + url));
    }, { once: true });
  });
}
