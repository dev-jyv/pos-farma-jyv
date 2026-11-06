# CLAUDE.md

Guía para Claude Code al trabajar en este repositorio.

## Proyecto

FarmaJyV Venta: punto de venta (POS) de escritorio para FarmaJyV, construido con Angular 22 + Electron. Comparte backend (Firestore + API REST) con `farma-jyv-admin`. UI en español (i18n default `es`).

## Comandos

- `npm start` / `ng serve` — servidor dev en `localhost:4400` contra los **emuladores** (`development`); `npm run start:dev-cloud` contra `farma-jyv-dev`
- `npm run build` — build de producción (`dist/farma-jyv-pos/browser`)
- `npm run electron:build` — build con configuración `electron` (`fileReplacements` a `environment.electron.ts`, `baseHref: './'`)
- `npm run electron:dev` / `electron:dev:cloud` — lanza Electron contra el dev server (`ELECTRON_DEV_SERVER_URL`, default `http://localhost:4400`) con `FARMAJYV_ENV=emulator` / `dev`; requieren `npm start` / `npm run start:dev-cloud` en paralelo
- `npm run release:mac|win` (feed de producción, `--project prod`) / `release:dev:mac|win` (build `electron-dev-cloud`, feed `farma-jyv-dev-updates`, `--project dev`) — ver `docs/SETUP.md` § Entornos
- `npm run electron:start` — build + Electron contra el bundle compilado
- `npm run electron:dist[:mac|:win]` — empaqueta con electron-builder (salida en `/release`)
- `npm test` / `ng test` — Vitest sobre `src/` (Angular)
- `npm run test:electron` — Vitest sobre `electron/test/**` (proceso principal: `electron/db/*.js` contra un Prisma falso en memoria; el builder de Angular no mira esa carpeta)
- `npm run test:all` — ambas suites
- `npm run check:promo-engine` — compara el sha256 de los casos dorados con los repos hermanos: `promotions-engine.cases.json` contra `../backend-farma-jyv` y `../farma-jyv-admin`, y `coupons-engine.cases.json` (SPEC 47) contra el backend (el admin solo si trae copia). Un repo hermano ausente se avisa y no falla; uno presente sin la copia obligatoria sí falla. El JSON no se edita en un solo repo: si cambia el motor, se regenera en todos.

## Arquitectura

### Layout: core / features / shared

- `src/app/core/` — singletons transversales: `auth` (`AuthService`, guards, login), `api` (interceptor de auth, `api.utils.ts`), `firebase` (inicialización del SDK modular de Firebase, sin `@angular/fire`), `layout` (shell + nav), `notifications`, `theme` (preset PrimeNG).
- `src/app/features/*` — un directorio por dominio de negocio. `pos` es la venta (búsqueda de producto, carrito, cobro).
- `src/app/shared/` — `models/` (barrel `index.ts`), `pipes/`, `ui/`, `utils/`.

### Firebase sin `@angular/fire`

`@angular/fire` aún no soporta Angular 22 (máximo `21.0.0-rc.0` al crear este proyecto). En vez de bajar la versión de Angular, `core/firebase/firebase.providers.ts` inicializa el SDK modular (`firebase/app`, `firebase/auth`) directamente vía `InjectionToken`s (`FIREBASE_APP`, `FIREBASE_AUTH`). `AuthService`, los guards y el interceptor usan `firebase/auth` (`onAuthStateChanged`, `signInWithEmailAndPassword`, etc.) igual que lo haría `@angular/fire`, solo que inyectando `FIREBASE_AUTH` en vez de `Auth` de `@angular/fire/auth`. Al migrar a `@angular/fire` cuando soporte Angular 22, reemplazar `provideFirebase()` por `provideFirebaseApp`/`provideAuth` y ajustar los imports.

### Routing & auth

