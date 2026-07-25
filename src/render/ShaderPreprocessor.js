/**
 * GLSL source preprocessor.
 *
 * Responsibilities:
 *  - resolve `#include <name>` directives against a registry of chunks, recursively
 *    and with cycle detection;
 *  - inject `#define K V` pairs immediately after the `#version 300 es` line;
 *  - collapse runs of blank lines so the resolved source stays readable;
 *  - keep a line -> (chunk, line) map so a driver info log can be translated back
 *    to the file the offending line actually came from.
 *
 * Deduplication rule. The preprocessor deliberately does not evaluate `#if`
 * conditionals - that is the GLSL compiler's job - so it can only prove that a
 * chunk is reachable when the include sits outside every conditional block, in a
 * file that was itself included unconditionally. Those chunks are recorded, and any
 * later include of the same chunk is skipped, no matter how deeply it is nested.
 *
 * A chunk that is only ever included from inside a conditional block is expanded
 * each time, because two mutually exclusive branches may legitimately need it and
 * skipping the second one would leave the code inside a dead branch. Every built in
 * chunk carries its own `#ifndef` guard, so the duplicate is stripped by the GLSL
 * preprocessor and only costs a few lines of text.
 */

const INCLUDE_PATTERN = /^[ \t]*#[ \t]*include[ \t]+[<"]([^>"]+)[>"][ \t]*;?[ \t]*(?:\/\/.*)?$/;
const NEWLINE_PATTERN = /\r\n|\r|\n/;
const VERSION_PATTERN = /^[ \t]*#[ \t]*version[ \t]+/;
const COND_OPEN_PATTERN = /^[ \t]*#[ \t]*(if|ifdef|ifndef)\b/;
const COND_CLOSE_PATTERN = /^[ \t]*#[ \t]*endif\b/;
const BLANK_PATTERN = /^[ \t]*$/;
const LOG_ENTRY_PATTERN = /^\s*(ERROR|WARNING)\s*:\s*(\d+)\s*:\s*(\d+)\s*:?\s*(.*)$/;

/** Name used in the source map for the top level shader source. */
const ROOT_NAME = '<shader>';

/** How many resolved sources keep their line map around for error formatting. */
const MAX_TRACKED_MAPS = 64;

/**
 * Format a defines object into GLSL `#define` lines, sorted for determinism.
 * `false`, `null` and `undefined` values are skipped; `true` becomes `1`.
 * @param {Object|null} defines
 * @returns {string[]} one entry per line, without trailing newlines
 */
export function formatDefines(defines) {
  const lines = [];
  if (!defines) return lines;
  const keys = Object.keys(defines).sort();
  for (let i = 0, n = keys.length; i < n; i++) {
    const key = keys[i];
    const value = defines[key];
    if (value === false || value === null || value === undefined) continue;
    if (value === true) {
      lines.push('#define ' + key + ' 1');
    } else {
      lines.push('#define ' + key + ' ' + value);
    }
  }
  return lines;
}

/**
 * Build a stable, deterministic key for a defines object.
 * @param {Object|null} defines
 * @returns {string}
 */
export function definesKey(defines) {
  if (!defines) return '';
  const keys = Object.keys(defines).sort();
  let key = '';
  for (let i = 0, n = keys.length; i < n; i++) {
    const k = keys[i];
    const v = defines[k];
    if (v === false || v === null || v === undefined) continue;
    key += k + '=' + (v === true ? '1' : v) + ';';
  }
  return key;
}

export class ShaderPreprocessor {
  /** Create an empty preprocessor. Chunks are registered explicitly. */
  constructor() {
    /** @type {Map<string,string>} chunk name -> GLSL source */
    this.chunks = new Map();
    /** Statistics, handy when profiling shader compilation. */
    this.stats = { resolves: 0, includes: 0, cacheHits: 0 };
    /** @type {Map<string,{names:string[],lines:number[]}>} resolved source -> line map */
    this._maps = new Map();
    /** @type {Array<{names:string[],lines:number[]}>} line map of the last resolve */
    this.lastLineMap = null;
  }

