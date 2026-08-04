# Memory — FarmaJyV Venta (POS)

## Stack

- Angular 22 standalone, signals, OnPush, lazy routes
- Electron (desktop), sin `@angular/fire` — Firebase SDK modular vía `InjectionToken`s (`core/firebase/firebase.providers.ts`)
- `@ngx-translate/core` v18+ → i18n `es` default
- Backend compartido con `farma-jyv-admin`: Firestore + API REST, mismo `apiUrl`
- Package: `farma-jyv-pos`

## Layout / routes

- Shell: `src/app/core/layout/`
- Routes: `src/app/app.routes.ts` — `/login` (`guestGuard`) + resto bajo `Shell` (`authGuard`)
- Features: `src/app/features/{dashboard, pos}` — `pos` tiene `cash-session`, `checkout`, `sale`, `services`
- `AuthService.fetchRole()` → `${apiUrl}/auth/me` (`admin` | `cashier`)

## Conventions

- Ver `CLAUDE.md` (reglas completas Angular/Electron ya documentadas ahí)
- `core/api/api.utils.ts`: `unwrapEntity`/`unwrapList`/`toDate` — reusar, no reparsear por feature
- Entornos: `.development` / `.prod` / `.electron` (`baseHref: './'`, `isElectron: true`)

## Preferencias user

- Español UI/i18n primario
- Commits solo si pide; caveman full activo en chat
- No inventar scope fuera de lo pedido
