import type { Operation, OperationType } from '@/domain/types'

/** Types that move the cash pocket (Fortuneo signed Montant net / crédit-débit). */
const CASH_TYPES = new Set<OperationType>([
  'ACHAT',
  'VENTE',
  'SCRIPT',
  'RACHAT',
  'DIVIDENDE',
  'VERSEMENT',
  'RETRAIT',
  'FRAIS',
  'TAXE',
  'AUGMENTATION_CAPITAL',
])

/**
 * Cash delta for an operation.
 *
 * Convention (aligned with FortuneoPEAViewer):
 * - Espèces: only VERSEMENT / RETRAIT (trade mirrors ignored at parse time)
 * - Titres: use signed Montant net as-is; OST/détachement → 0 (encaissement keeps the cash)
 */
export function cashImpact(op: Operation): number {
  if (op.type === 'POSITION_SEED') return 0
  if (!CASH_TYPES.has(op.type)) return 0
  if (op.netAmount === undefined || !Number.isFinite(op.netAmount)) return 0

  if (op.type === 'VERSEMENT') return Math.abs(op.netAmount)
  if (op.type === 'RETRAIT') return -Math.abs(op.netAmount)

  // Titres & frais: Fortuneo already signs Montant net (buy/tax negative, sell/div positive)
  return op.netAmount
}

export function affectsCash(type: OperationType): boolean {
  return CASH_TYPES.has(type)
}
