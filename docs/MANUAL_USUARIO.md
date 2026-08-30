# Manual de usuario — FarmaJyV Venta

Guía de caja para el punto de venta de FarmaJyV. Está escrita en el orden del día: entrar, abrir turno, vender, cobrar, cerrar.

---

## 1. Antes de empezar

Necesitas:

- El equipo con **FarmaJyV Venta** instalado.
- Tu **correo y contraseña** (los da el administrador; son los mismos del sistema de administración).
- Lector de código de barras USB conectado (funciona como teclado: lee el código y da Enter solo).
- Impresora de tickets y, si la caja lo tiene, cajón de dinero conectado a la impresora.

### Iniciar sesión

Escribe tu correo y contraseña y presiona **Entrar**.

Si el mensaje dice *"Correo o contraseña incorrectos"*, revisa el correo completo y las mayúsculas. Si estás seguro de tus datos y sigue fallando, avisa al administrador: puede que tu usuario no tenga rol asignado.

> **Tu sesión termina a las 12:00 de la noche**, no a las 24 horas de haber entrado. Es normal: vuelve a iniciar sesión. **El ticket que estabas armando se guarda solo** y aparece de nuevo al entrar.

### La barra de arriba

De izquierda a derecha: el logo, los accesos a las pantallas, y a la derecha tu rol, tu correo y **Cerrar sesión**. La pestaña en la que estás se marca en verde y con una línea debajo.

**No todos ven lo mismo.** La barra solo muestra lo que tu rol puede abrir:

| Rol | Ve |
|---|---|
| Cajero | **Venta (F1)**, **Historial (F3)** y **Entrada de stock**. Cobra, consulta y recibe mercancía, pero **no anula**: eso es del administrador |
| Gerente | Lo anterior más **Cobro directo** y **Libro de control** |
| Administrador | Todo, incluidos **Reportes** |

Si escribes a mano la dirección de una pantalla que no te toca, el sistema te devuelve a Venta con el aviso *"Tu rol no tiene acceso a esta pantalla"*. No es una falla: es el permiso.

Si aparece una franja de color debajo:

| Franja | Significa | Qué hacer |
|---|---|---|
| Roja: *Sin conexión a internet* | El equipo perdió la red | Puedes seguir vendiendo. Las ventas se guardan y se envían al reconectar |
| Ámbar: *El servidor no responde* | Hay internet pero el sistema central no contesta | Puedes seguir vendiendo. Avisa al administrador |

---

## 2. Abrir el turno de caja

**No se puede vender sin turno abierto.** Al entrar a la pantalla de venta, si no hay turno el sistema abre solo la ventana **Abrir turno de caja**.

1. Cuenta el efectivo con el que arrancas (el fondo).
2. Escríbelo en **Monto inicial en caja**.
3. Presiona **Abrir turno**.

Esa ventana no se cierra con Esc ni haciendo clic afuera, a propósito: sin turno el resto de la caja no sirve.

---

## 3. Vender

La pantalla se divide en dos: a la izquierda buscas productos, a la derecha se arma el **Ticket**.

### 3.1 Agregar productos

**Con lector (lo normal).** Pasa el código. El producto entra al ticket y suena un pitido corto de confirmación.

**Varias piezas del mismo producto.** Escribe la cantidad, un asterisco y el código, y presiona Enter:

```
3*7501234567890
```

Entran 3 piezas de una sola vez (máximo 999).

**Buscando a mano.** Presiona **F2** para ir al buscador y escribe nombre, principio activo o SKU. Aparece la lista con precio y stock. Haz clic en el renglón, o en el botón verde **+**, para agregarlo. Si escribes y presionas Enter y hay **un solo** resultado, ese se agrega directo.

La lista muestra el nombre, el principio activo y la concentración en verde, el código abajo, y el stock con color: rojo si es 0, ámbar si quedan 5 o menos.

### 3.2 Sonidos: qué te está diciendo la caja

| Sonido | Significa |
|---|---|
| Pitido corto agudo | Producto agregado correctamente |
| Tono medio de aviso | Ojo: caducidad próxima, o es un medicamento controlado |
| Tono grave largo | Error: no se encontró, no hay stock, o el stock está vencido |

Si oyes el tono grave, **lee el mensaje en pantalla antes de seguir escaneando.**

### 3.3 Avisos al agregar

