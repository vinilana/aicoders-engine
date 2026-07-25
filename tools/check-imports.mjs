#!/usr/bin/env node
/**
 * check-imports.mjs - static ES module graph verification for the AICoders Engine.
 *
 * The engine ships as raw ES modules loaded straight by the browser: there is no
 * bundler and no build step to catch a wrong path or a renamed export. This tool
 * replaces that safety net. It scans every .js/.mjs file under src/, examples/
 * and tools/ and verifies, for every static import, dynamic import and
 * re-export:
 *
 *   (a) the target file really exists on disk;
 *   (b) every named binding imported really exists as a named export of the
 *       target module (following `export * from` re-export chains);
 *   (c) no default import / default export is used anywhere (forbidden by the
 *       architecture contract);
 *   (d) every relative specifier carries an explicit `.js` extension;
 *   (e) no third party dependency is imported (only node: builtins in tools/).
 *
 * Every problem is reported as "file:line: message" and the process exits with
 * code 1 when at least one error was found.
 *
 * Usage: node tools/check-imports.mjs [--quiet] [--no-color]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';

/** Project root (parent of tools/). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories scanned for module sources. */
const SCAN_DIRS = ['src', 'examples', 'tools', 'games'];

/** File extensions treated as ES modules. */
const MODULE_EXT = new Set(['.js', '.mjs']);

/** Directories whose files must use the strict `.js`-only rule from the contract. */
const STRICT_JS_DIRS = ['src', 'examples', 'games'];

/** Directories ignored while walking. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache']);

/** Sentinel used to replace string literals inside the masked source. */
const SEN = String.fromCharCode(1);

/** Set of node builtin module names, with and without the `node:` prefix. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => 'node:' + m)]);

/* ------------------------------------------------------------------------- *
 * Source masking: comments removed, string/template literals extracted.
 * ------------------------------------------------------------------------- */

/**
 * Replace every non newline character by a space (keeps line numbers intact).
 * @param {string} text
 * @returns {string}
 */
function blank(text) {
  let out = '';
  for (let i = 0, n = text.length; i < n; i++) out += text.charCodeAt(i) === 10 ? '\n' : ' ';
  return out;
}

/**
 * Skip a single or double quoted string starting at `i`.
 * @param {string} src
 * @param {number} i index of the opening quote
 * @returns {number} index just past the closing quote
 */
function skipQuoted(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n') return i; // unterminated string: bail out on the newline
    i++;
  }
  return i;
}

/**
 * Skip a `{ ... }` block, honouring nested strings, templates and comments.
 * @param {string} src
 * @param {number} i index of the opening brace
 * @returns {number} index just past the matching closing brace
 */
function skipBraces(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Skip a template literal starting at `i`, including nested `${ ... }` blocks.
 * @param {string} src
 * @param {number} i index of the opening backtick
 * @returns {number} index just past the closing backtick
 */
function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      i = skipBraces(src, i + 1);
      continue;
    }
    i++;
  }
  return i;
}

/** Characters after which a `/` starts a regular expression literal. */
const REGEX_PREV_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);

/** Keywords after which a `/` starts a regular expression literal. */
const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw'
]);

/**
 * Decide whether a `/` at the current position opens a regex literal.
 * @param {string} lastSig last significant character already emitted
 * @param {string} out masked output so far
 * @returns {boolean}
 */
function regexAllowed(lastSig, out) {
  if (REGEX_PREV_CHARS.has(lastSig)) return true;
  if (/[A-Za-z0-9_$)\]]/.test(lastSig)) {
    const m = /([A-Za-z_$][\w$]*)\s*$/.exec(out);
    return !!(m && REGEX_PREV_WORDS.has(m[1]));
  }
  return false;
}

/**
 * Skip a regex literal starting at `i`; returns `i` when it is actually a division.
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n') return i;
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      j++;
      while (j < src.length && /[a-z]/.test(src[j])) j++;
      return j;
    }
    j++;
  }
  return i;
}

/**
 * Resolve the common JS escape sequences of a raw string literal body.
 * @param {string} raw
 * @returns {string}
 */
