/**
 * Prepara `dist-updates/` con lo que el auto-updater necesita y nada más.
 *
 * `release/` trae además carpetas de trabajo de electron-builder (`mac/`,
 * `mac-arm64/`, la app desempaquetada) que pesan cientos de megas y no sirven
 * para actualizar. Subirlas a Hosting sería pagar ancho de banda por basura, así
 * que aquí se copia solo el feed (`latest*.yml`), los instaladores y sus
 * `.blockmap` — el archivo que permite descargar únicamente el diff.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ORIGEN = 'release';
const DESTINO = 'dist-updates';

/** Lo que consume `electron-updater`; el resto de `release/` es intermedio. */
const PUBLICABLE = /\.(yml|zip|dmg|exe|blockmap)$/i;
/** `builder-debug.yml` es diagnóstico de la compilación, no parte del feed. */
const EXCLUIDO = /^builder-debug\.yml$/i;

if (!existsSync(ORIGEN)) {
  console.error(`No existe ${ORIGEN}/. Compila primero: npm run electron:dist:mac`);
  process.exit(1);
}

rmSync(DESTINO, { recursive: true, force: true });
mkdirSync(DESTINO, { recursive: true });

const copiados = [];
for (const nombre of readdirSync(ORIGEN)) {
  const ruta = join(ORIGEN, nombre);
  if (!statSync(ruta).isFile()) {
    continue;
  }
  if (!PUBLICABLE.test(nombre) || EXCLUIDO.test(nombre)) {
    continue;
  }
  cpSync(ruta, join(DESTINO, nombre));
  copiados.push({ nombre, mb: (statSync(ruta).size / 1024 / 1024).toFixed(1) });
}

if (!copiados.some((archivo) => archivo.nombre.endsWith('.yml'))) {
  // Sin feed no hay actualización: el updater no sabría qué versión hay.
  console.error('Falta el archivo latest*.yml en release/. ¿Compilaste con electron-builder?');
  process.exit(1);
}

for (const { nombre, mb } of copiados) {
  console.log(`  ${nombre} (${mb} MB)`);
}
console.log(`\n${copiados.length} archivos listos en ${DESTINO}/`);
