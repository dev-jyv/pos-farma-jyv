# Preparar una Mac nueva para desarrollar FarmaJyV

Guía para dejar una Mac lista para trabajar en los tres repos del sistema:

| Repo | Qué es |
|---|---|
| `pos-farma-jyv` | Punto de venta de escritorio (Angular 22 + Electron, SQLite local) |
| `backend-farma-jyv` | API en Cloud Functions (NestJS + Firestore) |
| `farma-jyv-admin` | Panel de administración (Angular 21, Firebase Hosting) |

Tiempo aproximado: 40 minutos, casi todo esperando descargas.

---

## 1. Herramientas de línea de comandos de Xcode

```bash
xcode-select --install
```

Acepta la ventana y espera a que termine. **Sin esto nada más funciona**: los módulos nativos (el motor de Prisma, `better-sqlite3`) se compilan al instalar dependencias, y `electron-builder` no puede empaquetar la app.

Verifica: `xcode-select -p` debe imprimir una ruta.

## 2. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

En Apple Silicon queda en `/opt/homebrew` y **no entra solo al PATH**. Al terminar, el propio instalador imprime dos líneas para agregar a `~/.zshrc`; hazlo y abre una terminal nueva.

Verifica: `brew --version`.

## 3. Paquetes del sistema

```bash
brew install nvm gh openjdk uv
brew install --cask google-cloud-sdk
```

`git` y `sqlite3` ya vienen con macOS: no los instales por Homebrew o tendrás dos versiones peleando por el PATH.

Por qué cada uno:

- **`openjdk`** — el emulador de Firestore es una aplicación Java. `npm test` del backend corre `firebase emulators:exec`, así que sin Java no puedes ejecutar sus pruebas.
- **`uv`** — instala `graphify` (paso 6), que es una herramienta de Python. Es el tropiezo más común al replicar este entorno: parece un paquete de npm y no lo es.
- **`gh`** — el CLI de GitHub, para clonar y trabajar con PRs.
- **`google-cloud-sdk`** — para leer los logs de la API en producción.

`openjdk` de Homebrew no queda enlazado solo. Si `java -version` falla:

```bash
sudo ln -sfn "$(brew --prefix)/opt/openjdk/libexec/openjdk.jdk" \
  /Library/Java/JavaVirtualMachines/openjdk.jdk
```

## 4. Node

Agrega a `~/.zshrc`, abre una terminal nueva:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix)/opt/nvm/nvm.sh" ] && . "$(brew --prefix)/opt/nvm/nvm.sh"
```

```bash
mkdir -p ~/.nvm
nvm install 22
nvm alias default 22
```

**Usa Node 22, no la última.** El backend declara `engines.node: "22"` y Cloud Functions despliega con runtime `nodejs22`. Con otra versión desarrollas sobre algo distinto a lo que corre en producción.

## 5. CLIs globales de npm

```bash
npm i -g @angular/cli@22 firebase-tools
```

## 6. graphify

```bash
uv tool install graphifyy
```

El paquete se llama `graphifyy` (con dos íes) y el comando queda como `graphify`. Los `CLAUDE.md` de los repos lo dan por instalado: es lo que mantiene el grafo de conocimiento del código.

Verifica: `graphify --version`.

## 7. Sesiones

```bash
firebase login
gcloud auth login
gcloud config set project farma-jyv
gh auth login
```

## 8. Clonar

```bash
mkdir -p ~/Documents/personal && cd ~/Documents/personal
git clone https://github.com/dev-jyv/pos-farma-jyv.git farma-jyv-pos
git clone https://github.com/dev-jyv/backend-farma-jyv.git
git clone https://github.com/dev-jyv/farma-jyv-admin.git
```

## 9. Dependencias

```bash
cd ~/Documents/personal/farma-jyv-pos        && npm install
cd ~/Documents/personal/farma-jyv-admin      && npm install
cd ~/Documents/personal/backend-farma-jyv/functions && npm install
```

En el POS, `npm install` dispara `prisma generate` en su `postinstall`. Si algún día lo saltas (`--ignore-scripts`), córrelo a mano con `npm run prisma:generate`: sin el cliente generado la capa SQLite no existe y `electron:dev` arranca roto.

## 10. Secretos

**`backend-farma-jyv/functions/.env` está en `.gitignore` y no viene al clonar.** Contiene:

- `MIGRATE_SECRET` — sin él no puedes correr `npm run migrate:roles`
- Credenciales de Mercado Pago (`MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`)
- `API_URL`

Cópialo desde la máquina anterior por un canal seguro: AirDrop o un gestor de contraseñas. **Nunca por chat, correo ni pegado en un ticket.**

---

## Comprobar que quedó bien

```bash
# Backend: levanta el emulador de Firestore (necesita Java)
cd ~/Documents/personal/backend-farma-jyv/functions && npm test