function unescapeJS(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, seq) => {
    const head = seq[0];
    if (head === 'u') {
      const hex = seq[1] === '{' ? seq.slice(2, -1) : seq.slice(1);
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (head === 'x') return String.fromCharCode(parseInt(seq.slice(1), 16));
    if (head === 'n') return '\n';
    if (head === 't') return '\t';
    if (head === 'r') return '\r';
    if (head === 'b') return '\b';
    if (head === 'f') return '\f';
    if (head === 'v') return '\v';
    return head;
  });
}

/**
 * Mask a JavaScript source: comments become blanks, string and template
 * literals become `<SEN><index><SEN>` placeholders. Newlines are preserved
 * exactly so line numbers of the masked source match the original file.
 *
 * @param {string} src
 * @returns {{masked:string, literals:Array<{value:(string|null), kind:string}>}}
 */
function maskSource(src) {
  const literals = [];
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSig = '';
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(src, i);
      literals.push({ value: unescapeJS(src.slice(i + 1, Math.max(i + 1, end - 1))), kind: 'quoted' });
      out += SEN + (literals.length - 1) + SEN;
      lastSig = '"';
      i = end;
      continue;
    }
    if (c === '`') {
      const end = skipTemplate(src, i);
      const body = src.slice(i + 1, Math.max(i + 1, end - 1));
      const hasExpr = body.indexOf('${') !== -1;
      literals.push({ value: hasExpr ? null : unescapeJS(body), kind: 'template' });
      let newlines = '';
      for (let k = i; k < end; k++) if (src.charCodeAt(k) === 10) newlines += '\n';
      out += SEN + (literals.length - 1) + SEN + newlines;
      lastSig = '`';
      i = end;
      continue;
    }
    if (c === '/' && regexAllowed(lastSig, out)) {
      const end = skipRegex(src, i);
      if (end > i) {
        out += blank(src.slice(i, end));
        lastSig = '/';
        i = end;
        continue;
      }
    }
    out += c;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') lastSig = c;
    i++;
  }
  return { masked: out, literals };
}

/**
 * Build the array of line start offsets for fast index -> line lookups.
 * @param {string} text
 * @returns {number[]}
 */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0, n = text.length; i < n; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/**
 * Convert a character index into a 1 based line number.
 * @param {number[]} starts
 * @param {number} index
 * @returns {number}
 */
function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/* ------------------------------------------------------------------------- *
 * Regexes over masked sources.
 * ------------------------------------------------------------------------- */

const RE_STATIC_IMPORT = new RegExp(
  '(?<![\\w$.])import(?=[\\s{*' + SEN + '])\\s*(?:([^;]*?)\\s*from\\s*)?' + SEN + '(\\d+)' + SEN,
  'g'
);
const RE_EXPORT_FROM = new RegExp('(?<![\\w$.])export\\s+([^;]*?)\\s*from\\s*' + SEN + '(\\d+)' + SEN, 'g');
const RE_DYNAMIC_IMPORT = new RegExp('(?<![\\w$.])import\\s*\\(\\s*' + SEN + '(\\d+)' + SEN + '\\s*\\)', 'g');
const RE_EXPORT_BRACE = /(?<![\w$.])export\s*\{([^}]*)\}/g;
const RE_EXPORT_CLASS = /(?<![\w$.])export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
const RE_EXPORT_FUNCTION = /(?<![\w$.])export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
const RE_EXPORT_VAR = /(?<![\w$.])export\s+(const|let|var)\s+/g;
const RE_EXPORT_DEFAULT = /(?<![\w$.])export\s+default(?![\w$])/g;

/* ------------------------------------------------------------------------- *
 * Import / export clause parsing.
 * ------------------------------------------------------------------------- */

/**
 * Split a text on a separator, ignoring separators nested in brackets.
 * @param {string} text
 * @param {string} sep
 * @returns {string[]}
 */
