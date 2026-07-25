#!/usr/bin/env node
/**
 * serve.mjs - zero dependency static development server for the AICoders Engine.
 *
 * ES modules cannot be loaded through the file:// protocol, so a tiny static
 * server is required to open index.html. This file uses nothing but node:http,
 * node:fs and node:path.
 *
 * Usage:
 *   node tools/serve.mjs                 # http://localhost:8080
 *   node tools/serve.mjs --port 3000
 *   node tools/serve.mjs --host 0.0.0.0 --root . --quiet
 *
 * Features:
 *   - correct MIME types for every asset the engine can load
 *   - aggressive no-cache headers (development server: always fresh code)
 *   - path traversal protection (nothing outside --root can ever be read)
 *   - HTTP range requests (partial content) for large .glb / .bin / media files
 *   - directory listing fallback when there is no index.html
 *   - graceful shutdown on SIGINT / SIGTERM
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

/** Absolute path of the project root (one level above tools/). */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extension -> Content-Type. Everything the engine may ever request. */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/aces',
  '.ktx': 'image/ktx',
  '.ktx2': 'image/ktx2',
  '.dds': 'image/vnd-ms.dds',
  '.basis': 'application/octet-stream',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glsl': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8'
};

const DEFAULT_MIME = 'application/octet-stream';
const INDEX_FILES = ['index.html', 'index.htm'];

/**
 * Parse process arguments into an options object.
 * @param {string[]} argv raw argv slice (process.argv.slice(2))
 * @returns {{port:number, host:string, root:string, quiet:boolean, listing:boolean}}
 */
function parseArgs(argv) {
  const options = {
    port: 8080,
    host: '0.0.0.0',
    root: PROJECT_ROOT,
    quiet: false,
    listing: true
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      options.port = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--port=')) {
      options.port = parseInt(arg.slice(7), 10);
    } else if (arg === '--host' || arg === '-h') {
      options.host = String(argv[++i]);
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice(7);
    } else if (arg === '--root' || arg === '-r') {
      options.root = resolve(process.cwd(), String(argv[++i]));
    } else if (arg.startsWith('--root=')) {
      options.root = resolve(process.cwd(), arg.slice(7));
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--no-listing') {
      options.listing = false;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`serve.mjs: argumento desconhecido "${arg}" (use --help)\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) {
    process.stderr.write('serve.mjs: porta invalida (use --port <0-65535>)\n');
    process.exit(2);
  }
  return options;
}

/** Print the CLI usage banner. */
function printHelp() {
  process.stdout.write(
    [
      'AICoders Engine - servidor estatico de desenvolvimento',
      '',
      'Uso: node tools/serve.mjs [opcoes]',
      '',
      '  -p, --port <n>     porta (padrao 8080)',
      '  -h, --host <addr>  interface (padrao 0.0.0.0)',
      '  -r, --root <dir>   diretorio raiz servido (padrao: raiz do projeto)',
      '  -q, --quiet        nao imprime uma linha por requisicao',
      '      --no-listing   desabilita listagem de diretorio',
      '      --help         mostra esta ajuda',
      ''
    ].join('\n')
  );
}

/**
 * Resolve a URL pathname into a safe absolute path inside root.
 * Returns null when the request tries to escape the root directory.
 * @param {string} root absolute root directory
 * @param {string} pathname decoded url pathname
 * @returns {string|null}
 */
function safeResolve(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Reject NUL bytes and backslash tricks outright.
  if (decoded.indexOf('\u0000') !== -1) return null;
  decoded = decoded.replace(/\\/g, '/');
  // join() normalizes ".." segments; the prefix test below is the real guard.
  const candidate = resolve(root, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

/** Standard set of headers applied to every response (development: never cache). */
function baseHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*'
  };
}

/**
 * Content-Type for a file path.
 * @param {string} filePath
 * @returns {string}
 */
function mimeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || DEFAULT_MIME;
}

/**
 * Send a small text/html body.
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {string} body
 * @param {string} type
 */
function sendText(res, code, body, type = 'text/html; charset=utf-8') {
  const buffer = Buffer.from(body, 'utf8');
  res.writeHead(code, { ...baseHeaders(), 'Content-Type': type, 'Content-Length': buffer.length });
  res.end(buffer);
}

/**
 * Parse a single-range "Range: bytes=a-b" header.
 * @param {string|undefined} header
 * @param {number} size
 * @returns {{start:number,end:number}|null|'invalid'}
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  let start;
  let end;
  if (startRaw === '' && endRaw === '') return 'invalid';
  if (startRaw === '') {
    const suffix = parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startRaw, 10);
    end = endRaw === '' ? size - 1 : parseInt(endRaw, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Escape text so it can be embedded in HTML.
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a simple directory listing page.
 * @param {string} urlPath
 * @param {string[]} entries
 * @returns {string}
 */
function renderListing(urlPath, entries) {
  const rows = entries
    .map((name) => {
      const href = urlPath.endsWith('/') ? urlPath + encodeURIComponent(name) : urlPath + '/' + encodeURIComponent(name);
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></li>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Index of ${escapeHtml(urlPath)}</title>
<style>body{font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:#111;color:#ddd;padding:24px}
a{color:#6cf;text-decoration:none}a:hover{text-decoration:underline}ul{list-style:none;padding:0}</style>
<h1>Index of ${escapeHtml(urlPath)}</h1><ul>
<li><a href="../">../</a></li>
${rows}
</ul>`;
}

/**
 * Handle a single request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{root:string, quiet:boolean, listing:boolean}} options
 */
async function handleRequest(req, res, options) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...baseHeaders(), Allow: 'GET, HEAD', 'Content-Length': 0 });
    res.end();
    return;
  }

  const urlPath = (req.url || '/').split('?')[0].split('#')[0];
  const filePath = safeResolve(options.root, urlPath);
  if (filePath === null) {
    sendText(res, 403, '<h1>403 Forbidden</h1><p>Caminho fora da raiz servida.</p>');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendText(res, 404, `<h1>404 Not Found</h1><p>${escapeHtml(urlPath)}</p>`);
    return;
  }

  if (info.isDirectory()) {
    if (!urlPath.endsWith('/')) {
      res.writeHead(301, { ...baseHeaders(), Location: urlPath + '/', 'Content-Length': 0 });
      res.end();
      return;
    }
    for (let i = 0; i < INDEX_FILES.length; i++) {
      const indexPath = join(filePath, INDEX_FILES[i]);
      try {
        const indexInfo = await stat(indexPath);
        if (indexInfo.isFile()) {
          await sendFile(req, res, indexPath, indexInfo);
          return;
        }
      } catch {
        /* keep looking */
      }
    }
    if (!options.listing) {
      sendText(res, 403, '<h1>403 Forbidden</h1><p>Listagem de diretorio desabilitada.</p>');
      return;
    }
    const names = (await readdir(filePath, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => (entry.isDirectory() ? entry.name + '/' : entry.name))
      .sort();
    sendText(res, 200, renderListing(urlPath, names));
    return;
  }

  if (!info.isFile()) {
    sendText(res, 404, '<h1>404 Not Found</h1>');
    return;
  }

  await sendFile(req, res, filePath, info);
}

