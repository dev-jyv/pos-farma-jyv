# Goals — FarmaJyV Venta (POS)

Objetivos del **punto de venta de escritorio** (Angular + Electron). Comparte API con `farma-jyv-admin` / `backend-farma-jyv`.

Referencias de mercado usadas para priorizar: **Eleventa**, **Pulpos**, **SICAR**, **Pharmastore**, y patrones de **Square / Toast** (UX de caja rápida). Criterios MX farmacia: lotes/caducidad, recetas, CFDI 4.0, corte de caja, operación con o sin internet.

---

## Objetivo principal

Operar la caja de FarmaJyV de punta a punta: escanear/buscar, ticket, cobro (efectivo / Point MP), turno de caja, con flujo tan rápido y claro como Eleventa, y con el cumplimiento mínimo de una farmacia mexicana.

---

## Pendiente

Todo lo que sigue **no** está en el POS. Lo marcado `B*` ya existe en la API (`backend-farma-jyv`): es deuda de integración, no diseño nuevo.

### Auditoría de QA como tester de POS (`QA-*`) — residuo

Los 16 hallazgos de la pasada están **cerrados**: 13 corregidos (ver "Hecho") y 3 anulados
con motivo (abajo). Lo que queda es operación, no código.

#### Anuladas, con motivo

| # | Era | Por qué no se arregla |
|---|-----|-----------------------|
| QA-2 | `catalogUnitPrice` se escribe y nadie lo lee: el backend marca la partida cobrada a un precio distinto del catálogo (`sales.service.ts:419,497`) y ninguna pantalla la muestra | **Fuera de alcance de este repo.** El vigilante natural es un reporte del panel (`farma-jyv-admin`), no la caja: el POS es justo la parte interesada —es quien manda el precio cobrado—, así que enseñarle ahí la señal no vigila a nadie. El dato ya está en Firestore por partida; falta la pantalla, y va en el panel |
| QA-6 | "El cursor del pull nunca converge" | **Diagnóstico erróneo mío.** El cursor se sella con el `updatedAt` máximo que devuelve el **servidor** (`sync-scheduler.service.ts:536-541`), no con la hora del cliente. El backend compara con `>=` (`products.repository.ts:67`), así que cada pull retrae la fila del propio cursor: un solapamiento de 1 fila, deliberado — con `>` se perderían las filas escritas en el mismo milisegundo que el corte |
| QA-10 | SQLite local sin cifrar con recetas, folios y RFC | **No es viable en código y ya hay control compensatorio.** Prisma no habla SQLCipher, y cifrar campos con una llave que vive en el mismo equipo no protege de quien tiene ese equipo: solo del archivo copiado o del respaldo, que es exactamente lo que cubre el cifrado de disco. FileVault está activo en el equipo de desarrollo (`fdesetup status: On`), y eso es lo que hay que **verificar equipo por equipo** en cada caja antes de instalar. Queda como requisito de instalación, no como tarea de código |

#### Operación pendiente

