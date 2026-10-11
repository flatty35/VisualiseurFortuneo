import type { Operation, OperationType } from '@/domain/types'

const BUY_TYPES = new Set<OperationType>([
  'ACHAT',
  'SCRIPT',
  'AUGMENTATION_CAPITAL',
])

const SELL_TYPES = new Set<OperationType>(['VENTE', 'RACHAT'])

/**
 * Signed trade cash (Montant net), buy &lt; 0, sell &gt; 0.
 * Used for TRI apports/retraits — not for the cash pocket balance.
 */
export function tradeCashAmount(op: Operation): number {
  if (op.synthetic || !op.isin) return 0
  // Ignore 0 — empty Montant net must not block the qty×prix fallback
  // (0€ price + lost net → no TRI apport while valo jumps → TRI spike).
  if (
    op.netAmount !== undefined &&
    Number.isFinite(op.netAmount) &&
    Math.abs(op.netAmount) > 1e-9
  ) {
    return op.netAmount
  }
  if (
    op.quantity !== undefined &&
    op.price !== undefined &&
    Number.isFinite(op.price) &&
    Math.abs(op.price) > 1e-12
  ) {
    const gross = Math.abs(op.quantity * op.price) + Math.abs(op.fees ?? 0)
    if (BUY_TYPES.has(op.type)) return -gross
    if (SELL_TYPES.has(op.type)) return gross
  }
  return 0
}

/**
 * Cash pocket delta for holdings replay.
 *
 * Titres-only model: trades do **not** accumulate a cash balance.
 * Money is treated as an external apport the day of an achat (TRI),
 * then spent immediately — EOD cash stays 0 historically.
 */
export function cashImpact(_op: Operation): number {
  return 0
}

export function affectsCash(type: OperationType): boolean {
  return BUY_TYPES.has(type) || SELL_TYPES.has(type)
}

export function isBuyTrade(type: OperationType): boolean {
  return BUY_TYPES.has(type)
}

export function isSellTrade(type: OperationType): boolean {
  return SELL_TYPES.has(type)
}
