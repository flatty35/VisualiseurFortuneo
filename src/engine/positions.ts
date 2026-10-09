import { quantityDelta } from '@/domain/classify'
import { cashImpact } from '@/engine/cashImpact'
import type { EnvelopeType, Operation, VirtualOpening } from '@/domain/types'

export interface HoldingsSnapshot {
  date: string
  quantities: Map<string, number>
  cash: number
}

function eachBusinessDay(from: string, to: string): string[] {
  const out: string[] = []
  const d = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  while (d <= end) {
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) {
      out.push(d.toISOString().slice(0, 10))
    }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/**
 * Build daily holdings from virtual opening + operations (forward replay).
 */
export function buildHoldingsSeries(input: {
  envelope: EnvelopeType
  operations: Operation[]
  virtualOpening?: VirtualOpening | null
  from?: string
  to?: string
}): HoldingsSnapshot[] {
  const ops = input.operations
    .filter((o) => o.envelope === input.envelope)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  const vo = input.virtualOpening
  const startDate =
    input.from ??
    vo?.date ??
    ops[0]?.date ??
    new Date().toISOString().slice(0, 10)
  const endDate = input.to ?? new Date().toISOString().slice(0, 10)

  const qty = new Map<string, number>()
  let cash = 0

  if (vo && vo.envelope === input.envelope) {
    cash = vo.cash
    for (const p of vo.positions) {
      qty.set(p.isin, p.quantity)
    }
  }

  // Apply seed ops that fall on start if no VO provided
  const byDate = new Map<string, Operation[]>()
  for (const op of ops) {
    // Skip POSITION_SEED qty/cash if VO already applied
    if (vo && op.synthetic && op.type === 'POSITION_SEED') continue
    const list = byDate.get(op.date) ?? []
    list.push(op)
    byDate.set(op.date, list)
  }

  const days = eachBusinessDay(startDate, endDate)
  const series: HoldingsSnapshot[] = []

  for (const date of days) {
    const dayOps = (byDate.get(date) ?? []).slice().sort((a, b) => {
      // Versements before buys so EOD cash is correct; chart spikes handled separately
      const rank = (o: Operation) =>
        o.type === 'VERSEMENT' || o.type === 'RETRAIT'
          ? 0
          : o.type === 'DIVIDENDE'
            ? 1
            : 2
      return rank(a) - rank(b) || a.id.localeCompare(b.id)
    })
    for (const op of dayOps) {
      if (op.type === 'POSITION_SEED' && !op.isin && op.netAmount !== undefined) {
        cash = op.netAmount
        continue
      }
      if (op.type === 'POSITION_SEED' && op.isin && op.quantity !== undefined) {
        qty.set(op.isin, op.quantity)
        continue
      }
      cash += cashImpact(op)
      if (op.isin && op.quantity !== undefined) {
        const delta = quantityDelta(op.type, op.quantity)
        qty.set(op.isin, (qty.get(op.isin) ?? 0) + delta)
      }
    }
    series.push({
      date,
      quantities: new Map(qty),
      cash,
    })
  }

  return series
}