# POS: las dos suites, Angular y capa local
cd ~/Documents/personal/farma-jyv-pos && npm run test:all

# Admin
cd ~/Documents/personal/farma-jyv-admin && npm test

# Y la app real contra los emuladores (ver "Entornos" abajo): tres terminales
cd ~/Documents/personal/backend-farma-jyv/functions && npm run serve   # emuladores
cd ~/Documents/personal/farma-jyv-pos && npm start                     # renderer en :4400
cd ~/Documents/personal/farma-jyv-pos && npm run electron:dev          # ventana de Electron
```

Si las tres suites pasan, el entorno está completo.

---

## Cosas que sorprenden

**La base local arranca vacía.** Las ventas, turnos y movimientos de la máquina anterior viven en un SQLite fuera del repo y no viajan con el código. Si necesitas esos datos, copia el archivo (ver [`arquitectura/shared-y-electron.md`](arquitectura/shared-y-electron.md) para la ruta exacta).

**Cada entorno usa su propia base local** (ver la tabla de `userData` en "Entornos"). Una venta hecha contra el emulador no la ve la app instalada, ni la de dev-cloud, y al revés.

**El POS fija `packageManager: npm@11.13.0`.** Si tu npm es más nuevo funciona igual, pero `corepack enable` respeta lo declarado y evita diferencias en `package-lock.json`.

---

## Entornos

El POS tiene tres entornos. **Ninguno de desarrollo toca producción**: ni la API, ni Firebase Auth, ni la terminal de Mercado Pago, ni la base local de una caja real.

| Entorno | Configuración Angular | Proyecto Firebase | API | Auth |
|---|---|---|---|---|
| **emulator** (local, default) | `development` (`environment.development.ts`) | `demo-farmajyv` | `http://127.0.0.1:5001/demo-farmajyv/us-central1/api/v1` | emulador en `127.0.0.1:9099` |
| **dev** (nube de pruebas) | `dev-cloud` / `electron-dev-cloud` | `farma-jyv-dev` | `https://us-central1-farma-jyv-dev.cloudfunctions.net/api/v1` | Auth real de `farma-jyv-dev` |
| **prod** | `production` / `electron` | `farma-jyv` | la de siempre | Auth real de `farma-jyv` |

- El prefijo `demo-` es a propósito: con un proyecto `demo-*` los SDK de Firebase nunca salen a la nube, así que el entorno local no puede tocar un proyecto real ni por error.
- `useEmulators: true` (solo en `environment.development.ts`) hace que `core/firebase/firebase.providers.ts` llame a `connectAuthEmulator`.
- **Mercado Pago fuera de producción:** `terminalEnabled: false` y `storeId`/`posId`/`terminalId` vacíos. El cobro con tarjeta se registra sin mandar nada a la terminal y, aunque alguien encienda `terminalEnabled`, no hay id que apunte a la TPV física del mostrador.
- `environment.dev-cloud.ts` y `environment.electron-dev-cloud.ts` usan la app web `famajyvPV-dev` de `farma-jyv-dev` (la misma que admin y clinic).

### Scripts

