import type { QuoteBar, QuoteSeries, Support } from '@/domain/types'
import { db } from '@/persist/db'
import {
  fetchHistoryBulk,
  fetchHistoryRange,
  isProxyConfigured,
} from './gasClient'

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

/** Prefer a dense Yahoo series over a short poisoned cache. */
function preferIncomingHistory(
  existing: QuoteBar[] | undefined,
  incoming: QuoteBar[],
): QuoteBar[] {
  if (incoming.length >= 40) return incoming
  return mergeBars(existing ?? [], incoming)
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

type RefreshPlan = {
  ticker: string
  period1: string
  cached?: QuoteSeries
}

/**
 * Usable 2Y history: enough bars spanning the window.
 * Rejects poisoned short series (GAS ychart cache bug reused 5-day deltas).
 */
function historyLooksUsable(
  cached: QuoteSeries | undefined,
  start: string,
  end: string,
): boolean {
  const bars = cached?.bars
  if (!bars || bars.length < 40) return false
  const first = bars[0].date
  const last = bars[bars.length - 1].date
  if (last < end) return false
  if (first > start) return false
  const spanMs =
    Date.parse(`${last}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)
  // At least ~6 months of calendar span for a 2Y request
  if (!Number.isFinite(spanMs) || spanMs < 180 * 86_400_000) return false
  return true
}

/**
 * Refresh Yahoo history for mapped supports.
 * Prefers one GAS `historybulk` (parallel Yahoo + Boursorama fallback) when
 * tickers share the same window; otherwise concurrent per-ticker fetches.
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

  const plans: RefreshPlan[] = []
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i]
    onProgress?.({
      current: i + 1,
      total: tickers.length,
      ticker: `prépare ${ticker}`,
    })
    const cached = await db.quoteCache.get(ticker)
    let period1 = start

    if (historyLooksUsable(cached, start, end)) {
      skipped++
      continue
    }

    if (cached?.bars.length) {
      const last = cached.bars[cached.bars.length - 1].date
      const first = cached.bars[0].date
      // Thin cache (e.g. 1 spot) → full window from start
      if (cached.bars.length >= 20 && first <= start) {
        const d = new Date(last + 'T00:00:00Z')
        d.setUTCDate(d.getUTCDate() - 5)
        const resume = d.toISOString().slice(0, 10)
        period1 = resume < start ? start : resume
      } else {
        period1 = start
      }
    }

    if (period1 > end) {
      skipped++
      continue
    }
    plans.push({ ticker, period1, cached })
  }

  if (!plans.length) return { updated, errors, skipped }

  // Group by period1 so bulk fetch uses one Yahoo window per group
  const byPeriod = new Map<string, RefreshPlan[]>()
  for (const p of plans) {
    const list = byPeriod.get(p.period1) ?? []
    list.push(p)
    byPeriod.set(p.period1, list)
  }

  let done = 0
  const total = plans.length

  for (const [period1, group] of byPeriod) {
    const names = group.map((g) => g.ticker)
    onProgress?.({
      current: done + 1,
      total,
      ticker: `bulk ${names.length} titre(s)…`,
    })

    let histories = new Map<string, QuoteBar[]>()
    let bulkOk = false
    try {
      histories = await fetchHistoryBulk(names, period1, end)
      bulkOk = true
    } catch (e) {
      // Fall through to concurrent singles
      const msg = e instanceof Error ? e.message : String(e)
      if (!/Action inconnue|historybulk/i.test(msg)) {
        // Still try per-ticker for resilience
      }
    }

    if (bulkOk) {
      const missing: RefreshPlan[] = []
      for (const plan of group) {
        done++
        onProgress?.({ current: done, total, ticker: plan.ticker })
        const bars = histories.get(plan.ticker) ?? []
        if (!bars.length) {
          // Bulk omitted / Yahoo empty — always retry singly (Boursorama fallback)
          missing.push(plan)
          continue
        }
        // Reject spot-only payloads so we still hit Boursorama via single history
        if (bars.length < 5 && (plan.cached?.bars.length ?? 0) < 20) {
          missing.push(plan)
          continue
        }
        try {
          await db.quoteCache.put({
            ticker: plan.ticker,
            bars: preferIncomingHistory(plan.cached?.bars, bars),
            updatedAt: new Date().toISOString(),
          })
          updated.push(plan.ticker)
        } catch (e) {
          errors.push(
            `${plan.ticker}: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      if (missing.length) {
        await mapPool(missing, 6, async (plan) => {
          onProgress?.({ current: done, total, ticker: plan.ticker })
          try {
            const bars = await fetchHistoryRange(plan.ticker, plan.period1, end)
            if (!bars.length) {
              errors.push(`${plan.ticker}: historique vide`)
              return
            }
            await db.quoteCache.put({
              ticker: plan.ticker,
              bars: preferIncomingHistory(plan.cached?.bars, bars),
              updatedAt: new Date().toISOString(),
            })
            updated.push(plan.ticker)
          } catch (e) {
            errors.push(
              `${plan.ticker}: ${e instanceof Error ? e.message : String(e)}`,
            )
          }
        })
      }
      continue
    }

    // Concurrent fallback (old GAS or bulk failed)
    await mapPool(group, 6, async (plan) => {
      done++
      onProgress?.({ current: done, total, ticker: plan.ticker })
      try {
        const bars = await fetchHistoryRange(plan.ticker, plan.period1, end)
        if (!bars.length && !(plan.cached?.bars.length)) {
          errors.push(`${plan.ticker}: historique vide`)
          return
        }
        await db.quoteCache.put({
          ticker: plan.ticker,
          bars: preferIncomingHistory(plan.cached?.bars, bars),
          updatedAt: new Date().toISOString(),
        })
        updated.push(plan.ticker)
      } catch (e) {
        errors.push(
          `${plan.ticker}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    })
  }

  return { updated, errors, skipped }
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++
        await fn(items[i])
      }
    },
  )
  await Promise.all(workers)
}

/** True if we have at least one non-empty Yahoo series in cache. */
export async function hasAnyQuoteHistory(): Promise<boolean> {
  const all = await db.quoteCache.toArray()
  return all.some((q) => q.bars.length > 0)
}
