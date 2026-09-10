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

# Y la app real
cd ~/Documents/personal/farma-jyv-pos && npm run electron:dev
```

Si las tres suites pasan, el entorno está completo.

---

## Cosas que sorprenden

**La base local arranca vacía.** Las ventas, turnos y movimientos de la máquina anterior viven en un SQLite fuera del repo y no viajan con el código. Si necesitas esos datos, copia el archivo (ver [`arquitectura/shared-y-electron.md`](arquitectura/shared-y-electron.md) para la ruta exacta).

**Desarrollo y app empaquetada usan bases distintas**, porque la ruta depende del nombre de la app:

| Entorno | Ruta (macOS) |
|---|---|
| `electron:dev` / `electron:start` | `~/Library/Application Support/Electron/farmajyv-pos.sqlite` |
| Empaquetada | `~/Library/Application Support/FarmaJyV Venta/farmajyv-pos.sqlite` |

Una venta hecha en desarrollo no la ve la app instalada, y al revés.

**El POS fija `packageManager: npm@11.13.0`.** Si tu npm es más nuevo funciona igual, pero `corepack enable` respeta lo declarado y evita diferencias en `package-lock.json`.
