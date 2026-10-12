import { quantityDelta } from '@/domain/classify'
import { cashImpact } from '@/engine/cashImpact'
import { eachBusinessDay, toBusinessDay } from '@/engine/businessDays'
import type { EnvelopeType, Operation, VirtualOpening } from '@/domain/types'

export interface HoldingsSnapshot {
  date: string
  quantities: Map<string, number>
  cash: number
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
    // Weekend / holiday settlement → next weekday so cash & qty are not dropped
    const day = toBusinessDay(op.date)
    const list = byDate.get(day) ?? []
    list.push(op)
    byDate.set(day, list)
  }

  const applyDay = (date: string) => {
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
  }

  // A window starting after the opening must still carry earlier trades
  for (const date of [...byDate.keys()].filter((d) => d < startDate).sort()) {
    applyDay(date)
  }

  const days = eachBusinessDay(startDate, endDate)
  const series: HoldingsSnapshot[] = []

  for (const date of days) {
    applyDay(date)
    series.push({
      date,
      quantities: new Map(qty),
      cash,
    })
  }

  return series
}