**Caducidad próxima.** Si el lote que se va a vender caduca en 30 días o menos, aparece el lote, la fecha y los días que faltan. La venta se permite; tú decides si conviene entregar ese lote. El sistema siempre asigna primero el lote **más próximo a caducar** y nunca uno vencido.

**Sin stock o stock vencido.** Se abre la ventana **Sustitutos disponibles** con otros productos del mismo principio activo que sí tienen stock. Elige uno con el botón **+** o cierra la ventana.

**Medicamento controlado.** Suena aviso y el mensaje dice el grupo y si la receta se queda en la farmacia. **Pide la receta en ese momento**, con el paciente enfrente — no al momento de cobrar. Ver la sección 5.

### 3.4 Ajustar el ticket

| Acción | Cómo |
|---|---|
| Subir o bajar cantidad | Botones **−** / **+** del renglón, o teclas **+** / **−** para la última línea agregada |
| Escribir la cantidad | **F4** salta al campo de cantidad de la última línea |
| Descuento en un renglón | Campo **Desc.** del renglón (en pesos) |
| Quitar un renglón | Icono de bote de basura, o **Del** para la última línea |
| Vaciar todo el ticket | **Esc**, o el botón **Vaciar** — pide confirmación |

Notas:

- No puedes pasar del stock disponible: el sistema avisa y no sube la cantidad.
- Quitar un renglón con **más de 5 piezas** pide confirmación.
- Un renglón con **Promo** en ámbar ya trae descuento automático aplicado; lo que escribas en **Desc.** se suma a ese.
- **Descuentos mayores al 20 % solo los puede aplicar un administrador.** Si no lo eres, el sistema rechaza el cambio y avisa.

### 3.5 Pausar una venta

Si el cliente se va por algo más y hay fila detrás, presiona **F6** o el botón **Pausar**. El ticket se guarda con su hora y aparece como botón ámbar en la barra de arriba. Para retomarlo, haz clic en ese botón.

**El ticket actual debe estar vacío para retomar uno en pausa.** Puedes tener varios en pausa a la vez.

### 3.6 Imprimir etiqueta de precio

En cualquier renglón de la lista de búsqueda, el icono de etiqueta imprime la etiqueta del producto.

---

## 4. Cobrar

Presiona **F9** o el botón verde **Cobrar**. Se abre la ventana de cobro con el total grande arriba.

### 4.1 Efectivo

1. Escribe lo que te dio el cliente en **Efectivo recibido**.
2. Los botones **+10 / +20 / +50 / +100 / +200** suman al monto; **Exacto** pone justo el total.
3. Debajo aparece **Cambio** en verde, o **Faltan** en ámbar si no alcanza.
4. Presiona **F9**, **Enter** sobre el monto, o el botón **Confirmar**.

El cajón se abre solo al confirmar.

### 4.2 Tarjeta (terminal Mercado Pago Point)

1. Elige **Tarjeta** (o **Alt+2**).
2. Selecciona la terminal en la lista. Si no aparece ninguna, presiona **Actualizar**; si dice que no hay terminales vinculadas, revisa que la Point esté encendida y en modo PDV.
3. Si el botón **Activar PDV** aparece, presiónalo: la terminal estaba en modo independiente.
4. Presiona **Enviar $… a la terminal**.
5. Sigue el estado en pantalla:

| Mensaje | Qué pasa |
|---|---|
| Esperando terminal… | El cobro va en camino |
| Inserte o pase la tarjeta en la terminal… | Pásale la terminal al cliente |
| Confirma la operación en la terminal… | Falta un toque en la terminal |
| **Pago aprobado** | Listo, ya puedes confirmar |
| Pago cancelado en terminal / El cobro expiró / Error en el cobro | No se cobró; usa **Reintentar** |

Debajo del mensaje verás **Vence en 14:32**: el cobro enviado a la terminal dura **15 minutos**. Si se agota, la terminal deja de aceptarlo y hay que reintentar. Ese contador es la diferencia entre "la terminal se colgó" y "el cobro caducó".

6. Con el pago aprobado, presiona **Confirmar**.

**Cancelar un cobro en curso**: botón **Cancelar cobro en terminal**. Solo aparece mientras la operación está viva y sin aprobar.

> Si el mensaje dice *"cancélalo desde la terminal"*, no es un error del sistema: Mercado Pago **solo** deja cancelar desde la caja mientras el cobro va en camino. Una vez que la terminal lo tomó, la cancelación se hace en la terminal. Hasta que eso pase, el cobro sigue apareciendo en pantalla a propósito —olvidarlo dejaría un cobro vivo que podría cobrarse después.

