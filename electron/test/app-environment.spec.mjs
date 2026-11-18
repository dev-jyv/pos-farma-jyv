import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveAppEnvironment, userDataDirFor } = require('../app-environment.js');

describe('resolveAppEnvironment', () => {
  it('sin nada: prod empaquetado, emulator con --dev', () => {
    expect(resolveAppEnvironment({ isDev: false })).toBe('prod');
    expect(resolveAppEnvironment({ isDev: true })).toBe('emulator');
  });

  it('FARMAJYV_ENV manda sobre lo horneado y sobre --dev', () => {
    expect(resolveAppEnvironment({ envVar: 'emulator', bakedEnv: 'prod', isDev: false })).toBe('emulator');
    expect(resolveAppEnvironment({ envVar: ' PROD ', isDev: true })).toBe('prod');
  });

  it('un entorno horneado válido se respeta', () => {
    expect(resolveAppEnvironment({ bakedEnv: 'emulator', isDev: false })).toBe('emulator');
  });

  it('`dev` (farma-jyv-dev, borrado) se retiró: avisa por qué y cae al default', () => {
    const warn = vi.fn();
    expect(resolveAppEnvironment({ envVar: 'dev', isDev: true, warn })).toBe('emulator');
    expect(resolveAppEnvironment({ bakedEnv: 'dev', isDev: false, warn })).toBe('prod');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('farma-jyv-dev se borró');
  });

  it('`dev` en FARMAJYV_ENV no tapa un entorno horneado válido', () => {
    const warn = vi.fn();
    expect(resolveAppEnvironment({ envVar: 'dev', bakedEnv: 'emulator', isDev: false, warn })).toBe('emulator');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('un valor desconocido avisa y cae al default, no se adivina', () => {
    const warn = vi.fn();
    expect(resolveAppEnvironment({ envVar: 'staging', isDev: false, warn })).toBe('prod');
    expect(resolveAppEnvironment({ envVar: 'staging', isDev: true, warn })).toBe('emulator');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('un FARMAJYV_ENV inválido no tapa el entorno horneado en el binario', () => {
    const warn = vi.fn();
    expect(resolveAppEnvironment({ envVar: 'Dev1', bakedEnv: 'emulator', isDev: false, warn })).toBe('emulator');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('userDataDirFor', () => {
  const appData = path.resolve('/Users/x/Library/Application Support');

  it('producción conserva la carpeta de siempre', () => {
    expect(userDataDirFor('prod', appData)).toBeNull();
  });

  it('el emulador tiene su propia carpeta', () => {
    expect(userDataDirFor('emulator', appData)).toBe(path.join(appData, 'FarmaJyV Venta (emulator)'));
  });
});
