# FarmaJyV Venta

Punto de venta de escritorio para FarmaJyV (Angular 22 + Electron + PrimeNG + Firebase).

**Local-first**: cobra contra su propia SQLite y sincroniza después, así que la
caja vende sin red. Es una de tres aplicaciones sobre la misma API —
[diagrama del sistema](docs/arquitectura.png).

## Desarrollo web

```bash
npm start          # ng serve — http://localhost:4200
npm run build      # build de producción (dist/farma-jyv-pos/browser)
npm test           # unit tests con Vitest
```

## Desarrollo Electron

```bash
npm run electron:dev     # build electron + levanta Electron apuntando a localhost:4200 (dev server debe estar corriendo aparte, o usar el bundle)
npm run electron:start   # build + ejecuta Electron contra el bundle compilado
```

## Pruebas

```bash
npm test             # 942 casos sobre src/ (jsdom)
npm run test:electron  # 238 casos sobre electron/ (Prisma falso en memoria)
npm run test:all     # ambas
```

## Empaquetado y publicación

```bash
npm run electron:dist        # empaqueta para la plataforma actual, salida en /release
npm run electron:dist:mac
npm run electron:dist:win

npm run release:mac          # empaqueta, prepara el feed y publica a Firebase Hosting
npm run release:win
```

`release:*` publica en `farma-jyv-updates.web.app`, que sirve de feed para
`electron-updater` y de página de descargas. Antes de subir, el script verifica
que el paquete lleve el cliente de Prisma desempacado: sin él la app abre el
login y muere al primer acceso a la base, y ninguna prueba lo detecta.

## Stack

- Angular 22 (standalone, signals, `@angular/build`)
- PrimeNG 22 + `@primeuix/themes` (preset propio en `core/theme/pos.preset.ts`)
- Tailwind CSS v4
- `@ngx-translate` — i18n (`es` por defecto, `en` disponible) en `public/i18n/*.json`
- Firebase Auth (SDK modular directo, sin `@angular/fire` para no acoplar a una versión de Angular) + API REST (mismo backend que `farma-jyv-admin`)
- Electron + electron-builder para el empaquetado de escritorio

## Documentación

| Documento | Para qué |
|---|---|
| [`docs/DOSSIER_TECNICO.md`](docs/DOSSIER_TECNICO.md) | Manual técnico: arquitectura, reglas de dinero, sincronización, Electron, pruebas y deuda |
| [`docs/INSTALACION_CAJA.md`](docs/INSTALACION_CAJA.md) | Instalar el POS en una caja nueva |
| [`docs/SETUP.md`](docs/SETUP.md) | Preparar una máquina de desarrollo |
| [`docs/MANUAL_USUARIO.md`](docs/MANUAL_USUARIO.md) | Manual del cajero |
| [`GOALS.md`](GOALS.md) | Pendientes y bitácora de lo hecho |
| `CLAUDE.md` | Guía para agentes |