function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0, n = text.length; i < n; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Parse a `{ a, b as c }` specifier list.
 * @param {string} body inner text of the braces
 * @returns {Array<{imported:string, local:string}>}
 */
function parseSpecifierList(body) {
  const out = [];
  const parts = splitTop(body, ',');
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i].trim();
    if (!piece) continue;
    const m = /^([A-Za-z_$][\w$]*|default)\s*(?:as\s+([A-Za-z_$][\w$]*|default))?$/.exec(piece);
    if (!m) continue;
    out.push({ imported: m[1], local: m[2] || m[1] });
  }
  return out;
}

/**
 * Parse the clause of a static import statement.
 * @param {string} clause text between `import` and `from`
 * @returns {{defaultName:(string|null), namespace:(string|null), named:Array<{imported:string,local:string}>}}
 */
function parseImportClause(clause) {
  const result = { defaultName: null, namespace: null, named: [] };
  if (!clause) return result;
  let rest = clause;
  const brace = /\{([^}]*)\}/.exec(rest);
  if (brace) {
    result.named = parseSpecifierList(brace[1]);
    rest = rest.slice(0, brace.index) + ' ' + rest.slice(brace.index + brace[0].length);
  }
  const tokens = splitTop(rest, ',');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();
    if (!token) continue;
    const ns = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(token);
    if (ns) {
      result.namespace = ns[1];
      continue;
    }
    const id = /^([A-Za-z_$][\w$]*)$/.exec(token);
    if (id) result.defaultName = id[1];
  }
  return result;
}

/**
 * Find the index just past the bracket matching the one at `i` (masked source).
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function matchBracket(src, i) {
  const open = src[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i, n = src.length; j < n; j++) {
    const c = src[j];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return src.length;
}

/**
 * Collect the declared names of a `const/let/var` declaration list starting at
 * `start` in a masked source.
 * @param {string} src masked source
 * @param {number} start index of the first character after the keyword
 * @returns {string[]}
 */
