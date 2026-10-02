/**
 * Catálogos de servicios y de doctores: consultas, procedimientos con comisión
 * y otros conceptos que se cobran en la venta pero **no son mercancía**.
 *
 * Son **solo-pull**: los administra el admin web y llegan por
 * `GET /pharmacy-services/sync`. Por eso, a diferencia de `products.js`, aquí
 * no hay colas de push, ni `remoteId`, ni ids locales — el `id` de cada fila ES
 * el de Firestore. Esa decisión es la que garantiza que el `serviceId` que se
 * congela en el payload de una venta siempre sea un id que el backend conoce, y
 * evita de raíz el problema de traducción de ids que sí tienen los productos.
 *
 * Que aquí no exista `stock` ni `Batch` es deliberado: hace **imposible** darle
 * entrada de inventario a un servicio, en vez de dejarlo como una regla que hay
 * que acordarse de verificar en cada pantalla.
 */

const { toDateOrNow } = require('./timestamps');

function toServiceDto(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description ?? null,
    serviceType: row.serviceType,
    price: row.price,
    taxMode: row.taxMode,
    hasIeps: row.hasIeps,
    iepsRate: row.iepsRate ?? null,
    commissionRate: row.commissionRate,
    requiresPerformer: row.requiresPerformer,
    isActive: row.isActive,
  };
}

function toProviderDto(row) {
  return {
    id: row.id,
    name: row.name,
    license: row.license ?? null,
    defaultCommissionRate: row.defaultCommissionRate ?? null,
    isActive: row.isActive,
  };
}

/** Campos que se persisten del documento remoto. Lista blanca explícita, como `productFieldsData`. */
function serviceData(remote) {
  return {
    code: remote.code ?? '',
    name: remote.name ?? '',
    description: remote.description ?? null,
    serviceType: remote.serviceType ?? 'other',
    price: remote.price ?? 0,
    taxMode: remote.taxMode ?? 'exempt',
    hasIeps: remote.hasIeps === true,
    iepsRate: remote.iepsRate ?? null,
    commissionRate: remote.commissionRate ?? 0,
    requiresPerformer: remote.requiresPerformer === true,
    isActive: remote.isActive !== false,
    updatedAt: toDateOrNow(remote.updatedAt),
  };
}

function providerData(remote) {
  return {
    name: remote.name ?? '',
    license: remote.license ?? null,
    defaultCommissionRate: remote.defaultCommissionRate ?? null,
    isActive: remote.isActive !== false,
    updatedAt: toDateOrNow(remote.updatedAt),
  };
}

/**
 * Pull: reemplaza lo que llegó del backend. Es un upsert por id (que ya es el
 * remoto), así que no hay nada que reconciliar — la caja nunca escribe estos
 * catálogos, solo los lee.
 *
 * Va en **una sola transacción**, no en un upsert suelto por fila: así el lote
 * se aplica entero o no se aplica, y un fallo a media tanda no deja el catálogo
 * mezclando servicios nuevos con precios viejos. De paso es un commit en vez de
 * uno por servicio. Mismo criterio que `products.upsertMany`, cuyo cursor solo
 * avanza si el lote completa.
 */
function upsertCatalog(prisma, modelo, remotes, toData) {
  // Las filas sin `id` se descartan: el id remoto es la llave, sin él no hay
  // upsert posible. Se cuentan solo las aplicadas.
  const validos = remotes.filter((remote) => remote?.id);
  if (validos.length === 0) {
    return Promise.resolve({ count: 0 });
  }
  return prisma
    .$transaction(
      validos.map((remote) => {
        const data = toData(remote);
        return modelo(prisma).upsert({
          where: { id: remote.id },
          create: { id: remote.id, ...data },
          update: data,
        });
      }),
    )
    .then(() => ({ count: validos.length }));
}

async function upsertServices(prisma, remotes = []) {
  return upsertCatalog(prisma, (db) => db.pharmacyService, remotes, serviceData);
}

async function upsertProviders(prisma, remotes = []) {
  return upsertCatalog(prisma, (db) => db.serviceProvider, remotes, providerData);
}

/**
 * Catálogo para el mostrador. Devuelve TODO el catálogo activo sin exigir un
 * término: son decenas de servicios, no miles de productos, así que el cajero
 * los ve de un vistazo en vez de tener que adivinar qué teclear.
 */
async function listServices(prisma, term = '') {
  const texto = term.trim();
  const rows = await prisma.pharmacyService.findMany({
    where: {
      isActive: true,
      ...(texto
        ? { OR: [{ name: { contains: texto } }, { code: { contains: texto } }] }
        : {}),
    },
    orderBy: { name: 'asc' },
  });
  return rows.map(toServiceDto);
}

async function getServiceById(prisma, id) {
  const row = await prisma.pharmacyService.findUnique({ where: { id } });
  return row ? toServiceDto(row) : null;
}

/** Doctores activos a los que se puede acreditar una comisión. */
async function listProviders(prisma) {
  const rows = await prisma.serviceProvider.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });
  return rows.map(toProviderDto);
}

module.exports = {
  toServiceDto,
  toProviderDto,
  upsertServices,
  upsertProviders,
  listServices,
  getServiceById,
  listProviders,
};