- `app.routes.ts`: `/login` (bloqueado por `guestGuard` si ya hay sesión) y todo lo demás bajo `Shell` protegido por `authGuard`. Cada feature se carga lazy (`loadChildren`/`loadComponent`).
- `AuthService.fetchProfile()` resuelve el perfil contra `${apiUrl}/auth/me`: rol (documento de `roles`, slug libre: `admin`, `manager`, `cashier`, `doctor`, `accountant` o uno personalizado) más permisos efectivos. `StaffRole` es `string`, no un enum: la UI pregunta por permiso (`AuthService.can(area, level)`), no por slug, salvo las reglas que el backend ata a un slug (anular = `admin`). `fetchRole()` queda por compatibilidad para los guards. Sin rol válido no hay sesión utilizable.
- **El contador no entra a la caja (SPEC 45).** `POS_BLOCKED_ROLES` (`shared/models`, hoy solo `accountant`) se revisa en `Login.onSubmit` y en `guestGuard`: cierra sesión con "Tu usuario es de consulta de reportes; entra desde el panel.". Es por slug a propósito (rol de sistema); un rol personalizado sin `pos` sigue entrando como antes y lo frena cada pantalla.

### API

- `core/api/auth.interceptor.ts` adjunta el ID token de Firebase a requests hacia `environment.apiUrl` y fuerza logout ante 401.
- `core/api/api.utils.ts` centraliza `unwrapEntity`/`unwrapList` (formas de respuesta inconsistentes del backend) y `toDate` (Firestore `Timestamp` / epoch / string → `Date`). Reusar en vez de parsear respuestas por feature.

### Sync y promociones

