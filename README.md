# FarmaJyV Venta

Punto de venta de escritorio para FarmaJyV (Angular 22 + Electron + PrimeNG + Firebase).

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

## Empaquetado (instalador de escritorio)

```bash
npm run electron:dist        # empaqueta para la plataforma actual (electron-builder), salida en /release
npm run electron:dist:mac
npm run electron:dist:win
```

## Stack

- Angular 22 (standalone, signals, `@angular/build`)
- PrimeNG 22 + `@primeuix/themes` (preset propio en `core/theme/pos.preset.ts`)
- Tailwind CSS v4
- `@ngx-translate` — i18n (`es` por defecto, `en` disponible) en `public/i18n/*.json`
- Firebase Auth (SDK modular directo, sin `@angular/fire` para no acoplar a una versión de Angular) + API REST (mismo backend que `farma-jyv-admin`)
- Electron + electron-builder para el empaquetado de escritorio

Ver `CLAUDE.md` para la arquitectura completa.
