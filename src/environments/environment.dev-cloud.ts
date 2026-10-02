/**
 * Entorno `dev-cloud` (`npm run start:dev-cloud`). TEMPORAL: apunta a
 * **producción** (`farma-jyv`) mientras `farma-jyv-dev` no esté listo.
 */
export const environment = {
  production: false,
  isElectron: false,
  useEmulators: false,
  version: 'vB1.0.5-dev',
  apiUrl: 'https://api-vykfsskx3q-uc.a.run.app/v1',
  primeNgLicense:
    'eyJpZCI6ImIyYTFiMmZkLWVjYzItNDMxNi1iZGU2LTJhOWE1YTg0YTg5MyIsInByb2R1Y3QiOiJwcmltZXVpIiwidGllciI6ImNvbW11bml0eSIsInR5cGUiOiJkZXYiLCJpYXQiOjE3ODU1NDU5MTcsImV4cCI6MTgxNzA4MTkxN30.qU9mWYPh-N38tjPZluyU8GWqThw0DFVabnjlJf50TeU0aBBs8_dqlIBN7Mk5GSS-TfSPk-hxC0v-16yEhzehAQ',
  /**
   * Cobro fuera de una venta. Oculto por ahora: la pantalla y su módulo siguen
   * completos (`/pos/cobro-directo`, `directCharges` en el backend); esto solo
   * quita la entrada del menú. Poner en `true` para volver a ofrecerlo.
   */
  directChargeEnabled: false,
  printTicketOnSale: false,
  expiryWarningDays: 30,
  soundsEnabled: true,
  cashDrawer: {
    printerName: '',
  },
  pharmacy: {
    name: 'FarmaJyV',
    address: '',
    phone: '',
    rfc: '',
  },
  mercadoPago: {
    /**
     * Terminal Point desactivada por ahora: no hay TPV emparejada, así que el cobro
     * con tarjeta y la parte con tarjeta del mixto se **registran** igual que el
     * efectivo, sin mandar nada a la terminal. Poner en `true` cuando la TPV esté
     * emparejada; el flujo de orders sigue intacto en el código.
     */
    terminalEnabled: false,
    storeId: '79847455',
    posId: '136414381',
    terminalId: 'NEWLAND_N950__N950NCCA05098242',
  },
  /**
   * TEMPORAL: claves de **producción** (`farma-jyv`) mientras `farma-jyv-dev`
   * no esté listo. Todo lo que se haga aquí cae en los datos reales de la
   * farmacia. La terminal Point sigue apagada y sin ids (ver `mercadoPago`).
   */
  firebase: {
    apiKey: 'AIzaSyCDkNTzuKSvhXzC716e9fGjGSrk-BctJS0',
    authDomain: 'farma-jyv.firebaseapp.com',
    projectId: 'farma-jyv',
    storageBucket: 'farma-jyv.firebasestorage.app',
    messagingSenderId: '1066277823355',
    appId: '1:1066277823355:web:b475853699ef0d6cbb13de',
  },
};