function parseDeclaratorNames(src, start) {
  const names = [];
  let i = start;
  let expectName = true;
  const n = src.length;
  while (i < n) {
    if (expectName) {
      const head = /^\s*([A-Za-z_$][\w$]*)/.exec(src.slice(i, i + 256));
      if (head) {
        names.push(head[1]);
        i += head[0].length;
        expectName = false;
        continue;
      }
      const pattern = /^\s*([[{])/.exec(src.slice(i, i + 64));
      if (pattern) {
        const openIdx = i + pattern[0].length - 1;
        const close = matchBracket(src, openIdx);
        const inner = src.slice(openIdx + 1, Math.max(openIdx + 1, close - 1));
        const parts = splitTop(inner, ',');
        for (let k = 0; k < parts.length; k++) {
          const mm = /^\s*(?:\.\.\.)?\s*(?:[A-Za-z_$][\w$]*\s*:\s*)?([A-Za-z_$][\w$]*)/.exec(parts[k]);
          if (mm) names.push(mm[1]);
        }
        i = close;
        expectName = false;
        continue;
      }
      break;
    }
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') {
      i = matchBracket(src, i);
      continue;
    }
    if (c === ';' || c === ')' || c === '}') break;
    if (c === ',') {
      expectName = true;
      i++;
      continue;
    }
    if (c === '\n') {
      const rest = src.slice(i + 1, i + 96);
      if (/^\s*(?:export|import|class|function|const|let|var|async|\/)/.test(rest)) break;
    }
    i++;
  }
  return names;
}

/* ------------------------------------------------------------------------- *
 * File walking and module analysis.
 * ------------------------------------------------------------------------- */

/**
 * Recursively list module files inside a directory.
 * @param {string} dir absolute directory
 * @param {string[]} out accumulator
 * @returns {string[]}
 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && MODULE_EXT.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Validate the JavaScript syntax of a file with `node --check`. A file that does
 * not parse cannot be analysed reliably, so it is reported and skipped.
 * @param {string} file absolute path
 * @returns {{line:number, message:string}|null}
 */
function javascriptSyntaxError(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (error) {
    const stderr = String((error && error.stderr) || (error && error.message) || '');
    const location = /:(\d+)\s*$/m.exec(stderr.split('\n')[0] || '');
    const message = /^\s*(\w*(?:Error|Warning):.*)$/m.exec(stderr);
    return {
      line: location ? Number(location[1]) : 1,
      message: message ? message[1].trim() : stderr.split('\n').slice(0, 2).join(' ').trim()
    };
  }
}

/** @type {Map<string, object>} cache of per file analyses */
const analysisCache = new Map();

/**
 * Analyse a module file: masked source, imports, exports.
 * @param {string} absPath
 * @returns {{ok:boolean, path:string, masked:string, starts:number[], imports:object[], exports:{named:Set<string>, hasDefault:boolean, defaultLine:number, stars:string[]}}}
 */
function analyzeFile(absPath) {
  const cached = analysisCache.get(absPath);
  if (cached) return cached;

  let source;
  try {
    source = readFileSync(absPath, 'utf8');
  } catch {
    const failed = {
      ok: false,
      path: absPath,
      masked: '',
      starts: [0],
      imports: [],
      exports: { named: new Set(), hasDefault: false, defaultLine: 0, stars: [] }
    };
    analysisCache.set(absPath, failed);
    return failed;
  }

  const { masked, literals } = maskSource(source);
  const starts = lineStarts(masked);

  /** @type {object[]} */
  const imports = [];
  /** @type {Array<{start:number,end:number}>} */
  const covered = [];

  const named = new Set();
  const stars = [];
  let hasDefault = false;
  let defaultLine = 0;

  /**
   * Resolve a placeholder index into its literal string value.
   * @param {string} indexText
   * @returns {string|null}
   */
  const literalValue = (indexText) => {
    const entry = literals[Number(indexText)];
    return entry ? entry.value : null;
  };

  // --- static imports -----------------------------------------------------
  RE_STATIC_IMPORT.lastIndex = 0;
  for (let m = RE_STATIC_IMPORT.exec(masked); m; m = RE_STATIC_IMPORT.exec(masked)) {
    const spec = literalValue(m[2]);
    const clause = parseImportClause(m[1] || '');
    imports.push({
      kind: 'import',
      spec,
      line: lineOf(starts, m.index),
      defaultName: clause.defaultName,
      namespace: clause.namespace,
      named: clause.named
    });
    covered.push({ start: m.index, end: m.index + m[0].length });
  }

  // --- re-exports (`export ... from '...'`) --------------------------------
  RE_EXPORT_FROM.lastIndex = 0;
  for (let m = RE_EXPORT_FROM.exec(masked); m; m = RE_EXPORT_FROM.exec(masked)) {
    const spec = literalValue(m[2]);
    const clause = (m[1] || '').trim();
    const line = lineOf(starts, m.index);
    covered.push({ start: m.index, end: m.index + m[0].length });

    const nsMatch = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (nsMatch) {
      named.add(nsMatch[1]);
      imports.push({ kind: 'export-from', spec, line, defaultName: null, namespace: nsMatch[1], named: [] });
      continue;
    }
    if (clause === '*') {
      stars.push(spec);
      imports.push({ kind: 'export-star', spec, line, defaultName: null, namespace: null, named: [] });
      continue;
    }
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace) {
      const list = parseSpecifierList(brace[1]);
      let defaultUse = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].local === 'default') {
          hasDefault = true;
          defaultLine = line;
        } else {
          named.add(list[i].local);
        }
        if (list[i].imported === 'default') defaultUse = list[i].local;
      }
      imports.push({
        kind: 'export-from',
        spec,
        line,
        defaultName: defaultUse,
        namespace: null,
        named: list.filter((s) => s.imported !== 'default')
      });
      continue;
    }
    imports.push({ kind: 'export-from', spec, line, defaultName: null, namespace: null, named: [] });
  }

  // --- dynamic imports ----------------------------------------------------
  RE_DYNAMIC_IMPORT.lastIndex = 0;
  for (let m = RE_DYNAMIC_IMPORT.exec(masked); m; m = RE_DYNAMIC_IMPORT.exec(masked)) {
    const spec = literalValue(m[1]);
    imports.push({
      kind: 'dynamic',
      spec,
      line: lineOf(starts, m.index),
      defaultName: null,
      namespace: null,
      named: []
    });
  }

  /**
   * True when the index falls inside an already consumed import/export-from.
   * @param {number} index
   * @returns {boolean}
   */
  const isCovered = (index) => {
    for (let i = 0; i < covered.length; i++) {
      if (index >= covered[i].start && index < covered[i].end) return true;
    }
    return false;
  };

  // --- local named exports ------------------------------------------------
  RE_EXPORT_BRACE.lastIndex = 0;
  for (let m = RE_EXPORT_BRACE.exec(masked); m; m = RE_EXPORT_BRACE.exec(masked)) {
    if (isCovered(m.index)) continue;
    const list = parseSpecifierList(m[1]);
    for (let i = 0; i < list.length; i++) {
      if (list[i].local === 'default') {
        hasDefault = true;
        defaultLine = lineOf(starts, m.index);
      } else {
        named.add(list[i].local);
      }
    }
  }

  RE_EXPORT_CLASS.lastIndex = 0;
  for (let m = RE_EXPORT_CLASS.exec(masked); m; m = RE_EXPORT_CLASS.exec(masked)) named.add(m[1]);

  RE_EXPORT_FUNCTION.lastIndex = 0;
  for (let m = RE_EXPORT_FUNCTION.exec(masked); m; m = RE_EXPORT_FUNCTION.exec(masked)) named.add(m[1]);

  RE_EXPORT_VAR.lastIndex = 0;
  for (let m = RE_EXPORT_VAR.exec(masked); m; m = RE_EXPORT_VAR.exec(masked)) {
    const declared = parseDeclaratorNames(masked, m.index + m[0].length);
    for (let i = 0; i < declared.length; i++) named.add(declared[i]);
  }

  RE_EXPORT_DEFAULT.lastIndex = 0;
  const defaultMatch = RE_EXPORT_DEFAULT.exec(masked);
  if (defaultMatch) {
    hasDefault = true;
    defaultLine = lineOf(starts, defaultMatch.index);
  }

  const result = {
    ok: true,
    path: absPath,
    masked,
    starts,
    imports,
    exports: { named, hasDefault, defaultLine, stars }
  };
  analysisCache.set(absPath, result);
  return result;
}

