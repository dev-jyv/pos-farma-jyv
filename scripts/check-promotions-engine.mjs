#!/usr/bin/env node
/**
 * Los casos dorados de los motores compartidos viven copiados en varios repos y
 * tienen que ser el MISMO archivo: la vista previa del admin, la caja y el
 * backend deben cobrar el mismo centavo. Este script compara el sha256 de cada
 * copia local contra las de los repos hermanos (rutas relativas a la raíz de
 * este repo: `../backend-farma-jyv` y `../farma-jyv-admin`).
 *
 * - `promotions-engine.cases.json`: backend, admin y POS.
 * - `coupons-engine.cases.json` (SPEC 47): backend y POS. El admin no calcula
 *   cupones; si algún día trae la copia, también se compara.
 *
 * Un repo hermano que no esté clonado junto a este se avisa y se salta (no
 * falla): en CI o en una máquina con solo la caja no hay contra qué comparar.
 * Una copia que existe y difiere sí falla, y también falla que falte una copia
 * obligatoria en un repo que sí está.
 *
 * Uso: `npm run check:promo-engine`
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..');
const backend = path.join(raiz, '..', 'backend-farma-jyv');
const admin = path.join(raiz, '..', 'farma-jyv-admin');

const archivos = [
  {
    nombre: 'promotions-engine.cases.json',
    hermanos: [
      { nombre: 'backend-farma-jyv', repo: backend, ruta: ['functions', 'test'], obligatorio: true },
      { nombre: 'farma-jyv-admin', repo: admin, ruta: ['src', 'app', 'shared', 'utils'], obligatorio: true },
    ],
  },
  {
    nombre: 'coupons-engine.cases.json',
    hermanos: [
      { nombre: 'backend-farma-jyv', repo: backend, ruta: ['functions', 'test'], obligatorio: true },
      { nombre: 'farma-jyv-admin', repo: admin, ruta: ['src', 'app', 'shared', 'utils'], obligatorio: false },
    ],
  },
];

const sha256 = (archivo) =>
  crypto.createHash('sha256').update(fs.readFileSync(archivo)).digest('hex');

let fallas = 0;
let comparados = 0;

for (const { nombre: archivoNombre, hermanos } of archivos) {
  console.log(`\n${archivoNombre}`);
  const local = path.join(raiz, 'src', 'app', 'shared', 'utils', archivoNombre);
  if (!fs.existsSync(local)) {
    console.error(`✗ No existe la copia local: ${path.relative(raiz, local)}`);
    fallas += 1;
    continue;
  }
  const esperado = sha256(local);
  console.log(`${'farma-jyv-pos'.padEnd(18)} ${esperado}`);

  for (const { nombre, repo, ruta, obligatorio } of hermanos) {
    if (!fs.existsSync(repo)) {
      console.warn(`⚠ ${nombre}: el repo no está en ${repo}; se omite la comparación.`);
      continue;
    }
    const archivo = path.join(repo, ...ruta, archivoNombre);
    if (!fs.existsSync(archivo)) {
      if (obligatorio) {
        console.error(`✗ ${nombre}: el repo existe pero falta ${path.relative(repo, archivo)}.`);
        fallas += 1;
      } else {
        console.log(`· ${nombre}: sin copia (no la usa); nada que comparar.`);
      }
      continue;
    }
    const hash = sha256(archivo);
    comparados += 1;
    const igual = hash === esperado;
    console.log(`${nombre.padEnd(18)} ${hash} ${igual ? '✓' : '✗ DISTINTO'}`);
    if (!igual) fallas += 1;
  }
}

if (fallas) {
  console.error(
    `\n${fallas} copia(s) de los casos dorados no coinciden o faltan. Regenera cada archivo en todos sus repos a la vez.`,
  );
  process.exit(1);
}
console.log(
  comparados
    ? '\nCasos dorados de los motores idénticos.'
    : '\nNo hubo repos hermanos contra qué comparar; nada que verificar.',
);
