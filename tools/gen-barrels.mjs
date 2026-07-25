/**
 * Gera os barris por area (src/<area>/index.js) usados pelos subpath exports
 * do pacote.
 *
 * Gerar em vez de escrever a mao porque a lista tem que acompanhar o codigo:
 * um barril desatualizado nao quebra nada em teste algum, ele so faz um export
 * publico sumir silenciosamente.
 *
 * `export *` omite nomes ambiguos sem avisar, entao aqui os nomes sao listados
 * explicitamente e qualquer colisao vira erro em vez de um export perdido.
 *
 * Uso: node tools/gen-barrels.mjs [--check]
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');

const checkOnly = process.argv.includes('--check');

/** Areas que ganham barril, com o titulo usado no cabecalho. */
const AREAS = [
  ['math', 'Matematica'],
  ['core', 'Nucleo'],
  ['util', 'Utilitarios'],
  ['scene', 'Grafo de cena'],
  ['spatial', 'Aceleracao espacial'],
  ['geometry', 'Geometria e texturas procedurais'],
  ['animation', 'Animacao'],
  ['loaders', 'Carregadores de assets'],
  ['physics', 'Fisica e colisao'],
  ['input', 'Entrada'],
  ['audio', 'Audio'],
];

/**
 * Nomes que NAO entram nos barris, com o motivo.
 *
 * `register` e exportado por todo modulo em render/shaders com significados
 * diferentes; `srgbToLinear`/`linearToSrgb` de ProceduralTexture duplicam os
 * canonicos de math/Color.js.
 */
const EXCLUDE = new Map([
  ['register', 'colide entre os modulos de shader'],
  ['srgbToLinear', 'duplica math/Color.js'],
  ['linearToSrgb', 'duplica math/Color.js'],
]);

const EXPORT_RE = /^export\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*(?:from\s*['"][^'"]+['"])?\s*;?/gm;

/**
 * Extrai os nomes exportados de um arquivo.
 * @param {string} file
 * @returns {string[]}
 */
function exportsOf(file) {
  const source = readFileSync(file, 'utf8');
  const names = new Set();

  let m;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(source)) !== null) names.add(m[1]);

  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(source)) !== null) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (piece === '') continue;
      const as = piece.split(/\s+as\s+/);
      const name = (as.length > 1 ? as[1] : as[0]).trim();
      if (name !== '' && name !== 'default') names.add(name);
    }
  }

  return Array.from(names);
}

let failures = 0;

for (const [area, title] of AREAS) {
  const dir = join(SRC, area);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'index.js')
    .sort();

  /** @type {Map<string, string>} nome -> arquivo, para detectar colisao */
  const owner = new Map();
  const perFile = [];

  for (const file of files) {
    const names = exportsOf(join(dir, file))
      .filter((n) => !EXCLUDE.has(n))
      .sort();
    if (names.length === 0) continue;

    for (const name of names) {
      if (owner.has(name)) {
        console.error('  COLISAO em ' + area + ': "' + name + '" em ' +
          owner.get(name) + ' e ' + file);
        failures++;
      }
      owner.set(name, file);
    }
    perFile.push({ file, names });
  }

  let out = '/**\n * ' + title + ' — barril da area.\n *\n' +
    ' * GERADO por tools/gen-barrels.mjs. Nao edite a mao: rode o gerador.\n' +
    ' * Existe para o subpath export do pacote, por exemplo\n' +
    ' *   import { ' + (perFile[0] ? perFile[0].names[0] : 'X') +
    " } from 'aicoders-engine/" + area + "';\n */\n\n";

  for (const entry of perFile) {
    out += 'export { ' + entry.names.join(', ') + " } from './" + entry.file + "';\n";
  }

  const target = join(dir, 'index.js');
  if (checkOnly) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { current = ''; }
    if (current !== out) {
      console.error('  DESATUALIZADO: src/' + area + '/index.js');
      failures++;
    }
  } else {
    writeFileSync(target, out);
    console.log('  src/' + area + '/index.js  (' + perFile.length + ' arquivos, ' +
      owner.size + ' exports)');
  }
}

if (failures > 0) {
  console.error('\n' + failures + ' problema(s).' +
    (checkOnly ? ' Rode: node tools/gen-barrels.mjs' : ''));
  process.exit(1);
}

console.log('\nOK - barris ' + (checkOnly ? 'em dia' : 'gerados') + '.');