### 4.3 Pago mixto (parte tarjeta, parte efectivo)

1. Elige **Mixto** (o **Alt+3**). Arranca partido a la mitad.
2. Escribe cuánto va **con tarjeta** en **Monto con tarjeta**. Debajo se actualiza **A cobrar en efectivo**.
3. Manda ese monto a la terminal y espera **Pago aprobado**.
4. Captura el efectivo que te dio el cliente. **El cambio se calcula solo contra la parte en efectivo**, nunca contra el total.
5. **Confirmar**.

Reglas importantes:

- El monto con tarjeta debe ser **mayor a cero y menor al total**. Si cubre todo, registra la venta como Tarjeta.
- Mientras el cobro con tarjeta está en curso o aprobado, el monto con tarjeta queda **fijo**. Si la terminal falla, se libera para reintentar con otro reparto.
- No se puede cambiar de método con un cobro **ya aprobado**: primero termina la venta o cancela el cobro.
- Se necesitan **las dos cosas**: tarjeta aprobada y efectivo suficiente.

### 4.4 Si el botón Confirmar está apagado

Debajo del botón aparece **la lista de lo que falta**, en el orden en que conviene resolverlo. Presionar **F9** sin poder cobrar te dice el primer pendiente. Los más comunes:

- *Esta venta incluye Grupo … y requiere datos de receta médica.*
- *La cédula profesional debe tener 7 u 8 dígitos.*
- *Los medicamentos de los grupos I a III requieren el folio de la receta.*
- *Los grupos I a III exigen retener la receta: confirma la retención.*
- *Falta que la terminal apruebe el cobro con tarjeta.*
- *Falta efectivo: $…*
- *Para facturar se requiere RFC (12–13 caracteres) y razón social.*

### 4.5 Atajos dentro del cobro

| Tecla | Acción |
|---|---|
| **F9** | Cobrar, desde cualquier campo |
| **Enter** | Cobrar (estando en el monto) |
| **Alt+1 / Alt+2 / Alt+3** | Efectivo / Tarjeta / Mixto |
| **Esc** | Salir del cobro (el ticket **no** se pierde) |

---

## 5. Medicamentos controlados (COFEPRIS)

El sistema aplica las reglas del artículo 226 de la Ley General de Salud según el grupo del medicamento:

| Grupo | ¿Receta? | ¿Folio obligatorio? | ¿La receta se queda? | ¿Va al libro de control? |
|---|---|---|---|---|
| **I** estupefacientes | Sí | Sí | **Sí** | Sí |
| **II** psicotrópicos | Sí | Sí | **Sí** | Sí |
| **III** psicotrópicos de menor riesgo | Sí | Sí | **Sí** | Sí |
| **IV** antibióticos y otros de receta | Sí | No | No — se sella y se devuelve | Sí |
| **V** venta en farmacia sin receta | No | No | No | No |
| **VI** venta libre | No | No | No | No |

En la ventana de cobro, la columna derecha muestra un aviso ámbar con **qué producto** es controlado y **de qué grupo**, y los campos de receta:

- **Médico** — nombre completo. Obligatorio si el grupo pide receta.
- **Cédula profesional** — 7 u 8 dígitos, solo números.
- **Folio de receta** — dice *Obligatorio* u *Opcional* según el grupo.
- **Confirmo que la receta se retuvo en la farmacia** — solo aparece en grupos I a III, y es obligatorio marcarla.

Puedes capturar los datos de la receta aunque el grupo no la exija: queda registrado.

Todo esto se imprime en el ticket y queda en el **Libro de control**.

---

## 6. Terminar la venta

Al confirmar aparece *"Venta … registrada"* y el ticket se imprime automáticamente. En la parte baja del panel derecho queda el folio con:

- **Imprimir ticket** — reimprime.
- **Anular venta** — **solo administradores**, para la última venta.

### Ventas sin conexión

Si no hay red al confirmar, la venta se guarda en el equipo y el folio dice **PENDIENTE-…**. El ticket se imprime igual. En la barra de arriba aparece un contador ámbar: *N pendiente(s) de sync*. Cuando vuelve el internet se envían solas, en orden, y el contador baja.

