import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Rampa verde de FarmaJyV, extraída del logo (`public/brand/logo.png`): el 500 es
 * el verde de las manos y la cruz. Va en literales y no en `{emerald.*}` porque el
 * verde de la marca es más cálido y saturado que el emerald de Tailwind: mezclarlos
 * dejaba la interfaz con dos verdes distintos según el componente.
 *
 * Debe mantenerse en paralelo con `--brand-green-*` de `styles.css`.
 */
const BRAND_GREEN = {
  50: '#f2faec',
  100: '#e0f4d3',
  200: '#c2e8aa',
  300: '#9bd87a',
  400: '#74c64b',
  500: '#4ca820',
  600: '#3c8a19',
  700: '#2e6c14',
  800: '#245312',
  900: '#1b3f0e',
  950: '#122b09',
};

/** Neutros fríos de la paleta; en paralelo con `--neutral-*` de `styles.css`. */
const NEUTRAL = {
  50: '#f1f5f7',
  100: '#e6ecef',
  200: '#d5dee3',
  300: '#b9c6cd',
  400: '#8a9ba5',
  500: '#64757f',
  600: '#4b5b64',
  700: '#37454c',
  800: '#243035',
  900: '#131c21',
};

export const PosPreset = definePreset(Aura, {
  semantic: {
    /**
     * Anillo de foco visible (WCAG 2.4.11). Aura trae 1px con `{primary.color}`, que
     * el navegador compone translúcido sobre blanco y queda en ~1.4:1: en un POS que
     * se opera con teclado, no ver dónde está el foco es un fallo funcional.
     * 2px opaco del verde 600 (#3c8a19) sobre blanco da 4.34:1 (≥3:1 exigido para
     * componentes de interfaz) y el offset lo despega del borde del control.
     */
    focusRing: {
      width: '2px',
      style: 'solid',
      color: '{primary.600}',
      offset: '2px',
      shadow: 'none',
    },
    primary: BRAND_GREEN,
    /**
     * Aura anula el anillo de foco en los campos de formulario (`width: 0`), así que
     * `p-inputnumber` / `p-select` solo cambiaban el color del borde. Se reactiva con
     * el mismo grosor que el resto de la app; sin offset, para que el anillo abrace el
     * borde del campo y no se recorte dentro de las rejillas del diálogo de cobro.
     */
    formField: {
      focusRing: {
        width: '2px',
        style: 'solid',
        color: '{primary.600}',
        offset: '0',
        shadow: 'none',
      },
    },
    colorScheme: {
      light: {
        /**
         * El relleno usa el 700 y no el 500 de marca: blanco sobre el verde del logo
         * da 3.03:1 y no cumple WCAG 1.4.3 para texto. El 700 llega a 6.42:1.
         */
        primary: {
          color: '{primary.700}',
          contrastColor: '#ffffff',
          hoverColor: '{primary.800}',
          activeColor: '{primary.900}',
        },
        formField: {
          background: '#ffffff',
          borderColor: NEUTRAL[300],
          hoverBorderColor: NEUTRAL[400],
          focusBorderColor: '{primary.600}',
          color: NEUTRAL[900],
          floatLabelColor: NEUTRAL[500],
          floatLabelFocusColor: '{primary.700}',
        },
        content: {
          background: '#ffffff',
          borderColor: NEUTRAL[200],
          color: NEUTRAL[700],
        },
        surface: NEUTRAL,
      },
    },
  },
});
