#!/usr/bin/env node
/**
 * Los casos dorados del motor de promociones viven copiados en tres repos
 * (backend, admin y POS) y tienen que ser el MISMO archivo: la vista previa del
 * admin, la caja y el backend deben cobrar el mismo centavo. Este script compara
 * el sha256 de la copia local contra las de los repos hermanos (rutas relativas
 * a la raíz de este repo: `../backend-farma-jyv` y `../farma-jyv-admin`).
 *
 * Un repo hermano que no esté clonado junto a este se avisa y se salta (no
 * falla): en CI o en una máquina con solo la caja no hay contra qué comparar.
 * Una copia que existe y difiere sí falla.
 *
 * Uso: `npm run check:promo-engine`
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..');
const local = path.join(raiz, 'src', 'app', 'shared', 'utils', 'promotions-engine.cases.json');
const hermanos = [
  {
    nombre: 'backend-farma-jyv',
    repo: path.join(raiz, '..', 'backend-farma-jyv'),
    archivo: path.join(
      raiz,
      '..',
      'backend-farma-jyv',
      'functions',
      'test',
      'promotions-engine.cases.json',
    ),
  },
  {
    nombre: 'farma-jyv-admin',
    repo: path.join(raiz, '..', 'farma-jyv-admin'),
    archivo: path.join(
      raiz,
      '..',
      'farma-jyv-admin',
      'src',
      'app',
      'shared',
      'utils',
      'promotions-engine.cases.json',
    ),
  },
];

const sha256 = (archivo) =>
  crypto.createHash('sha256').update(fs.readFileSync(archivo)).digest('hex');

if (!fs.existsSync(local)) {
  console.error(`✗ No existe la copia local: ${path.relative(raiz, local)}`);
  process.exit(1);
}

const esperado = sha256(local);
console.log(`${'farma-jyv-pos'.padEnd(18)} ${esperado}`);

let fallas = 0;
let comparados = 0;
for (const { nombre, repo, archivo } of hermanos) {
  if (!fs.existsSync(repo)) {
    console.warn(`⚠ ${nombre}: el repo no está en ${repo}; se omite la comparación.`);
    continue;
  }
  if (!fs.existsSync(archivo)) {
    console.error(`✗ ${nombre}: el repo existe pero falta ${path.relative(repo, archivo)}.`);
    fallas += 1;
    continue;
  }
  const hash = sha256(archivo);
  comparados += 1;
  const igual = hash === esperado;
  console.log(`${nombre.padEnd(18)} ${hash} ${igual ? '✓' : '✗ DISTINTO'}`);
  if (!igual) fallas += 1;
}

if (fallas) {
  console.error(
    `\n${fallas} copia(s) de los casos dorados no coinciden. Regenera el archivo en los tres repos a la vez.`,
  );
  process.exit(1);
}
console.log(
  comparados
    ? '\nCasos dorados del motor de promociones idénticos.'
    : '\nNo hubo repos hermanos contra qué comparar; nada que verificar.',
);
