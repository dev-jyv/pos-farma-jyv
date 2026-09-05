-- Las ventas rechazadas por inventario quedaban bloqueadas para siempre: el
-- rechazo no se resuelve reintentando, pero tampoco tenía a dónde ir. Ahora sí
-- (`unreconciledSales` en el servidor), así que se devuelven a la cola para que
-- el siguiente sync las registre allá en vez de dejarlas muertas en la caja.
UPDATE "Sale"
SET "pushError" = NULL
WHERE "pushError" IS NOT NULL
  AND "unreconciledAt" IS NULL
  AND (
    lower("pushError") LIKE '%stock%'
    OR lower("pushError") LIKE '%lote%'
    OR lower("pushError") LIKE '%producto no encontrado%'
  );