- `core/sync/sync-scheduler.service.ts`: sync completo en horario fijo (10:30/14:00/20:00) más el manual limitado del cajero. Al terminar cada sync (y cada 15 min con red) reporta el diagnóstico remoto: el panel marca en rojo la caja con más de 2 h sin reportar. Aparte, `pullPromotions()` corre **cada hora** solo el pull incremental de promociones (mismo cursor), emite `PROMOTIONS_SYNCED_EVENT`, no corre sin sesión/`electronAPI`, no se encima con otro igual ni con un sync completo y no cuenta para el límite manual.
- `core/sync/auto-push.service.ts`: envío automático **solo de subida** tras cada venta, alta/edición de producto, entrada de stock o anulación (`notifyChange()`): debounce 7 s (máx. 30 s) → un solo `/sales/bulk`; sin red no intenta; backoff 15 s→5 min con variación y pausa de 15 min tras 5 intentos sin avance. **El backoff y la pausa solo frenan reintentos**: un `notifyChange()` siempre programa envío tras el debounce (≤ 30 s), porque un pendiente que nunca avanza (entrada esperando a un producto rechazado) dejaba la entrada recién capturada sin subir hasta el horario fijo. Su contrato (`PushOnlyFlusher`) no tiene `pull`: **bajar el catálogo solo ocurre en el horario fijo o con "Sincronizar"** (cada venta cambia el `updatedAt` del producto; con N cajas un pull por venta multiplica las lecturas de Firestore). Antes de crear un producto, `ProductCatalogService` comprueba el SKU con `GET /products?sku=` (1 lectura; `search` recorre hasta 500 productos); con 409 cae a la búsqueda amplia (backend sin el filtro).
- Si al cobrar una promo del ticket ya cerró (la detecta el checkout, o el backend responde 400 `La promoción "X" no está vigente`), la venta no se registra: `Sale.onPromotionClosed` baja promociones, recalcula y pide volver a cobrar. Excepción: con la tarjeta ya aprobada en la terminal sí se registra.
- Una venta cuyo turno o producto aún no tiene `remoteId` solo gasta `payloadResolveAttempts` si esa dependencia está **atorada** (rechazada o fuera de su cola); si va en camino, espera sin contar (`dependenciaEnCamino` en `electron/db/sales.js`).
- **Rechazos por código, no por texto (SPEC 49).** `core/sync/sync-error-codes.ts` es la tabla única (`SYNC_ERROR_ACTIONS`) que `SaleService` y `StockEntryService` consultan con el `code`/`retryable` del servidor (`SyncErrorCode` en `shared/models`, copia exacta del backend): `retryable` o `DEFERRED`/`ENTRY_IN_PROGRESS`/`INTERNAL` → pendiente **sin** `pushError`; solo `PRODUCT_NOT_FOUND` → conciliación (SPEC 52); `STOCK_INSUFFICIENT`/`BATCH_EXPIRED`/`PRODUCT_INACTIVE`, `SESSION_*`, `VALIDATION`, etc. → bloqueo visible; `ALREADY_VOIDED` → anulación cumplida. El código llega en el índice de `/sales/bulk` o en `error.details.code`; el `code` del índice de un backend viejo es el HTTP (`BAD_REQUEST`) y **no** cuenta: sin contrato se usa el clasificador por texto de antes. Al bloquear, `withSyncCode` deja el código al final del `pushError` (`… [SESSION_CLOSED]`) y `blocked-diagnosis.js` lo lee primero (`diagnosis.syncCode`), sin columna nueva que pueda quedarse vieja.
- **Lote tolerante (SPEC 48).** `SaleService` manda la cola en trozos de `BULK_MAX_ITEMS` = 50 (el tope de `bulkCreateSalesSchema`), en serie. Un índice `DEFERRED` (al servidor se le acabó el presupuesto de 40 s) queda pendiente **sin** `pushError` ni conciliación, y los trozos siguientes de esa pasada no salen (van detrás, por orden de folios). `SaleService.deferredCount()` es un contador monotónico que `AutoPushService` lee antes y después del envío (`PushOnlyFlusher.deferredCount`): un envío sin avance pero con `DEFERRED` no cuenta como intento fallido ni lleva a la pausa. `VALIDATION` por índice se bloquea visible con el mensaje del servidor (`… [VALIDATION]`); la bisección ante un 400 del lote entero se conserva para backends viejos.
- **Venta cobrada siempre entra (SPEC 52).** El lote offline ya no rechaza faltante de stock, catálogo inactivo ni turno cerrado (con `businessAt ≤ closedAt`): devuelve `ok: true` con `stockReview`/`catalogReview`/`lateSync`. `syncReviewOf` las traduce a `SaleSyncReview` (`{ stock, catalog, late }`) y `sales:markSynced` las guarda en `Sale.syncReviewJson` (migración `20261106100000_sale_sync_review`); el historial pinta "Revisión: faltante de stock" / "Revisión: cobrada con turno cerrado" / "Revisión: producto inactivo". Si aun así llegan esos códigos como rechazo, se bloquean visibles: `unreconciledSales` no descuenta partidas y mandarlas ahí inflaba el inventario. El clasificador por texto (backend sin código) no cambió.
- **Autor original (SPEC 54, ventas).** `electron/db/sales.js#conAutor` agrega `soldBy` = `cashierId` de la venta local (el uid de Firebase de quien cobró) al payload de `getPendingPush`, `getPendingVoided` y `prepareUnreconciled`, al enviar y no al cobrar (las ventas ya en cola también lo llevan; `payloadJson` no cambia). Un `soldBy` ya presente se respeta; sin cajero no se manda. Con eso el servidor atribuye la venta a quien cobró aunque suba otro (`syncedBy`) y la llave de idempotencia no depende de quien sincroniza.
- **Anulación con motivo y consistente (SPEC 62).** Anular (historial) abre `shared/ui/reason-dialog` (opciones rápidas + texto, mínimo 5, máx. 300; sin motivo no se habilita el botón; sin PIN). `SaleService.void(sale, reason)` guarda `Sale.voidReason` local y lo manda en `POST /sales/:id/void` `{ reason, voidedAt?, voidedBy? }`, también en la anulación diferida y en la de dos pasos (alta + void); una anulación local anterior al motivo viaja con `'Sin motivo (POS anterior)'`, el mismo texto que usa el backend. Alta OK + void fallido → `markSynced` (deja `remoteId` y `needsRemoteVoid`), nunca `pushError`. El fallo del void remoto se decide por código (`remoteVoidOutcome`): `ALREADY_VOIDED` cierra; red/5xx/401/408/429 sigue en cola; cualquier otro 4xx → `sales.markVoidFailed` (`voidError`), sale de `getNeedingRemoteVoid`, no detiene el cierre del turno y aparece en "Rechazados" como `kind: 'saleVoid'` (`anulacion-rechazada`): el cajero ve "Pedir a un admin"; el admin, "Reintentar" (`clearVoidError`). **Descartar es lógico**: `sales.discard(id, { discardedBy, reason })` exige motivo, pone `discardedAt`/`discardedBy`/`discardReason`, repone stock si seguía viva, escribe `SyncLog` y la venta sale del historial, la cola y el corte; se rechaza con `remoteId` ("Ya está en el servidor; anúlala.") o con `pushAttempts > 0` (salió al menos una vez hacia el servidor: `getPendingPush`/`getPendingVoided` con `contarIntentos` lo incrementan; la migración `20261106110000_sale_void_reason_discard` lo pone en 1 a las ya rechazadas por el servidor). Después, best-effort, `POST /sales/unreconciled` con motivo `descartada: <razón>` (sin `markUnreconciled`).
- Panel "Rechazados al sincronizar" (`shell`): cada registro trae `diagnosis.code` (`electron/db/blocked-diagnosis.js`, sin red) y su texto/acción sale de `core/sync/sync-diagnosis.ts`. "Reintentar" corre `SyncScheduler.flushPendingNow()` (orden completo, sin gastar el cupo manual). Solo para `desconocido` y con red se ofrece la IA: `SyncHelpService` → `POST /assistant/sync-help` del backend (resumen sin cliente ni partidas; nunca propone descartar).
- `pullPromotions()` también baja los **cupones** (`GET /coupons/sync`, entidad `coupons`, mismo cursor por `updatedAt`) y emite `COUPONS_SYNCED_EVENT`; el resultado de cupones no cuenta para el `true/false` de promociones (un backend sin la ruta deja un `sync_run` con error y nada más).
- `electron/db/promotions.js#purgeStale` (y `coupons.js#purgeStale`) borra al arrancar (best-effort, tras migraciones) las promos dadas de baja o terminadas hace más de 30 días.