| Script | Qué hace |
|---|---|
| `npm start` | `ng serve` en `http://localhost:4400` con `development` → **emuladores** |
| `npm run start:dev-cloud` | `ng serve` en `:4400` con `dev-cloud` → `farma-jyv-dev` |
| `npm run build:dev-cloud` | build web contra `farma-jyv-dev` |
| `npm run electron:dev` | Electron (`--dev`) contra `:4400`, `FARMAJYV_ENV=emulator`. Necesita `npm start` corriendo en paralelo y los emuladores del backend (`npm run serve` en `backend-farma-jyv/functions`) |
| `npm run electron:dev:cloud` | Electron contra `:4400`, `FARMAJYV_ENV=dev`. Necesita `npm run start:dev-cloud` en paralelo |
| `npm run electron:start` | build `electron` (**producción**) + Electron sin `--dev` |
| `npm run release:mac` / `release:win` | empaqueta el build de producción, prepara `dist-updates/` y despliega el feed con `--project prod` (`deploy:prod`) |
| `npm run release:dev:mac` / `release:dev:win` | empaqueta el build `electron-dev-cloud`, prepara `dist-updates-dev/` y despliega con `--project dev` (`deploy:dev`) |

Los puertos están fijos para poder correr todo a la vez: admin 4200, consultorio 4300, POS 4400; emuladores del backend: auth 9099, firestore 8080, storage 9199, functions 5001, UI 4000. `npm start` y `npm run start:dev-cloud` usan el mismo puerto: corre uno a la vez.

En modo `--dev`, `electron/security.js` deja navegar la ventana a `http://localhost:4400` y a los emuladores (`127.0.0.1:5001`, `127.0.0.1:9099`). Con la app empaquetada esa lista no se consulta.

### Carpeta de datos (`userData`) por entorno

`electron/main.js` resuelve el entorno con `electron/app-environment.js` **antes** de cargar la capa de base de datos, y fuera de producción llama a `app.setPath('userData', …)`. Orden de precedencia: la variable `FARMAJYV_ENV` (`emulator` | `dev` | `prod`), luego `farmajyvEnv` horneado en el `package.json` empaquetado (lo pone `release:dev:*`), y si no hay ninguna, `emulator` con `--dev` y `prod` en cualquier otro caso. Al arrancar imprime `[env] entorno=… userData=…`.

| Entorno | Ruta de la base (macOS) |
|---|---|
| `electron:dev` (emulator) | `~/Library/Application Support/FarmaJyV Venta (emulator)/farmajyv-pos.sqlite` |
| `electron:dev:cloud` y el binario `FarmaJyV Venta DEV` (dev) | `~/Library/Application Support/FarmaJyV Venta (dev)/farmajyv-pos.sqlite` |
| App empaquetada de producción | `~/Library/Application Support/FarmaJyV Venta/farmajyv-pos.sqlite` (sin cambios) |
| `electron:start` (sin empaquetar, producción) | `~/Library/Application Support/Electron/farmajyv-pos.sqlite` (sin cambios) |

> **Aviso:** antes de este cambio `electron:dev` usaba `~/Library/Application Support/Electron/farmajyv-pos.sqlite`, la misma carpeta que `electron:start` contra producción, así que **puede contener datos sincronizados de producción** (ventas, turnos, catálogo). `electron:dev` ya **no** la usa. **No la borres** sin revisarla: si hay ventas o turnos con `pendingPush` sin subir, son dinero real que todavía no llegó al servidor.

### Builds de prueba empaquetados (dev-cloud)

`release:dev:*` pasa a `electron-builder`:

- `-c.appId=mx.farmajyv.pos.dev` y `-c.productName="FarmaJyV Venta DEV"`: se instala **al lado** de la app de producción, nunca encima.
- `-c.publish.url=https://farma-jyv-dev-updates.web.app`: el feed queda horneado en el binario (`app-update.yml`), así que un build de pruebas solo se actualiza desde el sitio de dev y una caja real nunca recibe un build de dev. `UPDATE_URL` no basta: solo cambia el feed de quien la tenga en su entorno.
- `-c.directories.output=release-dev`: los artefactos no se mezclan con los de `release/`.
- `-c.extraMetadata.farmajyvEnv=dev`: el binario sabe que es dev y usa la carpeta `FarmaJyV Venta (dev)`.

`scripts/publicar-actualizacion.mjs --dev` copia de `release-dev/` a `dist-updates-dev/`. En `firebase.json` hay dos sitios de Hosting con **targets distintos**: `updates` (`dist-updates/`) solo está mapeado en el proyecto `farma-jyv` y `updates-dev` (`dist-updates-dev/`) solo en `farma-jyv-dev` (`.firebaserc`, alias `prod` y `dev`). Por eso `firebase deploy --only hosting:updates-dev --project prod` falla en vez de publicar un feed de dev a las cajas.

