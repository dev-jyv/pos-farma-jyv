# Dosier técnico — FarmaJyV Venta (POS)

Punto de venta de escritorio para farmacia. Angular 22 + Electron 43 + PrimeNG 22, Firebase Auth y API REST NestJS (`backend-farma-jyv`), compartida con `farma-jyv-admin`.

Documento generado a partir del código en `main` (commit `f2ccc96`). Versión declarada en `environment.version`: `v1.0.0`.

---

## 1. Panorama

| Dato | Valor |
|---|---|
| Tipo | App de escritorio (Electron) + web SPA (mismo bundle) |
| Idioma UI | Español (`es` default, `en` presente en `public/i18n/en.json`) |
| Autenticación | Firebase Auth (email/password), SDK modular directo |
| Autorización | `GET /auth/me` → rol (documento `roles`) + permisos por área |
| Persistencia local | `localStorage` (cola offline, ticket en curso, ventas en pausa) |
| Impresión | `window.print()` sobre componentes montados al vuelo; cajón por ESC/POS vía IPC |
| Pago tarjeta | Mercado Pago Point (órdenes + polling) a través del backend |
| Tamaño | ~8.000 líneas (`src` + `electron`), 60 archivos fuente |
| Pruebas | Vitest sobre jsdom, 44 archivos, 423 casos — todos pasan (`npm test`) |

### Alcance funcional implementado

Venta (búsqueda/escaneo, ticket, descuentos, pausa), cobro (efectivo, tarjeta Point, mixto), **cobro directo sin venta** (terminal o link de pago con QR, en colección aparte), turno de caja (apertura, movimientos, cierre con corte Z propio), cumplimiento COFEPRIS (grupos I–VI, receta, retención, libro de control), desglose fiscal IVA/IEPS, cola offline idempotente, historial del día, reportes locales, anulación (solo `admin`), impresión de ticket/corte/etiqueta, auto-update Electron.

No implementado (ver `GOALS.md`): timbrado CFDI, devoluciones/notas de crédito, lectura X, reportes de servidor, multi-caja con selección al login, pantalla de cliente.

---

## 2. Estructura del repositorio

```
electron/           main.js (ventana, IPC, auto-update, cajón), preload.js (contextBridge)
public/i18n/        es.json, en.json
public/brand/       logo.png (original), isotipo.png (barra), logo-completo.png (login)
src/app/
  core/             api/ auth/ audio/ firebase/ health/ layout/ notifications/ theme/
  features/pos/     sale/ checkout/ direct-charge/ stock-entry/ cash-session/ history/ reports/
                    controlled-ledger/ ticket/ services/
  shared/           models/index.ts,
                    utils/{money,tender,taxes,controlled,session-expiry,date-range,point-order}.ts
  testing/          setup.ts (rellenos de jsdom para las pruebas)
src/environments/   environment{,.development,.prod,.electron}.ts
```

Regla de dependencia: `features` → `core` y `shared`; `shared` no importa de `features`; `core` es singleton transversal.

---

## 3. Arranque y configuración

### `app.config.ts`

- `provideRouter(routes)` + `withHashLocation()` **solo** cuando `environment.isElectron` — Electron carga `index.html` por `file://` y el router de path rompe.
- `provideHttpClient(withInterceptors([authInterceptor]))`.
- `provideTranslateService` con loader HTTP; prefijo `./i18n/` en Electron, `/i18n/` en web.
- `provideFirebase()` — `InjectionToken`s propios (ver 4.1).
- `providePrimeNG` con preset `PosPreset` y `darkModeSelector: false` (caja siempre en claro).

### Entornos

Los cuatro archivos comparten proyecto Firebase, `apiUrl` y credenciales de Mercado Pago (`storeId: 79584227`, `posId: 136088410`). Diferencias:

| Archivo | `production` | `isElectron` |
|---|---|---|
| `environment.ts` | false | false |
| `.development.ts` | false | false |
| `.prod.ts` | true | false |
| `.electron.ts` | true | true |

Claves de configuración operativa: `printTicketOnSale` (auto-imprime al cerrar venta), `expiryWarningDays: 30`, `soundsEnabled`, `promos: []` (reglas locales NxM/%), `cashDrawer.printerName` (vacío = cajón deshabilitado), `pharmacy.{name,address,phone,rfc}` (encabezado de tickets), `mercadoPago.terminalId` (terminal de **esta** caja; vacío = usar la primera que devuelva la API).

Variables del backend que condicionan al POS (`backend-farma-jyv/functions/.env`):

| Variable | Efecto si falta |
|---|---|
| `MERCADOPAGO_WEBHOOK_SECRET` | En producción se **rechazan** las notificaciones de Mercado Pago: sin firma, cualquiera que conozca la URL podría marcar un cobro como aprobado. El POS sigue resolviendo por sondeo |
| `PUBLIC_API_URL` | La preferencia de Checkout Pro se crea sin `notification_url`; el cobro en línea solo se resuelve por sondeo |
| `MERCADOPAGO_RETURN_URL` | La preferencia se crea sin `back_urls` ni `auto_return`: el cliente se queda en Mercado Pago tras pagar |
| `MERCADOPAGO_PRINT_ON_TERMINAL` | Default `no_ticket`: la terminal no imprime porque el ticket lo imprime el POS |

> **Nota de seguridad.** `environment.ts` versiona la `apiKey` de Firebase (esperado: es pública y se protege por reglas del proyecto) y la licencia de PrimeNG. No hay secretos de servidor en el bundle; el Access Token de Mercado Pago vive en el backend.

### Comandos

```bash
npm start                 # ng serve → localhost:4200
npm run build             # producción → dist/farma-jyv-pos/browser
npm run electron:build    # configuración `electron` (baseHref ./, env.electron)
npm run electron:dev      # Electron contra el dev server
npm run electron:start    # build + Electron contra el bundle
npm run electron:dist[:mac|:win]   # electron-builder → /release
npm test                  # Vitest
```

Presupuesto de bundle inicial: aviso 1.2 MB, error 1.6 MB. Hoy son 1.12 MB en crudo y **258 kB transferidos**; el aviso estaba en 700 kB y saltaba en cada build, lo que tapaba regresiones reales. En una app de escritorio que carga desde disco, el crudo importa menos que el transferido.

`allowedCommonJsDependencies` declara `qrcode` y `dijkstrajs`: son CommonJS y avisan de bailout de optimización. Se acepta a sabiendas porque el QR se importa de forma diferida (`import('qrcode')` dentro del cobro directo) y queda en su propio chunk.

---

## 4. Core

### 4.1 Firebase sin `@angular/fire`

`core/firebase/firebase.providers.ts` expone `FIREBASE_APP` y `FIREBASE_AUTH` como `InjectionToken`s creados con `initializeApp`/`getAuth` del SDK modular. Motivo: `@angular/fire` no soportaba Angular 22 al crear el proyecto. Consumo idéntico al de `@angular/fire` salvo el token inyectado. Migración futura: reemplazar `provideFirebase()` por `provideFirebaseApp`/`provideAuth`.

