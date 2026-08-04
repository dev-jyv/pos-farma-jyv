import { ControlledGroup, Product } from '../models';

/**
 * Reglas de medicamentos controlados — espejo de
 * `backend-farma-jyv/functions/src/constants/controlled.ts` y de
 * `assertPrescriptionRules` (`services/controlled.service.ts`).
 *
 * Se replican en el POS para **bloquear en el mostrador**, no para reemplazar la
 * validación del servidor: el cajero tiene que enterarse antes de cobrar (con el
 * paciente enfrente y la receta en la mano), no con un 400 después de pasar la
 * tarjeta. El backend sigue siendo la autoridad.
 *
 *  I   — estupefacientes: receta especial con código de barras, se retiene.
 *  II  — psicotrópicos: receta especial, se retiene.
 *  III — psicotrópicos de menor riesgo: receta médica que se retiene.
 *  IV  — antibióticos y otros de receta: se sella y se devuelve al paciente.
 *  V   — venta en farmacia sin receta.
 *  VI  — venta libre.
 */

export interface ControlledGroupRule {
  group: ControlledGroup;
  label: string;
  /** Etiqueta corta para chips en pantalla. */
  shortLabel: string;
  requiresPrescription: boolean;
  /** El folio de la receta es obligatorio, no opcional. */
  requiresFolio: boolean;
  /** La receta se queda en la farmacia; el cajero debe confirmarlo. */
  retainsPrescription: boolean;
  /** Debe quedar renglón en el libro de control (`controlledSalesLedger`). */
  requiresLedger: boolean;
}

export const CONTROLLED_GROUP_RULES: Record<ControlledGroup, ControlledGroupRule> = {
  I: {
    group: 'I',
    label: 'Grupo I (estupefacientes)',
    shortLabel: 'Grupo I',
    requiresPrescription: true,
    requiresFolio: true,
    retainsPrescription: true,
    requiresLedger: true,
  },
  II: {
    group: 'II',
    label: 'Grupo II (psicotrópicos)',
    shortLabel: 'Grupo II',
    requiresPrescription: true,
    requiresFolio: true,
    retainsPrescription: true,
    requiresLedger: true,
  },
  III: {
    group: 'III',
    label: 'Grupo III (psicotrópicos)',
    shortLabel: 'Grupo III',
    requiresPrescription: true,
    requiresFolio: true,
    retainsPrescription: true,
    requiresLedger: true,
  },
  IV: {
    group: 'IV',
    label: 'Grupo IV (antibióticos y otros de receta)',
    shortLabel: 'Grupo IV',
    requiresPrescription: true,
    requiresFolio: false,
    retainsPrescription: false,
    requiresLedger: true,
  },
  V: {
    group: 'V',
    label: 'Grupo V (venta en farmacia sin receta)',
    shortLabel: 'Grupo V',
    requiresPrescription: false,
    requiresFolio: false,
    retainsPrescription: false,
    requiresLedger: false,
  },
  VI: {
    group: 'VI',
    label: 'Grupo VI (venta libre)',
    shortLabel: 'Grupo VI',
    requiresPrescription: false,
    requiresFolio: false,
    retainsPrescription: false,
    requiresLedger: false,
  },
};

export const CONTROLLED_GROUPS: ControlledGroup[] = ['I', 'II', 'III', 'IV', 'V', 'VI'];

export function getControlledRule(group?: ControlledGroup): ControlledGroupRule | null {
  return group ? CONTROLLED_GROUP_RULES[group] : null;
}

export function isControlledGroup(value: unknown): value is ControlledGroup {
  return typeof value === 'string' && (CONTROLLED_GROUPS as string[]).includes(value);
}

export interface ControlledRequirements {
  /** Grupos controlados presentes en la venta. */
  groups: ControlledGroup[];
  requiresPrescription: boolean;
  requiresFolio: boolean;
  requiresRetention: boolean;
  /** Grupos que dejarán renglón en el libro de control. */
  ledgerGroups: ControlledGroup[];
}

type ControlledProduct = Pick<Product, 'controlledGroup' | 'requiresPrescription'>;

export function resolveControlledRequirements(
  products: ControlledProduct[],
): ControlledRequirements {
  const groups = new Set<ControlledGroup>();
  const ledgerGroups = new Set<ControlledGroup>();
  let requiresPrescription = false;
  let requiresFolio = false;
  let requiresRetention = false;

  for (const product of products) {
    const rule = getControlledRule(product.controlledGroup);
    if (!rule) {
      // Sin grupo capturado se respeta el flag suelto heredado del catálogo viejo.
      requiresPrescription = requiresPrescription || Boolean(product.requiresPrescription);
      continue;
    }
    groups.add(rule.group);
    requiresPrescription = requiresPrescription || rule.requiresPrescription;
    requiresFolio = requiresFolio || rule.requiresFolio;
    requiresRetention = requiresRetention || rule.retainsPrescription;
    if (rule.requiresLedger) {
      ledgerGroups.add(rule.group);
    }
  }

  return {
    groups: [...groups],
    requiresPrescription,
    requiresFolio,
    requiresRetention,
    ledgerGroups: [...ledgerGroups],
  };
}

/** Cédula profesional mexicana: 7 u 8 dígitos (misma validación que el backend). */
export const DOCTOR_LICENSE_PATTERN = /^\d{7,8}$/;

export function isValidDoctorLicense(value: string): boolean {
  return DOCTOR_LICENSE_PATTERN.test(value.trim());
}

export interface PrescriptionInput {
  doctorName: string;
  doctorLicense: string;
  folio: string;
  retained: boolean;
}

/**
 * Primer motivo por el que la venta no puede cobrarse, o `null` si cumple.
 * Los mensajes replican los del backend para que el cajero lea siempre lo mismo.
 */
export function validatePrescription(
  requirements: ControlledRequirements,
  input: PrescriptionInput,
): string | null {
  if (!requirements.requiresPrescription) {
    return null;
  }
  if (!input.doctorName.trim()) {
    const labels = requirements.groups
      .map((group) => CONTROLLED_GROUP_RULES[group].label)
      .join(', ');
    return labels
      ? `Esta venta incluye ${labels} y requiere datos de receta médica.`
      : 'Esta venta requiere datos de receta médica.';
  }
  if (!isValidDoctorLicense(input.doctorLicense)) {
    return 'La cédula profesional debe tener 7 u 8 dígitos.';
  }
  if (requirements.requiresFolio && !input.folio.trim()) {
    return 'Los medicamentos de los grupos I a III requieren el folio de la receta.';
  }
  if (requirements.requiresRetention && !input.retained) {
    return 'Los grupos I a III exigen retener la receta: confirma la retención.';
  }
  return null;
}
