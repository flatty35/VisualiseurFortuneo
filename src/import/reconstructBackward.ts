import { reverseQuantityDelta } from '@/domain/classify'
import { makeOperationId, operationFingerprint } from '@/domain/fingerprint'
import { cashImpact } from '@/engine/cashImpact'
import type {
  EnvelopeType,
  Operation,
  ParsedPosition,
  VirtualOpening,
  VirtualOpeningPosition,
} from '@/domain/types'

/**
 * Reconstruct virtual opening at the start of the known history window
 * by walking backward from current open positions + current cash.
 *
 * Cash ops must be the espèces ledger only (no ISIN). Titres rows
 * contribute quantity reversals but cashImpact() ignores them.
 */
export function reconstructVirtualOpening(input: {
  envelope: EnvelopeType
  positions: ParsedPosition[]
  operations: Operation[]
  currentCash?: number
}): VirtualOpening {
  const { envelope, positions, operations } = input

  const qty = new Map<string, { name: string; quantity: number }>()
  for (const p of positions) {
    if (!p.isin || p.isin === 'CASH') continue
    const nameLow = p.name.toLowerCase()
    if (
      nameLow.includes('especes') ||
      nameLow.includes('espèces') ||
      nameLow.includes('liquidit')
    ) {
      continue
    }
    qty.set(p.isin, { name: p.name, quantity: p.quantity })
  }

  const sortedDesc = [...operations]
    .filter((o) => !o.synthetic)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  // Default current cash = 0 when unknown (never invent a negative "estimate"
  // from truncated history starting at 0 — that was producing ~-valo titres).
  let cash = input.currentCash ?? 0

  for (const op of sortedDesc) {
    cash -= cashImpact(op)
    if (!op.isin || op.quantity === undefined) continue
    const delta = reverseQuantityDelta(op.type, op.quantity)
    if (delta === 0) continue
    const cur = qty.get(op.isin) ?? { name: op.name ?? op.isin, quantity: 0 }
    cur.quantity += delta
    cur.name = op.name ?? cur.name
    qty.set(op.isin, cur)
  }

  const openingPositions: VirtualOpeningPosition[] = [...qty.entries()]
    .filter(([, v]) => Math.abs(v.quantity) > 1e-8)
    .map(([isin, v]) => ({
      isin,
      name: v.name,
      quantity: Math.round(v.quantity * 1e6) / 1e6,
    }))
    .sort((a, b) => a.isin.localeCompare(b.isin))

  const dates = operations.map((o) => o.date).sort()
  const openingDate = dates[0] ?? new Date().toISOString().slice(0, 10)

  return {
    envelope,
    date: openingDate,
    cash: Math.round(cash * 100) / 100,
    positions: openingPositions,
    computedAt: new Date().toISOString(),
  }
}

/** Build POSITION_SEED synthetic operations from a VirtualOpening. */
export function seedsFromVirtualOpening(vo: VirtualOpening): Operation[] {
  const seeds: Operation[] = []
  let i = 0

  for (const p of vo.positions) {
    const fingerprint = operationFingerprint({
      envelope: vo.envelope,
      date: vo.date,
      type: 'POSITION_SEED',
      isin: p.isin,
      quantity: p.quantity,
      label: `SEED ${p.isin}`,
    })
    seeds.push({
      id: makeOperationId(fingerprint, i++),
      fingerprint,
      envelope: vo.envelope,
      date: vo.date,
      type: 'POSITION_SEED',
      isin: p.isin,
      name: p.name,
      quantity: p.quantity,
      label: `Position initiale virtuelle — ${p.name}`,
      synthetic: true,
    })
  }

  const cashFp = operationFingerprint({
    envelope: vo.envelope,
    date: vo.date,
    type: 'POSITION_SEED',
    netAmount: vo.cash,
    label: 'SEED CASH',
  })
  seeds.push({
    id: makeOperationId(cashFp, i++),
    fingerprint: cashFp,
    envelope: vo.envelope,
    date: vo.date,
    type: 'POSITION_SEED',
    netAmount: vo.cash,
    label: 'Espèces initiales virtuelles',
    synthetic: true,
  })

  return seeds
}

/** Forward cash cumsum (for diagnostics). Does not invent an opening balance. */
export function forwardCashDelta(operations: Operation[]): number {
  let cash = 0
  const sorted = [...operations]
    .filter((o) => !o.synthetic)
    .sort((a, b) => a.date.localeCompare(b.date))
  for (const op of sorted) cash += cashImpact(op)
  return Math.round(cash * 100) / 100
}
