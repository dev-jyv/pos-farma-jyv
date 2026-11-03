# Restaurar a mano una copia de la base de la caja

La caja guarda solita copias de su base de datos (SPEC 37). Este documento dice
dónde están y cómo volver a una de ellas cuando la base se perdió o se dañó. La
restauración **es manual a propósito**: decidir qué copia usar y qué hacer con
lo que ya se había subido es trabajo de una persona, no de la app.

## Qué copias existen

| Copia | Cuándo se hace | Dónde | Cuántas |
|---|---|---|---|
| De rutina, `corte-z` | Tras cada corte Z guardado en la caja | `Documentos/FarmaJyV/respaldos` | Las 7 más recientes (sumando `corte-z` y `cierre`) |
| De rutina, `cierre` | Al salir de la app (espera como mucho 5 s) | `Documentos/FarmaJyV/respaldos` | (las mismas 7) |
| Previa a migración | Al actualizar, si la versión nueva cambia la base | Junto a la base, en `backups/` | Las 5 más recientes |

Rutas concretas de `Documentos/FarmaJyV/respaldos`:

- Windows: `C:\Users\<usuario>\Documents\FarmaJyV\respaldos` (o la carpeta
  Documentos que tenga redirigida el equipo, p. ej. a OneDrive)
- macOS: `~/Documents/FarmaJyV/respaldos`

Una app de pruebas (`dev`, `emulator`) guarda las suyas aparte, en
`respaldos (dev)` / `respaldos (emulator)`, para no rotar las de la base real.

Los nombres llevan el motivo y la hora **UTC** (6 h más que la hora de la
farmacia): `farmajyv-pos-corte-z-2026-11-02T03-15-00-123Z.sqlite` es el corte
del 1 de noviembre a las 21:15 en Ciudad de México.

Un archivo que termina en `.sqlite.partial` es una copia que se cortó a la mitad
(la app se cerró antes de terminar): **no sirve**, ignóralo. La siguiente copia lo
borra.

Desde el panel (Cajas) se ve la fecha de la última copia de cada caja; si pasa de
48 h aparece marcada.

## Dónde está la base en uso

- Windows: `%APPDATA%\FarmaJyV Venta\farmajyv-pos.sqlite`
- macOS: `~/Library/Application Support/FarmaJyV Venta/farmajyv-pos.sqlite`

A su lado pueden existir `farmajyv-pos.sqlite-wal` y `farmajyv-pos.sqlite-shm`.
Son parte de la misma base mientras está abierta.

## Antes de restaurar

1. **Pregunta si de verdad hace falta.** Si la caja abre y vende, no se restaura:
   restaurar regresa la base al momento de la copia y lo posterior se pierde de
   esa caja.
2. **Anota qué hay en el servidor.** En el panel, revisa las ventas y turnos de esa
   caja desde la fecha de la copia que vas a usar. Ver "Después de restaurar".

## Pasos

1. **Cierra la app por completo.**
   - Windows: cierra la ventana y confirma en el Administrador de tareas que no
     quede ningún proceso "FarmaJyV Venta".
   - macOS: ⌘Q (cerrar la ventana no basta).

   Al salir, la app hace una copia `cierre` nueva. Si la base estaba dañada esa
   copia también lo estará: no la elijas.
2. **Elige la copia.** En `Documentos/FarmaJyV/respaldos`, normalmente la más
   reciente de **antes** del problema. Mira la fecha y el tamaño: una copia de
   pocos KB en una caja con historial es sospechosa.
3. **Aparta la base actual, no la borres.** En la carpeta de la base en uso,
   renombra `farmajyv-pos.sqlite` a `farmajyv-pos.sqlite.antes-de-restaurar`, y
   haz lo mismo con `farmajyv-pos.sqlite-wal` y `farmajyv-pos.sqlite-shm` si
   existen. **Que no se queden los `-wal`/`-shm` viejos**: SQLite intentaría
   aplicarlos sobre la copia y la dañaría.
4. **Copia** (no muevas) el respaldo elegido a esa misma carpeta y renómbralo
   exactamente `farmajyv-pos.sqlite`.
5. **Abre la app.** Al arrancar aplica las migraciones que falten (si la copia
   es de una versión anterior; antes de migrar hace su propia copia previa) e
   inicia sesión normal.
6. **Verifica** en el historial de ventas que aparezcan las ventas pendientes de
   subir que esperabas, y el turno en el estado en que estaba al hacer la copia
   (tras una copia `corte-z`, el turno ya cerrado).

Si algo sale mal, cierra la app, borra el `farmajyv-pos.sqlite` restaurado y
regresa los archivos `.antes-de-restaurar` a su nombre original.

## Después de restaurar: cuidado al sincronizar

La copia no sabe lo que se subió **después** de hacerla. Las ventas que en la
copia figuran como pendientes se reenvían con la misma llave de idempotencia, y
el servidor las reconoce como repetidas **solo durante 48 h**. Por eso:

- **Copia de menos de 2 días:** se puede pulsar Sincronizar; lo que ya estaba
  arriba no se duplica.
- **Copia de más de 2 días:** antes de sincronizar compara las ventas pendientes
  de la caja contra las que el panel ya tiene de esa caja. Si alguna ya está en el
  servidor, avisa al administrador antes de subir: se duplicaría.

Las ventas hechas después de la copia y que nunca llegaron al servidor se
perdieron con la base dañada; para ellas queda el corte impreso y los tickets.

## Privacidad

Las copias contienen ventas, clientes y recetas, igual que la base original y
con la misma protección (sin cifrar; la protege el cifrado de disco del equipo).
Si la carpeta Documentos del equipo se sincroniza con OneDrive o iCloud, las
copias suben a esa nube personal. En la instalación de cada caja se revisa
(ver `INSTALACION_CAJA.md`). Una copia restaurada no se manda por correo ni por
mensajería: se copia en el mismo equipo.