- **Desplegar el backend.** Sin desplegar quedan: el `unitPrice` de la partida de servicio (arreglo #2), el redondeo del efectivo esperado (QA-4) y la idempotencia del alta de stock (QA-5). Hasta que suban, el POS manda `unitPrice` e `idempotencyKey` y la API en producción los ignora — sin romper nada, pero sin arreglar nada. Recordar `npm run build` antes de `firebase deploy`: `firebase.json` no tiene `predeploy` y despliega `functions/lib` tal cual.
- Publicar el 1.0.0 real (`npm run release:mac`). La actualización automática en macOS sigue bloqueada sin Apple Developer ID (`identity: null` firma ad-hoc, y `electron-updater` rechaza el paquete).
- Commitear el trabajo del backend que ya está en producción (~53 archivos sin commitear).
- Quitar de `.claude/settings.local.json` las dos reglas `Bash` temporales de la limpieza de datos.
- Sigue sin ejercitarse un rol **sin** `inventory:read` y el pago mixto con TPV física (no hay terminal vinculada).

### Módulo de edición de catálogo (`/pos/productos`, 2026-09-03)

Nuevo módulo: alta y edición de producto **sin** lote/factura (a diferencia de "Entrada de
stock", que solo toca el producto como parte de recibir mercancía). Local-first, igual patrón
que venta/entrada de stock — busca y escribe directo en SQLite, sin red en el instante de la
acción; sube a Firestore en el siguiente sync. Visible para **cajero y admin** (permiso
`products:write`, antes el cajero solo tenía `read`).

- Búsqueda 100% local reusando `ProductService` (mismo IPC que usa la venta).
- Dos flags de push separados a propósito (`pendingPush` vs. `pendingCatalogPush`) para que
  este módulo y "Entrada de stock" nunca compitan por subir el mismo producto dos veces.
- `flushQueue()` reutiliza `POST /products`/`PATCH /products/:id` (ya existían para el panel de
  administración) — sin endpoints nuevos en el backend. Para las altas nuevas, hace un `GET
  /products?search=<sku>` antes de crear como defensa contra duplicados: `POST /products` no
  tiene llave de idempotencia propia, así que un reintento tras una respuesta perdida por red
  crearía un producto repetido sin esa comprobación.
- Campo "Unidad" con `<input>` + `<datalist>` nativo, no `p-select` editable — evita el mismo
  bug de cursor que se encontró y corrigió en `stock-entry.html` el mismo día.
- Detalle completo en `docs/arquitectura/pos.md` §10.

**Desplegado y verificado (2026-09-03)**: backend con `products:write` para `cashier` ya en
producción (`npm run deploy` + `npm run migrate:roles` — "Roles con permisos actualizados:
cashier", 3 usuarios migrados). Probado en vivo contra Electron real + backend real, 3 rondas:

1. Primera ronda: bloqueado por permisos (esperado, antes del deploy).
2. Segunda ronda (ya con permisos): encontró **2 bugs reales**, ambos corregidos el mismo día:
   - **"Guardar" quedaba deshabilitado para siempre al dar de alta un producto** — los
     `p-select`/`p-inputnumber` de `product-form.html` no tenían `name`, y dentro de un
     `<form>` eso dispara `NG01352` en cada ciclo de detección de cambios, cortándolo antes de
     refrescar los bloqueadores. Fix: `name="..."` en los 5 controles que faltaban.
   - **El sync de cualquier edición de catálogo fallaba con 400** (`iepsRate: Expected number,
     received null`) — `electron/db/products.js` mandaba explícitamente `null` en campos
     opcionales (`iepsRate`, `controlledGroup`, y potencialmente `barcode`/`activeIngredient`/
     `concentration`) que el backend espera *ausentes*, no `null` (Zod `.optional()`, no
     `.nullable()`). Afectaba a cualquier producto sin IEPS ni grupo COFEPRIS — la mayoría del
     catálogo. Fix: serializador dedicado `toPushFields()` que omite por completo los campos
     opcionales vacíos en vez de mandarlos como `null`; también omite `isActive` en altas nuevas
     (el backend no lo acepta en `createProductSchema`).
3. Tercera ronda (con los 2 fixes): **todo Passed** — alta nueva, edición sin IEPS/COFEPRIS,
   sync manual (`POST /v1/products` → 201, `PATCH /v1/products/:id` → 200) y persistencia
   post-sync, verificados de punta a punta contra la app y el backend reales.

### Pruebas exhaustivas de compras/stock/ventas/facturas (2026-09-03, segunda pasada)

Con la app real corriendo (Electron vía CDP para Venta/Entrada de stock; navegador para Facturas/Proveedores/Categorías, que son online), se probaron a fondo casos borde más allá del camino feliz. **2 bugs reales encontrados y corregidos**, el resto son gaps de producto/UX documentados (no bugs de código):

**Corregidos:**

- **Búsqueda se quedaba sin resultados al repetir un término** (Venta y Entrada de stock): borrar la búsqueda a menos de 2 caracteres y volver a teclear EXACTAMENTE el mismo término de antes (ej. "para" → "p" → "para") no volvía a buscar — `distinctUntilChanged()` en el pipe de RxJS lo descartaba como "sin cambio" porque nunca se le avisó que el término había pasado por un valle. En Entrada de stock además dejaba el spinner "Buscando…" colgado para siempre. Fix: se quitó `distinctUntilChanged()` de ambos pipes (`sale.ts`, `stock-entry.ts`) — el catálogo es local (SQLite vía IPC), repetir la consulta no cuesta nada.
- **El campo de descuento por línea no revertía visualmente** cuando el valor final aplicado coincidía con el que ya tenía (ej. escribir `-5` se clampa a `0`, pero si ya estaba en `0` el `<input>` se quedaba mostrando `-5` en pantalla aunque el cobro fuera correcto) — comportamiento normal de Angular cuando el valor del binding no cambia entre renders. Fix: el input pasó de `[ngModel]`/`(ngModelChange)` a `[value]`/`(change)` con reescritura explícita de `input.value` en cada rama de `updateLineDiscount()`.

Verificado: `tsc --noEmit` limpio, 423/423 tests, sin tocar `package.json`/procesos de prueba tras cerrar.

**Gaps documentados, no corregidos** (requieren decisión de producto o cambio de backend, no un fix aislado del POS):

- Factura marcada "Sin factura" (`hasInvoice:false`) igual exige subir un archivo — el backend (`backend-farma-jyv/functions/src/schemas/inventory.ts`) declara `fileUrl` obligatorio sin importar `hasInvoice`. Inconsistente con el propósito de la opción "sin factura".
- Sin validación de rango en la fecha de factura — acepta fechas futuras o de hace años sin aviso.
- Categorías: nombre duplicado permitido (sin unicidad en el backend) y se puede desactivar una categoría en uso por productos sin ninguna advertencia.
- Dato preexistente encontrado (no causado por esta sesión): proveedor con teléfono de 11 dígitos, de antes de que se afinara el validador a exactamente 10.
- No se pudo ejercitar: producto con `controlledGroup` (no hay ninguno en el catálogo de prueba), producto `isActive:false` (no hay forma de desactivar uno desde Venta/Entrada de stock), anular venta y cerrar turno (usuario de prueba es cajero, no admin), pago mixto interactivo (comportamiento inconsistente del `p-inputnumber` bajo automatización, sin confirmar si es bug real o artefacto de la prueba — requiere verificación manual).

### Auditoría post-pivot local-first + módulos admin (2026-09-03)

El POS ya opera **local-first**: cobrar y dar de alta stock escriben directo a un SQLite
propio (Prisma, proceso principal de Electron) vía IPC, sin ninguna llamada HTTP en el
instante de la acción. La sincronización con el backend corre sola a las 10:30/14:00/20:00,
al iniciar sesión, o a mano desde el botón del header. Se agregaron además 3 módulos
administrativos nuevos que sí son online (Categorías, Proveedores, Facturas, replicando
`farma-jyv-admin`). La matriz E2E (`qa/e2e/2026-08-30/`) cerró en **54/54 casos Passed**,
incluida cobertura nueva de Venta/Historial/Entrada de stock/Sync contra la app Electron real
(vía Playwright conectado por CDP). Documentación de arquitectura actualizada:
`docs/arquitectura/{pos,core,shared-y-electron}.md`.

Auditoría de código de esta fecha (2 agentes, código real, no hipotético) encontró 7 errores y
7 mejoras — **todo corregido el mismo día**, verificado con `tsc --noEmit` limpio, `ng build
--configuration electron` limpio, 423/423 tests en verde, y una prueba directa contra SQLite
que reproduce el bug P0 y confirma el fix (alta de stock sobre un producto con `remoteId`:
antes reventaba "Record to update not found", ahora incrementa el stock correctamente). El
detalle completo con archivo:línea vive en `docs/arquitectura/pos.md` §10 y
`docs/arquitectura/shared-y-electron.md` §7.

**Errores corregidos (por prioridad):**

| # | Hallazgo | Severidad | Fix |
|---|---|---|---|
| 1 | Dar de alta/reabastecer stock revenía para cualquier producto ya sincronizado (`stock-entry.ts` mandaba el `remoteId` como id local) | **P0** | `electron/db/products.js:recordStockEntry` resuelve el id local por `id` **o** `remoteId` antes de escribir |
| 2 | Anular una venta justo mientras se sincroniza podía dejarla "anulada" en local pero activa en el backend | Alta | Nuevo campo `Sale.needsRemoteVoid` (migración `20260903000000_...`): `markSynced` detecta la carrera y marca la venta para un `POST /sales/:id/void` remoto explícito; `SaleService.reconcileRemoteVoids()` lo dispara tras cada `flushQueue()` |
| 3 | Ventas/altas rechazadas por el servidor (4xx) se reintentaban solas en cada horario fijo | Alta | `getPendingPush`/`getPendingStockEntries` ahora excluyen `pushError` no nulo |
| 4 | Escanear el código de barras de un producto dado de baja lo seguía vendiendo | Alta | `getByBarcode` filtra `isActive: true`, igual que `search` |
| 5 | Fecha de nueva factura se precargaba con el día siguiente entre ~18:00 y medianoche hora de México | Alta | `invoice-form.ts` arma la fecha con componentes locales en vez de `toISOString()` |
| 6 | Guardar una factura sin esperar la respuesta y abrir otra podía expulsar al cajero de la segunda a medio llenar | Alta | `takeUntilDestroyed(destroyRef)` en `invoice-form.ts`/`category-form.ts`/`supplier-form.ts` |
| 7 | El botón "Venta" del header quedaba resaltado como activo en toda la sección POS | Media | `routerLinkActiveOptions` con `exact` solo para el item `/pos` |

**Mejoras aplicadas:**

- `abrirCajon` (`electron/main.js`) pasó de síncrono a async con timeout de 5 s — una impresora/cajón sin respuesta ya no congela el proceso principal.
- `SyncScheduler.pullProducts()` ahora comparte una sola promesa en vuelo entre llamadores concurrentes (sync manual + horario fijo ya no duplican el fetch).
- `catalog:upsertMany` envuelve cada producto+lotes en su propia transacción Prisma.
- Formularios de Categorías/Proveedores/Facturas con `Validators.maxLength` + atributo `maxlength` alineados al backend (120/300/500/60 según campo).
- `ApiHealthService.checkNow()` usa `switchMap` sobre un `Subject` para cancelar una llamada anterior en vuelo.
- `sale-history.ts`: se conectó el botón de reimpresión (`history.print`) al método `print()` que ya existía sin usar, en el diálogo de detalle.
- `flushQueue()` de `SaleService` ahora tiene `catchError` sobre el `getPendingPush()` por IPC.

Pendiente real, no trivial de resolver en una pasada: sigue sin haber pruebas automatizadas
sobre `electron/db/*.js`/`SyncSchedulerService` — es justo la capa donde apareció el bug P0;
un test de integración sobre `recordStockEntry` lo habría atrapado antes de producción.

### P0 — bloquea operación real

| # | Pendiente | Notas |
|---|-----------|-------|
| 4 | **Mercado Pago Point end-to-end** | PDV, `storeId`/`posId` y órdenes ya funcionan en código; falta el emparejado físico de la TPV y la venta real de prueba |
| 5 | **Modo offline robusto** | La cola y el reenvío con idempotencia están; falta prueba real sin red: flush confiable, conflictos, mensajes claros |
| B6 | `GET /sales/:id/receipt`, `GET /sale-returns/:id/receipt` (JSON + HTML 58/80 mm) | El backend ya renderiza el rollo (incluido el desglose mixto). Sustituir o complementar el ticket armado en el cliente |
| B7 | `POST /sale-returns`, `GET /sale-returns` | Devoluciones parciales por partida: reingreso al lote de origen, `refundedTotal`, reembolso Point. Cierra #23 sin trabajo de backend |
| B12 | `POST /payments/mercadopago/orders/:id/refund` | El POS cancela órdenes pero no reembolsa; requisito de B7 con pago tarjeta |

### P0.1 — cobro directo (`/pos/cobro-directo`, 2026-08-08)

Módulo nuevo: cobros con Mercado Pago **sin venta** (servicios, abonos, cobros de terceros), en colección aparte `directCharges`. Dos canales en tabs: terminal Point y link de pago (Checkout Pro, con QR). Backend nuevo en `backend-farma-jyv`: `POST /direct-charges`, `POST /direct-charges/online`, `GET /direct-charges[/:id]`, `POST /direct-charges/:id/cancel`. Lo que falta:

| # | Pendiente | Notas |
|---|-----------|-------|
| DC1 | **Desplegar el backend con el módulo `direct-charges`** | Sin despliegue la pantalla responde 404; es la misma deuda de despliegue del resto de la lista |
| DC2 | `MERCADOPAGO_RETURN_URL` sin valor en `.env` | Sin ella la preferencia se crea sin `back_urls` ni `auto_return`: el cliente se queda en Mercado Pago tras pagar |
| DC3 | **Política TTL de Firestore** sobre `directChargeIdempotencyKeys.expiresAt` | Igual que la de ventas; sin ella la colección crece sin límite |
| DC4 | Webhook `type=payment` sin ejercitar | El código resuelve el cobro en línea desde el webhook, pero no se ha probado con un pago real; hoy la caja depende del polling |
| DC5 | Prueba real de ambos canales | Point: falta la TPV emparejada (mismo bloqueo que #4). En línea: falta pagar un link de punta a punta y ver `approved`, vencido y rechazado |
| DC6 | Reembolso de un cobro directo aprobado | `cancelDirectCharge` lo rechaza a propósito; el reembolso existe en la API de Point (B12) pero no hay UI ni endpoint propio del módulo |
| DC7 | Reporte / arqueo de cobros directos | Por diseño no entran al corte ni a reportes de ventas; falta decidir si necesitan su propio resumen por turno |

### Revisión de la integración Mercado Pago (2026-08-08)

Repaso completo contra la documentación vigente de la Orders API de Point y de webhooks. **Corregido en esta pasada:**

- `pollOrder` del cobro con tarjeta usaba `takeUntilDestroyed()` fuera de contexto de inyección (NG0203): el sondeo de la terminal moría al arrancar. Ahora recibe el `DestroyRef` explícito.
- Cancelar el cobro con tarjeta limpiaba el estado local **antes** de que Mercado Pago confirmara. Una cancelación rechazada dejaba una orden viva que el cajero ya no veía y la terminal podía cobrar después. Ahora solo se limpia al confirmar, el método de pago no cambia si la cancelación falla, y el botón muestra su estado de carga.
- `POST /payments/mercadopago/orders` viaja con llave de idempotencia (la referencia externa, ya única por intento): un reintento de red creaba una segunda orden en la terminal.
- Todos los errores de Mercado Pago se devolvían como 400. Ahora se traducen: 401/403 → 502 `MERCADOPAGO_AUTH`, 5xx → 502 `MERCADOPAGO_UNAVAILABLE`, 429 → 429, timeout/red → 504. Un token vencido ya no se lee en caja como "datos inválidos".
- Las llamadas a Mercado Pago tienen corte de 15 s; antes una API colgada mantenía viva la Function y la caja girando.
- La orden Point se crea con `expiration_time` explícito (`PT15M`) y `print_on_terminal` configurable (`MERCADOPAGO_PRINT_ON_TERMINAL`, default `no_ticket` porque el ticket lo imprime el POS).
- Mercado Pago **no** permite cancelar por API una orden que la terminal ya tomó; el mensaje ahora lo dice ("cancélalo desde la terminal") en vez de repetir el error crudo.
- El webhook de orden (`order`, `orders`, `topic_orders`, `point_integration_wh`) resuelve el cobro directo con terminal. Es lo único que cierra el caso de una cancelación hecha en la terminal o de un cobro aprobado tras cerrar la pantalla.

**Segunda pasada — resueltos los pendientes MP1–MP6, MP8 y MP9:**

- **Firma del webhook a prueba de fallos** (MP1): sin `MERCADOPAGO_WEBHOOK_SECRET`, en producción se **rechazan** las notificaciones en vez de aceptarlas sin validar (fuera de producción se siguen aceptando para poder simular avisos). El POS sigue resolviendo por sondeo mientras el secreto no esté puesto.
- **El webhook de orden ya actualiza las ventas** (MP2): `syncPointPaymentFromOrder` refresca la foto del cobro Point de la venta cuando cambia del lado de Mercado Pago (reembolso, contracargo, cancelación). La venta no se anula sola —eso devolvería stock sin decisión de nadie—, se registra en el log. Una orden aprobada sin venta ni cobro directo detrás se reporta como huérfana.
- **`merchant_order` manejado** (MP3): resuelve el cobro en línea por un segundo camino cuando el aviso de `payment` no llega.
- **Respaldo para la consistencia eventual** (MP4): si `GET /v1/payments/search` no devuelve el pago, se consulta `merchant_orders/search` con la misma referencia; un fallo del respaldo deja el cobro pendiente en vez de tumbar la consulta.
- **Bitácora de notificaciones con deduplicado** (MP5): colección `mercadoPagoWebhookEvents` con el `x-request-id` como id. Los reenvíos (Mercado Pago reintenta cada 15 min) contestan 200 sin reprocesar, y queda constancia de qué llegó, cuándo y cómo se resolvió.
- **Reintento con espera corta en las consultas** (MP6): 2 reintentos (150 ms, 400 ms) ante 5xx/429/timeout, **solo en `GET`**. Un `POST` que expiró pudo haber llegado igual: reintentarlo es exactamente lo que duplicaría un cobro.
- **Cuenta atrás de la orden en caja** (MP8): el diálogo de cobro muestra "Vence en m:ss" sobre los 15 minutos de vigencia. Antes el vencimiento se leía como que la terminal se colgó.
- **Terminal de esta caja** (MP9): `environment.mercadoPago.terminalId` ya se usa para preseleccionar la terminal del mostrador (con varias terminales en la cuenta, tomar la primera podía mandar el cobro a otra sucursal); se elimina `external_pos_id`, que no usaba nadie.
- 22 pruebas en `backend-farma-jyv` (`test/mercado-pago.spec.ts`) y 12 en el POS: cuerpo de la orden, traducción de errores, reintentos (y su ausencia en `POST`), respaldo de merchant orders, cancelación, firma del webhook, terminal preferida y cuenta atrás. Todo con `fetch` sustituido: no toca la cuenta real.

**Sigue pendiente:**

| # | Pendiente | Notas |
|---|-----------|-------|
| MP1b | **Pegar `MERCADOPAGO_WEBHOOK_SECRET` y desplegar** | El código ya rechaza notificaciones sin firma en producción, pero el secreto sigue vacío en `.env`: hasta ponerlo (panel de Mercado Pago → Tus integraciones → Webhooks), el webhook no resuelve nada y todo depende del sondeo |
| MP7 | Conciliación diaria contra Mercado Pago | No hay reporte que cruce órdenes aprobadas contra ventas y cobros directos del día. Hoy la orden huérfana solo queda en el log; falta la vista que la haga accionable |
| MP10 | Índice de Firestore para `point.orderId` y `online.externalReference` | Las búsquedas del webhook son por igualdad sobre campo anidado (Firestore las indexa solo), pero conviene confirmarlo en la consola antes de que la colección crezca |
| MP11 | TTL de Firestore sobre `mercadoPagoWebhookEvents.expiresAt` | Igual que DC3: sin la política, la bitácora de notificaciones crece sin límite |

Además siguen abiertos DC4/DC5 (probar webhook y ambos canales contra la cuenta real), DC6 (reembolso de un cobro directo aprobado) y el emparejado físico de la TPV (#4).

### El push dejaba ventas y productos atrás (2026-09-04)

Reporte real: se cobraron dos ventas y se creó un producto, y al sincronizar solo subió una venta. Diagnóstico contra el SQLite de la caja — no sobre hipótesis:

```
V-000014                 sincronizada
PENDIENTE-1788556679780  pushError: "Stock insuficiente para Prodducto de preuba"
PENDIENTE-1788467939952  pushError: "Stock insuficiente para CORIVER"   (anulada)
PENDIENTE-1788467823137  pendiente, anulada                              (excluida por diseño)
PENDIENTE-1788467152355  pendiente, anulada                              (excluida por diseño)
```

Tres causas distintas, las tres corregidas:

1. **El push salía en paralelo.** `runNow()` disparaba catálogo, entradas de stock y ventas a la vez. Una venta de un producto recién dado de alta —o que consumió mercancía recién recibida— perdía la carrera y el backend la rechazaba. Ahora se encadena: **catálogo → entradas → ventas** (`flushQueueAsync()` en los dos primeros).
2. **El id del producto se congelaba al cobrar.** `buildPayload` grababa `remoteId ?? id`, así que un producto nuevo dejaba en el payload el uuid local, que el backend no conoce (404 "Producto") — y seguía ahí aunque el catálogo subiera después. La traducción pasó al **momento de empujar** (`resolvePayloadProductIds`, en el proceso main, que es donde están los datos). Si algún producto todavía no tiene `remoteId`, esa venta **espera** al siguiente sync en vez de romperse. Verificado contra un SQLite real: id local → remoto, id remoto intacto, venta con producto sin subir excluida.
3. **Un rechazo por inventario mataba la venta.** Quedaba con `pushError` y no se reintentaba nunca, aunque el dinero ya se había cobrado. Ahora se distingue: lo que el cajero puede corregir (turno cerrado, llave reciclada) sigue marcándose como bloqueado; lo que **no** se arregla reintentando (stock que no alcanza allá, producto inexistente) se registra en **`unreconciledSales`**, colección nueva de Firestore — con el payload íntegro, el motivo, el importe, el cajero y la hora real del cobro, más su renglón de auditoría (`sale.unreconciled`). El dinero y el movimiento quedan guardados sin descuadrar el inventario, y el historial de la caja la muestra como **"No conciliada"** con su motivo.

**Las anuladas que nunca sincronizaron ya suben.** Antes se excluían a propósito ("para el servidor esa venta nunca existió"); ahora se crean y se anulan en dos pasos, con su `voidedAt`/`voidedBy` reales, para que quede el rastro completo: la venta, la anulación, el contra-asiento del libro de control y la auditoría.

**Backend nuevo:** `POST /v1/sales/unreconciled` (permiso `pos`), `GET /v1/sales/unreconciled` y `POST /v1/sales/unreconciled/:id/resolve` (permiso `sales`). El documento usa el `localId` como id, así que reintentar el mismo push no duplica nada.

**Migración de datos** (`20260904130000_retry_inventory_rejections`): las ventas ya bloqueadas por inventario vuelven a la cola, para que el siguiente sync las registre en `unreconciledSales` en vez de dejarlas muertas en la caja.

9 pruebas nuevas (rechazo por inventario, rechazo corregible, fallo del propio registro aparte, anuladas que suben con su autor, y el schema en el backend). 437 en el POS, 5 en el backend, todo en verde.

**Pendiente:** desplegar el backend — hasta entonces `POST /sales/unreconciled` responde 404 y esas ventas seguirán marcándose como bloqueadas (el código cae a ese camino si el registro aparte falla).

### Efectivo de farmacia (`/pos/efectivo`, 2026-09-04)

Sacar o meter efectivo sin venta solo se podía desde un botón escondido en la pantalla de venta, protegido por un `@if (isAdmin())` de la plantilla —sin guard de ruta— y **solo con turno abierto**: el dueño no podía retirar efectivo con la caja cerrada. Tampoco había saldo ni historial a la vista.

**Pantalla propia**, tras `permissionGuard('cashSessions', 'write')`. Se reusó esa área en vez de crear una nueva: ya es exclusiva de `admin` (`manager` la tiene excluida a propósito), así que no hubo que tocar roles ni volver a correr `migrate:roles`. El diálogo de la venta se eliminó — un solo camino, con guard real.

**`cashSessionId` deja de ser obligatorio** en toda la cadena: tipo del backend, `CashMovement` de Prisma (migración `20260906000000_cash_movements_standalone`, que reconstruye la tabla porque SQLite no afloja un `NOT NULL` con `ALTER`) y el modelo del POS. El comportamiento es **híbrido**, y es la decisión de fondo: con turno abierto el movimiento se le cuelga y **baja su efectivo esperado** —si no, el cajero contaría un dinero que ya no está y cerraría con un faltante sin explicación—; sin turno queda con `cashSessionId: null` y fuera de todo corte, porque `buildSummary` filtra por sesión y los sueltos se excluyen solos.

**Sync.** `pushOne` elige destino según el origen: la ruta de siempre para los del turno, `POST /cash-sessions/movements` (nuevo, `cashSessions:write`) para los de la farmacia, que además no esperan a que ningún turno sincronice. De paso se corrigió que `markSynced` se llamaba sin el `remoteId` que devuelve el backend, así que todos los movimientos quedaban con `remoteId: null` y un reintento los habría duplicado allá.

**Auditoría.** El endpoint nuevo escribe `cashMovement.created` en `auditLogs` — `addMovement` no auditaba nada. Los gastos siguen exigiendo turno: su desglose por categoría solo tiene sentido dentro de un corte.

18 pruebas nuevas (pantalla, ruta de push sin turno, saldo, el gasto que sigue exigiendo turno, el permiso que el cajero no tiene, y el schema en el backend). 587 en el POS, 87 en la capa local y 6 en el backend, todo en verde. Migración probada contra una copia de la base real: `NOT NULL` fuera, llaves íntegras, movimientos conservados.

**Corrección del saldo (2026-09-05).** La tarjeta sumaba *todos* los movimientos del histórico, así que un gasto de un turno **ya cerrado** —cuyo importe ya estaba dentro del `countedCashAmount` de ese corte— se restaba dos veces: con un solo gasto de $100 la pantalla mostraba −$100 con la caja llena. Ahora el saldo sale de `getCashOnHand` (lo contado en el último corte ± los movimientos sin turno posteriores), que es el mismo número con el que se precarga el fondo al abrir turno: caja y apertura ya no pueden discrepar. Se eliminó `getBalance` de la base local, el IPC, los tipos y el servicio, para que exista una sola definición de saldo.

### Bitácora de movimientos de venta (2026-09-04)

La anulación se guardaba como **estado** (`voidedAt`/`voidedBy` en la venta) pero no como **historia**: el historial mostraba la etiqueta "Anulada" sin decir quién ni cuándo, y en local no había ningún registro por movimiento. Ahora cada movimiento queda asentado en las dos bases.

**Base local (SQLite).** Tabla nueva `SaleMovement` (migración `20260904000000_sale_movements`): un renglón por movimiento —`sale` al cobrar, `void` al anular— con `userId`, `userLabel` (el correo del cajero en ese momento; el uid no le dice nada a nadie), `reason` y `occurredAt`. Se escribe dentro de la misma transacción que la venta o la anulación, así que no puede haber una sin la otra. Se lee por IPC (`sales.listMovements`).

**Historial.** El detalle de la venta muestra la bitácora bajo el ticket ("Cobrada por … 18:00", "Anulada por … 18:20") y la fila del listado dice quién anuló junto a la etiqueta roja. Si la venta es anterior a la bitácora y solo tiene el uid, cae al mismo criterio del ticket antes que mostrar un identificador de Firestore.

**Firestore.** El movimiento remoto ya existía y no se tocó: `voidSale` escribe `stockMovements` negativos, contra-asienta el libro de control y deja el renglón en `auditLogs` (`sale.voided`, con usuario y rol). Lo que se corrigió es **la anulación hecha sin red**: antes se cerraba en el sync y quedaba sellada con la hora del sync y a nombre de quien sincronizó —que puede ser otro turno y otra persona—. Ahora el POS reporta `voidedAt` y `voidedBy` reales y el backend los usa para la venta, los movimientos de stock y el libro, **siempre que sean coherentes** (no futuros, no anteriores a la venta): un reloj desfasado en el equipo no debe escribir una línea de tiempo imposible. La identidad de la auditoría sigue siendo la del token —quien hizo la llamada—, y el dato reportado queda como metadata (`offlineVoid`, `reportedVoidedBy`, `reportedVoidedAt`), que es la única forma honesta de guardar ambas cosas.

11 pruebas nuevas (bitácora local, autor legible, anulación offline que viaja con su hora y su autor, y el schema del cuerpo de anulación en el backend). 433 en el POS y 4 en el backend, todo en verde.

### Anulación de venta y sincronización (2026-08-29)

Revisión de qué pasa al anular en la base local y en Firestore. **Nada se borra en ninguna de las dos**, que es lo correcto: la anulación es un contra-asiento, no un `DELETE`.

- **Local** (`voidLocal`): sella `voidedAt` + `voidedBy` y repone el stock descontado. La venta sigue en la tabla y en el historial marcada como anulada.
- **Firestore** (`voidSale` del backend): sella `voidedAt`, repone las cantidades de cada lote, escribe un `stockMovement` negativo por partida, **contra-asienta el libro de control** con cantidad negativa y deja el renglón de auditoría `sale.voided`. El único borrado duro del POS es `discard`, y solo aplica a una venta que el servidor rechazó y **nunca** llegó a existir allá.

**Hueco corregido:** anular una venta **ya sincronizada estando sin red** fallaba entera. El código pedía primero `POST /sales/:id/void` y solo después anulaba en local, así que sin internet el cajero recibía un error y la venta quedaba **activa en las dos bases**, con el dinero ya devuelto al cliente. Ahora, si el fallo es de red (status 0), se anula en local y la venta queda marcada con `needsRemoteVoid`; `reconcileRemoteVoids` la cierra en el servidor en el siguiente sync — la misma maquinaria que ya resolvía la carrera de `markSynced`. Cualquier otro error (400 "ya está anulada", 400 "tiene devoluciones", 403 de rol) **sigue propagándose sin tocar la base local**: son negativas del servidor, y anular igual dejaría las dos bases discrepando.

Añadido para eso: `sales.markNeedsRemoteVoid` (SQLite → IPC → `preload` → tipos) y cuatro pruebas nuevas (anulación sin red, rechazo del servidor, cierre en el sync siguiente).

**Queda una divergencia por decidir**, no un fallo: una venta creada y anulada **antes** de sincronizar nunca llega a Firestore (`getPendingPush` la excluye a propósito: no hay nada que anular allá). El movimiento queda solo en la base local; el backend no ve ni la venta ni su anulación, y si llevaba controlados, el libro de control tampoco. La alternativa sería empujarla y anularla en dos pasos para dejar el rastro completo. Decisión de cumplimiento, no técnica.

### Limpieza y optimización del POS (2026-08-29)

Repaso completo buscando código muerto, duplicado y peso innecesario.

- **Un solo servicio de categorías.** Había dos (`CategoryService` de solo lectura y `CategoryAdminService` con CRUD) y eso escondía un fallo real: crear o editar una categoría en `/pos/categorias` no invalidaba la caché del otro, así que la entrada de stock no la veía hasta recargar la app. Ahora es uno: `list()` pagina para la pantalla de administración, `options()` cachea para los selectores, y toda escritura tira la caché. Cubierto con pruebas.
- **`PageMeta` eliminado**: duplicaba `ApiListMeta` de `core/api/api.utils.ts` y lo importaban tres servicios *desde otro servicio*. También se borró `ListMeta` de `shared/models`, que no usaba nadie.
- **`toHttpParams()`** en `core/api/api.utils.ts`: sustituye el bloque de `if (query.x) params = params.set(...)` repetido en cinco servicios. Los `false` y `0` sí viajan (`activeOnly=false` es un filtro legítimo).
- **Los listados nuevos usan `unwrapListWithMeta`** en vez de leer `response.data` a pelo, como el resto del POS; si el backend cambia la forma del sobre, no se rompen en silencio.
- **`ProductService.invalidate()` era un no-op** conservado "para no tocar llamadores": se borró junto con sus dos llamadas. Con el catálogo local en SQLite no hay caché que invalidar.
- **QR con carga diferida**: `qrcode` es CommonJS y arrastraba ~90 kB con bailout de optimización dentro de la pantalla de cobro directo. Ahora se importa solo cuando hay un link que dibujar — el chunk de cobro directo pasó de **179 kB a 41 kB**. Los avisos de CommonJS quedan declarados en `allowedCommonJsDependencies`.
- **i18n honesto**: 45 claves muertas (de pantallas que después usaron texto en español directo) fuera, y **82 claves que faltaban en `en.json`** (categorías, proveedores, facturas, sync, nav) traducidas. Ambos idiomas tienen ahora las mismas 266 claves.
- **Presupuesto de bundle realista**: el inicial son 1.12 MB en crudo / **258 kB transferidos**, y el aviso estaba fijado en 700 kB, así que saltaba en cada build y tapaba regresiones de verdad. Sube a 1.2 MB de aviso y 1.6 MB de error. En una app de escritorio que carga desde disco, el crudo pesa menos que el transferido.

Verificado: sin dependencias sin usar en `package.json`, sin imports muertos (`tsc --noUnusedLocals` limpio en app y specs), build **sin un solo warning**, 44 archivos y 423 pruebas en verde.

Queda anotado, sin tocar: `getAppVersion` y `getDeviceInfo` están expuestos en el `preload` y no los llama nadie. Se conservan porque `getDeviceInfo` (MAC + hostname) es la pieza que necesita multi-caja (#21); si esa función se descarta, hay que quitarlos.

### Entrada de stock desde la caja (`/pos/entrada-stock`, 2026-08-28)

La caja recibía la mercancía pero no podía darle entrada: todo se capturaba en el panel. Pantalla nueva que cierra el hueco — elegir una de las últimas 10 facturas, buscar el producto por SKU, nombre o principio activo, verlo lleno (o darlo de alta si no existe), y sumar piezas con lote, caducidad y costo opcional.

- **Módulo `stock-entries` en el backend**: `GET /v1/stock-entries/invoices` y `POST /v1/stock-entries`. Ninguno de los endpoints existentes servía —`/inventory/entries` exige factura pero no crea producto; `/inventory/direct-entries` crea producto pero no acepta factura—. El módulo orquesta `productsService` e `inventoryService.recordEntry` sin duplicar lógica: lote, `stockMovement`, proveedor y `totalStock` siguen saliendo de la transacción que ya existía.
- **Área de permiso `stockEntry`**: el cajero recibe `stockEntry:write` y con eso ve solo esta pantalla. El libro de control sigue pidiendo `inventory:write`, así que recibir mercancía no le abre conteos, salidas ni el libro.
- **Lote y caducidad obligatorios**, y no se acepta mercancía vencida: de ellos dependen FEFO, el aviso de caducidad y el libro de control.
- Editar un producto existente manda **solo los campos cambiados** —el producto completo dejaría un renglón de auditoría en cada entrada— y el IEPS se captura en porcentaje y viaja como fracción.
- Tras guardar se invalida la caché del catálogo (el stock nuevo debe verse al vender) y **se conserva la factura**: una factura trae varias partidas.
- 29 pruebas nuevas: schema del backend (10, sin emulador), servicio y pantalla del POS, más la matriz del menú por rol.

Pendiente: **`npm run migrate:roles`** en el backend, o el cajero no recibe `stockEntry` aunque el código lo declare. El alta de facturas (subir PDF + registrar) sigue siendo del panel. Y el precio de venta queda al alcance del mostrador: el backend audita el cambio (`product.price_changed`), conviene revisar esa bitácora al principio.

### Catálogo y permisos: costo por consulta (2026-08-28)

Revisión de cuánto le cuesta al servidor cada tecleo en caja. **El catálogo no se guarda en local** —solo ticket, pausadas y cola offline—, pero las consultas eran más caras de lo necesario:

- **Término vacío ya no consulta.** `GET /products` sin `search` hace que el backend lea la colección **entera** de Firestore; eso pasaba cada vez que el cajero limpiaba el buscador. Igual en clientes.
- **Mínimo dos caracteres** antes de consultar: con una letra el backend recorre hasta 500 documentos para devolver medio mostrador.
- **`limit=25`** en la búsqueda del mostrador, en vez de la página por defecto.
- **Caché de 30 s** por término (máx. 40 entradas) + deduplicado de peticiones en vuelo. Se invalida al cerrar una venta: el stock recién descontado no debe seguir pintándose.
- **`clearSearch()` cancela el debounce pendiente**: tras escanear, esa consulta ya no le sirve a nadie.
- **Perfil cacheado** (5 min, atado al `uid`): `permissionGuard` pedía `GET /auth/me` en cada navegación porque el `shareReplay` solo deduplica lo que está en vuelo. Ahora es una petición por sesión.

11 pruebas nuevas cubren caché, término vacío, mínimo de caracteres y cancelación del debounce.

Pendiente del lado del backend: `listProducts` filtra en memoria tras leer hasta 500 documentos. Con un catálogo grande eso no escala; la salida es un índice de búsqueda (prefijos en Firestore o un servicio externo), no más caché en el cliente.

### Permisos por pantalla (2026-08-08)

El rol solo filtraba **enlaces del menú**: escribir la URL a mano abría cualquier pantalla, y de las tres sensibles solo el libro de control se autoprotegía por dentro. Además el rol `cashier` del backend no tenía `sales`, así que veía la caja pero no podía vender.

- `permissionGuard(area, level)` en `pos.routes.ts` cierra historial (`sales:read`), cobro directo (`directCharges:write`), reportes (`dashboard:read`) y libro de control (`inventory:write`). Venta queda sin guard a propósito: es el destino de la redirección al denegar, y cerrarla crearía un rebote infinito —ya se autoprotege con `canSell`.
- El libro pide `inventory:write` y no el `read` de su endpoint: `read` es lo que el cajero necesita para lote y caducidad al vender, así que gatearlo con `read` se lo mostraría a todo el mostrador.
- **Área de permiso nueva `directCharges`** (backend y POS): cobrar fuera del ticket mueve dinero sin venta que lo respalde, así que es atribución de supervisión y no se concede con `sales:write`. `admin` y `manager` la reciben por sus definiciones; `cashier` no.
- `cashier` redefinido como rol de mostrador. El backend además separó el área **`pos`** (operar la caja: vender, cobrar, turno, alta de cliente) de **`sales`** (administrar lo vendido: leer, anular, devolver, reembolsar), así que el cajero queda con `pos:write`, `sales:read`, `products:read`, `categories:read`, `inventory:read`. El POS ya lo refleja: `canSell` es `pos:write`. Se le retiran `categories:write`, `suppliers:write` e `invoices:write`, que eran accesos del panel de administración. **Ojo**: si alguien usaba `cashier` para facturar en el panel, pierde ese acceso — hay que moverlo a `manager` o a un rol propio.
- `PermissionArea` del POS ahora refleja al backend completo (faltaban `patients`, `medicalRecords`, `appointments`).
- Pruebas: `nav.config.spec.ts` fija la matriz por rol (el cajero solo ve venta e historial) y `auth.guard.spec.ts` cubre el guard. Las pruebas corren con `isolate: true` porque el mock de `firebase/auth` se filtraba entre archivos.

Pendiente: **ejecutar `npm run migrate:roles`** en el backend. Los permisos viven en la colección `roles` de Firestore; cambiar la definición en código no mueve nada hasta sembrar, y ese script además sube `permissionsVersion` y reemite los claims (sin eso, los usuarios conservan el alcance viejo mientras su token siga vivo).

### Pruebas unitarias (2026-08-08)

Suite de Vitest sobre `@angular/build:unit-test` (jsdom): 39 archivos, 351 pruebas. Cubre utilidades, todos los servicios del POS (con `HttpTestingController`) y la lógica de las pantallas (venta, cobro, cobro directo, historial, reportes, libro de control, diálogos de caja, tickets, shell, login, guards e interceptor). Rellenos de jsdom en `src/testing/setup.ts` (`ResizeObserver`, `matchMedia`). Cobertura: 72 % de sentencias en total — servicios ~96 %, utilidades ~98 %, plantillas de componentes por debajo. Pendiente:

| # | Pendiente | Notas |
|---|-----------|-------|
| T1 | `login`/`logout` de `AuthService` sin prueba directa | Son envolturas del SDK de Firebase; sustituir el módulo entero rompe con `--coverage`. Su efecto sí se prueba en guards e interceptor |
| T2 | Ramas de plantilla poco cubiertas (`sale.html`, `checkout.html`, `direct-charge.html`) | La lógica sí está probada; falta ejercitar el DOM (estados vacíos, avisos) |
| T3 | Sin pruebas de `flushQueue` con red intermitente | La cola se prueba con respuestas deterministas; el escenario real de reconexión sigue en #5 |

### P1 — cumplimiento y control de caja

| # | Pendiente | Notas |
|---|-----------|-------|
| B8 | `GET/POST /cash-sessions/:id/x-report`, `GET :id/x-readings` | Lectura X: foto del turno sin cerrarlo, con folio `X-000001` al registrarla. Hoy solo hay corte Z al cerrar |
| B9 | Recibo Z que ya devuelve `POST /cash-sessions/:id/close` (`?width=58\|80`) | El POS lo descarta y reimprime uno propio |
| B10 | `GET /reports/sales-summary`, `/profit`, `/top-products`, `/by-cashier`, `/dead-stock` | Los reportes del POS son locales sobre el turno; usar la API para día/rango, margen y por cajero |
| B11 | `GET /inventory/alerts` | Caducidad y stock bajo del servidor en el banner de caja, no solo el lote de la línea |
| B13 | `GET /audit-logs` | Rastro de anulaciones y movimientos visible para admin desde caja |
| B19 | **CFDI 4.0 (#10)** — decisión de backend (2026-08-04): **no se construye todavía**, falta elegir PAC | El POS ya captura `billing` (RFC, razón social, `usoCfdi`, correo) y deja `invoiceStatus: pending`. No prometer timbrado en caja |

### P2 — productividad de mostrador

| # | Pendiente | Notas |
|---|-----------|-------|
| 16 | **Pantalla de cliente** (2ª ventana Electron) | Total / último ítem agregado |
| 20 | **Teclado numérico touch** | Cobro y cantidades en tablet / touch POS |
| B14 | `GET /products/:id/sales-history` | Historial del producto desde la búsqueda del mostrador |

### P3 — operación y crecimiento

| # | Pendiente | Notas |
|---|-----------|-------|
| 21 | **Multi-caja / multi-sucursal** | `storeId`/`posId` ya en env; falta selección de caja al iniciar sesión |
| 23 | **Devoluciones / notas de crédito** | Vía B7 + B12, contra folio original |
| — | **Feed real de actualizaciones** | Hoy placeholder `https://updates.farmajyv.mx/pos` |

### Defectos de auditoría (`AUD-*`, 2026-08-07) — **corregidos**

Auditoría de las cuatro pantallas con `screen-auditor` (código + navegador real vía Playwright MCP + reglas replicadas). 58 defectos, cero escrituras al backend: las 12 peticiones mutantes se interceptaron y abortaron. Lo marcado *(sim.)* se midió con respuestas GET simuladas porque la base de producción tiene 1 venta; el resto es contra el servidor real.

Lo que **no** falló: la aritmética del cobro cuadra al centavo (incluido el mixto contra `total − cardAmount`), el desglose fiscal suma exacto, `cashCollected` no cuenta la parte de tarjeta, las piezas netas del libro respetan el signo, la idempotencia se reusa y renueva bien, y `Esc` con diálogo abierto ya no vacía el ticket.

> **Estado (2026-08-07): los 58 quedaron corregidos**, salvo lo anotado abajo. La columna «Arreglo» de las tablas describe lo que **se hizo**. Build de producción, `tsc` y las 43 pruebas en verde.
>
> Excepciones y matices, para no dar por cerrado lo que no lo está:
>
> - **AUD-10** (orden de tabulación) se cierra como **falso positivo**. El DOM ya sigue el orden visual y el pie ya es el último nodo; la secuencia que midió la auditoría es el ciclo correcto **partiendo del foco inicial**, que `onDialogShow()` coloca a propósito en el campo que bloquea. Moverlo al inicio del diálogo mejoraría la métrica y empeoraría el flujo de caja ("abrir → teclear → F9"). Se descartó introducir `tabindex` positivos, que son un antipatrón WCAG.
> - **AUD-14** quedó a media granularidad: `validatePrescription` devuelve un `string` sin identificar el campo, así que `aria-invalid` marca médico y cédula en bloque. Para señalar el campo exacto haría falta que esa función devuelva también el culpable. El campo de efectivo no recibe `aria-invalid` porque `p-inputnumber` no reenvía atributos al `input` interno; el motivo sigue anunciado por el `role="alert"` del pie.
> - **AUD-23/AUD-25**: el historial pasó a paginación real del servidor (`search` + `limit: 100`), así que turnos de más de 100 ventas quedan en una página. Cerrar esto del todo pide `[lazy]` + `onLazyLoad`.
> - **AUD-24**: pantalla y papel ya muestran lo mismo, pero las ventas de **otro** cajero siguen mostrando el UID: no hay endpoint para resolver el nombre desde el POS.
> - **AUD-53**: la identificación se repite en cada página (`position: fixed` en `@media print`), pero **no hay numeración "Página X de Y"**: Chromium no implementa los margin boxes de `@page`. Además `pharmacy.address`/`rfc` siguen vacíos en los cuatro entornos — hay que llenarlos para que el membrete sea válido.
> - **AUD-44**: la causa resultó **no ser** del POS ni del código del backend, sino un **desfase de despliegue** (ver más abajo). Aun así el POS bajó a `limit: 100` —el máximo que acepta cualquier versión desplegada— y ahora ofrece el CSV del periodo completo.

#### P0 — rompe al usuario, pierde dinero o descuadra la caja

| # | Defecto | Arreglo |
|---|---------|---------|
| AUD-44 | **El libro de control nunca carga en producción**: manda `limit: 200` y el backend responde `400 — "El límite no puede ser mayor a 100"`. El toast dura 3 s y queda una hoja con membrete, rango, resumen y pie de firmas que dice "Movimientos 0": imprimible y firmable en una visita de COFEPRIS | `controlled-ledger.ts:144` → `limit: 100`, y paginar (AUD-47) en vez de subir el tope |
| AUD-45 | **Al entrar al libro no se consulta nada**: el constructor llama `reload()`, que sale por `!canRead()` porque `GET /auth/me` aún no resolvió. Después `canRead()` pasa a `true` y se pinta la hoja, pero nadie reintenta | `controlled-ledger.ts:119-121` — disparar con un `effect()` sobre `canRead()`, y no confundir "permiso indeterminado" con "sin permiso" |
| AUD-46 | **Editar las fechas del libro no recarga, pero el encabezado impreso sí cambia**: se obtiene una hoja firmada que declara un periodo y contiene los renglones de otro | `controlled-ledger.html:9-24` — `reload()` en `(ngModelChange)`, o imprimir el rango realmente consultado (`appliedFrom`/`appliedTo`) |
| AUD-47 | **Truncamiento silencioso del libro**: sin paginación ni aviso. El backend devuelve `meta.total`/`totalPages` y `unwrapList` los tira *(sim.)* | `controlled-ledger.service.ts:59-79` devolver `{entries, meta}`; aviso de hoja incompleta **dentro** de `.pos-print-root` |
| AUD-01 | **"Anular venta" sobre una venta offline falla en silencio**: manda `POST /sales/offline-…/void` con un id que solo existe en el cliente y el `subscribe` no tiene handler de error. El cajero cree que anuló; la venta sigue en cola y se envía al reconectar | `sale.ts:537-546` — no ofrecer anulación con folio `PENDIENTE-*` (o convertirla en "descartar de la cola") y añadir `error:` |
| AUD-16 | **Nada impide dos `POST /sales/:id/void` de la misma venta**: sin señal de envío en curso, a diferencia del `submitting()` del cobro. Puede duplicar el renglón de anulación del libro y el reingreso de stock | `sale-history.ts:104` — signal `voiding`, salida temprana, `finalize`, y enlazarla a los dos botones (`sale-history.html:56-62`, `:100-107`) |
| AUD-29 | **Un `GET /cash-sessions/current` caído pinta un corte en ceros sin avisar**: `fetchCurrent().subscribe()` sin bloque `error`, así que `reload()` nunca corre. Queda "Venta neta $0.00" con `Generado` fresco, cero toast, y se puede imprimir | `reports.ts:136-142` — añadir `error:` y distinguir "no se pudo determinar el turno" de "sin ventas en el periodo" |
| AUD-30 | **Botón "Refrescar" muerto y alcance activo deshabilitado**: en el estado de AUD-29, `reload()` retorna temprano; refrescar no dispara nada y "Turno actual" está `disabled`. Sin salida salvo recargar la app | `reports.ts:149-154` — reintentar `fetchCurrent()` y, si sigue sin sesión, forzar `scope.set('day')` |

#### P1 — contrato, cumplimiento, accesibilidad, seguridad

| # | Defecto | Arreglo |
|---|---------|---------|
| AUD-02 | Una venta pendiente (no bloqueada) es inalcanzable: el badge es un `<span>`, no un botón. Evidencia de que `flushQueue()` solo corre con `window.online`: al recargar con 1 venta en cola y red disponible, 0 peticiones en 6 s | `sale.html:39-43` badge → botón con "Enviar ahora"; `sale.service.ts:176` llamar `flushQueue()` al construir si `navigator.onLine` |
| AUD-03 | La misma venta se cuenta dos veces en la barra: `pendingCount` incluye las bloqueadas, así que una rechazada pinta "1 pendiente" y "1 rechazada" | `sale.service.ts:169-173,455-459` — excluir las que tienen `blockedReason` |
| AUD-04 | Cinco campos sin `label` asociado en los diálogos de caja (fondo inicial, efectivo contado, tipo, monto, motivo). Contradice la línea de a11y de la sección Hecho | `cash-session-dialog.html:41,115-116` y `cash-movement-dialog.html:13-14,24-25,36-37` — `inputId` + `for` |
| AUD-05 | El botón de cerrar de los `p-dialog` no tiene nombre accesible (cobro, turno, movimiento, sustitutos, rechazadas) | `[closeAriaLabel]` en cada `p-dialog`, desde `checkout.html:1-11` |
| AUD-06 | Cerrar turno es irreversible, no pide confirmación y se puede pulsar con $0.00 contado; descartar **una** venta sí pide `confirm` | `cash-session-dialog.html:165` — deshabilitar hasta tocar el contado y confirmar si `difference() !== 0` |
| AUD-07 | Los dos CTA principales y la leyenda de atajos fallan contraste AA: "Confirmar" 3.77:1, "F9 Cobrar" 3.65:1, leyenda 2.63:1 | `sale.html:343` y `pos-cobrar-btn` a `emerald-700`; leyenda `sale.html:26-38` y `checkout.html:18` a `text-slate-600` |
| AUD-08 | El panel de receta es inalcanzable cuando el grupo no la exige, así que la rama "mándala si el cajero la capturó" (grupos V/VI) es código muerto | `checkout.html:309` — panel plegable "Registrar receta (opcional)" siempre disponible, abierto si `needsPrescription()` |
| AUD-17 | El fallo de anulación oculta el motivo del backend: siempre "No se pudo anular la venta.", sin distinguir 403, 409 o red | `sale-history.ts:119` → `getApiErrorMessage(e)` con fallback |
| AUD-18 | Un listado fallido deja datos viejos sin marca de obsolescencia: el toast se auto-cierra y la tabla parece al día. Con esa tabla se cuadra el turno | `sale-history.ts:83-87` — signal `loadError` + banda persistente con "Reintentar" |
| AUD-19 | Los tres icon-buttons de cada fila del historial (ver, imprimir, **anular**) no tienen nombre accesible | `sale-history.html:15,53,54,56-62` — `[ariaLabel]` con el folio interpolado |
| AUD-20 | El buscador del historial no tiene `label` ni `id`; su único nombre sale del `placeholder`, que desaparece al teclear | `sale-history.html:6-13` — `id` + `label.sr-only`, `autocomplete="off"` |
| AUD-21 | Al cerrar el diálogo de detalle el foco cae en `<body>`: con 250 filas son cientos de tabulaciones para volver | `sale-history.ts:95-98` guardar el disparador y devolver el foco en `(onHide)` |
| AUD-22 | Sin turno abierto el historial muestra el día pero sigue diciendo "turno" — justo la diferencia al cuadrar caja | `sale-history.ts:60-68` exponer el alcance; claves i18n `history.emptyShift` / `emptyDay` |
| AUD-31 | Mientras carga, Reportes es indistinguible de "no hubo ventas": ceros con `Generado` fresco, sin `aria-busy` ni skeleton. Se puede imprimir el cero | `reports.html:34-42` — overlay/skeleton, `[attr.aria-busy]`, no mostrar `generatedAt` hasta terminar |
| AUD-32 | `listAll` pagina sin tope: si el backend ignorase `page`, el POS martillea producción en bucle. Simulado: 41 peticiones en 6 s sin parar solas. Suma evidencia a **B10** | `sale.service.ts:249-259` cota dura de páginas con aviso de truncamiento, o migrar a `/reports/*` |
| AUD-33 | El botón de refrescar de Reportes no tiene nombre accesible | `reports.html:24` — `[ariaLabel]` + clave i18n |
| AUD-34 | Los botones de alcance de Reportes no exponen estado: sin `aria-pressed` ni `role="group"`. El libro de control ya lo resolvió; aquí quedó pendiente | `reports.html:7-19` `[attr.aria-pressed]`; `:5` `role="group"` |
| AUD-35 | **El anillo de foco de los `p-button` es invisible (1.44:1)** — afecta a toda la app, no solo a Reportes. Con "teclado primero" como principio 1, es un fallo directo | preset de `core/theme` — `focusRing` a 2 px opaco con offset |
| AUD-48 | El rango del libro se manda sin zona horaria (`from` pelada, `to` con `T23:59:59.999` sin offset): la ventana puede desplazarse ~6 h y perder la tarde del último día, justo lo que el comentario quiso evitar | `controlled-ledger.ts:140-142` — offset explícito de `America/Mexico_City`, y documentar el contrato en el dosier §15 |
| AUD-49 | Rango invertido y rango vacío se aceptan sin aviso: el vacío imprime "· a ·", una hoja legal sin periodo | `controlled-ledger.ts:131-145` — validar antes de consultar; `[min]`/`[max]` cruzados en los inputs |
| AUD-50 | Un renglón sin grupo válido se imprime como "Grupo VI (venta libre)" y suma al resumen: el libro blanquea un controlado. Enlaza con la carencia de `controlledGroup` en el catálogo | `controlled-ledger.service.ts:72` — no inventar grupo; "Sin grupo" con advertencia y contarlo aparte |
| AUD-51 | Tras un error el libro conserva los renglones anteriores y actualiza la hora de impresión; con AUD-46, hoja con periodo nuevo y datos viejos. Imprimir sigue habilitado durante la carga | `controlled-ledger.ts:151-154` — limpiar `entries`, `loadError` dentro de `.pos-print-root`, deshabilitar Imprimir |
| AUD-52 | Los dos campos de fecha y el select de grupo del libro no tienen nombre accesible (`<label for>` no asocia con el `<span role="combobox">` de PrimeNG) | `controlled-ledger.html:8-23` — `id`+`for` en fechas, `ariaLabelledBy` en el select, `[ariaLabel]` en refrescar |
| AUD-53 | La hoja del libro no lleva numeración de página ni se identifica más allá de la página 1 (16 páginas con 200 renglones): un verificador no puede comprobar que no falta ninguna. Faltan domicilio y licencia sanitaria (`pharmacy.address`/`rfc` vacíos) | `controlled-ledger.html:64-76` + `styles.css:130-152` — encabezado repetido y contador de páginas; llenar `pharmacy.*` en los cuatro entornos |

#### P2 — presentación, rendimiento, semántica

| # | Defecto | Arreglo |
|---|---------|---------|
| AUD-09 | `role="tab"` sin `aria-controls` ni ningún `tabpanel` en los métodos de pago | `checkout.html:47-67` → `role="radiogroup"`/`radio` + `aria-checked` |
| AUD-10 | El orden de tabulación del cobro no sigue el visual: el pie y la X van antes que la columna izquierda | mover `<ng-template #footer>` al final del DOM del diálogo |
| AUD-11 | `NG0956` en consola con cada cambio de bloqueo: `track blocker` usa el texto como llave | `checkout.html:594` — bloqueos como `{id, texto}` y `track blocker.id` |
| AUD-12 | El mensaje crudo del backend se pinta tal cual en el toast | `api.utils.ts:46` — acotar longitud y mensaje genérico para 5xx |
| AUD-13 | Scroll horizontal en 768×1024 en Venta (`scrollWidth 1021`). Bajo el mínimo Electron, pero bloquea el objetivo touch (#20) | `sale.html:185` — `max-w-[45vw]` o apilar bajo `lg:` |
| AUD-14 | Ningún campo se marca `aria-invalid` cuando es el que bloquea el cobro | `checkout.html:339-349,358-366,522-538` — `aria-invalid` + `aria-describedby` |
| AUD-15 | `−` sobre una línea en cantidad 1 no hace nada y no avisa (el `+` sí avisa) | `sale.ts:370-374` — quitar la partida o notificar |
| AUD-23 | Cada pulsación del buscador redescarga el historial completo página por página: 18 peticiones y 1 500 ventas transferidas para filtrar 51. El backend **ya** filtra por `search` | `sale-history.ts:90-93` — `debounceTime(250)` + `switchMap` con `search`; eliminar el filtro cliente de `:71-80` |
| AUD-24 | El detalle muestra el UID del cajero; el ticket impreso muestra el correo | `sale-history.html:88` — reusar la resolución de `sale-history.ts:101` |
| AUD-25 | Tabla del historial sin encabezado fijo ni paginación: 250 filas y 750 botones en el DOM | `sale-history.html:19` — `scrollable` + `paginator` o `virtualScroll` |
| AUD-26 | `[rowHover]` sugiere una fila clicable que no lo es | quitar `rowHover` o añadir `(click)` con `tabindex`/`role` |
| AUD-27 | Las ventas encoladas offline no aparecen en el historial: `PENDIENTE-…` vive en `localStorage` y no se lista, justo cuando el cliente vuelve a pedir su ticket | `sale-history.ts:69-82` — componer la cola con tag "Pendiente de sincronizar" |
| AUD-28 | Desbordamiento de 253 px en 768×1024 causado por el **shell** (bloque de usuario y "Cerrar sesión"), no por el historial | `core/layout/shell.html` — colapsar correo y rol bajo `sm`, permitir `flex-wrap` |
| AUD-36 | La hoja de Reportes no dice qué reporte es ni de qué turno: sin título, sin razón social, sin `openedAt`. No es archivable contra el corte Z | `reports.html:35` — encabezado imprimible dentro de `.pos-print-root` |
| AUD-37 | Una hora con ventas puede dibujar una barra de 0 px (redondeo bajo 0.5 % del máximo) | `reports.ts:125` — `Math.max(2, …)` cuando `total > 0` |
| AUD-38 | La barra por hora es decorativa pero no está marcada como tal; 2.25:1 contra la pista | `reports.html:126` — `aria-hidden` o `role="img"` con label |
| AUD-39 | `byHour` ordena por número de hora: un turno que cruza medianoche sale invertido *(razonado desde el código, no observado)* | `reports.ts:112-126` — en alcance sesión, ordenar relativo a `openedAt` |
| AUD-40 | Texto del alcance no seleccionado a 4.35:1 (Reportes) | `reports.html:13` → `text-slate-600` |
| AUD-41 | "Turno actual" deshabilitado sin decir por qué — mismo antipatrón que el cobro ya cerró | `reports.html:15` — nota "Sin turno abierto — mostrando el día" |
| AUD-42 | Las tres tablas de Reportes sin `caption`/`aria-label` y `<th>` sin `scope`; las dos de Top 10 son indistinguibles con lector de pantalla | `reports.html:83,145,174` — `[attr.aria-label]` y `scope="col"` |
| AUD-43 | Scroll horizontal en 768×1024 en Reportes, también por el shell (ver AUD-28) | mismo arreglo que AUD-28 |
| AUD-54 | Las filas del libro se parten entre páginas al imprimir (~15 de 200 en Letter) | `styles.css` — `break-inside: avoid` en `tbody tr` dentro de `@media print` |
| AUD-55 | Contraste 4.35:1 en los botones de rango inactivos del libro | `controlled-ledger.html:46` → `text-slate-600` |
| AUD-56 | Scroll horizontal en 768×1024 en el libro (la tabla desborda: 858 > 736) | envolver la `p-table` en `overflow-x: auto` solo en pantalla |
| AUD-57 | "impreso" es la hora de la consulta, no la de la impresión | `controlled-ledger.ts:158-160` — sellar en `print()`, o dos sellos distintos |
| AUD-58 | Sin permiso, los filtros e Imprimir del libro siguen activos: se puede imprimir una hoja con membrete cuyo contenido es el aviso de "no tienes permiso" | envolver la barra de filtros en el mismo `@if (canRead())` |

### Por verificar (no es código)

- ~~Catálogo real: que los productos traigan `controlledGroup` y banderas fiscales capturadas.~~ **Confirmado como problema (2026-08-07)**: `GET /products` no devuelve `controlledGroup` en **ningún** producto y todo llega con `hasIva: false, hasIvaZero: false, hasIeps: false`. Consecuencia observada en vivo: el desglose fiscal de una venta real muestra "Base gravable $201.67 / IVA $0.00". Sin grupo, el POS cae al flag viejo `requiresPrescription` y **no** exige folio ni retención — y con AUD-50, el libro de control imprimiría esos movimientos como "Grupo VI (venta libre)". Se arregla capturando el grupo en el catálogo (admin), no en el POS.
- Smoke test en Electron con TPV física: pago mixto punta a punta (tarjeta parcial + efectivo) y el corte resultante. Sigue pendiente: `GET /payments/mercadopago/devices` responde sin terminales vinculadas, así que la auditoría no pudo ejercitar `cardOrderApproved()`, el polling, `cardAmountLocked()` ni el reintento.
- **Desplegar `backend-farma-jyv`.** La API en producción está **atrasada respecto a su repositorio**: `GET /inventory/controlled-ledger?limit=101` responde `400 — "El límite no puede ser mayor a 100"`, mensaje que `parsePagination` solo emite cuando no recibe `maxLimit`, y el código commiteado sí pasa `CONTROLLED_LEDGER_MAX_LIMIT = 1000`. Hasta desplegar, no se puede dar por bueno ningún comportamiento observado contra la API — y varias funciones que el POS aún no consume (recibos, devoluciones, lectura X, reportes) pueden estar en la misma situación. **Ojo**: el repo del backend tiene trabajo sin commitear en `feature/medic-changes` (clinic/appointments/medical-records) más los cambios de esta pasada; hay que separar qué se despliega.
- ~~Prueba con un rol **sin** `sales:write`~~ **Hecho (2026-09-07)** con la cuenta `cashier` real, en Electron y contra la API de producción en modo solo lectura. Verificado en vivo: los 403 del backend (`GET /cash-sessions`, `/cash-sessions/movements`, `/reports/*`, `/users`, `/roles`, `/audit-logs`) y los 200 de lo suyo; el menú sin Reportes, Efectivo, Cortes ni Libro; el recorte del descuento al 20 % al bajar la cantidad, con aviso; el rechazo de una cantidad mayor al stock; el corte con efectivo esperado correcto ($0 de fondo + $25 de venta) y el aviso de movimientos sin sincronizar; y el diálogo de rechazados con Reintentar/Descartar. Sigue sin ejercitarse un rol sin `inventory:read` y el mixto con TPV física.
- Rango de fechas del libro contra el backend (AUD-48): con el libro real vacío no se pudo medir el corrimiento. Requiere leer el parseo en `backend-farma-jyv` o un entorno con datos.

---

## Hecho

### El residuo de la auditoría de QA (2026-09-07)

Diez arreglos, cada uno con prueba que falla sin él. **942 pruebas del POS, 238 de Electron,
679 del backend.** La CSP y el aviso del login se verificaron además en el empaquetado real
(`file://`), no solo en el dev server.

| # | Era | Arreglo |
|---|-----|---------|
| QA-1 | El cierre podía condenar un hijo: la primera pasada omitía `sinHijosPendientes` **siempre**, para liberar el hueco del cajero | El filtro se decide por **necesidad**, no por posición: solo se cierra con hijos en cola si hay un alta esperando el hueco (sin él, el alta choca por `remoteId`, P2002 visto en producción). Sin altas en cola no hay prisa: se filtra y el gasto que falló por red se salva. Deja de ser un compromiso permanente y pasa a ser el precio de un caso concreto |
| QA-3 | `/pos/historial` mostraba las ventas de todos los cajeros que usaron el equipo, y con permiso permitía anularlas | `list()` acepta `cashierId` (`electron/db/sales.js`) y la pantalla lo manda salvo para `admin`, que sigue viendo todo para auditar |
| QA-4 | `expectedCashAmount` sin redondear: el `round` se añadió con la rama de servicios y la de farmacia se quedó fuera | Redondeo a centavos en el efectivo esperado, el neto del cajón, el gran total y las devoluciones. Es la cifra contra la que el cajero cuenta el dinero a mano, y el cajón no tiene milésimas |
| QA-5 | Alta de stock sin idempotencia: un reintento de la cola tras un timeout duplicaba el lote — existencias que no existen y que nadie cuadra contra la factura | Mismo patrón que las ventas: `stockEntryIdempotencyKeys` con documento por `usuario:llave`, reservado antes de tocar catálogo e inventario; el reintento devuelve la entrada ya registrada. El POS manda como llave el id local de la entrada, estable entre reintentos. Una llave reservada sin terminar responde 409 y pide revisión humana: duplicar stock es peor que pedir que alguien mire |
| QA-7 | Aviso y diálogo de "ventas rechazadas" duplicados en la pantalla de venta, alimentados por una señal que `getPendingPush` nunca llena (filtra `pushError: null`) | Borrados de `sale.html`/`sale.ts`, y `blockedSales` fuera del servicio. Las rechazadas las lleva el shell (`BlockedSyncService`), que además abarca gastos y catálogo |
| QA-8 | `reviewPendingSales()` existía sin botón: el diálogo para forzar el envío era inalcanzable | El chip de la barra de venta —donde estaba el duplicado de QA-7— ahora dice "N venta(s) sin sincronizar" y abre ese diálogo. Reparto claro: la pantalla de venta muestra **su** cola (se puede empujar), el shell muestra lo **rechazado** (hay que decidir) |
| QA-9 | El botón "Entrar" se deshabilitaba sin decir por qué | Aviso bajo el botón, con `aria-describedby` y `aria-live`. Depende del **valor** del formulario y no de `statusChanges`: teclear un correo mal escrito no cambia el estado, así que con `statusChanges` el aviso nunca pasaba de "falta capturar" a "el correo no es válido" |
| QA-11 | CSP sin `script-src`: tapaba `object-src`/`frame-src` y dejaba abierto el vector que convierte un XSS en ejecución dentro de la ventana con acceso al IPC | CSP con `script-src 'self' file:` (el empaquetado carga por `file://`, donde `'self'` no aplica) más `style-src`/`img-src`/`font-src`/`media-src` y `form-action 'none'`. `connect-src` sigue fuera **a propósito**: habría que enumerar API, Firebase, dev server y emulador, y un host que falte no da error visible, deja la caja sin vender |
| — | **Efecto secundario que encontró la CSP:** Angular inyectaba el CSS crítico con `<link media="print" onload="this.media='all'">`, un manejador inline. Con `script-src` puesto, ese `onload` no corre y la hoja se queda en `media="print"`: **la app sin estilos en producción** | `inlineCritical: false` en las configuraciones `production` y `electron`. En una app de escritorio el CSS ya es local: el truco no ganaba nada y era incompatible con cualquier CSP decente. Verificado en `file://`: estilos completos, diálogos de PrimeNG bien, cero violaciones |
| QA-12 | `@@index([pendingCatalogPush])` declarado en el schema y sin migración: la cola de catálogo escaneaba `Product` completo en cada barrido | Migración con su `CREATE INDEX`, más un **guardián** en `migrate.spec.mjs` que compara los `@@index` del schema contra los `CREATE INDEX` de todas las migraciones. Comprobado que falla al renombrar el índice: si vuelve a pasar, lo dice una prueba y no una auditoría |
| QA-13 | `electron/prisma/dev-tmp.sqlite` versionado (un esqueleto de `prisma migrate dev`, además desactualizado del schema) | Fuera del índice de git y en `.gitignore`, junto con cualquier `*.sqlite` de esa carpeta. El archivo local se conserva |

### QA-14, QA-15 y QA-16 (2026-09-07)

Los tres verificados en Electron con la cuenta `cashier` real, base SQLite temporal y el
proxy que bloquea toda escritura. 940 pruebas del POS y 235 de Electron.

| # | Era | Arreglo |
|---|-----|---------|
| QA-14 | Una venta cobrada cuyo turno todavía no subía **no se veía en ningún sitio**: `getPendingPush` la omitía también en las lecturas de UI, así que no salía en la barra de pendientes, no entraba en `countPending` y el aviso del corte decía "Quedan 1" con dos movimientos sin subir. Solo aparecía al agotar los seis intentos, ya bloqueada | Las lecturas de UI ahora la devuelven con `payload: null` y `esperandoPor: 'turno' \| 'catalogo'`; el push sigue omitiéndola (no se puede enviar) y el contador de intentos no cambió. La pantalla muestra el motivo en español ("Espera a que suba el turno"), y `flush$` filtra por si acaso las que no traen payload. Verificado punta a punta: el aviso del corte pasó de "Quedan 1" a **"Quedan 2"** con los mismos dos movimientos, y el indicador aparece en la barra |
| QA-15 | El campo de cantidad del ticket no tenía nombre accesible, y el de descuento decía "Desc." en todas las líneas: con lector de pantalla no se sabía de qué producto era el descuento que se teclea | `aria-label` por línea: "Cantidad de CINTA MICROPORO", "Descuento de CINTA MICROPORO" (verificado en vivo). La insignia de rechazados ya tenía `aria-label` correcto —ese hallazgo era falso—; lo que le faltaba era la palabra a la vista: era "⚠ 1" y ahora es "Rechazados 1", oculta bajo `sm` para no empujar la barra en una caja de 1024 px |
| QA-16 | El historial fallaba en silencio fuera de Electron: tabla vacía, "Actualizar" deshabilitado y el error solo en consola — indistinguible de "no hay ventas". La pantalla **sí** tenía manejo de error; `api()` lanzaba al construir el observable, así que la excepción salía fuera del stream y el `catchError` no la veía | `defer()` en `list`, `movements`, `create` y `void`: el fallo viaja por el canal de error y cada pantalla lo muestra. Y el mensaje quedó redactado para quien está en la caja, no para el desarrollador. Verificado en el navegador: sale un aviso con botón Reintentar |

### Auditoría de QA: los ocho que rompían dinero o acceso (2026-09-04)

Corregidos en el orden acordado, con prueba que falla sin el arreglo. Total tras la pasada:
936 tests del POS, 233 de Electron, 675 del backend.

| # | Era | Arreglo |
|---|-----|---------|
| 9 | DevTools abría la consola en producción: desde ahí se podía reescribir el rol en memoria y saltarse los permisos | `isDevToolsShortcut()` (F12, ⌘⌥I, Ctrl+Shift+I/J/C), `devtools-opened` que cierra por si algo más lo abre, y **menú propio** en producción — el de Electron trae "View → Toggle Developer Tools", así que bloquear el atajo no bastaba. Se conservan appMenu/Edición/Ventana: sin ellos macOS pierde ⌘Q/⌘C/⌘V y el cajero no puede ni pegar un código |
| 4 | `getPendingPush` escribía el contador de intentos dentro de una **consulta de lectura**, y esa consulta la llaman 14 sitios de UI: abrir una pantalla gastaba reintentos de las ventas en cola hasta agotarlas | Solo el push real pasa `contarIntentos: true`. Y `clearPushError` repone el contador: antes "Reintentar" no servía porque la venta se rebloqueaba en el push siguiente con el contador en el tope |
| 3 | Un `400` sobre el lote condenaba las hasta 200 ventas que iban en él: una venta mal formada arrastraba a las 40 buenas | Troceo en peticiones de 100 + **bisección**: si un lote se rechaza en bloque se parte en dos y se reintenta cada mitad hasta aislar la venta culpable |
| 6 | El filtro `sinHijosPendientes` existía, bien escrito, y **ningún llamador lo pasaba**: el cierre se subía dejando gastos del turno atrás | Activo en la pasada final. El conteo mira solo hijos **recuperables**: un gasto ya rechazado espera al admin, y si retuviera el cierre el turno quedaría abierto en el servidor para siempre y su corte nunca llegaría a la auditoría |
| 5 | El auto-cierre a las 24:00 inventaba un faltante: comparaba el efectivo contado contra el esperado **solo de farmacia**, ignorando el de servicios, aunque el cajón es uno | Cierra con la suma de ambos. El test que debía atraparlo no lo hacía porque el doble de `getLiveSummary` no definía `expectedServicesCashAmount`; con el campo puesto, el test viejo falló hasta corregir el código |
| 7 | En `/pos/efectivo` (pantalla de admin) el retiro se registraba **sin turno**: se preguntaba por el turno propio del admin, que no tiene ninguno abierto. El cajero cerraba con un faltante por dinero que autorizó otro | Canal nuevo `getOpenLocalAnyUser()`: el turno abierto **del equipo**, sea de quien sea. Y el aviso dice de quién es el turno al que se va a cargar (`openedByLabel`, que la fila tenía y el DTO no propagaba) |
| 1 | Bajar la cantidad de una línea dejaba el descuento del cajero por encima del tope del 20 % que el backend impone | **Recorta** al tope del rol y lo avisa, en vez de bloquear: el cajero tiene al cliente enfrente y lo cobrado debe ser lo que su rol autoriza. El 20 % quedó en una constante que refleja `MAX_NON_ADMIN_DISCOUNT_RATE` |
| 2 | Los servicios se retarifaban al sincronizar: una consulta de las 11:00 se rechazaba con "el monto recibido es menor al total" si el admin subía el precio a la 13:00, y quedaba bloqueada con el dinero ya en el cajón | La partida de servicio manda `unitPrice`, igual que la mercancía, y el backend respeta el precio cobrado anotando `catalogUnitPrice` si difiere. **Requiere desplegar el backend** para surtir efecto |

### Baseline

- Login Firebase + rol; shell tipo Eleventa (F1/F2/F3/F6/F9)
- Venta: búsqueda, ticket, descuentos por línea, pausar venta (`localStorage` por uid)
- Escáner USB (`Enter` por `sku`/`barcode`) y escaneo `N*código`
- Cobro efectivo (cambio, quick amounts) y tarjeta Point MP con polling
- Apertura / cierre de turno, entradas y salidas de efectivo
- Cola offline de ventas + badge de sync
- Anular última venta (solo admin) · tope de descuento 20% para no admin
- Empaquetado Electron (`electron:dist`) y auto-update (`electron-updater`)
- Cajón ESC/POS vía IPC, sonidos de escaneo, promos locales NxM / %
- Historial del día, ticket imprimible, corte de caja con desglose por método
- Alertas de caducidad + FEFO sin vencidos, sustitutos por principio activo
- Reportes locales (turno/día, por hora, top productos), etiqueta de producto imprimible
- Health check API + banner sin conexión / API caída

### Integración con el backend NestJS (2026-08-04)

| # | Cambio backend | Qué se hizo en el POS |
|---|----------------|-----------------------|
| B1 | **Pago mixto con reparto real** (`Sale.cashAmount` / `Sale.cardAmount`) | `shared/utils/tender.ts` replica `resolveTender` y es la única fuente del reparto (checkout + cola offline). El checkout captura **monto con tarjeta**, manda a la terminal solo esa parte y calcula cambio/faltante contra `total − cardAmount`. Confirmar mixto exige order aprobada **y** efectivo suficiente. `shared/utils/money.ts` compara en centavos. El ticket imprime `Tarjeta` / `Efectivo` |
| B2 | **`cashInDrawer` con `cashAmount`** | El corte toma `expectedCashAmount` del backend; los reportes locales suman "efectivo cobrado" con la misma regla (`cashAmount`, con fallback `recibido − cambio` para ventas viejas) |
| B3 | **`idempotencyKey`** | La llave se genera al abrir el cobro y se reusa en cada reintento; la cola offline la guarda como `queueId`. `flushQueue` va en serie (`concatMap`) y marca como bloqueadas las ventas con 4xx en vez de reintentar en vacío; se revisan/descartan desde la barra de venta |
| B4 | **Sesión expira a las 24:00 (America/Mexico_City)** | `shared/utils/session-expiry.ts` replica el corte; `AuthService` programa el cierre con mensaje explícito y el interceptor repite el mensaje real del 401. `CartStorageService` autoguarda el ticket por `uid` y lo restaura al reentrar |
| B5 | **Roles dinámicos con permisos** | `GET /auth/me` se parsea completo (`StaffProfile`: rol + permisos); `AuthService.can(area, level)` replica `hasPermission` (con el atajo de `admin`). El badge del shell usa `role.name` (la clave i18n `shell.role.*` rompía con `manager`), la venta se bloquea sin `sales:write` y el nav se filtra por permiso |
| B15 | **Grupos controlados I–VI** (`product.controlledGroup`, `CONTROLLED_GROUP_RULES`) | `shared/utils/controlled.ts` replica las reglas y `assertPrescriptionRules` (bloqueo en mostrador; el backend sigue siendo la autoridad). El checkout señala qué partida es controlada y su grupo, exige folio en I–III, casilla **"receta retenida"** obligatoria en I–III, y manda `prescriptionRetained`. Al agregar un controlado suena aviso con el grupo y si se retiene la receta. El ticket imprime folio de receta, retención y grupos |
| B16 | **Libro de control** (`GET /inventory/controlled-ledger`, `Sale.controlledGroups`) | Pantalla `/pos/libro-control` (solo lectura, imprimible): filtros por rango y grupo; renglones con folio, movimiento (venta/anulación/devolución), producto, grupo, cantidad con signo, lotes, receta (médico, cédula, folio, retenida) y paciente, más piezas netas. Nav gateado por `inventory:read`, el mismo permiso del endpoint |
| B17 | **Desglose de impuestos** (`SaleItem.taxes`, `Sale.taxSummary`) | `shared/utils/taxes.ts` replica el desglose de precios con impuestos incluidos (IEPS sobre base, IVA sobre base + IEPS, residuo a la base) y el prorrateo del descuento de venta. El checkout muestra base / IEPS / IVA / total antes de cobrar, el ticket imprime el desglose y la venta encolada offline lleva su propio `taxSummary` |
| B18 | **Cédula profesional validada** (7 u 8 dígitos) | Mismo patrón validado en el formulario antes de enviar (`isValidDoctorLicense`) |
| B19 | **Turno de caja local-first + ajuste asíncrono** (`CashSession`, `CashMovement`) | Abrir/cerrar turno y ver el efectivo esperado en vivo son 100% SQLite (sin red); el push (`POST /cash-sessions`, `/close`) es create-then-close con defensa anti-duplicado (`GET /cash-sessions/current`). El cierre siempre procede: si hay diferencia queda `adjustmentStatus: 'pending'`, revisable después por un admin (nunca bloquea al cajero). A las 24:00 el turno se auto-cierra sin diferencia (`autoClosedByExpiry`), enganchado a `AuthService.endExpiredSession()`. El logout pregunta si se cierra el turno antes de salir |
| B20 | **Módulo de gastos por turno** (`CashMovement.type: 'expense'`) | Pantalla `/pos/gastos`: monto + categoría (Sueldo, Comida, Renta, Imprevistos, Luz, Insumos, Proveedor, Otros) + descripción obligatoria en Insumos/Proveedor/Otros. Resta del efectivo esperado del turno, igual que un retiro |
| B21 | **Auditoría admin de cortes y gastos** (`/pos/cortes`, `/pos/gastos-auditoria`, y espejo en `farma-jyv-admin`) | Exclusiva de `admin` (`PermissionArea` `cashSessions`/`expenses` en el POS; segmentos `cortes-caja`/`gastos` en admin-web). Lista todas las cajas (no solo la de este equipo) y aprueba/rechaza el ajuste pendiente — la aprobación vive solo en el backend, el POS solo hace pull del estado |

Cobertura de las reglas replicadas: `tender.spec.ts`, `controlled.spec.ts`, `taxes.spec.ts`, `session-expiry.spec.ts`.

### Pasada de UX sobre lo anterior (2026-08-04)

- **Cobro en dos columnas** (58 rem): izquierda lo que se teclea en cada venta (total, método, efectivo/tarjeta), derecha cumplimiento y datos fiscales. Antes era una sola columna de 26 rem con scroll largo.
- **Teclado primero**: `F9` cobra desde cualquier campo del diálogo, `Enter` sobre el monto también, `Alt+1/2/3` cambia método (con Alt para no comerse los dígitos), `Esc` sale. El foco entra al campo que bloquea (receta si el grupo la exige, efectivo si no) y sigue al método elegido.
- **Nunca un botón deshabilitado sin motivo**: lista de bloqueos junto a "Confirmar" (`role="alert"`), en el orden en que el cajero los resuelve; `F9` inválido avisa el primero.
- **Progressive disclosure**: cliente y facturación plegados (la venta típica es público general); receta y avisos COFEPRIS siempre visibles cuando aplican — el cumplimiento no se esconde.
- **Atajos aislados por diálogo**: con un diálogo abierto, `Esc`/`Del`/`+`/`−`/`F2`/`F6`/`F9` de la pantalla de venta ya no se disparan. Antes `Esc` cerraba el cobro **y** vaciaba el ticket.
- **Ventas rechazadas**: diálogo con reintentar o descartar por venta, en vez de un `window.confirm` con todo el volcado.
- **Libro de control**: rangos rápidos (hoy / 7 / 30 días), resumen por grupo y pie con firmas de responsable sanitario y verificador en la hoja impresa.
- **Ticket**: leyenda "precios con impuestos incluidos" y nota de receta retenida (art. 226 LGS).
- **A11y**: `label`/`for` en todos los campos, `aria-live` en cambio/faltante y estado de terminal, `aria-expanded`/`aria-controls` en el panel plegable, `aria-pressed` en los rangos, iconos con `aria-hidden`.

---

## No-objetivos (por ahora)

- Reemplazar `farma-jyv-admin` (catálogo, compras, usuarios siguen en admin)
- Contabilidad completa / bancarización
- E-commerce / pedidos en línea
- SICAD COFEPRIS (reporte federal; el POS solo aporta trazabilidad interna)
- Consultorio / expediente clínico (módulo doctor del backend)

---

## Principios de producto (como los POS óptimos)

1. **Teclado primero** — escáner + F-keys; el mouse es opcional.
2. **Una pantalla = una venta** — ticket siempre visible; cobro en ≤ 2 pasos.
3. **Farmacia no es abarrotes** — lotes, caducidad y receta no son “nice to have”.
4. **Internet opcional para cobrar** — sync después; nunca bloquear la fila.
5. **Cumplimiento MX** — CFDI e IVA por producto cuando se facture; cortes auditables.