/**
 * Stream a regular file, honouring Range requests.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {import('node:fs').Stats} info
 */
async function sendFile(req, res, filePath, info) {
  const headers = {
    ...baseHeaders(),
    'Content-Type': mimeFor(filePath),
    'Last-Modified': info.mtime.toUTCString(),
    'Accept-Ranges': 'bytes'
  };

  const range = parseRange(req.headers.range, info.size);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 });
    res.end();
    return;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': length
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    pipeStream(createReadStream(filePath, { start: range.start, end: range.end }), res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeStream(createReadStream(filePath), res);
}

/**
 * Pipe a read stream into the response with error handling.
 * @param {import('node:fs').ReadStream} stream
 * @param {import('node:http').ServerResponse} res
 */
function pipeStream(stream, res) {
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, baseHeaders());
    res.end();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * Collect the LAN addresses so the banner can print a reachable URL.
 * @returns {string[]}
 */
function localAddresses() {
  const found = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const list = nets[name] || [];
    for (let i = 0; i < list.length; i++) {
      const net = list[i];
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

/**
 * Create and start the server.
 * @param {{port:number, host:string, root:string, quiet:boolean, listing:boolean}} options
 * @returns {import('node:http').Server}
 */
export function startServer(options) {
  const server = createServer((req, res) => {
    const started = Date.now();
    handleRequest(req, res, options).catch(() => {
      if (!res.headersSent) sendText(res, 500, '<h1>500 Internal Server Error</h1>');
      else res.end();
    });
    if (!options.quiet) {
      res.on('finish', () => {
        const ms = Date.now() - started;
        process.stdout.write(`  ${String(res.statusCode)} ${req.method} ${req.url} (${ms}ms)\n`);
      });
    }
  });

  server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
      process.stderr.write(`\n  ERRO: a porta ${options.port} ja esta em uso. Use --port <outra>.\n\n`);
      process.exit(1);
    }
    process.stderr.write(`\n  ERRO no servidor: ${error && error.message ? error.message : String(error)}\n\n`);
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : options.port;
    const lines = [
      '',
      '  AICoders Engine - servidor de desenvolvimento',
      `  raiz:  ${options.root}`,
      `  local: http://localhost:${port}/`
    ];
    if (options.host === '0.0.0.0' || options.host === '::') {
      const addresses = localAddresses();
      for (let i = 0; i < addresses.length; i++) lines.push(`  rede:  http://${addresses[i]}:${port}/`);
    }
    lines.push('', '  Ctrl+C para encerrar.', '');
    process.stdout.write(lines.join('\n'));
  });

  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const server = startServer(options);
  const shutdown = () => {
    process.stdout.write('\n  encerrando...\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { MIME_TYPES, parseArgs, safeResolve, mimeFor, parseRange, PROJECT_ROOT };