### 4.2 `AuthService`

- `user` — signal desde `onAuthStateChanged`.
- `profile` — signal desde `GET /auth/me`, parseado con `parseStaffProfile` (tolera `role` como string o `{slug}`). Deduplicado con `shareReplay(1)` + `finalize` que limpia la petición en vuelo, y **cacheado por sesión** (5 min de TTL, atado al `uid`): `shareReplay` solo deduplica lo que está en vuelo, así que cada `permissionGuard` disparaba un `GET /auth/me` y navegar entre pantallas costaba un viaje de red por cambio de ruta. `refreshProfile()` invalida a mano; el backend sigue siendo la autoridad y responde 403 aunque la caché diga otra cosa.
- `role`, `roleName`, `permissions`, `isAuthenticated`, `isAdmin` (`role === 'admin'`, exacto porque `assertCanVoidSale` en el backend exige ese slug), `canSell` (`sales:write`).
- `can(area, level)` delega en `hasPermission`, que replica la función homónima del backend **incluido el atajo de `admin`**: una UI más estricta que la API bloquearía acciones permitidas.
- **Expiración de sesión**: `effect` que, al cambiar el usuario, lee `authTime` del ID token y programa `endExpiredSession()` para el instante que devuelve `getSessionExpiryMs`. El `setTimeout` se acota a 2.147.483.000 ms para no desbordar.

### 4.3 Guards

- `authGuard` — espera `authStateReady()`, exige `currentUser`; si no, `UrlTree` a `/login`.
- `permissionGuard(area, level)` — resguarda cada pantalla del POS por permiso (ver 5). Al denegar, avisa y manda a `/pos`.
- `guestGuard` — en `/login`: si ya hay usuario, resuelve el rol; **sin rol útil hace `signOut` y deja entrar al login** (evita el limbo de un usuario de Firebase sin staff en el backend).

### 4.4 `authInterceptor`

1. Pasa de largo cualquier URL que no empiece con `environment.apiUrl`, y también `/health`.
2. Espera `authStateReady()`, adjunta `Authorization: Bearer <idToken>`.
3. Ante 401: notifica con el mensaje real del backend (que distingue "sesión expiró a las 24:00" de "no autorizado"), hace `signOut`, navega a `/login` y re-lanza el error. Flag módulo-global `isLoggingOut` evita cascadas cuando varias peticiones fallan a la vez.
4. `/auth/me` queda exento del manejo de 401 — de otro modo el propio arranque del perfil dispararía el logout.

### 4.5 `api.utils.ts`

`unwrapEntity` / `unwrapList(response, key?)` absorben las formas inconsistentes del backend (`data`, `items`, `products`, array plano). `toDate` normaliza `Timestamp` de Firestore, `Date`, epoch, ISO y `{_seconds}`. `getApiErrorMessage` prioriza `error.error.message`. `ApiRequestError` y `getApiErrorStatus` para errores propios.

### 4.6 `ApiHealthService`

`browserOnline` (eventos `online`/`offline`), `apiOk` (GET `/health` cada 30 s), `degraded = !browserOnline || !apiOk`. El shell pinta banner rojo (sin internet) o ámbar (API caída).

### 4.7 Otros

- `NotificationService` — wrapper de `MessageService` de PrimeNG; `sessionExpired()` con copy explícito y `life: 10 s`.
- `ScanSoundService` — WebAudio: `ok()` 880 Hz seno, `warn()` 440 Hz triángulo, `error()` 220 Hz cuadrada. Falla en silencio si el navegador bloquea audio sin gesto previo.
- `PosPreset` — preset de tema PrimeNG con la rampa verde de la marca (ver 16.1).

---

## 5. Rutas y navegación

```
/login                     guestGuard
/                          authGuard → Shell
  ''                       → redirect /pos
  /pos                     Sale            (F1)
  /pos/historial           SaleHistory     (F3)
  /pos/cobro-directo       DirectChargeScreen (requiere sales:write)
  /pos/reportes            PosReports
  /pos/libro-control       ControlledLedger  (requiere inventory:read)
**                         → /
```

Todo lazy (`loadComponent`/`loadChildren`).

**Dos capas, no una.** `NAV_ITEMS` decide si se *ofrece* el camino (el shell filtra con `AuthService.can()`) y `permissionGuard(area, level)` decide si se *abre*. Antes solo existía la primera: escribir la URL a mano entraba igual. Ambas deben declarar el mismo permiso.

| Pantalla | Permiso | Por qué ese |
|---|---|---|
| `/pos` (venta) | — | Sin guard a propósito: es el destino al que redirige el guard al denegar, y cerrarla crearía un rebote infinito. Se autoprotege por dentro: sin `sales:write`, `ensureShiftOpen()` corta el cobro con un mensaje explícito |
| `/pos/historial` | `sales:read` | Mismo que exige `GET /sales` |
| `/pos/cobro-directo` | `directCharges:write` | Área **propia**, no `sales`: cobrar fuera del ticket mueve dinero sin venta que lo respalde, así que es atribución de supervisión. Con `sales:write` cualquier cajero podría hacerlo |
| `/pos/entrada-stock` | `stockEntry:write` | Área **propia**, no `inventory`: recibir mercancía es del mostrador, pero `inventory:write` abriría además conteos, salidas y el libro de control |
| `/pos/reportes` | `dashboard:read` | Analítica; misma área que los reportes del backend |
| `/pos/libro-control` | `inventory:write` | Más estricto que el `inventory:read` del endpoint **a propósito**: `read` es el permiso con el que el cajero consulta lotes y caducidades al vender, así que gatearlo con `read` se lo mostraría a todo el mostrador |

`permissionGuard` resuelve con `fetchProfile()` y no con la señal `profile`: al recargar la app dentro de una pantalla, el perfil aún no ha llegado y una lectura síncrona negaría el acceso a quien sí lo tiene.

### Roles del sistema

Definidos en `backend-farma-jyv/functions/src/constants/permissions.ts` y sembrados en Firestore por `seedSystemRoles` (`npm run migrate:roles`, que además sube `permissionsVersion` y reemite los claims: cambiar la definición sin reemitir dejaría a los usuarios con el alcance viejo mientras su token siguiera vivo).

**`pos` y `sales` son áreas distintas.** `pos:write` es *operar la caja* —levantar la venta, cobrar con la terminal, mover y cerrar turno, dar de alta al cliente en mostrador— y `sales` es *administrar lo vendido*: leer el historial (`read`), anular, devolver y reembolsar (`write`). Con una sola área, habilitar la caja le daba al cajero el poder de cancelar y reembolsar sus propias ventas. En el POS, `AuthService.canSell` es `pos:write`.

| Rol | Alcance en el POS |
|---|---|
| `cashier` | Venta, historial y entrada de stock. `pos:write`, `sales:read`, `products:read`, `categories:read`, `inventory:read` (lo necesita para lote/caducidad al vender), `stockEntry:write` |
| `manager` | Todo menos reportes (`dashboard` está excluido de su definición) |
| `admin` | Todo, por el atajo de slug en `hasPermission` |
| `doctor` | Solo la pantalla de venta, y sin poder cobrar |

