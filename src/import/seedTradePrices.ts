import type { Operation } from '@/domain/types'
import type { Portfolio } from '@/domain/portfolioModel'
import { GetterType } from '@/domain/portfolioModel'

function dateToDateTime(date: string): number {
  const t = Date.parse(`${date}T12:00:00Z`)
  return Number.isFinite(t) ? t : 0
}

const TRADE_TYPES = new Set([
  'ACHAT',
  'VENTE',
  'SCRIPT',
  'RACHAT',
  'ACTIONS_GRATUITES',
  'AUGMENTATION_CAPITAL',
])

/**
 * Seed dated static prices from trade execution prices (incl. 0 on worthless
 * exits). Market history still wins in {@link priceOnDate}; these fill gaps
 * for turbos / certificates absent from Yahoo.
 */
export function seedTradePricesFromOperations(
  portfolio: Portfolio,
  operations: Operation[],
): number {
  /** isin → date → last trade price that day */
  const byIsin = new Map<string, Map<string, number>>()

  for (const op of operations) {
    if (!op.isin || op.synthetic || !TRADE_TYPES.has(op.type)) continue
    if (op.price === undefined || !Number.isFinite(op.price) || op.price < 0) {
      continue
    }
    let dates = byIsin.get(op.isin)
    if (!dates) {
      dates = new Map()
      byIsin.set(op.isin, dates)
    }
    dates.set(op.date, op.price)
  }

  let seeded = 0
  for (const [isin, dates] of byIsin) {
    const support = portfolio.findSupportByKey(isin)
    if (!support) continue

    const existing = new Map(
      support.staticDatedValues
        .filter(([ts]) => ts > 0)
        .map(([ts, px]) => [new Date(ts).toISOString().slice(0, 10), px]),
    )

    let changed = false
    for (const [date, price] of dates) {
      // Keep an explicit user/manual override if already present and different
      // from a flat zero-only seed — but always write when missing.
      if (!existing.has(date)) {
        existing.set(date, price)
        changed = true
        seeded += 1
      } else if (existing.get(date) !== price && price === 0) {
        // Worthless exit must pin the day to 0 even if a prior trade that day
        // left a positive mid-day print.
        existing.set(date, 0)
        changed = true
        seeded += 1
      }
    }

    if (!changed) continue

    const zeroSlot = support.staticDatedValues.find(([ts]) => ts === 0)
    const dated = [...existing.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, px]) => [dateToDateTime(d), px] as [number, number])
    support.staticDatedValues = zeroSlot ? [zeroSlot, ...dated] : dated

    // Prefer STATIC getter when no Yahoo ticker so valuation can use seeds.
    if (!support.yahooFinanceTicker && support.getterType === GetterType.END) {
      support.getterType = GetterType.STATIC
    }

    // Last known = most recent trade price (incl. 0 after knockout)
    const last = [...dates.entries()].sort((a, b) => a[0].localeCompare(b[0])).at(-1)
    if (last) {
      support.lastKnownValue = [dateToDateTime(last[0]), last[1]]
    }
  }

  return seeded
}