**Si aparece un botón rojo: *N venta(s) rechazada(s) al sincronizar*** — el sistema central no aceptó esas ventas. Haz clic para verlas: cada una muestra el motivo (turno cerrado, sin stock, cobro ya usado).

- **Reintentar** — después de corregir la causa. No duplica la venta.
- **Descartar** — solo si esa venta definitivamente no debe registrarse. Pide confirmación porque el dinero ya se cobró.

Si no sabes qué hacer, **no descartes**: avisa al administrador.

---

## 6 bis. Cobro directo (cobrar sin venta)

Pantalla **Cobro directo** de la barra de arriba. Es para el dinero que entra por Mercado Pago **sin** que haya productos de por medio: un servicio (aplicación de inyección, toma de presión), un abono, un cobro a un tercero.

> **Estos cobros van aparte.** No generan ticket de venta, no descuentan inventario y **no aparecen en el corte de caja ni en los reportes de ventas**. Quedan en su propia lista, con su propio folio (`CD-000001`). Si lo que cobras sí lleva productos, es una venta normal, no un cobro directo.

Elige monto y **concepto** (obligatorio, mínimo 3 caracteres: es lo único que explicará ese cobro dentro de tres meses) y luego la pestaña:

### Terminal

1. Revisa que la terminal seleccionada sea la de tu caja.
2. **Enviar cobro** (o **F9**).
3. Pásale la terminal al cliente y espera **Aprobado**.

Mientras el cobro está en curso puedes **Cancelar cobro**. Igual que en la venta: si la terminal ya lo tomó, la cancelación se hace en la terminal.

### Link de pago

1. **Enviar cobro**. El sistema genera un link de Mercado Pago y su **código QR**.
2. El cliente escanea el QR con su teléfono, o le compartes el link con **Copiar link** (WhatsApp, correo).
3. La pantalla se queda esperando: cuando el cliente paga, el estado cambia a **Aprobado** solo.

**El link vence en 30 minutos.** La hora exacta aparece debajo del QR. Vencido, hay que generar uno nuevo.

### Reglas

- No puedes cambiar de pestaña con un cobro en curso: primero espera a que se resuelva o cancélalo.
- Un cobro **aprobado** ya no se cancela desde aquí. Devolver ese dinero es un reembolso y hoy se hace desde Mercado Pago; avisa al administrador.
- Abajo tienes los **cobros recientes** con folio, fecha, concepto, canal, monto y estado.

---

## 6 ter. Entrada de stock (recibir mercancía)

Pantalla **Entrada de stock** de la barra de arriba. Sirve para meter al sistema la mercancía que acaba de llegar, con su factura enfrente.

> **Necesitas la factura ya dada de alta.** Subir el PDF y registrar la factura se hace desde el panel de administración; aquí solo se elige de la lista.

### Paso a paso

1. **Elige la factura** en el selector: muestra las últimas 10 con su proveedor y total.
2. **Busca el producto** por SKU, nombre comercial o principio activo (mínimo 2 letras).
   - **Si aparece**, haz clic: se llenan todos sus datos y ves su stock actual.
   - **Si no aparece**, presiona **Dar de alta** y captura el producto nuevo: nombre, SKU, código de barras, principio activo, concentración, categoría, unidad, precio de venta, stock mínimo, grupo COFEPRIS e impuestos.
3. **Captura el lote**: número de lote, caducidad, cuántas piezas entran y, si lo tienes a la mano, el costo unitario.
4. Revisa el resumen **12 → 36** (stock actual → como queda) y presiona **Guardar entrada** o **F9**.

Al guardar, la factura **se queda seleccionada**: una factura suele traer varios productos y se capturan uno tras otro.

### Reglas

- **Lote y caducidad son obligatorios.** De ellos dependen el orden de salida (primero lo que caduca antes) y el aviso de caducidad próxima al vender. Sin ellos, esa mercancía no se puede vender bien.
- **No se recibe mercancía vencida**: si la caducidad ya pasó, el sistema no deja guardar.
- Si el producto ya existía y **cambias algún dato** (precio, categoría, impuestos), ese cambio **se guarda en el catálogo**. Los cambios de precio quedan registrados con tu usuario.
- Las piezas se **suman** al stock que ya había; nunca lo reemplazan.

---

## 7. Movimientos de caja (solo administradores)

Botón **Movimiento de caja** en la barra de arriba. Sirve para dejar registrado el efectivo que entra o sale sin ser una venta:

- **Depósito / fondo** — se agrega efectivo a la caja.
- **Retiro** — se saca efectivo (por ejemplo, a la caja fuerte).
- **Gasto** — se paga algo desde la caja.

Monto y motivo son obligatorios. Todo aparece en el corte al cerrar el turno.

---

## 8. Cerrar el turno (corte de caja)

Botón **Cerrar turno** en la barra de arriba.

1. Revisa el resumen: ventas, anuladas, total por método de pago, depósitos, retiros y gastos.
2. Compara **Fondo inicial** y **Efectivo esperado** con lo que hay en el cajón.
3. Cuenta el efectivo real y escríbelo en **Efectivo contado**. El campo viene precargado con el esperado — **cámbialo por lo que realmente contaste.**
4. La **Diferencia** se muestra en vivo: verde si es cero, ámbar si sobra o falta.
5. Presiona **Cerrar turno**.
6. Presiona **Imprimir corte** y luego **Listo**.

Después de cerrar no se puede vender hasta abrir un turno nuevo. Antes de cerrar, revisa que **no queden ventas pendientes de sincronizar** — se envían con el turno al que pertenecen.

---

## 9. Historial (F3)

Ventas del turno actual, o del día si no hay turno abierto.

- **Buscar** por folio o por nombre de producto.
- Clic en un renglón para ver el detalle con el ticket completo.
- **Imprimir** para reimprimir.
- **Anular** — solo administradores, con confirmación. Una venta anulada queda marcada como *Anulada*, no desaparece.
- *Por facturar* marca las ventas donde el cliente pidió factura.

---

## 10. Reportes

Elige el alcance: **Turno actual** o **Día**. Muestra:

- Venta neta, número de ventas y cuántas se anularon.
- Ticket promedio y total de descuentos.
- Desglose por método de pago.
- Ventas por hora, con barra para ver las horas pico.
- Top 10 de productos por cantidad y por importe.

**Imprimir** genera la hoja del reporte. Las ventas anuladas no cuentan en los totales.

---

## 11. Libro de control

Registro de todos los movimientos de medicamentos de los grupos I a IV. Es **lo que se muestra en una visita de verificación de COFEPRIS**, y por eso se consulta desde la caja.

- Rangos rápidos: **Hoy**, **7 días**, **30 días**, o captura las fechas.
- Filtro por grupo.
- Cada renglón: folio, tipo de movimiento (Venta / Anulación / Devolución), producto, grupo, cantidad **con signo** (negativa cuando el producto regresa), lotes, datos de la receta y paciente.
- **Resumen por grupo** y **piezas netas** al pie.
- **Imprimir** genera la hoja con espacio para las firmas del responsable sanitario y del verificador.

Es solo de lectura: los renglones los escribe el sistema al registrar cada venta, anulación o devolución. Si tu usuario no tiene permiso de inventario, la pantalla no aparece en el menú.

---

## 12. Facturación

En la ventana de cobro, abre **Cliente y facturación** y marca **Facturar (timbrado posterior)**. Captura:

- **RFC receptor** (12 o 13 caracteres)
- **Razón social**
- **Uso del CFDI**: G03 gastos en general, D01 honorarios médicos, S01 sin efectos fiscales
- **Correo** (opcional)

> **La factura no se emite en la caja.** La venta queda marcada *Por facturar* y el timbrado se hace después, desde administración. No prometas al cliente la factura en el momento.

También puedes ligar un **cliente**: búscalo por nombre o RFC, o usa **+ Cliente nuevo** para darlo de alta con nombre y RFC. Si el cliente ya tiene RFC guardado, se copia solo a los datos de factura. Si no capturas cliente, la venta queda a público general.

---

## 13. Todos los atajos

**Pantalla de venta**

| Tecla | Acción |
|---|---|
| **F1** | Ir a Venta |
| **F2** | Ir al buscador |
| **F3** | Ir a Historial |
| **F4** | Escribir cantidad de la última línea |
| **F6** | Pausar la venta |
| **F9** | Cobrar |
| **Del** / **Backspace** | Quitar la última línea |
| **+** / **−** | Subir o bajar la cantidad de la última línea |
| **Esc** | Limpiar la búsqueda; si está vacía, vaciar el ticket |
| **Enter** en el buscador | Agregar el producto escaneado o el único resultado |
| `N*código` + Enter | Agregar N piezas |

**Ventana de cobro**