### Venta por caja completa (SPEC 46)

- `Product.boxQuantity` (2..1000) + `boxPrice` (impuestos incluidos) llegan juntos por el pull o no cuentan (`hasBoxSale`); `boxBarcode` es opcional. `stock` **siempre en piezas**.
- Carrito: `CartProductLine.saleUnit: 'box'` → `lineKey` `product:<id>:box` (la pieza sigue en `product:<id>`), `quantity` cuenta **cajas**, `lineUnitPrice` = `boxPrice`. Caja y pieza del mismo producto son dos líneas que comparten existencias: `Sale.maxFor`/`commitAdd` validan `cajas × boxQuantity + piezas de la otra línea ≤ stock`. Una caja **nunca** entra a promoción (`PromoService.promotionFor`) ni manda `promotionId`; sí admite manual con el tope del 20 % y cupón de producto.
- Escanear `boxBarcode` agrega una caja (la búsqueda local lo incluye; el código de pieza y el SKU ganan). `getByBarcode` devuelve `saleUnit: 'box'` en ese caso; `cartProduct()` lo quita antes de meter el producto al carrito.
- Payload (`/sales/bulk`): `quantity` en cajas, `unitPrice` por caja, `saleUnit: 'box'`. **La partida local (`SaleItem`) guarda piezas en `quantity`**, como el backend, con `saleUnit` JSON `{ type, boxes, piecesPerBox, boxPrice }`: así el descuento de stock, la anulación, `pendingStockDelta` y los reportes siguen contando piezas sin saber de cajas. `sales.js#piecesOf` deriva las piezas de `boxes × piecesPerBox`, no del `quantity` que mande el renderer.
- Ticket: `boxOf` imprime "N cajas × M pzas" y la columna Cant muestra cajas.

### Cupones (SPEC 47)

- Tabla `Coupon` **solo-pull** (`electron/db/coupons.js`), id = código normalizado (`^[A-Z0-9-]{4,20}$`, mayúsculas, sin espacios). `findByCode` devuelve también inactivos para decir *por qué* no aplica.
- Motor `shared/utils/coupons.ts` (`computeCouponDiscount`, centavos) copiado del backend; `coupons-engine.cases.json` debe ser **byte a byte** el del backend (`check:promo-engine` lo compara; el admin no lo usa). Producto: `percent × neto` o `monto × piezas` con tope en el neto, nunca en líneas con promoción. Venta: sobre la suma de netos, con mínimo.
- `CouponService.apply` corre **después** de `PromoService.apply` en `Sale.setCart`: el cupón de producto entra en el `discountAmount` de la línea (`line.coupon`) y la línea pierde el manual (se conserva en `manualDiscounts` y vuelve si se quita el cupón); el de venta queda en `Sale.couponSaleDiscount` → `saleDiscountAmount` del payload, del desglose fiscal y del reparto por rama (`branchTotals`). El 20 % manual no cuenta el cupón.
- Vigencia con el reloj local; `usedCount ≥ maxUses` solo **avisa** ("puede estar agotado; el servidor lo revisará"): `/sales/bulk` nunca rechaza por el cupón, lo marca para revisión. El cupón se revalida al abrir el cobro (vencido o sin efecto → se quita y se avisa el total nuevo, hay que volver a pulsar F9), tras cada pull de cupones y en `Checkout.confirm` (salvo tarjeta ya aprobada) → `couponExpired`.
- Se aplica solo en la pantalla de venta (el cobro muestra el chip pero no lo cambia: con el diálogo abierto el total no se mueve). Persiste en el ticket autoguardado y en ventas en espera como `couponCode`, y se vuelve a buscar al recuperarlos. Venta local: `Sale.couponJson` y `SaleItem.couponDiscount`; ticket "Cupón CODIGO −$x".

