/**
 * Prepara `dist-updates/` con lo que el auto-updater necesita y nada más.
 *
 * `release/` trae además carpetas de trabajo de electron-builder (`mac/`,
 * `mac-arm64/`, la app desempaquetada) que pesan cientos de megas y no sirven
 * para actualizar. Subirlas a Hosting sería pagar ancho de banda por basura, así
 * que aquí se copia solo el feed (`latest*.yml`), los instaladores y sus
 * `.blockmap` — el archivo que permite descargar únicamente el diff.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `--dev` prepara el feed de la nube de pruebas (`farma-jyv-dev-updates`) con
 * carpetas propias: `release:dev:*` compila a `release-dev/` y aquí se publica a
 * `dist-updates-dev/` (target de Hosting `updates-dev`). Nunca se mezclan con
 * los de producción: un `latest*.yml` de dev en `dist-updates/` haría que las
 * cajas reales se "actualizaran" a un build que habla con `farma-jyv-dev`.
 */
const ES_DEV = process.argv.includes('--dev');
const ORIGEN = ES_DEV ? 'release-dev' : 'release';
const DESTINO = ES_DEV ? 'dist-updates-dev' : 'dist-updates';
const PRODUCTO = ES_DEV ? 'FarmaJyV Venta DEV' : 'FarmaJyV Venta';
const COMPILAR = ES_DEV ? 'npm run electron:dist:dev:mac' : 'npm run electron:dist:mac';

/** Lo que consume `electron-updater`; el resto de `release/` es intermedio. */
const PUBLICABLE = /\.(yml|zip|dmg|exe|blockmap)$/i;
/** `builder-debug.yml` es diagnóstico de la compilación, no parte del feed. */
const EXCLUIDO = /^builder-debug\.yml$/i;

if (!existsSync(ORIGEN)) {
  console.error(`No existe ${ORIGEN}/. Compila primero: ${COMPILAR}`);
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
  console.error(`Falta el archivo latest*.yml en ${ORIGEN}/. ¿Compilaste con electron-builder?`);
  process.exit(1);
}

/**
 * Portada de descargas.
 *
 * El feed lo consume `electron-updater` por URL directa, pero una persona que
 * abre la raíz para instalar en una caja nueva se topaba con el "Page Not
 * Found" de Firebase: los archivos estaban ahí y no había forma de llegar a
 * ellos sin conocer el nombre exacto. Se genera aquí y no a mano para que no se
 * quede señalando una versión vieja.
 */
function escribirPortada() {
  const yml = readdirSync(DESTINO).find((nombre) => /^latest.*\.yml$/i.test(nombre));
  const version = yml
    ? (readFileSync(join(DESTINO, yml), 'utf8').match(/^version:\s*(.+)$/m)?.[1].trim() ?? '')
    : '';

  const instaladores = copiados
    .filter(({ nombre }) => /\.(dmg|exe)$/i.test(nombre))
    .map(({ nombre, mb }) => {
      const arm = /arm64/i.test(nombre);
      const equipo = nombre.endsWith('.exe')
        ? 'Windows'
        : arm
          ? 'Mac con chip Apple (M1 en adelante)'
          : 'Mac con chip Intel';
      return `      <li>
        <a href="${encodeURIComponent(nombre)}" download>${equipo}</a>
        <span>${mb} MB · ${nombre}</span>
      </li>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PRODUCTO} ${version}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; padding: 2.5rem 1.25rem; max-width: 40rem; font: 16px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif; }
  h1 { margin: 0; font-size: 1.5rem; }
  .version { color: #64757f; margin: .25rem 0 2rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin-bottom: .75rem; padding: .9rem 1rem; border: 1px solid #d5dee3; border-radius: .75rem; }
  li a { display: block; font-weight: 600; font-size: 1.05rem; color: #2e6c14; text-decoration: none; }
  li span { display: block; font-size: .8rem; color: #64757f; }
  .aviso { margin-top: 2rem; padding: 1rem; border-radius: .75rem; background: #fef3c7; color: #7c4a03; font-size: .9rem; }
  code { background: rgba(127,127,127,.18); padding: .1rem .3rem; border-radius: .25rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #131c21; color: #e6ecef; }
    li { border-color: #37454c; }
    li a { color: #9bd87a; }
    .aviso { background: #3a2f10; color: #f6dfa5; }
  }
</style>
</head>
<body>
  <h1>${PRODUCTO}</h1>
  <p class="version">Versión ${version} · descarga para instalar en una caja</p>${
    ES_DEV
      ? `
  <p class="aviso"><strong>Build de pruebas:</strong> habla con <code>farma-jyv-dev</code>, no con la farmacia. No instalar en una caja real.</p>`
      : ''
  }
  <ul>
${instaladores}
  </ul>
  <p class="aviso">
    <strong>Primera vez en Mac:</strong> el sistema dirá que no puede comprobar
    el desarrollador. Abre la app con <strong>clic derecho → Abrir</strong>, o
    ejecuta <code>xattr -d com.apple.quarantine "/Applications/${PRODUCTO}.app"</code>.
    Es porque la app aún no está firmada con un Apple Developer ID.
  </p>
</body>
</html>
`;
  writeFileSync(join(DESTINO, 'index.html'), html);
  console.log('  index.html (portada de descargas)');
}

escribirPortada();

for (const { nombre, mb } of copiados) {
  console.log(`  ${nombre} (${mb} MB)`);
}
console.log(`\n${copiados.length + 1} archivos listos en ${DESTINO}/`);