---

## 6. Modelo de dominio (`shared/models/index.ts`)

Entidades: `Product` (con `controlledGroup`, banderas fiscales `hasIva`/`hasIvaZero`/`hasIeps`/`iepsRate`), `ProductBatch` (lote + caducidad), `CartLine`, `Sale`/`SaleItem`/`SaleItemTaxes`/`SaleTaxSummary`, `SalePrescription`, `SaleBilling`, `Customer`, `CashSession`/`CashSessionSummary`/`CashSessionCut`, `CashMovement`, `HeldSale`, `DirectCharge`/`DirectChargePoint`/`DirectChargeOnline`, `StaffProfile`/`RoleSummary`/`RolePermission`.

`DirectCharge` vive **fuera** del modelo de venta a propósito: `channel` (`point` | `online`), `status` (`pending` | `approved` | `failed` | `canceled`), `point` u `online` según el canal, y folio propio `CD-000001`. No comparte nada con `Sale` porque no debe sumarse a ella en ningún cálculo.

Campos de `Sale` que importan para cuadrar caja:

- `cashAmount` — parte del total pagada en efectivo (lo que entra al cajón). `null` en ventas previas al split mixto y en tarjeta/transferencia.
- `cardAmount` — parte con tarjeta (monto de la orden Point).
- `amountReceived` / `change` — lo entregado por el cliente y su cambio.
- `taxSummary` — `null` en ventas anteriores al desglose.
- `controlledGroups`, `prescriptionRetained` — rastro COFEPRIS.
- `invoiceStatus: 'pending' | null` — el POS **no** timbra.

`PermissionArea` cubre `dashboard | users | sales | pos | stockEntry | categories | products | suppliers | inventory | invoices | uploads | doctor | patients | medicalRecords | appointments | directCharges`; `PermissionLevel` es `read | write`. Debe mantenerse igual a la del backend: un área que falte aquí es un permiso válido que la UI no sabe leer.

---

## 7. Reglas replicadas del backend (`shared/utils`)

Cuatro módulos puros que espejean lógica del servidor. **El backend sigue siendo la autoridad**; la copia existe para bloquear en el mostrador y para que el ticket offline sea correcto. Todos tienen spec.

### 7.1 `money.ts`

Aritmética en centavos enteros: `toCents`, `fromCents`, `roundMoney`, `addMoney`, `subtractMoney`, `compareMoney`, `isMoneyGreaterOrEqual`. Sin esto, el "faltan" de la caja se separa del total que valida la API por punto flotante.

### 7.2 `tender.ts` — reparto efectivo/tarjeta

`resolveTender({paymentMethod, total, amountReceived, cardAmount})` → `{cashDue, cashAmount, cardAmount, change, shortfall, cashSatisfied, error}`.

| Método | `cashDue` | Notas |
|---|---|---|
| `cash` | `total` | cambio = recibido − total |
| `card` / `transfer` | 0 | en `card`, `cardAmount = total` |
| `mixed` | `total − cardAmount` | **el cambio se calcula contra esa parte, nunca contra el total** |

Validaciones de `mixed`: `cardAmount` requerido, > 0, y estrictamente menor que el total (si cubre todo, es venta con tarjeta). Fuente única para checkout, ticket y cola offline.

### 7.3 `taxes.ts` — desglose con impuestos incluidos

El precio de catálogo es precio al público. Se calcula hacia atrás con el orden legal mexicano: IEPS sobre la base, IVA sobre (base + IEPS).

```
gross = base × (1 + iepsRate) × (1 + ivaRate)
```

`resolveIvaRate` — `hasIvaZero` gana sobre `hasIva` (medicina de patente 0%); `IVA_RATE = 0.16`. El residuo de redondeo se absorbe en la base para que `base + ieps + iva` sea exactamente el importe cobrado (un desglose que no suma se rechaza al timbrar). `prorateDiscount` reparte el descuento de venta proporcionalmente **antes** de calcular impuestos, con los centavos sobrantes cargados a la partida mayor. `previewTaxSummary` es la secuencia completa que usa el checkout y el ticket offline.

### 7.4 `controlled.ts` — grupos COFEPRIS (art. 226 LGS)

| Grupo | Receta | Folio obligatorio | Se retiene | Libro de control |
|---|---|---|---|---|
| I estupefacientes | sí | sí | sí | sí |
| II psicotrópicos | sí | sí | sí | sí |
| III psicotrópicos menor riesgo | sí | sí | sí | sí |
| IV antibióticos y otros de receta | sí | no | no | sí |
| V venta en farmacia sin receta | no | no | no | no |
| VI venta libre | no | no | no | no |

`resolveControlledRequirements(products)` agrega el ticket completo. Si un producto **no** trae `controlledGroup`, cae al flag heredado `requiresPrescription` (deuda de catálogo, ver 13). `validatePrescription` devuelve el primer motivo de bloqueo, con los mismos mensajes del backend. `isValidDoctorLicense` — cédula de 7 u 8 dígitos.

### 7.5 `session-expiry.ts`

El backend rechaza cualquier token cuyo `auth_time` sea de un día anterior en `America/Mexico_City`: la sesión muere a las **24:00 locales**, no a las 24 h de haber entrado. `getSessionExpiryMs` calcula el inicio del día siguiente por búsqueda binaria en ±14 h sobre `Intl.DateTimeFormat` — sin offset hardcodeado, sobrevive al horario de verano.

---

## 8. Flujo de venta (`features/pos/sale`)

### Estado

Signals: `searchTerm`, `results`, `cart`, `heldSales`, `manualDiscounts`, `lastSale`, más los `*Visible` de cada diálogo. Derivados: `subtotal`, `discountTotal`, `total`, `itemCount`, `lastLineId`.

### Búsqueda y escaneo

`Subject` con `debounceTime(500)` + `distinctUntilChanged()` + `switchMap` a `GET /products?search=`. `Enter` en el buscador:

1. Parsea el prefijo `N*código` (`/^(\d+)\*(.+)$/`), cantidad acotada a 1–999.
2. Busca y toma coincidencia exacta por `sku` o `barcode`; si hay un solo resultado, ese.
3. Sin coincidencia → sonido de error + mensaje distinto para "no encontrado" vs "varios resultados".

### Catálogo: qué se consulta y qué se guarda

**El POS no guarda el catálogo en local.** Lo único que persiste en `localStorage` es el ticket en curso, las ventas en pausa y la cola offline —los tres con la foto del producto que ya está en el ticket, no el catálogo—. Cada búsqueda es una consulta acotada al servidor.

`ProductService` acota el costo de esas consultas, que no es trivial: el backend resuelve una búsqueda de texto leyendo hasta 500 documentos de Firestore y filtrando en memoria, y **sin `search` lee la colección entera**.

