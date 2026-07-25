/**
 * Valida o pacote antes de publicar.
 *
 * Um `exports` map quebrado nao falha em nenhum teste do repositorio: o codigo
 * roda perfeitamente aqui, onde os caminhos sao relativos, e so quebra na
 * maquina de quem instalou. Estas checagens simulam o consumo de fora.
 *
 * Uso: node tools/check-package.mjs
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let errors = 0;
let warnings = 0;

function fail(msg) { errors++; console.error('  ERRO  ' + msg); }
function warn(msg) { warnings++; console.warn('  AVISO ' + msg); }
function ok(msg) { console.log('  ok    ' + msg); }

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

console.log('\ncheck-package - ' + pkg.name + '@' + pkg.version + '\n');

/* ------------------------------------------------------------ metadados */

for (const field of ['name', 'version', 'description', 'license', 'repository', 'exports', 'files']) {
  if (pkg[field] === undefined) fail('package.json sem "' + field + '"');
}
if (pkg.private === true) {
  fail('package.json tem "private": true - npm publish vai recusar');
}
if (pkg.type !== 'module') fail('"type" deve ser "module"');
if (pkg.sideEffects !== false) {
  warn('"sideEffects": false ausente - bundlers nao vao poder eliminar codigo morto');
}
if (errors === 0) ok('metadados de publicacao completos');

/* ------------------------------------------------- versao em sincronia */

// A engine exporta a propria versao. Se ela divergir do package.json, quem
// consome recebe um numero que nao corresponde ao que instalou — e nada quebra,
// o que e justamente o que torna esse erro dificil de notar.
try {
  const barrel = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const m = /export const VERSION = '([^']+)'/.exec(barrel);
  if (m === null) {
    warn('src/index.js nao exporta VERSION');
  } else if (m[1] !== pkg.version) {
    fail('VERSION em src/index.js e "' + m[1] + '" mas package.json diz "' +
      pkg.version + '"');
  } else {
    ok('VERSION do barril bate com o package.json (' + pkg.version + ')');
  }
} catch (error) {
  warn('nao foi possivel ler src/index.js: ' + error.message);
}

/* ------------------------------------------------------- exports resolvem */

/**
 * Percorre o exports map e devolve todos os caminhos concretos declarados.
 * @returns {Array<{subpath: string, condition: string, target: string}>}
 */
function collectTargets(node, subpath, out) {
  if (typeof node === 'string') {
    out.push({ subpath, condition: 'default', target: node });
    return out;
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith('.')) collectTargets(node[key], key, out);
    else out.push({ subpath, condition: key, target: node[key] });
  }
  return out;
}

const targets = collectTargets(pkg.exports, '.', []);
let missing = 0;
for (const t of targets) {
  // Curingas sao validados a parte.
  if (t.target.indexOf('*') !== -1) continue;
  const file = join(ROOT, t.target);
  if (!existsSync(file)) {
    fail('exports["' + t.subpath + '"].' + t.condition + ' aponta para ' +
      t.target + ' que nao existe');
    missing++;
  }
}
if (missing === 0) ok(targets.length + ' alvos do exports map existem');

// O curinga ./src/* precisa que src/ esteja em files.
const wildcard = targets.filter((t) => t.target.indexOf('*') !== -1);
for (const t of wildcard) {
  const base = t.target.split('*')[0].replace(/^\.\//, '').replace(/\/$/, '');
  if (!pkg.files.some((f) => f === base || f.startsWith(base))) {
    fail('exports["' + t.subpath + '"] usa curinga em ' + base +
      ' mas "' + base + '" nao esta em "files"');
  }
}
if (wildcard.length > 0 && errors === 0) ok(wildcard.length + ' curinga(s) cobertos por "files"');

/* --------------------------------------------------------- files existem */

for (const entry of pkg.files) {
  if (!existsSync(join(ROOT, entry))) fail('"files" lista "' + entry + '" que nao existe');
}
ok('"files" lista ' + pkg.files.length + ' entradas, todas presentes');

/* -------------------------------------------- src/ e auto-contido */

/**
 * O tarball publicado leva src/ e types/. Se um arquivo de src/ importar algo
 * de fora (tools/, examples/), o pacote instala quebrado — e nada no repo
 * percebe, porque aqui o arquivo existe.
 */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(ROOT, 'src'), []);
