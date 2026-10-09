import type { QuoteBar, Support } from '@/domain/types'
import type { HoldingsSnapshot } from './positions'

export interface ValuePoint {
  date: string
  securities: number
  cash: number
  total: number
  byIsin: Record<string, number>
}

function priceOnDate(
  date: string,
  support: Support | undefined,
  quotes: Map<string, QuoteBar[]>,
): number | undefined {
  if (!support) return undefined

  // 1) Yahoo history (market) — preferred for time series
  const ticker = support.yahooTicker
  if (ticker) {
    const bars = quotes.get(ticker)
    if (bars?.length) {
      let lo = 0
      let hi = bars.length - 1
      let best: number | undefined
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (bars[mid].date <= date) {
          best = bars[mid].close
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      if (best !== undefined) return best
    }
  }

  // 2) Manual dated override
  const manual = support.manualPrices
    ?.filter((p) => p.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  if (manual) return manual.price

  // 3) Constant import/PRU fallback (flat series if used alone)
  return support.staticPrice
}


export function valueHoldingsSeries(input: {
  holdings: HoldingsSnapshot[]
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  isinFilter?: string[]
}): ValuePoint[] {
  const supportByIsin = new Map(input.supports.map((s) => [s.isin, s]))
  const filter = input.isinFilter ? new Set(input.isinFilter) : null

  return input.holdings.map((h) => {
    let securities = 0
    const byIsin: Record<string, number> = {}
    for (const [isin, qty] of h.quantities) {
      if (filter && !filter.has(isin)) continue
      if (Math.abs(qty) < 1e-10) continue
      const px = priceOnDate(h.date, supportByIsin.get(isin), input.quotes)
      const val = px !== undefined ? qty * px : 0
      byIsin[isin] = val
      securities += val
    }
    const cash = filter ? 0 : h.cash
    return {
      date: h.date,
      securities,
      cash,
      total: securities + cash,
      byIsin,
    }
  })
}

/** Normalize series to base 100 at first non-zero / first point. */
export function toBase100(values: number[]): number[] {
  const base = values.find((v) => v !== 0 && Number.isFinite(v))
  if (base === undefined || base === 0) return values.map(() => 100)
  return values.map((v) => (v / base) * 100)
}

export function sliceByPeriod(
  dates: string[],
  period: '1M' | '3M' | '1Y' | '3Y' | '10Y' | 'MAX',
): { from: string; to: string } {
  if (!dates.length) {
    const today = new Date().toISOString().slice(0, 10)
    return { from: today, to: today }
  }
  const to = dates[dates.length - 1]
  if (period === 'MAX') return { from: dates[0], to }

  const end = new Date(to + 'T00:00:00Z')
  const start = new Date(end)
  switch (period) {
    case '1M':
      start.setUTCMonth(start.getUTCMonth() - 1)
      break
    case '3M':
      start.setUTCMonth(start.getUTCMonth() - 3)
      break
    case '1Y':
      start.setUTCFullYear(start.getUTCFullYear() - 1)
      break
    case '3Y':
      start.setUTCFullYear(start.getUTCFullYear() - 3)
      break
    case '10Y':
      start.setUTCFullYear(start.getUTCFullYear() - 10)
      break
  }
  const from = start.toISOString().slice(0, 10)
  return { from: from < dates[0] ? dates[0] : from, to }
}
