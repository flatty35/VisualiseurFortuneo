import type { QuoteBar, QuoteSeries, Support } from '@/domain/types'
import { quoteKeyForSupport } from '@/engine/valuation'
import { db } from '@/persist/db'
import { isValidIsin } from '@/persist/rekeySupport'
import { mapPool } from './mapPool'
import {
  fetchHistoryBulk,
  fetchHistoryRange,
  isProxyConfigured,
} from './gasClient'
import {
  fetchMorningstarCloses,
  pickHistoryListing,
  searchMorningstarByIsins,
  type MorningstarHit,
} from './morningstarScreener'

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

/**
 * A dense series replaces the cache wholesale — never splice two sources
 * (Morningstar EUR vs Yahoo native currency) into one line.
 */
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

/** Last weekday strictly before `date` (most recent session already closed). */
export function previousWeekday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  do {
    d.setUTCDate(d.getUTCDate() - 1)
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d.toISOString().slice(0, 10)
}

const FRESH_FOR_MS = 6 * 3600_000

/**
 * True when the cached series covers `start` and is recent enough: either
 * fetched in the last 6 h, or its last bar is the previous session (weekends,
 * holidays and Morningstar's one-day lag no longer force a refetch).
 * Rejects short poisoned series (old GAS ychart cache bug).
 */
