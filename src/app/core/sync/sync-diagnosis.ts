import { BlockedCode, BlockedSyncRecord } from '../electron/window.d';

/** Qué conviene hacer primero. Nunca "descartar": puede ser dinero ya cobrado. */
export type BlockedAction = 'reintentar' | 'corregir' | 'avisar-admin';

export interface BlockedHelp {
  title: string;
  explanation: string;
  recommended: BlockedAction;
}

/**
 * Texto para el cajero por cada causa que clasifica `electron/db/blocked-diagnosis.js`.
 *
 * El panel mostraba solo el `pushError` crudo, que dice qué pasó pero no qué
 * hacer. Esto va arriba del motivo técnico (que se sigue mostrando, en chico,
 * para el admin). `dep` es el turno o el producto que la venta espera.
 */
const AYUDA: Record<BlockedCode, (dep: string, record: BlockedSyncRecord) => BlockedHelp> = {
  'turno-sin-subir': (dep) => ({
    title: 'Falta subir el turno',
    explanation:
      `La venta está bien, pero su turno${dep ? ` (${dep})` : ''} todavía no llega al ` +
      'servidor, casi siempre por falta de internet. Con conexión, pulsa Reintentar: ' +
      'sube el turno y después la venta.',
    recommended: 'reintentar',
  }),
  'turno-rechazado': (dep) => ({
    title: 'El servidor rechazó el turno de esta venta',
    explanation:
      `Primero hay que resolver la apertura del turno${dep ? ` (${dep})` : ''}, que también ` +
      'aparece en esta lista. Cuando suba, reintenta la venta. No la descartes: es dinero cobrado.',
    recommended: 'avisar-admin',
  }),
  'producto-sin-subir': (dep) => ({
    title: 'Falta subir un producto nuevo',
    explanation:
      `El producto «${dep || 'nuevo'}» se dio de alta en esta caja y aún no llega al servidor. ` +
      'Con conexión, pulsa Reintentar: sube el catálogo y después la venta.',
    recommended: 'reintentar',
  }),
  'producto-rechazado': (dep) => ({
    title: 'El servidor rechazó un producto de esta venta',
    explanation:
      `El alta de «${dep || 'un producto'}» fue rechazada. Corrígelo en Productos o avisa ` +
      'al administrador; después reintenta la venta.',
    recommended: 'avisar-admin',
  }),
  'producto-no-encontrado': () => ({
    title: 'Un producto de esta venta ya no existe',
    explanation:
      'Probablemente se borró del catálogo. Avisa al administrador antes de descartar la venta: ' +
      'el cobro ya se hizo.',
    recommended: 'avisar-admin',
  }),
  'listo-para-reintentar': () => ({
    title: 'Ya se puede enviar',
    explanation: 'Lo que faltaba ya llegó al servidor. Pulsa Reintentar.',
    recommended: 'reintentar',
  }),
  'turno-duplicado': () => ({
    title: 'Choque con el turno anterior',
    explanation:
      'El servidor todavía tiene abierto un turno anterior de este equipo. Reintenta: la caja ' +
      'sube primero ese cierre. Si se repite, avisa al administrador.',
    recommended: 'reintentar',
  }),
  'turno-abierto-existente': () => ({
    title: 'Ya hay un turno abierto en el servidor',
    explanation:
      'Este cajero tiene otro turno abierto en el servidor (quizá en otro equipo). El ' +
      'administrador debe cerrarlo; después reintenta.',
    recommended: 'avisar-admin',
  }),
  'turno-ajeno': () => ({
    title: 'El turno es de otro cajero',
    explanation:
      'Solo quien abrió el turno o un administrador puede subir esto. Que esa persona entre ' +
      'en esta caja, o avisa al administrador.',
    recommended: 'avisar-admin',
  }),
  'turno-cerrado': (_dep, record) =>
    record.kind === 'cashMovement'
      ? {
          title: 'El turno ya está cerrado en el servidor',
          explanation:
            'Este gasto llegó después del cierre del turno. Corrígelo para registrarlo en el ' +
            'turno actual, o avisa al administrador.',
          recommended: 'corregir',
        }
      : {
          title: 'El turno ya está cerrado en el servidor',
          explanation:
            'Este registro llegó después del cierre del turno. Avisa al administrador: debe ' +
            'registrarse aparte. No lo descartes sin consultarlo.',
          recommended: 'avisar-admin',
        },
  'turno-no-encontrado': () => ({
    title: 'El servidor no conoce el turno',
    explanation:
      'Reintenta: la caja sube primero el turno y después lo demás. Si se repite, avisa al ' +
      'administrador.',
    recommended: 'reintentar',
  }),
  'sin-stock': () => ({
    title: 'Sin existencias en el servidor',
    explanation:
      'El servidor no tiene stock suficiente para esta venta (puede faltar registrar una entrada ' +
      'de mercancía). Registra la entrada o avisa al administrador; después reintenta.',
    recommended: 'avisar-admin',
  }),
  'promocion-no-vigente': () => ({
    title: 'La promoción ya terminó',
    explanation:
      'La venta se cobró con una promoción que ya no está vigente en el servidor. Avisa al ' +
      'administrador: decide si se respeta el precio cobrado.',
    recommended: 'avisar-admin',
  }),
  desconocido: () => ({
    title: 'Motivo no reconocido',
    explanation:
      'Lee el detalle de abajo y avisa al administrador antes de descartar: puede ser dinero ya cobrado.',
    recommended: 'avisar-admin',
  }),
};

/** Ayuda para un registro bloqueado; sin diagnóstico (versión vieja del IPC) cae en `desconocido`. */
export function describeBlocked(record: BlockedSyncRecord): BlockedHelp {
  const code = record.diagnosis?.code ?? 'desconocido';
  const ayuda = AYUDA[code] ?? AYUDA.desconocido;
  return ayuda(record.diagnosis?.dependency?.label ?? '', record);
}