### Ventas atoradas: bloqueadores, healing y diagnóstico remoto

- `electron/db/sale-blockers.js#diagnoseSale/blockersForPayload` devuelve los `PosBlocker` de una venta: turno local sin `remoteId`, producto local sin `remoteId` (error de `catalogPushError` → `pushError` → `Batch.pushError`) o producto **sin fila local** (`missingLocally`). Ids locales = uuid de Prisma; ids de Firestore = 20 alfanuméricos. Producto sin fila local con forma Firestore → se manda tal cual (`buildRemoteIdMap`, igual que el turno sin fila); con forma uuid → se bloquea **en el acto** (nunca va a aparecer).
- Bloqueo por espera (`getPendingPush`, `MAX_RESOLVE_ATTEMPTS`): `pushError` específico ("Espera al turno de Ana del 25/09 13:02 (su apertura falló: …)" / "Espera al producto X (alta local sin subir: …)") y `payloadResolveAttempts` al tope. **Esa marca (contador ≥ tope, o el texto genérico viejo) es como se reconoce un bloqueo por espera** (`isWaitBlocked`); `healClosedShiftBlocks` los salta.
- `healResolvedWaitBlocks` (al inicio de `getPendingPush`): desbloquea y repone el cupo si los bloqueadores ya se resolvieron, y reescribe el mensaje genérico viejo con el bloqueador concreto.
- Panel "Rechazados" (`shell.html`): cada venta trae `blockers` (`sales.listBlocked`). "Arreglar" → `core/sync/sync-repair.service.ts#fixSale`: reintenta el bloqueador (`cashSessions.retryPush` / `catalog.retryProductPush`), `SyncScheduler.flushPendingNow()`, y solo si ya no queda bloqueador limpia la venta y vuelve a empujar. Tras un "Arreglar" fallido con turno rechazado (o producto inexistente) se ofrece "Mandar a conciliación" (con `confirm`): `SaleService.sendToUnreconciled` → `POST /sales/unreconciled` con el payload de `sales.prepareUnreconciled` (sin `cashSessionId` local). Desde SPEC 53 el cuerpo lleva `deviceId` (el `id` de `get-device-info`, pedido una vez por `SaleService.deviceId()`; sin él se omite): el servidor arma el id del registro como `<deviceId|cashierId>:<localId>` y valida `localId` contra `[A-Za-z0-9_-]{1,128}`, que el uuid local cumple.
- Bitácora `SyncLog` (`electron/db/sync-log.js`, IPC `syncLog:*`): errores de sync y de push (se asientan en los handlers `mark*PushFailed`/`sync:recordRun` de `main.js`), bloqueos/desbloqueos, "Arreglar", comandos remotos. Purga >30 días al arrancar. Escribir con `appendSafe`: nunca puede romper un push.
- Diagnóstico remoto (`core/sync/pos-diagnostics.service.ts`): tras cada sync completo, el cierre de turno, el pull horario de promociones y, con red (`navigator.onLine`), un latido cada 15 min (`DIAGNOSTICS_HEARTBEAT_MS`, armado en `SyncScheduler.start()`), manda `POST /pos/diagnostics` con `diagnostics:buildSnapshot` (`electron/db/diagnostics.js`; `deviceId` = `id` de `get-device-info`) — incluye `openCashSessionId` (turno sin cerrar en el equipo: `remoteId`, o id local si no ha subido; `null` sin turno; se omite si SQLite falla) para que el backend avise por correo de una caja con turno abierto que deja de reportar (SPEC 44), y ejecuta los `PosCommand` devueltos (`retrySale`, `retryCashSession`, `retryProduct`, `sendSaleToUnreconciled`), reportando con `POST /pos/commands/:id/result` `{ status, message, deviceId }`. Best-effort, sin sesión no corre, un reporte a la vez; un resultado no reportado se reenvía sin re-ejecutar. Contrato en `shared/models` (`PosDiagnosticsInput`, `PosCommand`…): no cambiarlo de un solo lado.

