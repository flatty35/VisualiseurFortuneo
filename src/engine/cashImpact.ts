import type { Operation, OperationType } from '@/domain/types'

const BUY_TYPES = new Set<OperationType>([
  'ACHAT',
  'SCRIPT',
  'AUGMENTATION_CAPITAL',
])

const SELL_TYPES = new Set<OperationType>(['VENTE', 'RACHAT'])

const CASH_LEDGER_TYPES = new Set<OperationType>([
  'VERSEMENT',
  'RETRAIT',
  'FRAIS',
  'TAXE',
  'DIVIDENDE',
])

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

export type CashImpactMode = 'titres' | 'ledger'

/**
 * Cash pocket delta for holdings replay.
 *
 * - `titres` (Fortuneo default): trades do **not** accumulate a cash balance.
 *   Money is an external apport the day of an achat (TRI), then spent immediately.
 *   EOD cash stays 0 historically; idle cash is shown only via reportedCash.
 * - `ledger` (Saxo full history): every booked amount moves the cash line,
 *   including trades, dividendes, intérêts and coûts de portage.
 */
export function cashImpact(
  op: Operation,
  mode: CashImpactMode = 'titres',
): number {
  if (op.synthetic) return 0
  if (mode !== 'ledger') return 0

  if (CASH_LEDGER_TYPES.has(op.type)) {
    return op.netAmount !== undefined && Number.isFinite(op.netAmount)
      ? op.netAmount
      : 0
  }

  if (BUY_TYPES.has(op.type) || SELL_TYPES.has(op.type)) {
    return tradeCashAmount(op)
  }

  return 0
}

export function affectsCash(type: OperationType): boolean {
  return (
    BUY_TYPES.has(type) ||
    SELL_TYPES.has(type) ||
    CASH_LEDGER_TYPES.has(type)
  )
}

export function isBuyTrade(type: OperationType): boolean {
  return BUY_TYPES.has(type)
}

export function isSellTrade(type: OperationType): boolean {
  return SELL_TYPES.has(type)
}

/** Saxo envelopes: full cash journal from account opening. */
export function cashModeForEnvelope(
  envelope: string | undefined,
): CashImpactMode {
  return envelope === 'CTO_SAXO' ||
    envelope === 'PEA_SAXO' ||
    envelope === 'PEA_PME_SAXO'
    ? 'ledger'
    : 'titres'
}

export function isSaxoCashLedger(envelope: string | undefined): boolean {
  return cashModeForEnvelope(envelope) === 'ledger'
}
