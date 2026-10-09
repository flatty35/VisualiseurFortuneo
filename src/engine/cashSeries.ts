import { cashImpact } from '@/engine/cashImpact'
import type { Operation } from '@/domain/types'

export interface CashPoint {
  /** Display / axis key (may suffix same-day spike) */
  date: string
  /** True calendar day YYYY-MM-DD */
  day: string
  cash: number
  /** Spike top after versements, before trades */
  isSpike?: boolean
}

function opOrder(op: Operation): number {
  // External cash first so same-day abondement appears before buys
  if (op.type === 'VERSEMENT' || op.type === 'RETRAIT') return 0
  if (op.type === 'DIVIDENDE') return 1
  if (op.type === 'FRAIS' || op.type === 'TAXE') return 2
  return 3 // buys/sells
}

/**
 * Build a cash curve with visible spikes when the account is funded
 * before purchases on the same day.
 *
 * Data model (same as FortuneoPEAViewer):
 * - VERSEMENT / RETRAIT from historique espèces
 * - signed Montant net from historique titres (not the espèces trade mirrors)
 */
export function buildCashSpikeSeries(input: {
  operations: Operation[]
  openingCash: number
  from: string
  to: string
}): CashPoint[] {
  const ops = [...input.operations]
    .filter((o) => !o.synthetic)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        opOrder(a) - opOrder(b) ||
        a.id.localeCompare(b.id),
    )

  const byDate = new Map<string, Operation[]>()
  for (const op of ops) {
    if (op.date < input.from || op.date > input.to) continue
    const list = byDate.get(op.date) ?? []
    list.push(op)
    byDate.set(op.date, list)
  }

  const days = eachBusinessDay(input.from, input.to)
  const points: CashPoint[] = []
  let cash = input.openingCash

  for (const day of days) {
    const dayOps = byDate.get(day) ?? []
    if (!dayOps.length) {
      points.push({ date: day, day, cash })
      continue
    }

    const inflows = dayOps.filter(
      (o) => o.type === 'VERSEMENT' || o.type === 'DIVIDENDE',
    )
    const rest = dayOps.filter(
      (o) => o.type !== 'VERSEMENT' && o.type !== 'DIVIDENDE',
    )

    // Apply abondements / dividends first
    let inflowDelta = 0
    for (const op of inflows) inflowDelta += cashImpact(op)
    cash += inflowDelta

    const hasTradeOutflow = rest.some((o) => cashImpact(o) < 0)
    if (inflowDelta > 0 && hasTradeOutflow) {
      // Peak just after funding, before buys
      points.push({ date: `${day}·abo`, day, cash, isSpike: true })
    }

    for (const op of rest) cash += cashImpact(op)
    points.push({ date: day, day, cash })
  }

  return points
}

function eachBusinessDay(from: string, to: string): string[] {
  const out: string[] = []
  const d = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  while (d <= end) {
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}