### Copias locales de la base (SPEC 37)

- `electron/db/backup.js#backupDatabase(prisma, { dir, reason, ... })` escribe `farmajyv-pos-<reason>-<timestamp>.sqlite` con `VACUUM INTO` (primero a `.partial`, luego rename: una copia cortada nunca cuenta). La usan la copia **previa a migración** (`migrate.js`, motivo `pre-migracion`, en `userData/backups`, 5, con caída a copiar el archivo) y las **de rutina** (`corte-z`, `cierre`).
- Las de rutina van a `Documentos/FarmaJyV/respaldos` (fuera de `userData`; fuera de `prod`, `respaldos (<env>)`): `main.js` las lanza tras `cashSessions:closeLocal` (sin esperarla) y en `before-quit` (`preventDefault` → copia ≤ 5 s, `QUIT_BACKUP_TIMEOUT_MS` → `app.quit()` otra vez). Rotación: las 7 más nuevas de rutina; nunca toca las previas a migración ni archivos ajenos. Sin caída a copia de archivo (la base está viva).
- Un fallo nunca lanza: `log.error('local-backup-failed')` + `SyncLog` (`entity: 'respaldo'`), que viaja en el diagnóstico. `diagnostics:buildSnapshot` manda `lastLocalBackupAt` (la copia de rutina más nueva de la carpeta, o `null`). Restaurar es manual: `docs/RESTAURAR_RESPALDO.md`.

### Entornos

- `environment.ts` / `.prod.ts` / `.electron.ts` — producción (`farma-jyv`). `.electron.ts` añade `isElectron: true` y se activa solo en la configuración `electron` de `angular.json` (`baseHref: './'`, necesario porque Electron carga `index.html` con `file://`).
- `.development.ts` — **emuladores** (`demo-farmajyv`, `useEmulators: true` → `connectAuthEmulator`). `.dev-cloud.ts` / `.electron-dev-cloud.ts` — nube de pruebas `farma-jyv-dev`. Fuera de producción Mercado Pago va con `terminalEnabled: false` e ids vacíos.
- `electron/app-environment.js` separa `userData` (base SQLite, `invoice-rag/`) por entorno: fuera de `prod` usa `FarmaJyV Venta (<env>)`. Se resuelve en `main.js` antes de cargar `db/client.js`; no mover ese bloque.

### Electron

- `electron/main.js` — ventana única (`BrowserWindow`), carga dev server o `dist/farma-jyv-pos/browser/index.html` según `NODE_ENV`/`--dev`. IPC mínimo: `get-app-version`, `get-device-info` (MAC/hostname para identificar el equipo de venta).
- `electron/preload.js` — expone `window.electronAPI` vía `contextBridge` (`contextIsolation: true`, sin `nodeIntegration`).
- Empaquetado con `electron-builder`, configuración en la clave `build` de `package.json`.
- **El cliente de Prisma se declara como `node_modules/.prisma`, sin glob.** Los patrones de `files`/`asarUnpack` no entran en carpetas ocultas, así que `node_modules/.prisma/**/*` no incluye nada y el paquete sale sin el cliente generado: la app abre el login y muere con `MODULE_NOT_FOUND` al primer acceso a la base — un fallo que ninguna prueba ve, porque solo existe en el `.app` empaquetado.
- Antes de publicar un release, verificar el paquete real (no `electron:start`, que corre contra `node_modules`):
  `ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/<bin>" -e "new (require('<app>/Contents/Resources/app.asar/node_modules/@prisma/client').PrismaClient)({datasourceUrl:'file:/tmp/t.sqlite'}).\$queryRawUnsafe('select 1').then(()=>console.log('OK')).catch(e=>console.log('FALLA',e.message))"`

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