  /**
   * Register a chunk under the name used by `#include <name>`.
   * @param {string} name
   * @param {string} source
   * @returns {ShaderPreprocessor} this
   */
  registerChunk(name, source) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('ShaderPreprocessor.registerChunk: nome de chunk invalido.');
    }
    if (typeof source !== 'string') {
      throw new Error('ShaderPreprocessor.registerChunk: o chunk "' + name + '" nao e uma string.');
    }
    this.chunks.set(name, source);
    return this;
  }

  /**
   * Remove a chunk from the registry.
   * @param {string} name
   * @returns {boolean} true when a chunk was removed
   */
  unregisterChunk(name) {
    return this.chunks.delete(name);
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  hasChunk(name) {
    return this.chunks.has(name);
  }

  /**
   * @param {string} name
   * @returns {string|null}
   */
  getChunk(name) {
    const chunk = this.chunks.get(name);
    return chunk === undefined ? null : chunk;
  }

  /** @returns {number} number of registered chunks */
  get chunkCount() {
    return this.chunks.size;
  }

  /**
   * Resolve a shader source: expand includes and inject defines.
   *
   * @param {string} source raw shader source, usually starting with `#version 300 es`
   * @param {Object|null} defines map of macro name -> value
   * @param {{stage?:string, extraDefines?:Object, name?:string}} [options]
   *        `stage` may be 'vertex' or 'fragment'; it injects VERTEX_SHADER /
   *        FRAGMENT_SHADER so chunks can guard stage specific built-ins.
   * @returns {string} the fully resolved source
   */
  resolve(source, defines = null, options = null) {
    if (typeof source !== 'string') {
      throw new Error('ShaderPreprocessor.resolve: o fonte precisa ser uma string.');
    }
    this.stats.resolves++;

    const rootName = (options && options.name) || ROOT_NAME;
    const lines = source.split(NEWLINE_PATTERN);

    // --- locate the #version directive -------------------------------------
    let versionLine = '#version 300 es';
    let bodyStart = 0;
    for (let i = 0, n = lines.length; i < n; i++) {
      const line = lines[i];
      if (BLANK_PATTERN.test(line)) continue;
      if (VERSION_PATTERN.test(line)) {
        versionLine = line.trim();
        bodyStart = i + 1;
      }
      break;
    }

    const ctx = {
      out: [],
      names: [],
      lineNumbers: [],
      lastBlank: false,
      included: new Set()
    };

    this._emit(ctx, versionLine, rootName, 1);

    // --- inject defines -----------------------------------------------------
    const stage = options && options.stage;
    if (stage === 'vertex') this._emit(ctx, '#define VERTEX_SHADER 1', '<defines>', 1);
    else if (stage === 'fragment') this._emit(ctx, '#define FRAGMENT_SHADER 1', '<defines>', 1);

    const defineLines = formatDefines(defines);
    for (let i = 0, n = defineLines.length; i < n; i++) {
      this._emit(ctx, defineLines[i], '<defines>', i + 1);
    }
    if (options && options.extraDefines) {
      const extra = formatDefines(options.extraDefines);
      for (let i = 0, n = extra.length; i < n; i++) {
        this._emit(ctx, extra[i], '<defines>', i + 1);
      }
    }
    if (defineLines.length > 0 || stage) this._emit(ctx, '', '<defines>', 0);

    // --- expand the body ----------------------------------------------------
    // A fragment shader has no default float precision, and the chunks are full of
    // floats. The default is emitted after any leading #extension / #pragma (which
    // must precede every declaration) but before the first #include, so a chunk
    // never lands in front of it. Re-declaring precision later is legal, so a
    // shader that wants something else simply states it and wins.
    if (stage === 'fragment' && !(options && options.injectPrecision === false)) {
      const prefixEnd = this._findDeclarationStart(lines, bodyStart);
      if (prefixEnd > bodyStart) this._expand(ctx, lines, rootName, bodyStart, [], true, prefixEnd);
      this._emit(ctx, 'precision highp float;', '<precision>', 1);
      this._emit(ctx, 'precision highp int;', '<precision>', 2);
      this._expand(ctx, lines, rootName, prefixEnd, [], true);
    } else {
      this._expand(ctx, lines, rootName, bodyStart, [], true);
    }

    const resolved = ctx.out.join('\n');
    this._trackMap(resolved, ctx.names, ctx.lineNumbers);
    return resolved;
  }

  /**
   * Index of the first line that introduces a declaration, skipping blank lines,
   * line comments and the directives that must stay in front of every declaration.
   * @private
   * @returns {number}
   */
  _findDeclarationStart(lines, startLine) {
    let index = startLine;
    for (let i = startLine, n = lines.length; i < n; i++) {
      const text = lines[i].trim();
      if (text === '' || text.startsWith('//')) continue;
      if (/^#[ \t]*(extension|pragma|line)\b/.test(text)) {
        index = i + 1;
        continue;
      }
      return i > index ? index : i;
    }
    return index;
  }

  /**
   * Expand a block of lines into the output, resolving nested includes.
   * @private
   * @param {number} [endLine] exclusive upper bound, defaults to the whole array
   */
  _expand(ctx, lines, fileName, startLine, stack, unconditional, endLine) {
    let conditionalDepth = 0;
    const limit = endLine === undefined ? lines.length : endLine;

    for (let i = startLine, n = limit; i < n; i++) {
      const line = lines[i];

      if (COND_OPEN_PATTERN.test(line)) {
        conditionalDepth++;
      } else if (COND_CLOSE_PATTERN.test(line)) {
        if (conditionalDepth > 0) conditionalDepth--;
      } else {
        const match = INCLUDE_PATTERN.exec(line);
        if (match !== null) {
          this._include(ctx, match[1], fileName, i + 1, stack, unconditional && conditionalDepth === 0);
          continue;
        }
      }

      this._emit(ctx, line, fileName, i + 1);
    }
  }

  /**
   * Resolve one `#include <name>` directive.
   * @private
   */
  _include(ctx, name, fromFile, fromLine, stack, canDeduplicate) {
    const chunk = this.chunks.get(name);
    if (chunk === undefined) {
      throw new Error(
        'ShaderPreprocessor: chunk "' + name + '" nao registrado (incluido de ' +
        fromFile + ':' + fromLine + '). Chunks disponiveis: ' +
        Array.from(this.chunks.keys()).sort().join(', ')
      );
    }

    for (let i = 0, n = stack.length; i < n; i++) {
      if (stack[i] === name) {
        throw new Error(
          'ShaderPreprocessor: ciclo de #include detectado: ' +
          stack.join(' -> ') + ' -> ' + name
        );
      }
    }

    // `included` only ever holds chunks that were emitted unconditionally, so a
    // hit here proves the definitions are already present on every code path.
    if (ctx.included.has(name)) {
      this.stats.cacheHits++;
      return;
    }
    if (canDeduplicate) ctx.included.add(name);

    this.stats.includes++;
    stack.push(name);
    const lines = chunk.split(NEWLINE_PATTERN);
    this._expand(ctx, lines, name, 0, stack, canDeduplicate);
    stack.pop();
  }

  /**
   * Append one line to the output, collapsing consecutive blank lines.
   * @private
   */
  _emit(ctx, text, fileName, lineNumber) {
    const blank = BLANK_PATTERN.test(text);
    if (blank && ctx.lastBlank) return;
    ctx.lastBlank = blank;
    ctx.out.push(text);
    ctx.names.push(fileName);
    ctx.lineNumbers.push(lineNumber);
  }

  /**
   * Remember the line map of a resolved source, evicting the oldest entry once the
   * budget is exhausted.
   * @private
   */
  _trackMap(resolved, names, lineNumbers) {
    const entry = { names, lines: lineNumbers };
    this.lastLineMap = entry;
    if (this._maps.has(resolved)) this._maps.delete(resolved);
    this._maps.set(resolved, entry);
    if (this._maps.size > MAX_TRACKED_MAPS) {
      const oldest = this._maps.keys().next();
      if (!oldest.done) this._maps.delete(oldest.value);
    }
  }

  /**
   * Translate a line of a resolved source back to the chunk it came from.
   * @param {string} resolvedSource
   * @param {number} lineNumber 1 based line in the resolved source
   * @returns {{file:string, line:number}|null}
   */
  getOrigin(resolvedSource, lineNumber) {
    const map = this._maps.get(resolvedSource) || this.lastLineMap;
    if (!map) return null;
    const index = lineNumber - 1;
    if (index < 0 || index >= map.names.length) return null;
    return { file: map.names[index], line: map.lines[index] };
  }

  /**
   * Turn a driver info log into a readable report with the offending lines, three
   * lines of context on each side and the originating chunk.
   *
   * @param {string} infoLog raw log from getShaderInfoLog / getProgramInfoLog
   * @param {string} resolvedSource the source that was compiled
   * @param {string} [label] optional heading, e.g. 'standard.vertex'
   * @returns {string}
   */
  formatError(infoLog, resolvedSource, label) {
    const sourceLines = typeof resolvedSource === 'string' ? resolvedSource.split('\n') : [];
    const log = typeof infoLog === 'string' ? infoLog : '';
    const logLines = log.split('\n');
    const parts = [];

    parts.push('--- Erro de shader' + (label ? ' [' + label + ']' : '') + ' ---');

    let reported = 0;
    for (let i = 0; i < logLines.length; i++) {
      const raw = logLines[i].trim();
      if (raw.length === 0) continue;

      const match = LOG_ENTRY_PATTERN.exec(raw);
      if (match === null) {
        parts.push(raw);
        continue;
      }

      const severity = match[1];
      const lineNumber = parseInt(match[3], 10);
      const message = match[4];
      const origin = this.getOrigin(resolvedSource, lineNumber);

      parts.push('');
      parts.push(
        severity + ' na linha ' + lineNumber +
        (origin ? '  (chunk "' + origin.file + '", linha ' + origin.line + ')' : '') +
        ': ' + message
      );

      const from = Math.max(0, lineNumber - 4);
      const to = Math.min(sourceLines.length, lineNumber + 3);
      const width = String(to).length;
      for (let l = from; l < to; l++) {
        const number = String(l + 1).padStart(width, ' ');
        const marker = l + 1 === lineNumber ? ' >> ' : '    ';
        parts.push(marker + number + ' | ' + sourceLines[l]);
      }
      reported++;
    }

    if (reported === 0 && log.length === 0) {
      parts.push('(o driver nao retornou nenhuma mensagem)');
    }

    parts.push('--- fim ---');
    return parts.join('\n');
  }

  /**
   * Number the lines of a source, for dumping a shader during debugging.
   * @param {string} source
   * @returns {string}
   */
  numberLines(source) {
    const lines = source.split('\n');
    const width = String(lines.length).length;
    let out = '';
    for (let i = 0, n = lines.length; i < n; i++) {
      out += String(i + 1).padStart(width, ' ') + ' | ' + lines[i] + (i < n - 1 ? '\n' : '');
    }
    return out;
  }

  /** Drop every tracked line map. Chunks stay registered. */
  clear() {
    this._maps.clear();
    this.lastLineMap = null;
  }

  /** Drop chunks and line maps. */
  dispose() {
    this.chunks.clear();
    this.clear();
  }
}
