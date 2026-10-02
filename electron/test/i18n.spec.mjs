import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Salud de los archivos de traducción.
 *
 * Vive en la suite de Node (no en la de Angular) por una razón práctica: las
 * pruebas de Angular corren en jsdom, sin acceso al sistema de archivos, y esto
 * necesita leer los `.json` y recorrer las plantillas.
 *
 * Existe porque la paridad entre `es` y `en` se rompe en silencio: una llave que
 * falta en `en` no truena, solo muestra la llave cruda en pantalla.
 */

const RAIZ = path.join(import.meta.dirname, '..', '..');
const I18N = path.join(RAIZ, 'public', 'i18n');

function planas(objeto, prefijo = '') {
  const salida = new Map();
  for (const [clave, valor] of Object.entries(objeto)) {
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      for (const [k, v] of planas(valor, `${prefijo}${clave}.`)) {
        salida.set(k, v);
      }
    } else {
      salida.set(`${prefijo}${clave}`, valor);
    }
  }
  return salida;
}

const es = planas(JSON.parse(fs.readFileSync(path.join(I18N, 'es.json'), 'utf8')));
const en = planas(JSON.parse(fs.readFileSync(path.join(I18N, 'en.json'), 'utf8')));

/** Todo el código del renderer, sin las pruebas. */
function fuenteDelRenderer() {
  const archivos = [];
  const recorrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        recorrer(completo);
      } else if (/\.(html|ts)$/.test(entrada.name) && !entrada.name.includes('.spec.')) {
        archivos.push(fs.readFileSync(completo, 'utf8'));
      }
    }
  };
  recorrer(path.join(RAIZ, 'src', 'app'));
  return archivos.join('\n');
}

const fuente = fuenteDelRenderer();

describe('paridad entre idiomas', () => {
  it('cada llave de es existe en en', () => {
    const faltantes = [...es.keys()].filter((clave) => !en.has(clave));
    // Una llave que falta en `en` no truena: muestra la llave cruda en pantalla.
    expect(faltantes).toEqual([]);
  });

  it('cada llave de en existe en es', () => {
    const faltantes = [...en.keys()].filter((clave) => !es.has(clave));
    expect(faltantes).toEqual([]);
  });

  it('ninguna traducción quedó vacía', () => {
    const vacias = [...es, ...en].filter(([, valor]) => typeof valor === 'string' && !valor.trim());
    expect(vacias.map(([clave]) => clave)).toEqual([]);
  });

  /**
   * Un `{{placeholder}}` que existe en un idioma y no en el otro deja un hueco
   * en el mensaje traducido (o un dato sin mostrar, como el monto de una
   * diferencia de caja).
   */
  it('los placeholders coinciden entre los dos idiomas', () => {
    const desajustes = [];
    for (const [clave, valorEs] of es) {
      const valorEn = en.get(clave);
      if (typeof valorEs !== 'string' || typeof valorEn !== 'string') {
        continue;
      }
      const marcas = (texto) => (texto.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((m) => m.replace(/\s/g, '')).sort();
      const enEs = marcas(valorEs);
      const enEn = marcas(valorEn);
      if (JSON.stringify(enEs) !== JSON.stringify(enEn)) {
        desajustes.push({ clave, es: enEs, en: enEn });
      }
    }
    expect(desajustes).toEqual([]);
  });
});

describe('llaves y código', () => {
  /**
   * Llaves que el código arma en tiempo de ejecución (`'payment.' + method`).
   * No aparecen literales en la fuente y por eso se declaran aquí a mano: si se
   * quitara este listado, la prueba de huérfanas las señalaría en falso.
   */
  const PREFIJOS_DINAMICOS = ['payment.', 'history.movement.', 'directCharge.status.'];

  it('no hay llaves definidas que nadie use', () => {
    const huerfanas = [...es.keys()].filter(
      (clave) => !fuente.includes(clave) && !PREFIJOS_DINAMICOS.some((p) => clave.startsWith(p)),
    );
    // Una llave sin usar suele ser el síntoma de un texto escrito a fuego en el
    // componente: la app se ve en español aunque esté en inglés.
    expect(huerfanas).toEqual([]);
  });

  it('cada llave que el código usa está definida', () => {
    // `'algo.con.puntos' | translate` y `translate.instant('algo.con.puntos')`.
    const usadas = new Set();
    for (const coincidencia of fuente.matchAll(/'([a-z][\w]*(?:\.[\w]+){1,4})'\s*\|\s*translate/g)) {
      usadas.add(coincidencia[1]);
    }
    for (const coincidencia of fuente.matchAll(/instant\('([a-z][\w]*(?:\.[\w]+){1,4})'/g)) {
      usadas.add(coincidencia[1]);
    }
    const sinDefinir = [...usadas].filter((clave) => !es.has(clave));
    expect(sinDefinir).toEqual([]);
  });
});
