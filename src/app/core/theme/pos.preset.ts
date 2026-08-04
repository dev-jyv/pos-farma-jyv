import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

export const PosPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{emerald.50}',
      100: '{emerald.100}',
      200: '{emerald.200}',
      300: '{emerald.300}',
      400: '{emerald.400}',
      500: '{emerald.600}',
      600: '{emerald.600}',
      700: '{emerald.700}',
      800: '{emerald.800}',
      900: '{emerald.900}',
      950: '{emerald.950}',
    },
    colorScheme: {
      light: {
        primary: {
          color: '{emerald.600}',
          contrastColor: '#ffffff',
          hoverColor: '{emerald.700}',
          activeColor: '{emerald.800}',
        },
        formField: {
          background: '#ffffff',
          borderColor: '{slate.300}',
          hoverBorderColor: '{slate.400}',
          focusBorderColor: '{emerald.500}',
          color: '{slate.900}',
          floatLabelColor: '{slate.500}',
          floatLabelFocusColor: '{emerald.600}',
        },
        content: {
          background: '#ffffff',
          borderColor: '{slate.200}',
          color: '{slate.700}',
        },
      },
    },
  },
});
