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
    expect(resolveAppEnvironment({ envVar: 'dev', bakedEnv: 'prod', isDev: true })).toBe('dev');
    expect(resolveAppEnvironment({ envVar: ' PROD ', isDev: true })).toBe('prod');
  });

  it('un binario de dev-cloud se reconoce por el package.json horneado', () => {
    expect(resolveAppEnvironment({ bakedEnv: 'dev', isDev: false })).toBe('dev');
  });

  it('un valor desconocido avisa y cae al default, no se adivina', () => {
    const warn = vi.fn();
    expect(resolveAppEnvironment({ envVar: 'staging', isDev: false, warn })).toBe('prod');
    expect(resolveAppEnvironment({ envVar: 'staging', isDev: true, warn })).toBe('emulator');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('userDataDirFor', () => {
  const appData = path.resolve('/Users/x/Library/Application Support');

  it('producción conserva la carpeta de siempre', () => {
    expect(userDataDirFor('prod', appData)).toBeNull();
  });

  it('cada entorno de pruebas tiene su propia carpeta', () => {
    expect(userDataDirFor('emulator', appData)).toBe(path.join(appData, 'FarmaJyV Venta (emulator)'));
    expect(userDataDirFor('dev', appData)).toBe(path.join(appData, 'FarmaJyV Venta (dev)'));
  });
});
