import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isAllowedNavigation, isSafePrinterTarget, isDevToolsShortcut } = require('../security.js');

const DIST_INDEX = path.resolve('/opt/farmajyv/dist/farma-jyv-pos/browser/index.html');
const DEV = 'http://localhost:4200';

/** `C:\x\y` → `file:///C:/x/y`; `/x/y` → `file:///x/y`. */
function fileUrl(p) {
  const posix = p.replace(/\\/g, '/');
  return `file://${posix.startsWith('/') ? '' : '/'}${posix}`;
}

describe('isAllowedNavigation', () => {
  const prod = { isDev: false, devServerUrl: DEV, appIndexPath: DIST_INDEX };
  const dev = { isDev: true, devServerUrl: DEV, appIndexPath: DIST_INDEX };

  it('permite el propio index.html del bundle', () => {
    expect(isAllowedNavigation(fileUrl(DIST_INDEX), prod)).toBe(true);
  });

  it('permite un asset dentro del directorio del bundle', () => {
    const asset = path.join(path.dirname(DIST_INDEX), 'assets', 'logo.png');
    expect(isAllowedNavigation(fileUrl(asset), prod)).toBe(true);
  });

  it('bloquea un file:// fuera del bundle', () => {
    expect(isAllowedNavigation(fileUrl('/etc/passwd'), prod)).toBe(false);
    expect(isAllowedNavigation(fileUrl(path.resolve('/opt/farmajyv/otro/index.html')), prod)).toBe(
      false,
    );
  });

  it('bloquea el escape por `..` aunque venga escapado', () => {
    const dir = path.dirname(DIST_INDEX).replace(/\\/g, '/');
    expect(isAllowedNavigation(`file://${dir}/../../secreto.html`, prod)).toBe(false);
    expect(isAllowedNavigation(`file://${dir}/%2e%2e/%2e%2e/secreto.html`, prod)).toBe(false);
  });

  it('bloquea http(s) en producción, incluido el dev server', () => {
    expect(isAllowedNavigation('https://evil.example/pwn', prod)).toBe(false);
    expect(isAllowedNavigation('http://localhost:4200/', prod)).toBe(false);
  });

  it('permite solo el origen del dev server en desarrollo', () => {
    expect(isAllowedNavigation('http://localhost:4200/pos/venta', dev)).toBe(true);
    expect(isAllowedNavigation('http://localhost:4201/', dev)).toBe(false);
    expect(isAllowedNavigation('https://evil.example/', dev)).toBe(false);
  });

  it('en desarrollo permite el dev server 4400 y los emuladores, y nada más', () => {
    for (const url of [
      'http://localhost:4400/pos/venta',
      'http://127.0.0.1:5001/demo-farmajyv/us-central1/api/v1/health',
      'http://127.0.0.1:9099/emulator/auth/handler',
    ]) {
      expect(isAllowedNavigation(url, dev)).toBe(true);
    }
    expect(isAllowedNavigation('http://127.0.0.1:8080/', dev)).toBe(false);
    expect(isAllowedNavigation('http://localhost:5001/', dev)).toBe(false);
    expect(isAllowedNavigation('https://127.0.0.1:9099/', dev)).toBe(false);
  });

  it('en producción los orígenes de desarrollo siguen bloqueados', () => {
    for (const url of [
      'http://localhost:4400/',
      'http://127.0.0.1:5001/demo-farmajyv/us-central1/api/v1',
      'http://127.0.0.1:9099/',
    ]) {
      expect(isAllowedNavigation(url, prod)).toBe(false);
    }
  });

  it('bloquea esquemas no navegables y basura', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      'no-es-una-url',
      '',
      null,
      undefined,
    ]) {
      expect(isAllowedNavigation(url, prod)).toBe(false);
    }
  });

  it('bloquea file:// si no se sabe dónde vive el bundle', () => {
    expect(isAllowedNavigation(fileUrl(DIST_INDEX), { isDev: false })).toBe(false);
  });
});

