/**
 * Evento que emite el sync al terminar de bajar promociones. `PromoService` lo
 * escucha para releer las vigentes sin que el sync dependa de la pantalla de
 * venta.
 */
export const PROMOTIONS_SYNCED_EVENT = 'farmajyv:promotions-synced';
