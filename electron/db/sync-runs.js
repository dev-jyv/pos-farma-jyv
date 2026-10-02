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

async function getStatus(prisma) {
  const rows = await prisma.syncRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: 20,
  });
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
