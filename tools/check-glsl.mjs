#!/usr/bin/env node
/**
 * check-glsl.mjs - static validation of every GLSL source embedded in the engine.
 *
 * All shader code lives inside JavaScript template literals under
 * src/render/chunks/*.js (reusable snippets) and src/render/shaders/*.js
 * (complete programs). Nothing compiles them until a real GPU is available, so
 * this tool performs the checks a compiler would perform first:
 *
 *   1. balanced braces / parentheses / brackets;
 *   2. every `#include <name>` resolves to a chunk that really exists;
 *   3. complete programs start with `#version 300 es`;
 *   4. for every vertex/fragment pair, each `out` varying of the vertex stage
 *      has a matching `in` of the same type and name in the fragment stage and
 *      vice-versa (includes are resolved before comparing);
 *   5. no GLSL 1.00 syntax (varying / attribute / gl_FragColor / texture2D /
 *      textureCube / gl_FragData);
 *   6. the Camera / Lights / Shadows / Fog uniform blocks are declared with
 *      `layout(std140)` and are bound to the contract binding points
 *      (0 / 1 / 2 / 3).
 *
 * Problems are printed as "file:line: message"; the process exits with a non
 * zero status when at least one error is found.
 *
 * Usage: node tools/check-glsl.mjs [--quiet] [--no-color]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/** Project root (parent of tools/). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_DIR = join(ROOT, 'src', 'render', 'chunks');
const SHADER_DIR = join(ROOT, 'src', 'render', 'shaders');
const RENDER_DIR = join(ROOT, 'src', 'render');
const PREPROCESSOR_FILE = join(RENDER_DIR, 'ShaderPreprocessor.js');

/** Uniform block name -> mandatory std140 binding point (architecture contract, section 9). */
const UBO_BINDINGS = { Camera: 0, Lights: 1, Shadows: 2, Fog: 3 };

