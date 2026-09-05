import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isAllowedNavigation, isSafePrinterTarget } = require('../security.js');

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
