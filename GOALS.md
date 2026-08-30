# Goals — FarmaJyV Venta (POS)

Objetivos del **punto de venta de escritorio** (Angular + Electron). Comparte API con `farma-jyv-admin` / `backend-farma-jyv`.

Referencias de mercado usadas para priorizar: **Eleventa**, **Pulpos**, **SICAR**, **Pharmastore**, y patrones de **Square / Toast** (UX de caja rápida). Criterios MX farmacia: lotes/caducidad, recetas, CFDI 4.0, corte de caja, operación con o sin internet.

---

## Objetivo principal

Operar la caja de FarmaJyV de punta a punta: escanear/buscar, ticket, cobro (efectivo / Point MP), turno de caja, con flujo tan rápido y claro como Eleventa, y con el cumplimiento mínimo de una farmacia mexicana.

---

## Pendiente

Todo lo que sigue **no** está en el POS. Lo marcado `B*` ya existe en la API (`backend-farma-jyv`): es deuda de integración, no diseño nuevo.

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
- Prueba con un rol **sin** `sales:write` y sin `inventory:read`: toda la auditoría corrió como `admin`. Las ramas por rol (bloqueo de venta, ausencia del botón de anular, tope de descuento del 20 %) se leyeron en código pero no se ejercitaron con credenciales reales.
- Rango de fechas del libro contra el backend (AUD-48): con el libro real vacío no se pudo medir el corrimiento. Requiere leer el parseo en `backend-farma-jyv` o un entorno con datos.

---

## Hecho

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