/** @type {Map<string, Set<string>>} */
const fullExportCache = new Map();

/**
 * Resolve a module specifier relative to the importing file.
 * @param {string} spec
 * @param {string} importerAbs
 * @returns {string|null} absolute path, or null for bare specifiers
 */
function resolveSpec(spec, importerAbs) {
  if (!spec) return null;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return resolve(dirname(importerAbs), spec);
  }
  if (spec.startsWith('/')) return resolve(ROOT, '.' + spec);
  return null;
}

/**
 * All named exports of a module, following `export * from` chains.
 * @param {string} absPath
 * @param {Set<string>} [seen] cycle guard
 * @returns {Set<string>}
 */
function getAllExports(absPath, seen = new Set()) {
  const cached = fullExportCache.get(absPath);
  if (cached) return cached;
  if (seen.has(absPath)) return new Set();
  seen.add(absPath);

  const analysis = analyzeFile(absPath);
  const all = new Set(analysis.exports.named);
  const stars = analysis.exports.stars;
  for (let i = 0; i < stars.length; i++) {
    const target = resolveSpec(stars[i], absPath);
    if (!target || !existsSync(target)) continue;
    const inherited = getAllExports(target, seen);
    for (const name of inherited) all.add(name);
  }
  fullExportCache.set(absPath, all);
  return all;
}

/* ------------------------------------------------------------------------- *
 * Reporting.
 * ------------------------------------------------------------------------- */