- **Término vacío: no sale a la red.** Devuelve lista vacía. Antes, limpiar el buscador disparaba el caso "sin `search`", es decir, una lectura del catálogo completo por cada vez que el cajero borraba el campo.
- **Mínimo dos caracteres** (`MIN_SEARCH_LENGTH` en `sale.ts`). Con una letra el servidor recorre el catálogo para devolver medio mostrador.
- **`limit=25`.** La lista se recorre con la vista, no con scroll infinito.
- **Caché en memoria de 30 s** por término normalizado, máximo 40 entradas (se descarta la más vieja). Corta a propósito: el stock cambia con cada venta. `invalidate()` se llama al cerrar una venta, para no volver a pintar el stock que se acaba de descontar.
- **Deduplicado de peticiones en vuelo**: dos disparos del mismo término comparten una sola petición.
- `clearSearch()` empuja un término vacío al `Subject`, que cancela por `switchMap` la búsqueda que quedó en el debounce. Tras escanear, esa consulta ya no le sirve a nadie.

`CustomerService.search` sigue la misma regla: sin término no consulta, porque listar clientes sin filtro también lee la colección completa.

### Alta al ticket — `addToCart` → `commitAdd`

1. `ensureShiftOpen()`: verifica `sales:write` y turno abierto (si no, abre el diálogo de turno).
2. `stock < 1` → sonido de error + diálogo de **sustitutos** por principio activo.
3. `GET /inventory/batches?productId=` → `sellableBatches`: descarta `quantity <= 0` y vencidos, ordena por caducidad ascendente (**FEFO**).
   - Suma vendible 0 → "El stock disponible está vencido" + sustitutos.
   - Lote más próximo a ≤ `expiryWarningDays` (30) días → sonido de aviso + fecha y días restantes.
   - Si la llamada a lotes falla, se degrada a `product.stock`.
4. Tope por `min(sellableQty, product.stock)`.
5. Producto controlado nuevo en el ticket → `warnIfControlled`: sonido + grupo + si se retiene la receta. Se avisa **al agregar**, no al cobrar.
6. `setCart` pasa siempre por `PromoService.apply`.

### Descuentos

`updateLineDiscount` reparte el importe capturado entre promo (calculada) y manual (`manualDiscounts[productId]`), acota al total de línea, y **rechaza > 20 % si el usuario no es `admin`**.

### Autoguardado y pausa

- `CartStorageService` — `effect` que persiste ticket + descuentos manuales en `pos.current-cart.<uid>` en cada cambio; se restaura al entrar (solo si el carrito está vacío) con aviso al cajero. Existe porque la sesión muere a las 24:00 y un 401 cierra sesión: sin esto se reescanea todo.
- `HeldSaleStorageService` — `pos.held-sales.<uid>`; F6 pausa (etiqueta con hora), botón para retomar. Retomar exige carrito vacío. Clave por `uid` para no mezclar tickets de cajeros en el mismo equipo.

### Atajos (host bindings en `document`)

`F2` buscar · `F4` foco en cantidad de la última línea · `F6` pausar · `F9` cobrar · `Esc` limpiar búsqueda, luego vaciar ticket (con `confirm`) · `Del`/`Backspace` quitar última línea · `+`/`-`/`=` ajustar cantidad de la última línea.

Getter privado `dialogOpen` cortocircuita **todos** los atajos cuando hay cualquier diálogo abierto. Sin él, `Esc` cerraba el cobro **y** vaciaba el ticket. `isTypingTarget` protege los campos de texto de `Del` y `+/−`.

---

## 9. Cobro (`features/pos/checkout`)

Diálogo de 58 rem en dos columnas: izquierda lo que se teclea (total, método, efectivo/tarjeta), derecha cumplimiento y datos fiscales.

### Idempotencia

`idempotencyKey` (uuid v4, con fallback `pos-<base36>-<random>` para WebViews viejos) se genera **al abrir el diálogo** y se reusa en cada reintento de "Confirmar". La referencia enviada a la terminal es `sale-<idempotencyKey>-<intento>`: la orden queda trazable a la venta y el sufijo distingue reintentos, porque una orden muerta sigue ocupando su referencia en Mercado Pago.

### Métodos

`cash` · `card` · `mixed` (la UI ofrece tres; el modelo también admite `transfer`). `selectPaymentMethod` protege dos casos: con orden **aprobada** no se cambia de método (dejaría dinero cobrado fuera de la venta; el reembolso debe ser explícito), y con orden viva sin aprobar se cancela antes de cambiar. `mixed` arranca a mitades y mueve el foco al campo que toca teclear.

### Tarjeta — Mercado Pago Point

`GET /payments/mercadopago/devices?storeId&posId` lista terminales; `MercadoPagoService.preferredDevice` selecciona la de **esta** caja (`environment.mercadoPago.terminalId`) y solo cae a la primera de la lista si no está configurada o no aparece — con varias terminales en la misma cuenta, tomar la primera podía mandar el cobro a otra sucursal. Si `operatingMode === 'STANDALONE'` aparece "Activar PDV" (`PATCH .../devices/operating-mode`). `POST .../orders` crea el cobro por `cardChargeAmount` (total, o solo la parte con tarjeta en mixto) y arranca polling `interval(2000)` + `takeWhile(pending, true)` sobre `GET .../orders/:id`.

El `POST` viaja con llave de idempotencia (la propia referencia externa, ya única por intento) en cuerpo y header `Idempotency-Key`: sin ella, un reintento de red creaba una **segunda** orden en la terminal.

El polling usa `takeUntilDestroyed(this.destroyRef)` con `DestroyRef` inyectado. Sin el argumento explícito, Angular exige contexto de inyección y `pollOrder` —que arranca dentro de un `subscribe`— lanzaba NG0203: el sondeo moría al arrancar y el cobro con tarjeta se quedaba sin seguimiento.

Estados: `created`, `at_terminal`, `action_required` (pendientes) → `processed` (aprobado), `failed`, `expired`, `canceled`, `refunded`. `cardAmountLocked` congela el monto con tarjeta mientras la orden vive (pendiente o aprobada) y lo libera si falló/expiró, para reintentar con otro reparto sin cerrar el diálogo.

**Vigencia.** La orden se crea con `expiration_time: PT15M` explícito y el diálogo pinta la cuenta atrás (`cardCountdown`, `shared/utils/point-order.ts`). Antes el vencimiento se leía como que la terminal se había colgado, y el cajero remandaba el cobro a ciegas.

**Cancelación.** `retryCardPayment` no cancela (la orden ya está muerta). `cancelCardPayment` hace `DELETE .../orders/:id` y **solo limpia el estado local cuando Mercado Pago confirma**: limpiarlo antes dejaba una orden viva que el cajero ya no veía y que la terminal podía cobrar encima del cobro siguiente. Si la cancelación falla, el método de pago tampoco cambia. Mercado Pago solo acepta cancelar por API mientras la orden está en `created`; una vez `at_terminal` se cancela **en la terminal**, y el backend traduce el error a esas palabras.

### Bloqueos

