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

### Por verificar (no es código)

- Catálogo real: que los productos traigan `controlledGroup` y banderas fiscales capturadas. Sin grupo, el POS cae al flag viejo `requiresPrescription` y **no** exige folio ni retención.
- Smoke test en Electron con TPV física: pago mixto punta a punta (tarjeta parcial + efectivo) y el corte resultante.

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
