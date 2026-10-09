import type { QuoteBar, QuoteSeries, Support } from '@/domain/types'
import { db } from '@/persist/db'
import { fetchHistoryRange, isProxyConfigured } from './gasClient'

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function mergeBars(existing: QuoteBar[], incoming: QuoteBar[]): QuoteBar[] {
  const map = new Map<string, number>()
  for (const b of existing) map.set(b.date, b.close)
  for (const b of incoming) map.set(b.date, b.close)
  return [...map.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export async function getCachedQuotes(ticker: string): Promise<QuoteSeries | undefined> {
  return db.quoteCache.get(ticker)
}

export async function getAllQuoteMaps(): Promise<Map<string, QuoteBar[]>> {
  const all = await db.quoteCache.toArray()
  return new Map(all.map((q) => [q.ticker, q.bars]))
}

export type QuoteRefreshProgress = (info: {
  current: number
  total: number
  ticker: string
}) => void

/**
 * Refresh Yahoo history for mapped supports.
 * Only requests tickers + date ranges (delta from last cached bar).
 */
export async function refreshQuotesForSupports(
  supports: Support[],
  historyStart: string,
  onProgress?: QuoteRefreshProgress,
): Promise<{ updated: string[]; errors: string[]; skipped: number }> {
  const updated: string[] = []
  const errors: string[] = []
  let skipped = 0

  if (!isProxyConfigured()) {
    errors.push('Proxy non configuré — valorisation via prix manuels / import uniquement.')
    return { updated, errors, skipped }
  }

  const tickers = [
    ...new Set(
      supports.map((s) => s.yahooTicker).filter((t): t is string => Boolean(t)),
    ),
  ]

  if (!tickers.length) {
    errors.push('Aucun ticker Yahoo associé — renseignez les correspondances d’abord.')
    return { updated, errors, skipped }
  }

  const end = todayISO()
  // Clamp very old starts (Yahoo/GAS ~2y practical window)
  let start = historyStart
  const minStart = new Date()
  minStart.setUTCFullYear(minStart.getUTCFullYear() - 2)
  const minStartIso = minStart.toISOString().slice(0, 10)
  if (start < minStartIso) start = minStartIso

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    onProgress?.({ current: i + 1, total: tickers.length, ticker })

    try {
      const cached = await db.quoteCache.get(ticker)
      let period1 = start

      if (cached?.bars.length) {
        const last = cached.bars[cached.bars.length - 1].date
        const first = cached.bars[0].date
        // Already covers today and starts early enough → skip
        if (last >= end && first <= start) {
          skipped++
          continue
        }
        // Delta: resume a few days before last bar
        const d = new Date(last + 'T00:00:00Z')
        d.setUTCDate(d.getUTCDate() - 5)
        const resume = d.toISOString().slice(0, 10)
        period1 = resume < start ? start : resume
        // If cache starts too late, refetch from start
        if (first > start) period1 = start
      }

      if (period1 > end) {
        skipped++
        continue
      }

      const bars = await fetchHistoryRange(ticker, period1, end)
      if (!bars.length && !(cached?.bars.length)) {
        errors.push(`${ticker}: historique vide`)
        continue
      }
      const merged = mergeBars(cached?.bars ?? [], bars)
      const series: QuoteSeries = {
        ticker,
        bars: merged,
        updatedAt: new Date().toISOString(),
      }
      await db.quoteCache.put(series)
      updated.push(ticker)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${ticker}: ${msg}`)
    }
  }

  return { updated, errors, skipped }
}

/** True if we have at least one non-empty Yahoo series in cache. */
export async function hasAnyQuoteHistory(): Promise<boolean> {
  const all = await db.quoteCache.toArray()
  return all.some((q) => q.bars.length > 0)
}