`blockers()` lista, **en el orden en que el cajero los resuelve**, por qué no se puede cobrar: receta → reparto inválido → terminal sin aprobar → falta efectivo → RFC/razón social. Se renderiza con `role="alert"` junto al botón. `F9` inválido notifica el primero. Regla de diseño: nunca un botón deshabilitado sin motivo visible.

`canConfirm`: `cash` exige `cashSatisfied`; `card` exige orden aprobada; `mixed` exige **ambos** — con uno solo la venta quedaría cobrada a medias.

### Cumplimiento y fiscal

Panel COFEPRIS lista qué partida es controlada y su grupo; campos de receta (médico, cédula, folio) con obligatoriedad dinámica; casilla de retención en I–III. Cliente y facturación **plegados** por defecto (la venta típica es público general). `usoCfdi`: G03, D01, S01. Facturar solo marca `invoiceStatus: pending` — el POS no timbra. Desglose base/IEPS/IVA/total visible antes de cobrar.

### Teclado y foco

`F9` cobra desde cualquier campo (escuchado en `document` porque el diálogo de PrimeNG monta fuera del componente). `Enter` sobre el monto también cobra. `Alt+1/2/3` cambia método — con `Alt` para no comerse los dígitos. Al abrir, el foco va al campo que bloquea: receta si el grupo la exige, efectivo si no. `focusInput` resuelve el `input` real tanto de `pInputText` como del wrapper de `p-inputnumber`.

### Confirmación

`SaleService.buildPayload(...)` → `POST /sales`. `prescriptionRetained` se envía **solo** cuando el grupo lo exige. Los datos de receta se envían aunque el grupo no la pida (V/VI) si el cajero los capturó: trazabilidad ya escrita a mano. Éxito con efectivo o mixto → `CashDrawerService.open()`.

---

## 9 bis. Cobro directo (`features/pos/direct-charge`)

Pantalla propia (`/pos/cobro-directo`, permiso `sales:write`) para el dinero que entra por Mercado Pago **sin venta detrás**: servicios, abonos, cobros de terceros. Vive en la colección `directCharges` del backend y **por diseño no toca nada más**: no genera ticket, no descuenta inventario, no entra al arqueo de caja ni a los reportes de ventas. Es un registro paralelo, solo para trazabilidad.

Dos canales en pestañas (`p-tabs`), con el mismo formulario (monto + concepto):

- **Terminal** — `POST /direct-charges` con `deviceId`. El backend crea la orden Point y devuelve el cobro en `pending`.
- **Link de pago** — `POST /direct-charges/online`. El backend crea una preferencia de Checkout Pro (vigencia 30 min, `binary_mode`) y devuelve `online.initPoint`; la pantalla pinta el link, su **QR** (librería `qrcode`, generado en el cliente) y botones de copiar/abrir.

Cambiar de pestaña con un cobro vivo se rechaza: dejaría una orden o un link cobrando por su cuenta.

**Estados y sondeo.** `pending` → `approved` | `failed` | `canceled`. La pantalla consulta `GET /direct-charges/:id` cada 2 s; el backend es quien pregunta a Mercado Pago (orden Point o pago del link) y persiste el cambio. `POST /direct-charges/:id/cancel` cancela la orden o vence el link; un cobro **aprobado** no se cancela desde aquí —ese dinero ya se cobró y devolverlo es un reembolso explícito (pendiente DC6).

**Idempotencia.** Llave por cobro reusada en cada reintento. El backend reserva la llave **antes** de tocar Mercado Pago (`directChargeIdempotencyKeys`, doc id `<cajero>:<llave>`) y la libera si Mercado Pago rechaza, para que el cajero reintente sin esperar el TTL.

**Folio.** `CD-000001`, consecutivo propio en `counters/directCharges`, asignado dentro de una transacción para que dos cajas simultáneas no se peleen el mismo número.

**Webhook.** `POST /payments/mercadopago/webhooks` resuelve los avisos de `payment`, `merchant_order` y de orden (`order`, `orders`, `topic_orders`, `point_integration_wh`). Es lo único que cierra dos casos que el sondeo no ve: una cancelación hecha **en la terminal** (que la API no permite cancelar) y una aprobación posterior a que el cajero cerrara la pantalla. Los avisos se deduplican por `x-request-id` en `mercadoPagoWebhookEvents` —Mercado Pago reintenta cada 15 min hasta recibir 200— y esa misma colección sirve de bitácora de qué llegó y cómo se resolvió.

---

## 9 ter. Entrada de stock (`features/pos/stock-entry`)

Pantalla propia (`/pos/entrada-stock`, permiso `stockEntry:write`) para recibir mercancía **contra una factura ya registrada**. Cierra el hueco de que todo lo que entraba al almacén tenía que capturarse en el panel de administración, aunque la caja fuera quien recibía las cajas.

Flujo: elegir factura (últimas 10) → buscar el producto por SKU, nombre o principio activo → ver sus campos llenos (o darlo de alta si no existe) → capturar lote, caducidad, piezas y costo opcional → guardar. Las piezas se **suman** al stock; la pantalla muestra "12 → 36" antes de confirmar.

**Lote y caducidad son obligatorios** por diseño: de ellos dependen FEFO, el aviso de caducidad próxima y el libro de control. Un alta sin lote dejaría stock que el resto del sistema no sabe vender.