const useColor = process.stdout.isTTY && !process.argv.includes('--no-color');
const RED = useColor ? '\u001b[31m' : '';
const YELLOW = useColor ? '\u001b[33m' : '';
const GREEN = useColor ? '\u001b[32m' : '';
const DIM = useColor ? '\u001b[2m' : '';
const RESET = useColor ? '\u001b[0m' : '';

/** @type {Array<{file:string, line:number, message:string}>} */
const errors = [];
/** @type {Array<{file:string, line:number, message:string}>} */
const warnings = [];

/**
 * Record an error.
 * @param {string} file absolute path
 * @param {number} line
 * @param {string} message
 */
function addError(file, line, message) {
  errors.push({ file: relative(ROOT, file), line, message });
}

/**
 * Record a warning.
 * @param {string} file absolute path
 * @param {number} line
 * @param {string} message
 */
function addWarning(file, line, message) {
  warnings.push({ file: relative(ROOT, file), line, message });
}

/**
 * Suggest close matches for a missing export name.
 * @param {string} name
 * @param {Set<string>} candidates
 * @returns {string}
 */
function suggest(name, candidates) {
  const lower = name.toLowerCase();
  const close = [];
  for (const candidate of candidates) {
    const cl = candidate.toLowerCase();
    if (cl === lower || cl.includes(lower) || lower.includes(cl)) close.push(candidate);
  }
  if (close.length === 0) return '';
  return ` (voce quis dizer: ${close.slice(0, 4).join(', ')}?)`;
}

/* ------------------------------------------------------------------------- *
 * Main.
 * ------------------------------------------------------------------------- */

/**
 * Run the whole check.
 * @returns {number} process exit code
 */
