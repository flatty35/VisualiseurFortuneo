import type { Operation, OperationType } from '@/domain/types'

/** Types that may carry a signed cash amount on the espèces ledger. */
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
  'UNKNOWN',
])

/**
 * Cash delta for an operation.
 *
 * Cash pocket follows the Fortuneo **espèces** file (Débit/Crédit) only.
 * Titres rows (have an ISIN) drive quantities — their Montant net is ignored
 * here so we do not drift vs the bank cash ledger.
 */
export function cashImpact(op: Operation): number {
  if (op.type === 'POSITION_SEED') return 0
  // Titres / seeded lines with a security key → quantity only
  if (op.isin) return 0
  if (!CASH_TYPES.has(op.type)) return 0
  if (op.netAmount === undefined || !Number.isFinite(op.netAmount)) return 0
  return op.netAmount
}

export function affectsCash(type: OperationType): boolean {
  return CASH_TYPES.has(type)
}