**Backend — módulo `stock-entries`.** Ninguno de los endpoints existentes servía: `POST /inventory/entries` exige factura pero no acepta crear producto, y `POST /inventory/direct-entries` crea producto pero no admite factura. El módulo nuevo orquesta los servicios que ya existen, sin duplicar lógica de inventario:

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/v1/stock-entries/invoices?limit=10` | `stockEntry:read` |
| POST | `/v1/stock-entries` | `stockEntry:write` |

El `POST` recibe `invoiceId`, `lotNumber`, `expiryDate`, `quantity`, `costPrice?` y **exactamente uno** de `productId` (+ `productUpdate?`) o `product` (alta completa). El servicio verifica la factura **antes** de tocar el catálogo —dar de alta un producto para una factura inexistente dejaría basura sin nada que la respalde—, crea o actualiza el producto (`productsService`, que ya valida unicidad de SKU, categoría activa y reglas de IVA/IEPS, y **audita el cambio de precio**) y delega la entrada en `inventoryService.recordEntry`: de ahí salen el lote, el `stockMovement`, el proveedor en `products.suppliers` y el `increment` de `totalStock`, todo en la transacción que ya existía.

**Correcciones al producto**: la pantalla solo manda los campos que el cajero cambió. Enviar el producto completo dejaría una actualización —y un renglón de auditoría— en cada entrada, aunque nadie hubiera tocado nada.

**IEPS**: se captura en porcentaje y viaja como fracción (8 % → `0.08`), que es lo que espera el backend.

Al guardar se llama `ProductService.invalidate()` —el stock recién recibido debe verse en la siguiente búsqueda de venta— y el formulario queda listo para la siguiente partida **conservando la factura**: una factura trae varios productos y se capturan uno tras otro.

---

## 10. Cola offline

`SaleService` con `localStorage['pos.pending-sales']`.

- **Encolado**: solo ante `HttpErrorResponse.status === 0` (sin red). Devuelve una `Sale` sintética con `id: offline-<ts>`, `folio: PENDIENTE-<ts>`, `taxSummary` calculado localmente y `change`/`cashAmount`/`cardAmount` resueltos por `resolveTender`, para que el ticket se imprima igual.
- **Flush**: en el evento `online` y en reintentos manuales. `concatMap` — **en serie**, para no perder el orden de folios ni abrir N peticiones al recuperar la red. Cada venta viaja con su `idempotencyKey` original: si el POST anterior sí llegó y se perdió la respuesta, el backend devuelve la venta ya registrada en vez de duplicarla. Flag `flushing` evita solapes.
- **Bloqueo**: un 4xx (excepto 401, 408, 429) marca `blockedReason` y la venta deja de reintentarse — turno cerrado, sin stock, orden Point reusada no se arreglan reintentando. El cajero las revisa desde el badge rojo de la barra y decide **reintentar** (misma llave) o **descartar** (con `confirm`; descartar en silencio sería perder una venta ya cobrada).

Badge ámbar = pendientes de sync. Badge rojo = rechazadas.

---

## 11. Turno de caja

`CashSessionService` sobre `/cash-sessions`: `current`, `POST /` (abrir con `openingAmount`), `GET :id/summary`, `POST :id/close` (`countedCashAmount`), `GET/POST :id/movements`.

`CashSessionDialog` tiene tres modos derivados: `open` (sin sesión; no cerrable con Esc ni clic afuera — sin turno no se vende), `close` (resumen + captura del efectivo contado + diferencia en vivo), `result` (turno cerrado, imprimir corte). El efectivo esperado sale de `expectedCashAmount` del backend con fallback a `summary.cashInDrawer`; el contado se precarga con el esperado.

Movimientos de caja (`deposit` / `withdrawal` / `expense`, con monto y motivo obligatorios) se capturan desde dos pantallas propias, no desde la venta: **Gastos** (`/pos/gastos`, `pos:write`, `type` fijo en `expense`) y **Efectivo de farmacia** (`/pos/efectivo`, ver abajo).

### Efectivo de farmacia (`/pos/efectivo`)

Entrada o salida de efectivo sin venta de por medio, tras `permissionGuard('cashSessions', 'write')` — área ya exclusiva de `admin`, y no el `pos:write` de los gastos: mover el efectivo de la farmacia no es tarea de mostrador. Antes esto era un diálogo dentro de la venta, protegido solo por un `@if (isAdmin())` de la plantilla y sin guard de ruta.

**`cashSessionId` es opcional en toda la cadena** (`CashMovement` local y remoto, migración `20260906000000_cash_movements_standalone` que reconstruye la tabla porque SQLite no afloja un `NOT NULL` con `ALTER`). El comportamiento es híbrido a propósito:

- **Con turno abierto** el movimiento se cuelga de ese turno y baja o sube su efectivo esperado. Es lo que evita que el cajero cuente un dinero que ya no está y cierre con un faltante sin explicación.
- **Sin turno** queda con `cashSessionId: null` y fuera de todo corte — `buildSummary` (local y backend) consulta los movimientos filtrando por sesión, así que los sueltos se excluyen solos.

Local-first como el resto: `CashMovementService.create()` escribe en SQLite y el push ocurre en `SyncScheduler`. `pushOne` elige destino según el origen: `POST /cash-sessions/:remoteId/movements` para los del turno, `POST /cash-sessions/movements` para los de la farmacia. Los de la farmacia **no** esperan a que ningún turno sincronice.

El saldo sale de `CashSessionService.cashOnHandDetail()` (IPC `cashSessions:getCashOnHand`): **lo contado en el último corte, más o menos los movimientos sin turno posteriores** — el mismo número con el que se precarga el fondo al abrir el siguiente turno, así que caja y apertura no pueden discrepar. Deliberadamente **no** es la suma de todos los movimientos: los de un turno ya entraron al conteo de su corte, y restarlos otra vez los contaba dos veces (con un solo gasto de $100 la pantalla llegó a mostrar −$100 con la caja llena). A diferencia de `cashOnHand()`, propaga el error: aquí un cero por fallo de lectura se lee como "no hay efectivo".

Debajo, los últimos movimientos paginados contra SQLite (`listPageLocal`, 50 por página). Ese historial es el de **ese equipo**; la vista global sigue siendo `/pos/gastos-auditoria`.

El backend audita cada uno (`cashMovement.created`, entidad `cashMovement`) — a diferencia de `addMovement`, que no auditaba: sacar efectivo sin ticket que lo respalde es justo lo que la bitácora existe para rastrear. Los gastos siguen exigiendo turno, porque su desglose por categoría solo tiene sentido dentro de un corte.

---

## 12. Pantallas de consulta

**Historial** (`/pos/historial`) — ventas del turno actual, o del día si no hay turno; `includeVoided: true`. Filtro local por folio o nombre de producto. Detalle en diálogo con el ticket embebido, reimpresión, y anulación (`POST /sales/:id/void`) solo para `admin` y con `confirm`.

**Reportes** (`/pos/reportes`) — alcance turno o día, calculados **en el cliente** sobre `listAll` (paginación recursiva de 100 en 100). Métricas: venta neta, ticket promedio, descuentos, anuladas, por método, por hora (con barra proporcional), top 10 por cantidad e importe. `cashCollected` suma con la misma regla del corte del backend: `cashAmount`, con fallback `recibido − cambio` para ventas viejas — sumar el total de una venta mixta contaría también lo de la tarjeta. Imprimible con `window.print()`.

**Libro de control** (`/pos/libro-control`) — `GET /inventory/controlled-ledger`, solo lectura (los renglones los escribe el backend dentro de la transacción de venta/anulación/devolución). Filtros por rango, rangos rápidos (hoy / 7 / 30 días) y grupo; `to` se envía como `<fecha>T23:59:59.999` porque el backend filtra por instante. Renglones con folio, movimiento, producto, grupo, cantidad **con signo**, lotes, receta y paciente. Resumen por grupo y piezas netas. Gateado por `inventory:read`, mismo permiso del endpoint. Se consulta desde la caja porque la visita de verificación ocurre en el mostrador.

---

## 13. Impresión

`TicketPrintService.printHost` crea el componente con `createComponent`, lo adjunta al `ApplicationRef`, fuerza `detectChanges`, llama `window.print()` y limpia en `afterprint` o a los 1500 ms (idempotente por flag `cleaned`).

Tres plantillas: `SaleTicket` (encabezado de farmacia, partidas, reparto efectivo/tarjeta cuando aplica, desglose fiscal, folio de receta y retención, grupos COFEPRIS, leyenda de impuestos incluidos y nota del art. 226 LGS), `CashCutTicket` (corte Z con desglose por método y movimientos), `ProductLabel`.

`CashDrawerService` → IPC `open-cash-drawer` → `electron/main.js` escribe el pulso ESC/POS `1B 70 00 19 FA` a un archivo temporal y lo manda a la impresora: `copy /b` en Windows, `lp -d <cola> -o raw` en el resto. No-op si no es Electron o si `printerName` está vacío.

---

## 14. Electron

`main.js` — ventana única 1360×900 (mín. 1024×700), `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`. Carga el dev server si `NODE_ENV=development` o `--dev`; si no, `dist/farma-jyv-pos/browser/index.html`, y si falta el build sale con mensaje explícito. Locale forzado a `es-MX`. `setPermissionRequestHandler` solo concede `geolocation`.

IPC expuesto por `preload.js` vía `contextBridge` como `window.electronAPI`: `getAppVersion`, `getDeviceInfo` (MAC + hostname → `id` estable para identificar el equipo de venta), `openCashDrawer`.

Auto-update con `electron-updater` (`autoDownload = true`, instala al cerrar), solo fuera de dev, con feed sobreescribible por `UPDATE_URL`. Todos los errores del updater son no-op logueados — un feed caído no debe tumbar la caja.

`electron-builder` (clave `build` de `package.json`): `appId mx.farmajyv.pos`, salida `/release`, asar. macOS dmg+zip arm64/x64 (`identity: null`, **sin firmar**), Windows nsis+zip. Feed de publicación `https://updates.farmajyv.mx/pos` — hoy placeholder.

