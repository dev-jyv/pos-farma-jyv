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

/**
 * El paquete tiene que llevar el cliente de Prisma generado (`node_modules/.prisma`).
 *
 * Los patrones de `files` de electron-builder no entran en carpetas ocultas: con
 * `node_modules/.prisma/**` el 1.0.0 salió **sin** el cliente y la app abría el
 * login y moría con `MODULE_NOT_FOUND` al primer acceso a la base. Ninguna
 * prueba lo veía —solo existe en el `.app` empaquetado—, así que se comprueba
 * aquí, en el único paso por el que pasa todo lo que se publica.
 */
function verificarPrismaEmpaquetado() {
  const apps = [];
  for (const carpeta of readdirSync(ORIGEN)) {
    const ruta = join(ORIGEN, carpeta);
    if (!statSync(ruta).isDirectory()) {
      continue;
    }
    for (const nombre of readdirSync(ruta)) {
      if (nombre.endsWith('.app')) {
        apps.push(join(ruta, nombre));
      }
    }
  }
  if (!apps.length) {
    // Un release de Windows no deja `.app`: no hay nada que revisar aquí.
    return;
  }
  const sinPrisma = apps.filter(
    (app) => !existsSync(join(app, 'Contents/Resources/app.asar.unpacked/node_modules/.prisma')),
  );
  if (sinPrisma.length) {
    console.error('El paquete no lleva el cliente de Prisma; la app moriría al abrir la base:');
    for (const app of sinPrisma) {
      console.error(`  ${app}`);
    }
    console.error('Revisa `build.files` en package.json (usar la forma from/to, no un glob).');
    process.exit(1);
  }
  console.log(`Prisma empaquetado correctamente en ${apps.length} app(s).`);
}

verificarPrismaEmpaquetado();

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