| Tecla | Acción |
|---|---|
| **F9** o **Enter** | Confirmar el cobro |
| **Alt+1 / 2 / 3** | Efectivo / Tarjeta / Mixto |
| **Esc** | Salir sin cobrar |

**Pantalla de cobro directo**

| Tecla | Acción |
|---|---|
| **F9** | Enviar el cobro (a la terminal o generar el link) |

**Pantalla de entrada de stock**

| Tecla | Acción |
|---|---|
| **F9** | Guardar la entrada |

Con una ventana abierta, los atajos de la pantalla de venta **no** se disparan: Esc solo cierra la ventana.

---

## 14. Problemas frecuentes

| Situación | Qué hacer |
|---|---|
| *"Abre un turno de caja antes de vender"* | Abre el turno con el monto inicial |
| *"Tu rol no tiene permiso para registrar ventas"* | Tu usuario es de solo consulta. Avisa al administrador |
| El buscador está deshabilitado | No hay turno abierto |
| *"Producto no encontrado"* | Código mal leído, o el producto no está en el catálogo. Búscalo por nombre |
| *"Hay varios resultados: elige uno de la lista"* | El código coincide con más de un producto; elige del listado |
| *"Sin stock suficiente para agregar otra unidad"* | El sistema no vende más de lo que hay, ni lotes vencidos |
| *"El stock disponible está vencido"* | Todo el stock caducó. Usa un sustituto y avisa a inventario |
| *"Guarda o termina la venta actual antes de retomar otra"* | Cobra o pausa el ticket actual antes de retomar el pausado |
| *"Descuento mayor a 20% requiere autorización de un administrador"* | Pide autorización |
| No aparece ninguna terminal | Point apagada, en otra cuenta, o fuera de modo PDV. Presiona **Actualizar** |
| *"La terminal ya aprobó el cobro…"* al cambiar método | El dinero ya se cobró. Termina la venta o cancela el cobro en la terminal |
| *"…cancélalo desde la terminal"* | Mercado Pago no deja cancelar desde la caja un cobro que la terminal ya tomó. Cancélalo en la terminal; el cobro sigue en pantalla hasta que se resuelva |
| *"Mercado Pago no respondió a tiempo…"* | Se cortó la comunicación. **Verifica en la terminal si cobró o no antes de reintentar** |
| *"Mercado Pago rechazó las credenciales del comercio"* | No es un error tuyo ni del cliente: es configuración. Avisa al administrador |
| El contador *Vence en …* llegó a 0 | El cobro caducó en la terminal (dura 15 min). Usa **Reintentar** |
| El cobro directo no aparece en el corte | Es correcto: los cobros directos van en su propia lista, nunca en el corte ni en los reportes de ventas |
| El QR del link no lo lee el teléfono | Usa **Copiar link** y compártelo por WhatsApp o correo |
| *"No hay facturas registradas"* al recibir mercancía | La factura se da de alta primero en el panel de administración |
| *"La caducidad no puede estar en el pasado"* | No se recibe mercancía vencida. Verifica la fecha del empaque |
| *"El SKU ya existe"* al dar de alta un producto | Ese código ya está en el catálogo: búscalo en vez de crearlo |
| El cajón no se abre | Solo funciona en la app de escritorio y con la impresora configurada. Avisa al administrador |
| *Sesión expirada* a media jornada | Normal después de medianoche. Vuelve a entrar; el ticket se recupera |
| El ticket no se imprimió | Reimprime desde el folio en el panel derecho, o desde **Historial** |

---

## 15. Buenas prácticas de caja

1. **Cuenta el fondo antes de abrir el turno.** El corte al final se compara contra ese número.
2. **Pide la receta cuando suena el aviso**, no al cobrar.
3. **Escribe el efectivo contado real** al cerrar, no el esperado. Una diferencia registrada es información; una diferencia oculta es un problema.
4. **No descartes ventas rechazadas por tu cuenta.** Ese dinero ya entró.
5. **Antes de cerrar el turno**, verifica que no queden pendientes de sincronizar.
6. **Sin internet se puede seguir vendiendo.** No detengas la fila.
7. **Usa el teclado.** F2 buscar, escanear, F9 cobrar, teclear, Enter. El mouse es opcional.
8. **Escribe conceptos claros en los cobros directos.** "Servicio" no dice nada dentro de un mes; "Aplicación de inyección — Sra. Ramírez" sí.