describe('isSafePrinterTarget', () => {
  it('acepta la cola compartida y los dispositivos de Windows', () => {
    expect(isSafePrinterTarget('\\\\CAJA1\\TICKETS', 'win32')).toBe(true);
    expect(isSafePrinterTarget('LPT1', 'win32')).toBe(true);
    expect(isSafePrinterTarget('prn', 'win32')).toBe(true);
  });

  it('acepta un nombre a secas (lo que hay configurado hoy)', () => {
    expect(isSafePrinterTarget('EPSON TM-T20', 'win32')).toBe(true);
    expect(isSafePrinterTarget('EPSON TM-T20', 'darwin')).toBe(true);
  });

  it('rechaza rutas en Windows: ahí `copyFile` sobreescribiría el archivo', () => {
    expect(isSafePrinterTarget('C:\\Windows\\System32\\drivers\\etc\\hosts', 'win32')).toBe(false);
    expect(isSafePrinterTarget('..\\..\\config.json', 'win32')).toBe(false);
    expect(isSafePrinterTarget('subdir/archivo', 'win32')).toBe(false);
    expect(isSafePrinterTarget('\\\\CAJA1\\TICKETS\\..\\..\\c$\\boot.ini', 'win32')).toBe(false);
  });

  it('rechaza lo que `lp` leería como opción', () => {
    expect(isSafePrinterTarget('-o', 'darwin')).toBe(false);
    expect(isSafePrinterTarget('--dest=otra', 'darwin')).toBe(false);
  });

  it('rechaza vacíos, no-cadenas, caracteres de control y nombres absurdos', () => {
    for (const value of ['', '   ', null, undefined, 42, {}, []]) {
      expect(isSafePrinterTarget(value, 'darwin')).toBe(false);
    }
    expect(isSafePrinterTarget('TICKETS\u0000/etc/passwd', 'darwin')).toBe(false);
    expect(isSafePrinterTarget('TICKETS\nlp -d otra', 'darwin')).toBe(false);
    expect(isSafePrinterTarget('T'.repeat(256), 'darwin')).toBe(false);
  });
});

/**
 * DevTools en un equipo de mostrador es un bypass de todos los guards de rol:
 * desde la consola se llama `window.electronAPI` a mano y los handlers de IPC
 * no verifican quién es el usuario.
 */
describe('isDevToolsShortcut', () => {
  const keyDown = (extra) => ({ type: 'keyDown', ...extra });

  it('reconoce F12', () => {
    expect(isDevToolsShortcut(keyDown({ key: 'F12' }))).toBe(true);
  });

  it('reconoce ⌘⌥I de macOS', () => {
    expect(isDevToolsShortcut(keyDown({ key: 'I', meta: true, alt: true }))).toBe(true);
  });

  it('reconoce Ctrl+Shift+I / J / C de Windows y Linux', () => {
    for (const key of ['i', 'j', 'c']) {
      expect(isDevToolsShortcut(keyDown({ key, control: true, shift: true }))).toBe(true);
    }
  });

  it('deja pasar los atajos que el cajero sí usa', () => {
    // ⌘C y Ctrl+C son copiar: bloquearlos rompería la caja.
    expect(isDevToolsShortcut(keyDown({ key: 'c', meta: true }))).toBe(false);
    expect(isDevToolsShortcut(keyDown({ key: 'c', control: true }))).toBe(false);
    // ⌘I sin Alt es cursiva, no DevTools.
    expect(isDevToolsShortcut(keyDown({ key: 'i', meta: true }))).toBe(false);
    // F9 cobra.
    expect(isDevToolsShortcut(keyDown({ key: 'F9' }))).toBe(false);
  });

  it('ignora keyUp: bloquear en la bajada basta y evita comerse la tecla dos veces', () => {
    expect(isDevToolsShortcut({ type: 'keyUp', key: 'F12' })).toBe(false);
  });

  it('tolera entradas basura sin reventar', () => {
    expect(isDevToolsShortcut(null)).toBe(false);
    expect(isDevToolsShortcut({})).toBe(false);
    expect(isDevToolsShortcut(keyDown({}))).toBe(false);
  });
});