export function historyIsFresh(
  cached: QuoteSeries | undefined,
  start: string,
  end: string,
  now = Date.now(),
): boolean {
  const bars = cached?.bars
  if (!bars || bars.length < 40) return false
  const first = bars[0].date
  const last = bars[bars.length - 1].date
  // Allow a few days of slack: the first session can follow `start`
  if (first > shiftDays(start, 7)) return false
  if (last >= previousWeekday(end)) return true
  const age = now - Date.parse(cached.updatedAt)
  return Number.isFinite(age) && age >= 0 && age < FRESH_FOR_MS
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

interface RefreshPlan {
  key: string
  isin?: string
  yahooTicker?: string
  cached?: QuoteSeries
}

/** Morningstar series of the best listing (null = not covered). */
async function morningstarHistory(
  plan: RefreshPlan,
  listings: MorningstarHit[],
  start: string,
): Promise<QuoteBar[] | null> {
  if (!plan.isin) return null
  const listing = pickHistoryListing(listings, plan.isin, plan.yahooTicker)
  if (!listing?.secId) return null
  const bars = await fetchMorningstarCloses(listing.secId, { start })
  return bars.length ? bars : null
}

/**
 * Refresh daily history for the given supports.
 *
 * 1. Morningstar (direct browser call, CORS) for every support with a real
 *    ISIN — no proxy needed, ~200 ms per title, closes in EUR.
 * 2. GAS proxy (Yahoo, Boursorama fallback) for LOCAL:… keys and the titles
 *    Morningstar does not cover — one bulk round-trip, singles for the gaps.
 */
export async function refreshQuotesForSupports(
  supports: Support[],
  historyStart: string,
  onProgress?: QuoteRefreshProgress,
): Promise<{ updated: string[]; errors: string[]; skipped: number }> {
  const updated: string[] = []
  const errors: string[] = []
  let skipped = 0

  const byKey = new Map<string, Support>()
  for (const s of supports) {
    const key = quoteKeyForSupport(s)
    if (key && !byKey.has(key)) byKey.set(key, s)
  }
  if (!byKey.size) {
    errors.push(
      'Aucun ISIN ni ticker Yahoo associé — renseignez les correspondances d’abord.',
    )
    return { updated, errors, skipped }
  }

  const end = todayISO()
  // Yahoo / Morningstar practical window: 2 years
  const minStart = new Date()
  minStart.setUTCFullYear(minStart.getUTCFullYear() - 2)
  const minStartIso = minStart.toISOString().slice(0, 10)
  const start = historyStart < minStartIso ? minStartIso : historyStart

  const keys = [...byKey.keys()]
  const cachedRows = await db.quoteCache.bulkGet(keys)
  const plans: RefreshPlan[] = []
  keys.forEach((key, i) => {
    const cached = cachedRows[i]
    if (historyIsFresh(cached, start, end)) {
      skipped++
      return
    }
    const s = byKey.get(key)!
    plans.push({
      key,
      isin: isValidIsin(s.isin) ? s.isin.toUpperCase() : undefined,
      yahooTicker: s.yahooTicker,
      cached,
    })
  })
  if (!plans.length) return { updated, errors, skipped }

  const total = plans.length
  let done = 0
  const writes: QuoteSeries[] = []
  const store = (plan: RefreshPlan, bars: QuoteBar[]) => {
    writes.push({
      ticker: plan.key,
      bars: preferIncomingHistory(plan.cached?.bars, bars),
      updatedAt: new Date().toISOString(),
    })
    updated.push(plan.key)
  }

  // 1) Morningstar — one screener call for all ISINs, then series concurrently
  onProgress?.({ current: 0, total, ticker: 'Morningstar…' })
  let listings: MorningstarHit[] = []
  try {
    listings = await searchMorningstarByIsins(
      plans.map((p) => p.isin).filter((i): i is string => Boolean(i)),
    )
  } catch {
    // Everything falls through to the proxy
  }
  const forProxy: RefreshPlan[] = []
  await mapPool(plans, 6, async (plan) => {
    let bars: QuoteBar[] | null = null
    try {
      bars = await morningstarHistory(plan, listings, start)
    } catch {
      bars = null
    }
    if (bars) {
      done++
      onProgress?.({ current: done, total, ticker: plan.key })
      store(plan, bars)
    } else {
      forProxy.push(plan)
    }
  })

  // 2) GAS proxy for the rest (only Yahoo tickers can go there)
  const proxyPlans = forProxy.filter((p) => p.yahooTicker)
  for (const p of forProxy) {
    if (!p.yahooTicker) {
      done++
      errors.push(`${p.key}: absent de Morningstar et sans ticker Yahoo`)
    }
  }
  if (proxyPlans.length && !isProxyConfigured()) {
    errors.push(
      `${proxyPlans.length} titre(s) hors Morningstar — proxy non configuré pour Yahoo.`,
    )
    proxyPlans.length = 0
  }
  if (proxyPlans.length) {
    onProgress?.({
      current: done + 1,
      total,
      ticker: `proxy ${proxyPlans.length} titre(s)…`,
    })
    let histories = new Map<string, QuoteBar[]>()
    try {
      histories = await fetchHistoryBulk(
        proxyPlans.map((p) => p.yahooTicker!),
        start,
        end,
      )
    } catch {
      // Singles below
    }
    const gaps: RefreshPlan[] = []
    for (const plan of proxyPlans) {
      const bars = histories.get(plan.yahooTicker!) ?? []
      // Spot-only payloads → retry singly (GAS Boursorama fallback)
      if (bars.length < 5) {
        gaps.push(plan)
        continue
      }
      done++
      onProgress?.({ current: done, total, ticker: plan.key })
      store(plan, bars)
    }
    await mapPool(gaps, 6, async (plan) => {
      try {
        const bars = await fetchHistoryRange(plan.yahooTicker!, start, end)
        done++
        onProgress?.({ current: done, total, ticker: plan.key })
        if (bars.length) store(plan, bars)
        else errors.push(`${plan.key}: historique vide`)
      } catch (e) {
        done++
        errors.push(`${plan.key}: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  if (writes.length) await db.quoteCache.bulkPut(writes)
  return { updated, errors, skipped }
}

/** True if we have at least one non-empty series in cache. */
export async function hasAnyQuoteHistory(): Promise<boolean> {
  const all = await db.quoteCache.toArray()
  return all.some((q) => q.bars.length > 0)
}