---

## 15. Superficie de API consumida

| Método | Ruta | Uso |
|---|---|---|
| GET | `/auth/me` | perfil, rol y permisos |
| GET | `/health` | banner de degradación |
| GET | `/products?search=` | búsqueda y escaneo |
| GET | `/inventory/batches?productId=` | lotes, FEFO, caducidad |
| GET | `/inventory/controlled-ledger` | libro de control |
| GET/POST | `/customers` | búsqueda y alta rápida |
| GET | `/sales` | historial y reportes (paginado) |
| GET | `/sales/:id` | detalle |
| POST | `/sales` | registrar venta (idempotente) |
| POST | `/sales/:id/void` | anular (solo `admin`) |
| GET | `/cash-sessions/current` | turno vigente |
| POST | `/cash-sessions` | abrir turno |
| GET | `/cash-sessions/:id/summary` | resumen previo al corte |
| POST | `/cash-sessions/:id/close` | cerrar turno |
| GET/POST | `/cash-sessions/:id/movements` | entradas, salidas y gastos de un turno |
| POST | `/cash-sessions/movements` | efectivo de farmacia, con turno o sin él (`cashSessions:write`) |
| GET | `/payments/mercadopago/devices` | terminales Point |
| PATCH | `/payments/mercadopago/devices/operating-mode` | activar PDV |
| POST | `/payments/mercadopago/orders` | enviar cobro a la terminal |
| GET | `/payments/mercadopago/orders/:id` | polling del cobro |
| DELETE | `/payments/mercadopago/orders/:id` | cancelar cobro |
| POST | `/direct-charges` | cobro directo con terminal |
| POST | `/direct-charges/online` | cobro directo por link de pago (Checkout Pro) |
| GET | `/direct-charges` | cobros directos recientes |
| GET | `/direct-charges/:id` | estado del cobro (el backend consulta a Mercado Pago) |
| POST | `/direct-charges/:id/cancel` | cancelar cobro directo pendiente |
| GET | `/stock-entries/invoices` | últimas facturas para recibir mercancía |
| POST | `/stock-entries` | entrada de stock (crea o actualiza el producto) |
| GET | `/categories` | categorías para el alta de productos |
| GET | `/inventory/controlled-ledger/export` | CSV del periodo completo, sin paginar (entregable de COFEPRIS) |

Endpoints ya disponibles en el backend y **no** consumidos aún: recibos (`/sales/:id/receipt`, `/sale-returns/:id/receipt`), devoluciones (`/sale-returns`), reembolso Point, lectura X (`/cash-sessions/:id/x-report`), reportes de servidor (`/reports/*`), alertas de inventario (`/inventory/alerts`), auditoría (`/audit-logs`).

### Paginación

Las respuestas de lista traen `{ data, meta }` con `meta = { page, limit, total, totalPages }`. `unwrapList` **descarta** el `meta`; usa `unwrapListWithMeta` cuando la pantalla necesite saber que el servidor tiene más renglones de los que mandó — sin eso, un listado truncado es indistinguible de uno completo.

El tope por defecto es 100 (`MAX_PAGE_LIMIT` en el backend). El libro de control admite hasta 1000 (`CONTROLLED_LEDGER_MAX_LIMIT`) porque se entrega por periodo completo.

### Desfase entre el backend desplegado y su repositorio (2026-08-07)

Verificado durante la auditoría: la API desplegada **está atrasada** respecto a `backend-farma-jyv`. Evidencia concreta: `GET /inventory/controlled-ledger?limit=101` responde `400 — "El límite no puede ser mayor a 100"`, mensaje que `parsePagination` solo emite cuando **no** recibe la opción `maxLimit`; el código commiteado sí la pasa (`CONTROLLED_LEDGER_MAX_LIMIT = 1000`).

Consecuencia práctica: antes de dar por bueno cualquier comportamiento contra la API, comprueba si lo que estás viendo es el código del repositorio o una versión anterior. Varias funciones que el POS aún no consume (recibos, devoluciones, lectura X, reportes) pueden estar en la misma situación.

---

## 16. Convenciones de código

Standalone por defecto (sin `standalone: true`), `ChangeDetectionStrategy.OnPush` en todo componente, signals para estado y `computed` para derivados (nunca mutación directa), `input()`/`output()` en lugar de decoradores, objeto `host` en lugar de `@HostBinding`/`@HostListener`, control de flujo nativo `@if`/`@for`/`@switch`, bindings `class`/`style` en lugar de `ngClass`/`ngStyle`, `inject()` sobre constructor, servicios `providedIn: 'root'`, plantillas y estilos externos junto al `.ts`.

`@ngx-translate` v18: `TranslatePipe`/`TranslateDirective` standalone, **no** `TranslateModule`. PrimeNG `p-table`: `#header`/`#body`, no `pTemplate`.

### 16.1 Utilidades compartidas de API

`core/api/api.utils.ts` es el único lugar donde se interpreta la forma de las respuestas del backend: `unwrapEntity`, `unwrapList`, `unwrapListWithMeta` (con `ApiListMeta`), `toDate`, `getApiErrorMessage` y `toHttpParams`.

Regla: **ningún servicio lee `response.data` a pelo ni arma sus `HttpParams` a mano.** Los servicios de administración (categorías, proveedores, facturas) lo hacían y además declaraban su propio `PageMeta`, copia de `ApiListMeta`, importándolo unos de otros; se unificó. `toHttpParams` descarta `undefined`, `null` y cadena vacía, pero deja pasar `false` y `0`, que son filtros legítimos (`activeOnly=false`).