function main() {
  const quiet = process.argv.includes('--quiet');
  const files = [];
  const missingDirs = [];
  for (let i = 0; i < SCAN_DIRS.length; i++) {
    const dir = join(ROOT, SCAN_DIRS[i]);
    if (!existsSync(dir)) {
      missingDirs.push(SCAN_DIRS[i]);
      continue;
    }
    walk(dir, files);
  }

  if (files.length === 0) {
    process.stderr.write(`${RED}check-imports: nenhum modulo encontrado em ${SCAN_DIRS.join(', ')}${RESET}\n`);
    return 1;
  }

  let importCount = 0;
  let bindingCount = 0;
  let syntaxErrors = 0;
  const skipSyntax = process.argv.includes('--no-syntax');

  for (let f = 0; f < files.length; f++) {
    const file = files[f];

    if (!skipSyntax) {
      const issue = javascriptSyntaxError(file);
      if (issue) {
        syntaxErrors++;
        addError(file, issue.line, `erro de sintaxe JavaScript: ${issue.message}`);
        continue;
      }
    }

    const analysis = analyzeFile(file);
    if (!analysis.ok) {
      addError(file, 1, 'nao foi possivel ler o arquivo');
      continue;
    }

    const relFile = relative(ROOT, file);
    const topDir = relFile.split(sep)[0];
    const strictJs = STRICT_JS_DIRS.indexOf(topDir) !== -1;

    if (analysis.exports.hasDefault) {
      addError(
        file,
        analysis.exports.defaultLine || 1,
        "'export default' e proibido pelo contrato: use apenas exports nomeados"
      );
    }

    const imports = analysis.imports;
    for (let i = 0; i < imports.length; i++) {
      const entry = imports[i];
      importCount++;

      if (entry.spec === null || entry.spec === undefined) {
        addWarning(file, entry.line, 'especificador dinamico nao literal: nao foi possivel verificar');
        continue;
      }

      if (entry.defaultName) {
        addError(
          file,
          entry.line,
          `import default '${entry.defaultName}' de '${entry.spec}' e proibido pelo contrato (somente exports nomeados)`
        );
      }

      const isRelative = entry.spec.startsWith('.') || entry.spec.startsWith('/');
      if (!isRelative) {
        if (BUILTINS.has(entry.spec)) {
          if (strictJs) {
            addError(
              file,
              entry.line,
              `modulo builtin do Node ('${entry.spec}') nao pode ser importado por codigo de ${topDir}/ (a engine roda no navegador)`
            );
          }
          continue;
        }
        addError(
          file,
          entry.line,
          `dependencia externa '${entry.spec}' e proibida: a engine nao pode ter nenhuma dependencia de terceiros`
        );
        continue;
      }

      // (d) explicit extension rules
      const ext = extname(entry.spec);
      if (strictJs) {
        if (!entry.spec.endsWith('.js')) {
          addError(
            file,
            entry.line,
            `import relativo '${entry.spec}' deve terminar em '.js' (ES modules nativos nao resolvem extensao)`
          );
        }
      } else if (ext !== '.js' && ext !== '.mjs' && ext !== '.json') {
        addError(
          file,
          entry.line,
          `import relativo '${entry.spec}' deve terminar em '.js' ou '.mjs' (ES modules nativos nao resolvem extensao)`
        );
      }

      // (a) target must exist
      const target = resolveSpec(entry.spec, file);
      if (!target) {
        addError(file, entry.line, `nao foi possivel resolver '${entry.spec}'`);
        continue;
      }
      let targetStat = null;
      try {
        targetStat = statSync(target);
      } catch {
        targetStat = null;
      }
      if (!targetStat) {
        addError(file, entry.line, `arquivo alvo inexistente: '${entry.spec}' -> ${relative(ROOT, target)}`);
        continue;
      }
      if (!targetStat.isFile()) {
        addError(file, entry.line, `'${entry.spec}' aponta para um diretorio, nao para um modulo`);
        continue;
      }
      if (!MODULE_EXT.has(extname(target)) && extname(target) !== '.json') {
        addWarning(file, entry.line, `'${entry.spec}' nao e um modulo .js/.mjs`);
        continue;
      }
      if (extname(target) === '.json') continue;

      // (b) named bindings must exist in the target
      if (entry.named.length === 0) continue;
      const available = getAllExports(target);
      for (let k = 0; k < entry.named.length; k++) {
        bindingCount++;
        const binding = entry.named[k];
        if (binding.imported === 'default') continue; // already reported as default usage
        if (!available.has(binding.imported)) {
          addError(
            file,
            entry.line,
            `'${binding.imported}' nao e exportado por '${entry.spec}'${suggest(binding.imported, available)}`
          );
        }
      }
    }
  }

  // --- report -------------------------------------------------------------
  const out = [];
  out.push('');
  out.push(`${DIM}check-imports${RESET} - grafo de modulos ES do AICoders Engine`);
  if (missingDirs.length) {
    out.push(`${YELLOW}  aviso: diretorios ausentes (ainda nao criados): ${missingDirs.join(', ')}${RESET}`);
  }
  out.push('');

  if (warnings.length && !quiet) {
    for (let i = 0; i < warnings.length; i++) {
      const w = warnings[i];
      out.push(`${YELLOW}  AVISO ${RESET}${w.file}:${w.line}: ${w.message}`);
    }
    out.push('');
  }

  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    out.push(`${RED}  ERRO  ${RESET}${e.file}:${e.line}: ${e.message}`);
  }
  if (errors.length) out.push('');

  out.push(
    `  arquivos: ${files.length}   imports: ${importCount}   bindings nomeados: ${bindingCount}   ` +
      `erros de sintaxe: ${syntaxErrors}   avisos: ${warnings.length}   erros: ${errors.length}`
  );
  if (errors.length === 0) out.push(`${GREEN}  OK - todo o grafo de imports esta consistente.${RESET}`);
  else out.push(`${RED}  FALHOU - ${errors.length} problema(s) de import/export.${RESET}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return errors.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // process.exitCode (instead of process.exit) so a piped stdout is never truncated.
  process.exitCode = main();
}

export { maskSource, analyzeFile, getAllExports, resolveSpec, parseImportClause, parseSpecifierList, main };
