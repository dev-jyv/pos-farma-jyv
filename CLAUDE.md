# CLAUDE.md

Guía para Claude Code al trabajar en este repositorio.

## Proyecto

FarmaJyV Venta: punto de venta (POS) de escritorio para FarmaJyV, construido con Angular 22 + Electron. Comparte backend (Firestore + API REST) con `farma-jyv-admin`. UI en español (i18n default `es`).

## Comandos

- `npm start` / `ng serve` — servidor dev en `localhost:4200`
- `npm run build` — build de producción (`dist/farma-jyv-pos/browser`)
- `npm run electron:build` — build con configuración `electron` (`fileReplacements` a `environment.electron.ts`, `baseHref: './'`)
- `npm run electron:dev` — lanza Electron contra el dev server (`ELECTRON_DEV_SERVER_URL`, default `http://localhost:4200`)
- `npm run electron:start` — build + Electron contra el bundle compilado
- `npm run electron:dist[:mac|:win]` — empaqueta con electron-builder (salida en `/release`)
- `npm test` / `ng test` — Vitest

## Arquitectura

### Layout: core / features / shared

- `src/app/core/` — singletons transversales: `auth` (`AuthService`, guards, login), `api` (interceptor de auth, `api.utils.ts`), `firebase` (inicialización del SDK modular de Firebase, sin `@angular/fire`), `layout` (shell + nav), `notifications`, `theme` (preset PrimeNG).
- `src/app/features/*` — un directorio por dominio de negocio. `pos` es la venta (búsqueda de producto, carrito, cobro).
- `src/app/shared/` — `models/` (barrel `index.ts`), `pipes/`, `ui/`, `utils/`.

### Firebase sin `@angular/fire`

`@angular/fire` aún no soporta Angular 22 (máximo `21.0.0-rc.0` al crear este proyecto). En vez de bajar la versión de Angular, `core/firebase/firebase.providers.ts` inicializa el SDK modular (`firebase/app`, `firebase/auth`) directamente vía `InjectionToken`s (`FIREBASE_APP`, `FIREBASE_AUTH`). `AuthService`, los guards y el interceptor usan `firebase/auth` (`onAuthStateChanged`, `signInWithEmailAndPassword`, etc.) igual que lo haría `@angular/fire`, solo que inyectando `FIREBASE_AUTH` en vez de `Auth` de `@angular/fire/auth`. Al migrar a `@angular/fire` cuando soporte Angular 22, reemplazar `provideFirebase()` por `provideFirebaseApp`/`provideAuth` y ajustar los imports.

### Routing & auth

- `app.routes.ts`: `/login` (bloqueado por `guestGuard` si ya hay sesión) y todo lo demás bajo `Shell` protegido por `authGuard`. Cada feature se carga lazy (`loadChildren`/`loadComponent`).
- `AuthService.fetchRole()` resuelve el `StaffRole` (`admin` | `cashier`) contra `${apiUrl}/auth/me`. Sin rol válido no hay sesión utilizable.

### API

- `core/api/auth.interceptor.ts` adjunta el ID token de Firebase a requests hacia `environment.apiUrl` y fuerza logout ante 401.
- `core/api/api.utils.ts` centraliza `unwrapEntity`/`unwrapList` (formas de respuesta inconsistentes del backend) y `toDate` (Firestore `Timestamp` / epoch / string → `Date`). Reusar en vez de parsear respuestas por feature.

### Entornos

- `environment.ts` / `.development.ts` / `.prod.ts` / `.electron.ts` — mismo proyecto Firebase y `apiUrl` que `farma-jyv-admin`. `.electron.ts` añade `isElectron: true` y se activa solo en la configuración `electron` de `angular.json` (`baseHref: './'`, necesario porque Electron carga `index.html` con `file://`).

### Electron

- `electron/main.js` — ventana única (`BrowserWindow`), carga dev server o `dist/farma-jyv-pos/browser/index.html` según `NODE_ENV`/`--dev`. IPC mínimo: `get-app-version`, `get-device-info` (MAC/hostname para identificar el equipo de venta).
- `electron/preload.js` — expone `window.electronAPI` vía `contextBridge` (`contextIsolation: true`, sin `nodeIntegration`).
- Empaquetado con `electron-builder`, configuración en la clave `build` de `package.json`.

## Convenciones Angular

- Standalone por defecto (sin `standalone: true` explícito).
- Signals para estado; `computed()` para derivado; `update`/`set`, nunca mutación directa.
- `input()`/`output()` en vez de decoradores. `ChangeDetectionStrategy.OnPush` en todo componente.
- Sin `@HostBinding`/`@HostListener` — usar el objeto `host` del decorador.
- Control de flujo nativo (`@if`/`@for`/`@switch`), nunca `*ngIf`/`*ngFor`.
- Sin `ngClass`/`ngStyle` — usar bindings `class`/`style`.
- Formularios reactivos sobre template-driven.
- `inject()` sobre inyección por constructor; servicios `providedIn: 'root'`.
- Plantillas/estilos externos relativos al `.ts` del componente.
- `@ngx-translate/core` v18+: usar `TranslatePipe`/`TranslateDirective` standalone, **no** `TranslateModule` (ya no se exporta).
- PrimeNG `p-table`: templates con `#header`/`#body`, no `pTemplate="..."` .

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