### 16.1 Identidad visual y tokens de color

La paleta sale del logo (`public/brand/logo.png`): verde de las manos y la cruz `#4CA820`, verde del wordmark `#17601F`, azul del corazón `#0078C8` y azul profundo `#003C6C`. La traducción a interfaz es deliberada: **el verde manda** (acción, confirmación, identidad), el **azul acompaña** (información y datos), los neutros son grises azulados para no ensuciar el verde, y ámbar/rojo quedan reservados a aviso y error —un color de alarma usado como decoración deja de alarmar.

- `src/styles.css` define las rampas (`--brand-green-*`, `--brand-blue-*`, `--neutral-*`) y encima los **roles** que usan las pantallas (`--pos-primary`, `--pos-accent`, `--pos-border`, `--pos-danger`…). Las plantillas usan roles, nunca tonos crudos.
- Contraste: el verde de marca (500) con texto blanco da 3.03:1 y **no** cumple WCAG 1.4.3, así que todo relleno con texto usa el 700 (6.42:1) y el 500 queda para acentos, bordes y foco, donde basta 3:1.
- Un bloque `@theme` de Tailwind v4 reasigna las familias `slate`, `emerald`, `sky`/`blue`/`teal`/`violet` a la paleta de marca. Así las ~350 clases de color ya escritas en las plantillas pasan a la identidad nueva sin tocar el HTML: en este proyecto `emerald` significa "verde de marca", `sky` "azul de marca" y `slate` "neutro".
- `PosPreset` (PrimeNG) usa la misma rampa en literales, no `{emerald.*}`: el verde de la marca es más cálido que el emerald de Tailwind y mezclarlos dejaba dos verdes distintos según el componente.
- Assets: `public/brand/logo.png` (original), `isotipo.png` (manos + corazón, recortado con fondo transparente, va en la barra) y `logo-completo.png` (lockup con nombre y lema, va en el login).

---

## 17. Pruebas

`npm test` (`ng test`, builder `@angular/build:unit-test` con Vitest sobre jsdom) → **40 archivos, 366 casos**. Cobertura: 72 % de sentencias en total; servicios ~96 %, utilidades ~98 %, plantillas de componentes por debajo.

- **Utilidades**: `money`, `taxes`, `tender`, `controlled`, `date-range`, `session-expiry`, `point-order`, `api.utils`, `models`.
- **Servicios**: todos los del POS con `HttpTestingController` — venta (incluida la cola offline: encolado sin red, bloqueo por 4xx, reintento con la misma llave), cobro directo, Mercado Pago, turno de caja, catálogo, lotes, clientes, libro de control, almacenamiento local, promociones, cajón e impresión.
- **Core**: notificaciones, salud de la API, sonidos, `AuthService`, guards e interceptor (401 → cierre de sesión).
- **Pantallas**: venta, cobro, cobro directo, historial, reportes, libro de control, diálogos de caja, tickets, shell y login.
- **Infraestructura**: `src/testing/setup.ts` rellena `ResizeObserver`, `IntersectionObserver` y `matchMedia`, que jsdom no implementa y PrimeNG sí usa. Registrado en `angular.json` (`test.options.setupFiles`).

En `backend-farma-jyv`, `test/mercado-pago.spec.ts` cubre la integración con `fetch` sustituido (22 casos, sin tocar la cuenta real ni el emulador): cuerpo de la orden, traducción de errores, reintentos y su ausencia en `POST`, respaldo de merchant orders, cancelación y firma del webhook.

**Sin cobertura**: e2e reales, y las ramas de plantilla de las pantallas grandes (`sale.html`, `checkout.html`). La prueba de la cola offline con red intermitente y la de Point con TPV física siguen siendo manuales (ver `GOALS.md`).

---

## 18. Riesgos y deuda técnica

**Operativos / de datos**

1. **Catálogo sin `controlledGroup`**: el POS cae al flag heredado `requiresPrescription`, que no exige folio ni retención ni deja renglón en el libro. Es la brecha de cumplimiento más directa y se cierra capturando el grupo en el catálogo, no en el POS.
2. **Point sin prueba física**: código completo, emparejado de TPV y venta real de prueba pendientes.
3. **Modo offline sin prueba real sin red**: flush, conflictos y mensajes están escritos pero no ejercitados end-to-end.
4. **Reportes calculados en el cliente** sobre `listAll` paginado: con volumen alto, muchas peticiones y agregación en memoria. La API ya expone `/reports/*`.
5. **Corte Z reimpreso localmente**: `POST :id/close` ya devuelve el recibo renderizado (58/80 mm) y el POS lo descarta.
6. **Sin lectura X**: solo hay corte Z al cerrar; el turno no puede fotografiarse sin cerrarlo.
7. **Sin devoluciones**: `POST /sale-returns` existe en el backend; en caja solo hay anulación total de la venta.
8. **CFDI**: se captura `billing` y se marca `pending`; sin PAC elegido no hay timbrado. No prometer facturación en caja.

**Técnicos**

9. `window.confirm`/`window.alert` nativos en varios flujos (vaciar ticket, quitar línea > 5 piezas, anular, descartar venta bloqueada) — en Electron son diálogos del sistema, inconsistentes con el resto de la UI.
10. `isLoggingOut` es estado global de módulo en el interceptor: correcto en la app real (una ventana), pero frágil en pruebas.
11. Firma de código ausente en macOS (`identity: null`) y feed de actualizaciones apuntando a un host placeholder.
12. `en.json` existe y está completo pero no hay selector de idioma en la UI.
13. `PromoService` lee reglas de `environment.promos` — cambiar una promo exige recompilar y redistribuir el instalador.
14. Multi-caja: `storeId`/`posId`/`terminalId` son fijos en el entorno; no hay selección de caja al iniciar sesión.

**Mercado Pago (revisión 2026-08-08)**

15. **`MERCADOPAGO_WEBHOOK_SECRET` vacío**: el código ya rechaza notificaciones sin firma en producción, pero hasta pegar el secreto del panel el webhook no resuelve nada y todo depende del sondeo.
16. **Sin conciliación diaria**: una orden aprobada sin venta ni cobro directo detrás solo queda en el log del backend; falta la vista que la haga accionable.
17. **Reembolso de cobro directo**: `cancelDirectCharge` rechaza a propósito los cobros aprobados; el reembolso existe en la API de Point pero no hay UI ni endpoint del módulo.
18. **TTL de Firestore** pendiente en `directChargeIdempotencyKeys` y `mercadoPagoWebhookEvents`: sin la política, ambas colecciones crecen sin límite.
19. **El módulo `direct-charges` no está desplegado**: hasta desplegar el backend, la pantalla de cobro directo responde 404.

---

## 19. Referencias

- `CLAUDE.md` — guía de arquitectura para agentes.
- `GOALS.md` — backlog priorizado (P0–P3) y bitácora de lo hecho.
- `README.md` — comandos y stack.
- `graphify-out/` — grafo de conocimiento del código (`graphify query`, `path`, `explain`).