const srcRoot = resolve(ROOT, 'src');
let escapes = 0;
let bareImports = 0;

for (const file of srcFiles) {
  const source = readFileSync(file, 'utf8');
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) specs.push(m[1]);
  DYNAMIC_RE.lastIndex = 0;
  while ((m = DYNAMIC_RE.exec(source)) !== null) specs.push(m[1]);

  for (const spec of specs) {
    if (!spec.startsWith('.')) {
      // Nada de dependencia externa nem builtin do Node em src/.
      fail(relative(ROOT, file) + ': importa "' + spec +
        '" - src/ tem que ser auto-contido e sem dependencias');
      bareImports++;
      continue;
    }
    const resolved = resolve(dirname(file), spec);
    if (!resolved.startsWith(srcRoot)) {
      fail(relative(ROOT, file) + ': importa "' + spec +
        '" fora de src/ - o pacote publicado nao leva esse arquivo');
      escapes++;
    }
  }
}
if (escapes === 0 && bareImports === 0) {
  ok(srcFiles.length + ' arquivos em src/, nenhum importa fora de src/ nem dependencia externa');
}

/* ----------------------------------------------- types espelham os barris */

const areaSubpaths = Object.keys(pkg.exports).filter((k) => k !== '.' && !k.includes('*') && k !== './package.json');
let typeGaps = 0;
for (const sub of areaSubpaths) {
  const entry = pkg.exports[sub];
  const runtime = typeof entry === 'string' ? entry : entry.default;
  const types = typeof entry === 'string' ? null : entry.types;
  if (types === undefined || types === null) {
    warn('exports["' + sub + '"] sem condicao "types" - o subpath fica sem tipagem');
    typeGaps++;
    continue;
  }
  if (!existsSync(join(ROOT, runtime))) fail('runtime de "' + sub + '" ausente: ' + runtime);
  if (!existsSync(join(ROOT, types))) {
    fail('tipos de "' + sub + '" ausentes: ' + types + ' (rode: npm run types)');
    typeGaps++;
  }
}
if (typeGaps === 0) ok(areaSubpaths.length + ' subpaths com runtime e tipos');

/* ------------------------------------- tipos em dia com os fontes */

const typesRoot = join(ROOT, 'types');
if (existsSync(typesRoot)) {
  let stale = 0;
  for (const file of srcFiles) {
    const rel = relative(join(ROOT, 'src'), file).replace(/\.js$/, '.d.ts');
    const dts = join(typesRoot, rel);
    if (!existsSync(dts)) {
      warn('sem tipos para src/' + relative(join(ROOT, 'src'), file) + ' (rode: npm run types)');
      stale++;
      continue;
    }
    if (statSync(file).mtimeMs > statSync(dts).mtimeMs + 1000) {
      warn('tipos desatualizados para src/' + relative(join(ROOT, 'src'), file));
      stale++;
    }
  }
  if (stale === 0) ok('types/ cobre e acompanha src/');
  else if (stale > 6) console.warn('  (' + stale + ' arquivos - rode: npm run types)');
} else {
  fail('types/ nao existe (rode: npm run types)');
}

/* -------------------------------------------------------------- veredito */

console.log('');
if (errors > 0) {
  console.error(errors + ' erro(s), ' + warnings + ' aviso(s) - pacote NAO esta pronto.\n');
  process.exit(1);
}
console.log('OK - pacote pronto para publicar' +
  (warnings > 0 ? ' (' + warnings + ' aviso(s))' : '') + '.\n');
