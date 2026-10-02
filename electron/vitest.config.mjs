import { defineConfig } from 'vitest/config';

/**
 * Las pruebas del proceso principal de Electron (`electron/db/*.js`) corren
 * aparte de `ng test`: son CommonJS de Node, sin TestBed ni DOM, y el builder
 * de Angular solo mira `src/`.
 */
export default defineConfig({
  test: {
    name: 'electron',
    environment: 'node',
    include: ['electron/test/**/*.spec.mjs'],
    root: new URL('..', import.meta.url).pathname,
  },
});
