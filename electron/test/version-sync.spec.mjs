import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La versión que ve el cajero en el login y en el shell sale de
 * `environment.version`, escrita a mano en cada `environment*.ts`. Los releases
 * 1.0.6 y 1.0.7 solo subieron `package.json`, y la caja siguió mostrando "vE1.0.5".
 * Este test falla si algún entorno no lleva la versión del `package.json`.
 */
const root = path.resolve(import.meta.dirname, '..', '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const envDir = path.join(root, 'src', 'environments');
const archivos = fs.readdirSync(envDir).filter((name) => /^environment.*\.ts$/.test(name));

describe('versión visible de la app', () => {
  it('hay entornos que revisar', () => {
    expect(archivos.length).toBeGreaterThan(0);
  });

  it.each(archivos)('%s lleva la versión de package.json', (archivo) => {
    const texto = fs.readFileSync(path.join(envDir, archivo), 'utf8');
    const declarada = /version:\s*'([^']+)'/.exec(texto)?.[1];
    expect(declarada, `${archivo} no declara version`).toBeDefined();
    // Se admite un prefijo de letras (vB, vE, vP) y un sufijo (-dev), no otra versión.
    expect(declarada).toMatch(new RegExp(`^v[A-Z]*${version.replaceAll('.', '\\.')}(-[a-z]+)?$`));
  });
});
