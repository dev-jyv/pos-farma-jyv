async function recordRun(prisma, run) {
  const created = await prisma.syncRun.create({
    data: {
      entity: run.entity,
      direction: run.direction,
      status: run.status,
      cursor: run.cursor ?? null,
      errorMessage: run.errorMessage ?? null,
      finishedAt: new Date(),
    },
  });
  return { id: created.id };
}

/** Entidades que llevan cursor: de cada una hay que conservar su último pull exitoso. */
const CURSOR_ENTITIES = ['products', 'pharmacyServices', 'serviceProviders', 'promotions'];

async function getStatus(prisma) {
  const recientes = await prisma.syncRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: 20,
  });
  // El cursor de cada catálogo sale del último pull `ok`. Con solo las últimas 20
  // filas, un día sin red (una fila de error por hora y por catálogo) lo empujaba
  // fuera de la ventana y el siguiente sync bajaba el catálogo completo.
  const entidades = new Set([...CURSOR_ENTITIES, ...recientes.map((row) => row.entity)]);
  const vistos = new Set(recientes.map((row) => row.id));
  const rows = [...recientes];
  for (const entity of entidades) {
    const ultimoOk = await prisma.syncRun.findFirst({
      where: { entity, direction: 'pull', status: 'ok', cursor: { not: null } },
      orderBy: { startedAt: 'desc' },
    });
    if (ultimoOk && !vistos.has(ultimoOk.id)) {
      vistos.add(ultimoOk.id);
      rows.push(ultimoOk);
    }
  }
  return rows.map((row) => ({
    entity: row.entity,
    direction: row.direction,
    status: row.status,
    cursor: row.cursor,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
}

module.exports = { recordRun, getStatus };
