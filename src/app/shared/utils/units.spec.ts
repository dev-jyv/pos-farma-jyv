import { describe, expect, it } from 'vitest';

import { UNIT_OPTIONS, buildUnitOptions } from './units';

describe('buildUnitOptions', () => {
  it('ofrece el catálogo cerrado cuando la unidad ya está en él', () => {
    const options = buildUnitOptions('caja');
    expect(options.map((option) => option.value)).toEqual([...UNIT_OPTIONS]);
  });

  it('sin unidad capturada devuelve solo el catálogo', () => {
    expect(buildUnitOptions(null)).toHaveLength(UNIT_OPTIONS.length);
    expect(buildUnitOptions('  ')).toHaveLength(UNIT_OPTIONS.length);
  });

  /**
   * Un producto viejo (o dado de alta desde el admin web) puede traer una unidad
   * fuera de la lista. El selector debe poder representarla: si no, al guardar se
   * borraría un dato del catálogo sin que nadie lo pidiera.
   */
  it('conserva una unidad fuera del catálogo, marcada como la actual', () => {
    const options = buildUnitOptions('botella');
    expect(options).toHaveLength(UNIT_OPTIONS.length + 1);
    expect(options.at(-1)).toEqual({ label: 'botella (actual)', value: 'botella' });
  });
});