/** Forbidden GLSL 1.00 constructs. */
const LEGACY_PATTERNS = [
  { re: /(?<![\w#])varying(?![\w])/g, message: "'varying' e GLSL 1.00: use 'in'/'out'" },
  { re: /(?<![\w#])attribute(?![\w])/g, message: "'attribute' e GLSL 1.00: use 'layout(location=N) in'" },
  { re: /\bgl_FragColor\b/g, message: "'gl_FragColor' e GLSL 1.00: declare 'layout(location=0) out vec4 ...'" },
  { re: /\bgl_FragData\b/g, message: "'gl_FragData' e GLSL 1.00: declare saidas com layout(location=N)" },
  { re: /\btexture2D\s*\(/g, message: "'texture2D()' e GLSL 1.00: use 'texture()'" },
  { re: /\btexture2DProj\s*\(/g, message: "'texture2DProj()' e GLSL 1.00: use 'textureProj()'" },
  { re: /\btexture2DLod\s*\(/g, message: "'texture2DLod()' e GLSL 1.00: use 'textureLod()'" },
  { re: /\btextureCube\s*\(/g, message: "'textureCube()' e GLSL 1.00: use 'texture()'" },
  { re: /\btextureCubeLod\s*\(/g, message: "'textureCubeLod()' e GLSL 1.00: use 'textureLod()'" }
];

/** Varying / attribute style declaration at the beginning of a line. */
const VARYING_RE =
  /^[ \t]*(?:(?:flat|smooth|noperspective|centroid|invariant|precise|highp|mediump|lowp)[ \t]+)*(in|out)[ \t]+(?:(?:highp|mediump|lowp)[ \t]+)?([A-Za-z_]\w*)[ \t]+([A-Za-z_]\w*)[ \t]*(\[[^\]]*\])?[ \t]*;/gm;

/** Uniform block declaration. */
const UBO_RE = /(?:layout\s*\(([^)]*)\)\s*)?uniform\s+([A-Za-z_]\w*)\s*\{/g;

/* ------------------------------------------------------------------------- *
 * Reporting helpers
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
 * @param {string} file absolute file path
 * @param {number} line 1 based line number
 * @param {string} message
 */
function addError(file, line, message) {
  errors.push({ file: relative(ROOT, file), line, message });
}

/**
 * Record a warning.
 * @param {string} file absolute file path
 * @param {number} line 1 based line number
 * @param {string} message
 */
function addWarning(file, line, message) {
  warnings.push({ file: relative(ROOT, file), line, message });
}

/* ------------------------------------------------------------------------- *
 * Template literal extraction
 * ------------------------------------------------------------------------- */

/**
 * Skip a quoted string.
 * @param {string} src
 * @param {number} i index of the opening quote
 * @returns {number}
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
    if (c === quote || c === '\n') return i + 1;
    i++;
  }
  return i;
}

/**
 * Skip a `{ ... }` block honouring nested literals and comments.
 * @param {string} src
 * @param {number} i index of the opening brace
 * @returns {number}
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
      i = skipTemplate(src, i).end;
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
 * Skip a template literal, returning its end index and whether it interpolates.
 * @param {string} src
 * @param {number} i index of the opening backtick
 * @returns {{end:number, hasExpr:boolean}}
 */
function skipTemplate(src, i) {
  let hasExpr = false;
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return { end: i + 1, hasExpr };
    if (c === '$' && src[i + 1] === '{') {
      hasExpr = true;
      i = skipBraces(src, i + 1);
      continue;
    }
    i++;
  }
  return { end: i, hasExpr };
}

/**
 * Count the 1 based line number of an index inside a text.
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0, n = Math.min(index, text.length); i < n; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Replace every `${ ... }` interpolation by a harmless token so the GLSL
 * structure checks are not confused by JavaScript expressions.
 * @param {string} body
 * @returns {string}
 */
function stripInterpolations(body) {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '{') {
      const end = skipBraces(body, i + 1);
      let newlines = '';
      for (let k = i; k < end; k++) if (body.charCodeAt(k) === 10) newlines += '\n';
      out += '1' + newlines;
      i = end;
      continue;
    }
    out += body[i];
    i++;
  }
  return out;
}

/**
 * Guess the name a template literal was assigned to.
 * @param {string} src full JavaScript source
 * @param {number} backtickIndex
 * @returns {string|null}
 */
function labelBefore(src, backtickIndex) {
  const before = src.slice(Math.max(0, backtickIndex - 240), backtickIndex);
  const cleaned = before.replace(/\/\*[\s\S]*?\*\//g, ' ');
  let m = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(cleaned);
  if (m) return m[1];
  m = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(cleaned);
  if (m) return m[1];
  m = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*$/.exec(cleaned);
  if (m) return m[1];
  return null;
}

/**
 * Extract every template literal of a JavaScript file.
 * @param {string} src
 * @returns {Array<{label:(string|null), body:string, raw:string, index:number, line:number, hasExpr:boolean}>}
 */
function extractTemplates(src) {
  const found = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === '`') {
      const { end, hasExpr } = skipTemplate(src, i);
      const raw = src.slice(i + 1, Math.max(i + 1, end - 1));
      found.push({
        label: labelBefore(src, i),
        body: stripInterpolations(raw),
        raw,
        index: i,
        line: lineAt(src, i),
        hasExpr
      });
      i = end;
      continue;
    }
    i++;
  }
  return found;
}

/**
 * Heuristic: does this template literal contain GLSL?
 * @param {string} body
 * @returns {boolean}
 */
function looksLikeGLSL(body) {
  if (body.length < 12) return false;
  if (/#[ \t]*(version|include|ifdef|ifndef|define|endif|elif)\b/.test(body)) return true;
  if (/\bvoid\s+main\s*\(/.test(body)) return true;
  if (/\b(vec[234]|mat[234]|uniform|precision|sampler\w*|gl_\w+)\b|layout\s*\(/.test(body)) return true;
  // A multi line snippet declaring GLSL scalars is still GLSL.
  return body.indexOf('\n') !== -1 && /\b(float|int|uint|bool|void)\s+\w+\s*[(;=]/.test(body);
}

/* ------------------------------------------------------------------------- *
 * GLSL utilities
 * ------------------------------------------------------------------------- */

/**
 * Remove GLSL comments while preserving line structure.
 * @param {string} src
 * @returns {string}
 */
function stripGLSLComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      for (let k = start; k < i; k++) if (src.charCodeAt(k) === 10) out += '\n';
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/**
 * Keep only one side of every preprocessor conditional so asymmetric blocks can
 * be balance-checked branch by branch.
 * @param {string} src comment free GLSL
 * @param {'if'|'else'} keep which branch to preserve
 * @returns {string}
 */
function selectPreprocessorBranch(src, keep) {
  const lines = src.split('\n');
  const out = [];
  /** @type {Array<{active:boolean, seenElse:boolean}>} */
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const directive = /^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b/.exec(line);
    if (directive) {
      const kind = directive[1];
      if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
        stack.push({ active: keep === 'if', seenElse: false });
      } else if (kind === 'elif' || kind === 'else') {
        const top = stack[stack.length - 1];
        if (top) {
          top.seenElse = true;
          top.active = keep === 'else';
        }
      } else if (kind === 'endif') {
        stack.pop();
      }
      out.push('');
      continue;
    }
    let active = true;
    for (let k = 0; k < stack.length; k++) if (!stack[k].active) active = false;
    out.push(active ? line : '');
  }
  return out.join('\n');
}

/**
 * Count bracket balance of a GLSL source.
 * @param {string} src comment free GLSL
 * @returns {{braces:number, parens:number, brackets:number, firstUnmatched:number}}
 */
function bracketBalance(src) {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let firstUnmatched = -1;
  for (let i = 0, n = src.length; i < n; i++) {
    const c = src[i];
    if (c === '{') braces++;
    else if (c === '}') {
      braces--;
      if (braces < 0 && firstUnmatched < 0) firstUnmatched = i;
    } else if (c === '(') parens++;
    else if (c === ')') {
      parens--;
      if (parens < 0 && firstUnmatched < 0) firstUnmatched = i;
    } else if (c === '[') brackets++;
    else if (c === ']') {
      brackets--;
      if (brackets < 0 && firstUnmatched < 0) firstUnmatched = i;
    }
  }
  return { braces, parens, brackets, firstUnmatched };
}

/**
 * Normalize a chunk name for tolerant lookups.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build all lookup aliases of a chunk name.
 * @param {string} name
 * @returns {string[]}
 */
function nameAliases(name) {
  const base = normalizeName(name);
  const aliases = new Set([base]);
  const suffixes = ['glsl', 'chunk', 'shader', 'source', 'src'];
  for (let i = 0; i < suffixes.length; i++) {
    const s = suffixes[i];
    if (base.endsWith(s) && base.length > s.length) aliases.add(base.slice(0, base.length - s.length));
    aliases.add(base + s);
  }
  return [...aliases];
}

/* ------------------------------------------------------------------------- *
 * Collection
 * ------------------------------------------------------------------------- */

/**
 * List .js files of a directory (non recursive is enough for chunks/shaders).
 * @param {string} dir
 * @returns {string[]}
 */
function listJs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === '.js')
    .map((entry) => join(dir, entry.name))
    .sort();
}

/**
 * Recursively list .js files (used to look for registerChunk() calls).
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function listJsDeep(dir, out = []) {
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listJsDeep(full, out);
    else if (entry.isFile() && extname(entry.name) === '.js') out.push(full);
  }
  return out;
}

/**
 * Validate the JavaScript syntax of a file with `node --check`.
 * A shader file with a stray backtick would silently break template extraction,
 * so this runs first and short circuits the GLSL checks for that file.
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

/**
 * A parsed GLSL template literal.
 * @typedef {{file:string, label:(string|null), body:string, line:number, hasExpr:boolean, index:number, stage:(string|null)}} GLSLUnit
 */

/**
 * Classify a GLSL unit as vertex / fragment / null using its label and body.
 * @param {(string|null)} label
 * @param {string} body
 * @returns {string|null}
 */
function classifyStage(label, body) {
  const l = label ? label.toLowerCase() : '';
  if (/vert|vs\b|_vs|vsource/.test(l)) return 'vertex';
  if (/frag|fs\b|_fs|fsource|pixel/.test(l)) return 'fragment';
  if (/\bgl_Position\b/.test(body)) return 'vertex';
  if (/\bgl_FragCoord\b|layout\s*\(\s*location\s*=\s*0\s*\)\s*out\s+vec4/.test(body)) return 'fragment';
  return null;
}

/* ------------------------------------------------------------------------- *
 * ShaderPreprocessor awareness
 * ------------------------------------------------------------------------- */

/** @type {boolean|null} memoised answer of {@link preprocessorInjectsPrecision}. */
let _injectsPrecision = null;

/**
 * Does ShaderPreprocessor.resolve() really emit a default float precision for
 * the fragment stage? Read from the source instead of assumed, so the check
 * follows the engine: the day that injection is removed, the warning comes back
 * by itself.
 * @returns {boolean}
 */
function preprocessorInjectsPrecision() {
  if (_injectsPrecision !== null) return _injectsPrecision;
  _injectsPrecision = false;
  if (!existsSync(PREPROCESSOR_FILE)) return _injectsPrecision;
  const src = stripGLSLComments(readFileSync(PREPROCESSOR_FILE, 'utf8'));
  // The emit has to be guarded by the fragment stage and must contain the
  // 'precision <qualifier> float;' line itself.
  const guardsFragment = /stage\s*===\s*['"]fragment['"]/.test(src);
  const emitsPrecision = /['"`]\s*precision\s+(highp|mediump|lowp)\s+float\s*;\s*['"`]/.test(src);
  _injectsPrecision = guardsFragment && emitsPrecision;
  return _injectsPrecision;
}

/**
 * Is this shader file compiled through ShaderLib (and therefore through the
 * ShaderPreprocessor)? A file qualifies when it hands its sources to a shader
 * library - `shaderLib.register(...)`, `export function register(shaderLib)` or
 * one of the `registerXxxShaders()` helpers - which is the only way the engine
 * ever builds a Program (see ShaderLib.get -> new Program(..., {preprocessor})).
 *
 * @param {string} src JavaScript source of the shader module
 * @returns {boolean}
 */
function usesShaderLib(src) {
  return /\bshaderLib\s*\.\s*register\s*\(/.test(src) ||
    /\bfunction\s+register\w*\s*\(\s*shaderLib/.test(src) ||
    /\bregister\w*\s*\(\s*shaderLib\s*\)/.test(src);
}

/* ------------------------------------------------------------------------- *
 * Checks
 * ------------------------------------------------------------------------- */

/**
 * Check bracket balance of one GLSL unit.
 * @param {GLSLUnit} unit
 * @param {string} clean comment free source
 */
function checkBalance(unit, clean) {
  const total = bracketBalance(clean);
  if (total.braces === 0 && total.parens === 0 && total.brackets === 0) return;

  const ifBranch = bracketBalance(selectPreprocessorBranch(clean, 'if'));
  const elseBranch = bracketBalance(selectPreprocessorBranch(clean, 'else'));
  const branchesOk =
    ifBranch.braces === 0 &&
    ifBranch.parens === 0 &&
    ifBranch.brackets === 0 &&
    elseBranch.braces === 0 &&
    elseBranch.parens === 0 &&
    elseBranch.brackets === 0;

  const parts = [];
  if (total.braces !== 0) parts.push(`chaves ${total.braces > 0 ? '+' : ''}${total.braces}`);
  if (total.parens !== 0) parts.push(`parenteses ${total.parens > 0 ? '+' : ''}${total.parens}`);
  if (total.brackets !== 0) parts.push(`colchetes ${total.brackets > 0 ? '+' : ''}${total.brackets}`);
  const where = total.firstUnmatched >= 0 ? unit.line + lineAt(clean, total.firstUnmatched) - 1 : unit.line;
  const label = unit.label || '(anonimo)';

  if (branchesOk) {
    addWarning(
      unit.file,
      where,
      `${label}: desbalanceamento aparente (${parts.join(', ')}) mas cada ramo de #if/#else esta balanceado`
    );
    return;
  }
  addError(unit.file, where, `${label}: GLSL desbalanceado (${parts.join(', ')})`);
}

/**
 * Check the forbidden GLSL 1.00 constructs.
 * @param {GLSLUnit} unit
 * @param {string} clean comment free source
 */
function checkLegacySyntax(unit, clean) {
  for (let i = 0; i < LEGACY_PATTERNS.length; i++) {
    const pattern = LEGACY_PATTERNS[i];
    pattern.re.lastIndex = 0;
    const m = pattern.re.exec(clean);
    if (m) {
      addError(unit.file, unit.line + lineAt(clean, m.index) - 1, `${unit.label || '(anonimo)'}: ${pattern.message}`);
    }
  }
}

/**
 * Check uniform block declarations of one GLSL unit.
 * @param {GLSLUnit} unit
 * @param {string} clean comment free source
 * @param {Map<string, number>} jsBindings bindings discovered in JavaScript
 */
function checkUniformBlocks(unit, clean, jsBindings) {
  UBO_RE.lastIndex = 0;
  for (let m = UBO_RE.exec(clean); m; m = UBO_RE.exec(clean)) {
    const layout = (m[1] || '').trim();
    const name = m[2];
    const line = unit.line + lineAt(clean, m.index) - 1;
    const known = Object.prototype.hasOwnProperty.call(UBO_BINDINGS, name);
    const hasStd140 = /\bstd140\b/.test(layout);

    if (!hasStd140) {
      const message = `uniform block '${name}' precisa de layout(std140) (o layout padrao 'shared' quebra o upload do UBO)`;
      if (known) addError(unit.file, line, message);
      else addWarning(unit.file, line, message);
    }

    const bindingMatch = /\bbinding\s*=\s*(\d+)/.exec(layout);
    if (bindingMatch) {
      addWarning(
        unit.file,
        line,
        `uniform block '${name}': o qualificador 'binding=' nao existe em GLSL ES 3.00 (use gl.uniformBlockBinding)`
      );
      if (known && Number(bindingMatch[1]) !== UBO_BINDINGS[name]) {
        addError(
          unit.file,
          line,
          `uniform block '${name}' declarado com binding=${bindingMatch[1]}, o contrato exige ${UBO_BINDINGS[name]}`
        );
      }
    }

    if (known) {
      const jsBinding = jsBindings.get(name);
      if (jsBinding !== undefined && jsBinding !== UBO_BINDINGS[name]) {
        addError(
          unit.file,
          line,
          `uniform block '${name}' e associado ao binding ${jsBinding} no JavaScript, o contrato exige ${UBO_BINDINGS[name]}`
        );
      }
    }
  }
}

/**
 * Resolve `#include <name>` directives against the chunk registry.
 * @param {string} src
 * @param {Map<string,string>} registry normalized name -> source
 * @param {string[]} stack cycle guard
 * @param {string[]} unresolved output list of unknown includes
 * @param {number} depth
 * @returns {string}
 */
function resolveIncludes(src, registry, stack, unresolved, depth = 0) {
  if (depth > 32) return src;
  return src.replace(/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"][^\n]*$/gm, (_line, rawName) => {
    const key = lookupChunk(registry, rawName);
    if (!key) {
      unresolved.push(rawName);
      return '';
    }
    if (stack.indexOf(key) !== -1) return '';
    return resolveIncludes(registry.get(key), registry, stack.concat(key), unresolved, depth + 1);
  });
}

/**
 * Find the registry key of an include name.
 * @param {Map<string,string>} registry
 * @param {string} rawName
 * @returns {string|null}
 */
function lookupChunk(registry, rawName) {
  const candidates = nameAliases(rawName.replace(/\.glsl$/i, ''));
  for (let i = 0; i < candidates.length; i++) if (registry.has(candidates[i])) return candidates[i];
  return null;
}

/**
 * Extract the varyings of a GLSL stage.
 * @param {string} clean comment free source
 * @param {'in'|'out'} direction
 * @returns {Map<string,string>} name -> type (with array suffix)
 */
function collectVaryings(clean, direction) {
  const found = new Map();
  VARYING_RE.lastIndex = 0;
  for (let m = VARYING_RE.exec(clean); m; m = VARYING_RE.exec(clean)) {
    if (m[1] !== direction) continue;
    const type = m[2];
    const name = m[3];
    const array = m[4] ? m[4].replace(/\s+/g, '') : '';
    if (name.startsWith('gl_')) continue;
    if (type === 'struct') continue;
    found.set(name, type + array);
  }
  return found;
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

/**
 * Run the whole GLSL verification.
 * @returns {number} exit code
 */
function main() {
  const quiet = process.argv.includes('--quiet');
  const chunkFiles = listJs(CHUNK_DIR);
  const shaderFiles = listJs(SHADER_DIR);

  if (chunkFiles.length === 0 && shaderFiles.length === 0) {
    process.stderr.write(
      `${RED}check-glsl: nenhum arquivo GLSL encontrado em src/render/chunks/ nem em src/render/shaders/${RESET}\n`
    );
    return 1;
  }

  /** @type {Map<string,string>} normalized chunk name -> source */
  const registry = new Map();
  /** @type {Set<string>} human friendly chunk names, used in error messages */
  const primaryNames = new Set();
  /** @type {GLSLUnit[]} */
  const units = [];

  // --- JavaScript syntax gate --------------------------------------------
  // Template literal extraction is only meaningful on parseable files.
  const skipSyntax = process.argv.includes('--no-syntax');
  /** @type {Set<string>} */
  const brokenFiles = new Set();
  if (!skipSyntax) {
    const allGlslFiles = chunkFiles.concat(shaderFiles);
    for (let i = 0; i < allGlslFiles.length; i++) {
      const issue = javascriptSyntaxError(allGlslFiles[i]);
      if (issue) {
        brokenFiles.add(allGlslFiles[i]);
        addError(allGlslFiles[i], issue.line, `erro de sintaxe JavaScript: ${issue.message}`);
      }
    }
  }

  // --- chunks -------------------------------------------------------------
  for (let f = 0; f < chunkFiles.length; f++) {
    const file = chunkFiles[f];
    if (brokenFiles.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    const templates = extractTemplates(src);
    for (let t = 0; t < templates.length; t++) {
      const tpl = templates[t];
      if (!looksLikeGLSL(tpl.body)) continue;
      const unit = {
        file,
        label: tpl.label,
        body: tpl.body,
        line: tpl.line,
        hasExpr: tpl.hasExpr,
        index: tpl.index,
        stage: null,
        isChunk: true
      };
      units.push(unit);
      const fileName = basename(file).replace(/\.glsl\.js$|\.js$/i, '');
      primaryNames.add(tpl.label || fileName);
      primaryNames.add(fileName);
      const names = tpl.label ? nameAliases(tpl.label) : [];
      const fallback = nameAliases(fileName);
      const keys = names.length ? names : fallback;
      for (let k = 0; k < keys.length; k++) if (!registry.has(keys[k])) registry.set(keys[k], tpl.body);
      // The file name is always a valid alias too.
      for (let k = 0; k < fallback.length; k++) if (!registry.has(fallback[k])) registry.set(fallback[k], tpl.body);
    }
  }

  // --- explicit registerChunk('name', ...) calls ---------------------------
  const renderFiles = listJsDeep(RENDER_DIR);
  /** @type {Map<string, number>} */
  const jsBindings = new Map();
  for (let f = 0; f < renderFiles.length; f++) {
    const src = readFileSync(renderFiles[f], 'utf8');
    const registerRe = /registerChunk\s*\(\s*['"`]([A-Za-z0-9_.\-/]+)['"`]/g;
    for (let m = registerRe.exec(src); m; m = registerRe.exec(src)) {
      const aliases = nameAliases(m[1]);
      let already = false;
      for (let k = 0; k < aliases.length; k++) if (registry.has(aliases[k])) already = true;
      primaryNames.add(m[1]);
      if (!already) registry.set(normalizeName(m[1]), '');
    }
    for (const blockName of Object.keys(UBO_BINDINGS)) {
      // Matches `'Camera', 0`, `"Camera": 0` and `Camera: 0` (object literal key).
      const bindingRe = new RegExp("(?<![\\w$.])['\"]?" + blockName + "['\"]?\\s*[,:]\\s*(\\d+)", 'g');
      for (let m = bindingRe.exec(src); m; m = bindingRe.exec(src)) {
        if (!jsBindings.has(blockName)) jsBindings.set(blockName, Number(m[1]));
      }
    }
  }

  // --- shaders ------------------------------------------------------------
  /** @type {Map<string, GLSLUnit[]>} */
  const perShaderFile = new Map();
  for (let f = 0; f < shaderFiles.length; f++) {
    const file = shaderFiles[f];
    if (brokenFiles.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    const templates = extractTemplates(src);
    const fileUnits = [];
    // Sources handed to a ShaderLib go through the ShaderPreprocessor, which
    // injects the default precision; sources compiled by hand do not.
    const preprocessed = usesShaderLib(src);
    for (let t = 0; t < templates.length; t++) {
      const tpl = templates[t];
      if (!looksLikeGLSL(tpl.body)) continue;
      const unit = {
        file,
        label: tpl.label,
        body: tpl.body,
        raw: tpl.raw,
        line: tpl.line,
        hasExpr: tpl.hasExpr,
        index: tpl.index,
        stage: classifyStage(tpl.label, tpl.body),
        isChunk: false,
        preprocessed
      };
      units.push(unit);
      fileUnits.push(unit);
    }
    perShaderFile.set(file, fileUnits);
  }

  // --- per unit checks ----------------------------------------------------
  let includeCount = 0;
  for (let u = 0; u < units.length; u++) {
    const unit = units[u];
    const clean = stripGLSLComments(unit.body);

    checkBalance(unit, clean);
    checkLegacySyntax(unit, clean);
    checkUniformBlocks(unit, clean, jsBindings);

    // includes must resolve
    const includeRe = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm;
    for (let m = includeRe.exec(clean); m; m = includeRe.exec(clean)) {
      includeCount++;
      if (!lookupChunk(registry, m[1])) {
        const names = [...primaryNames].sort().join(', ');
        addError(
          unit.file,
          unit.line + lineAt(clean, m.index) - 1,
          `#include <${m[1]}> nao corresponde a nenhum chunk registrado. Disponiveis: ${names}`
        );
      }
    }

    if (unit.isChunk) {
      if (/^[ \t]*#[ \t]*version\b/m.test(clean)) {
        addError(unit.file, unit.line, `chunk '${unit.label || basename(unit.file)}' nao pode declarar '#version'`);
      }
      continue;
    }

    // complete programs must start with '#version 300 es'
    const startsWithVersion = /^\s*(?:\/\/[^\n]*\n\s*)*#version\s+300\s+es\b/.test(unit.body);
    if (!startsWithVersion) {
      const interpolatedHead = unit.hasExpr && /^\s*\$\{/.test(unit.raw || '');
      const message = `${unit.label || '(anonimo)'}: shader completo deve comecar com '#version 300 es' na primeira linha`;
      if (interpolatedHead) addWarning(unit.file, unit.line, message + ' (comeca com interpolacao ${...}: nao verificavel)');
      else addError(unit.file, unit.line, message);
    }

    if (unit.stage === 'fragment') {
      const unresolved = [];
      const resolved = resolveIncludes(clean, registry, [], unresolved);
      // A precisao default so precisa estar escrita no fonte quando ele NAO passa
      // pelo ShaderPreprocessor - o preprocessador injeta 'precision highp float;'
      // logo apos o '#version' de todo fragment shader (ver ShaderPreprocessor.resolve).
      const injected = preprocessorInjectsPrecision() && unit.preprocessed;
      if (!injected && !/precision\s+(highp|mediump|lowp)\s+float\s*;/.test(resolved)) {
        addWarning(unit.file, unit.line, `${unit.label || '(anonimo)'}: fragment shader sem 'precision highp float;'`);
      }
    }
  }

  // --- vertex / fragment varying matching ---------------------------------
  let pairCount = 0;
  for (const [file, fileUnits] of perShaderFile) {
    const vertexUnits = fileUnits.filter((u) => u.stage === 'vertex');
    const fragmentUnits = fileUnits.filter((u) => u.stage === 'fragment');
    if (vertexUnits.length === 0 || fragmentUnits.length === 0) {
      if (fileUnits.length > 0 && (vertexUnits.length === 0) !== (fragmentUnits.length === 0)) {
        addWarning(
          file,
          fileUnits[0].line,
          'nao foi possivel identificar um par vertex/fragment neste arquivo (varyings nao verificadas)'
        );
      }
      continue;
    }

    for (let i = 0; i < fragmentUnits.length; i++) {
      const fragment = fragmentUnits[i];
      let vertex = null;
      let bestScore = Infinity;
      for (let k = 0; k < vertexUnits.length; k++) {
        const candidate = vertexUnits[k];
        const distance = fragment.index - candidate.index;
        const score = distance >= 0 ? distance : Math.abs(distance) * 4;
        if (score < bestScore) {
          bestScore = score;
          vertex = candidate;
        }
      }
      if (!vertex) continue;
      pairCount++;

      const vertexUnresolved = [];
      const fragmentUnresolved = [];
      const vertexSource = resolveIncludes(stripGLSLComments(vertex.body), registry, [], vertexUnresolved);
      const fragmentSource = resolveIncludes(stripGLSLComments(fragment.body), registry, [], fragmentUnresolved);
      const incomplete = vertexUnresolved.length > 0 || fragmentUnresolved.length > 0;

      const outs = collectVaryings(vertexSource, 'out');
      const ins = collectVaryings(fragmentSource, 'in');
      const pairName = `${vertex.label || 'vertex'} -> ${fragment.label || 'fragment'}`;

      for (const [name, type] of outs) {
        if (!ins.has(name)) {
          const message = `${pairName}: varying '${name}' (${type}) declarada como 'out' no vertex mas ausente no fragment`;
          if (incomplete) addWarning(file, fragment.line, message + ' [includes nao resolvidos]');
          else addError(file, fragment.line, message);
        } else if (ins.get(name) !== type) {
          addError(
            file,
            fragment.line,
            `${pairName}: varying '${name}' tem tipo '${type}' no vertex e '${ins.get(name)}' no fragment`
          );
        }
      }
      for (const [name, type] of ins) {
        if (!outs.has(name)) {
          const message = `${pairName}: varying '${name}' (${type}) declarada como 'in' no fragment mas ausente no vertex`;
          if (incomplete) addWarning(file, vertex.line, message + ' [includes nao resolvidos]');
          else addError(file, vertex.line, message);
        }
      }
    }
  }

  // --- report -------------------------------------------------------------
  const out = [];
  out.push('');
  out.push(`${DIM}check-glsl${RESET} - shaders GLSL ES 3.00 do AICoders Engine`);
  if (shaderFiles.length === 0) {
    out.push(`${YELLOW}  aviso: src/render/shaders/ ainda nao existe (somente chunks verificados)${RESET}`);
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
    `  chunks: ${chunkFiles.length}   arquivos de shader: ${shaderFiles.length}   blocos GLSL: ${units.length}   ` +
      `includes: ${includeCount}   pares vertex/fragment: ${pairCount}   avisos: ${warnings.length}   erros: ${errors.length}`
  );
  if (errors.length === 0) out.push(`${GREEN}  OK - GLSL consistente.${RESET}`);
  else out.push(`${RED}  FALHOU - ${errors.length} problema(s) de GLSL.${RESET}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return errors.length === 0 ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // process.exitCode (instead of process.exit) so a piped stdout is never truncated.
  process.exitCode = main();
}

export { extractTemplates, stripGLSLComments, bracketBalance, collectVaryings, resolveIncludes, normalizeName, main };
