/**
 * Evento que emite el sync al terminar de bajar promociones. `PromoService` lo
 * escucha para releer las vigentes sin que el sync dependa de la pantalla de
 * venta.
 */
export const PROMOTIONS_SYNCED_EVENT = 'farmajyv:promotions-synced';

/**
 * Evento que emite el sync al terminar de bajar servicios y doctores.
 * `ServiceCatalogService` cachea el catálogo en una señal: sin esto, lo que
 * llega después de abrir la venta no se ve hasta reiniciar la caja.
 */
export const SERVICES_SYNCED_EVENT = 'farmajyv:services-synced';
