# Instalar FarmaJyV Venta en una caja nueva

Guía para poner en marcha el punto de venta en el equipo de una farmacia. No es
para desarrollar: aquí se **instala la aplicación ya compilada**.

Para preparar una máquina de desarrollo, ver [`SETUP.md`](SETUP.md).

---

## Antes de ir a la farmacia

Tres cosas tienen que estar listas **antes** de tocar el equipo de la caja, y
dos de ellas se resuelven desde una máquina de desarrollo.

### 1. El usuario del cajero

Créalo en el panel de administración (**Usuarios**) con rol **Cajero**. Sin un
rol válido no hay sesión utilizable: la app deja entrar pero no deja vender.

Anota el correo y la contraseña temporal; se entregan en la caja.

### 2. El nombre de la impresora, si va a haber cajón de dinero

Esto es lo que más retrasa una instalación, porque **no se puede cambiar en la
caja**: el nombre de la impresora vive en `src/environments/environment.electron.ts`
(`cashDrawer.printerName`) y se compila dentro de la app.

Hoy está vacío, así que **el cajón no se abre solo**. Si esta caja lleva cajón:

1. Conecta la impresora térmica al equipo de la farmacia.
2. Averigua su nombre exacto en el sistema:
   - macOS: `lpstat -p` — o Ajustes › Impresoras
   - Windows: Panel de control › Dispositivos e impresoras
3. Ponlo en `cashDrawer.printerName` y **vuelve a compilar** (paso 3).

El pulso se manda como comando ESC/POS: en macOS con `lp -d <impresora> -o raw`,
en Windows copiando el archivo al recurso de impresión.

### 3. Compilar el instalador

Desde una máquina de desarrollo, con el repo al día:

```bash
cd farma-jyv-pos
npm run electron:dist:mac     # genera .dmg y .zip para Intel y Apple Silicon
npm run electron:dist:win     # genera el instalador .exe
```

Los archivos quedan en `release/`. Para una caja nueva usa el **`.dmg`** (macOS)
o el **`-setup.exe`** (Windows).

---

## Instalar en el equipo de la caja

### macOS

1. Copia el `.dmg` al equipo (USB o descarga).
2. Ábrelo y arrastra **FarmaJyV Venta** a Aplicaciones.
3. **La primera vez macOS se va a negar a abrirla.** La app no está firmada con
   un certificado de Apple (`identity: null` en la configuración de compilación),
   así que Gatekeeper la bloquea con un aviso de desarrollador no identificado.
   Para autorizarla:

   - Clic derecho sobre la app › **Abrir** › **Abrir** en el diálogo.
   - Si no aparece la opción: Ajustes del Sistema › Privacidad y seguridad ›
     botón **Abrir de todos modos**.

   Solo hace falta la primera vez.

### Windows

1. Copia el `FarmaJyV Venta-<versión>-setup.exe`.
2. **SmartScreen va a advertir** por el mismo motivo: el instalador no está
   firmado. Pulsa **Más información** › **Ejecutar de todas formas**.
3. Sigue el instalador. Permite elegir carpeta de instalación.

---

## Primer arranque

1. **Inicia sesión** con el usuario del cajero.
2. **Espera la sincronización inicial.** Al entrar, la app descarga el catálogo
   completo y muestra un modal. En una farmacia con miles de productos tarda;
   déjala terminar antes de seguir. A partir de ahí el catálogo vive en el
   equipo y la venta ya no depende de internet.
3. **Abre el turno de caja** con el efectivo con el que arranca el cajón.
   Sin turno abierto no se puede vender.
4. **Haz una venta de prueba** de un producto barato y anúlala después. Con eso
   compruebas de una vez la búsqueda, el cobro, el ticket y —si hay cajón— que
   el cajón abre.

Comprueba también que arriba a la derecha no haya una cinta roja de "sin
conexión" y que el botón **Sincronizar** no muestre el punto ámbar de
pendientes.

---

## Cómo se actualiza después

No hay que reinstalar. La app consulta al arrancar el feed de actualizaciones en
`https://farma-jyv-updates.web.app`, descarga la versión nueva en segundo plano
y **la instala al cerrar la aplicación**. En la práctica: la caja se actualiza
sola de un día para otro.

Para publicar una versión nueva, desde desarrollo:

```bash
npm run release:mac     # compila, prepara dist-updates/ y despliega a Hosting
npm run release:win
```

Sube el número de versión en `package.json` antes; el actualizador compara
versiones y sin el incremento no ofrece nada.

---

## Lo que hay que saber de esta caja

**La base de datos es local y es única de este equipo.** Ventas, turnos,
movimientos y el catálogo viven en un SQLite dentro del equipo:

- macOS: `~/Library/Application Support/FarmaJyV Venta/farmajyv-pos.sqlite`
- Windows: `%APPDATA%\FarmaJyV Venta\farmajyv-pos.sqlite`

Se crea sola en el primer arranque, con sus migraciones. No hay nada que
preparar a mano.

**Consecuencia práctica:** si se reemplaza el equipo o se reinstala el sistema,
lo que no se haya sincronizado se pierde. Antes de retirar una caja de
servicio, entra, pulsa **Sincronizar** y confirma que no queden pendientes.

**Cerrar sesión y cerrar la app avisan** si queda algo sin subir, e intentan
subirlo antes de salir. Aun así, la costumbre de sincronizar al terminar el
turno es la que evita sustos.

**La caja sigue vendiendo sin internet.** Las ventas se acumulan y suben cuando
vuelve la red, en los horarios automáticos (10:30, 14:00 y 20:00), al iniciar
sesión, o al pulsar Sincronizar.

---

## Qué NO está activo hoy

Vienen desactivados en la compilación de producción. Si se necesitan, se
cambian en `environment.electron.ts` y se vuelve a compilar:

| Función | Bandera | Estado |
|---|---|---|
| Terminal Mercado Pago Point | `mercadoPago.terminalEnabled` | **Apagada.** El cobro con tarjeta se registra, pero no se manda nada a la terminal |
| Cobro directo (sin venta) | `directChargeEnabled` | Apagado; la pantalla existe pero no aparece en el menú |
| Imprimir ticket automático al cobrar | `printTicketOnSale` | Apagado; se imprime a mano desde el historial |
| Cajón de dinero | `cashDrawer.printerName` | Vacío: no se abre |

Los datos de la farmacia que salen en el ticket (`pharmacy.name`, dirección,
teléfono, RFC) también están ahí, y hoy solo tienen el nombre.

---

## Si algo falla

**"Correo o contraseña incorrectos"** con datos correctos: el usuario existe en
Firebase pero le falta el rol. Revísalo en el panel, en Usuarios.

**Entra pero no deja vender:** falta abrir el turno de caja, o el usuario quedó
con un rol que no es Cajero.

**Cinta roja permanente arriba:** el equipo no alcanza la API. Revisa la red y
que no haya un filtro bloqueando `api-vykfsskx3q-uc.a.run.app`.

**El cajón no abre:** lo esperado hoy, porque `printerName` está vacío. Ver el
paso 2 de la preparación.

**Un número en rojo junto a Sincronizar:** el servidor rechazó registros. No es
falta de red: hay que abrirlo y resolver cada uno. Puede haber una venta cobrada
que no llegó al servidor.
