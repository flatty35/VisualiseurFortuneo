/**
 * Fast ISIN + Yahoo ticker resolution for imported titles.
 *
 * Only uses the two public sources the browser can call directly (CORS):
 *  - Fortuneo Accès Marchés search — same libellés as the exports, gives
 *    ISIN + mnemo + place (→ Yahoo suffix).
 *  - Morningstar screener — covers OPCVM / ETFs Fortuneo misses, gives ISIN
 *    + ticker / exchange, or PerformanceId (→ `0P….F` on Yahoo for funds).
 *
 * Titles are resolved concurrently and persisted with one save. Anything not
 * confidently matched is left untouched for the GAS cascade / manual edit.
 */
import type { Support } from '@/domain/types'
import { GetterType, type Portfolio } from '@/domain/portfolioModel'
import { isLocalSupportId } from '@/import/resolveIsin'
import { isValidIsin, rekeyInPortfolio } from '@/persist/rekeySupport'
import { loadProjected, updatePortfolio } from '@/persist/portfolioStore'
import {
  fortuneoHitAcceptable,
  guessYahooTicker,
  pickBestFortuneoHit,
  searchFortuneo,
  type FortuneoHit,
} from './fortuneoSearch'
import {
  morningstarCloseOn,
  searchMorningstar,
  type MorningstarHit,
} from './morningstarScreener'
import {
  cleanLabelForSearch,
  isQualifiedYahooTicker,
  nameMatchBonus,
  passesNameQualityGate,
  shareClassConflict,
  usListingPenalty,
} from './nameMatch'
import { mapPool } from './mapPool'
import { googleTickerFromYahoo } from './tickerMatch'
import { lookupSeedIsin, lookupSeedTicker, normalizeMatchKey } from './tickerSeed'

export interface IdentityInput {
  /** Current support key (real ISIN or LOCAL:…) */
  key: string
  name: string
  /** Fortuneo « Place » most seen in the history for this title */
  place?: string
  /** One EUR trade of the title — cross-checks label-only matches */
  trade?: { date: string; price: number }
}

export interface IdentityResult {
  key: string
  name: string
  isin?: string
  ticker?: string
  source: 'seed' | 'fortuneo' | 'morningstar' | 'none'
  detail: string
}

export interface ResolverSources {
  fortuneo: (term: string) => Promise<FortuneoHit[]>
  morningstar: (term: string) => Promise<MorningstarHit[]>
  /** EUR close of an ISIN on a day (undefined = unknown, check skipped) */
  closeOn?: (isin: string, date: string) => Promise<number | undefined>
}

const defaultSources: ResolverSources = {
  fortuneo: async (term) => (await searchFortuneo(term)).hits,
  morningstar: (term) => searchMorningstar(term),
  closeOn: morningstarCloseOn,
}

/** Minimum name similarity to accept a Morningstar hit without review. */
const MORNINGSTAR_MIN_NAME_BONUS = 50

/** Trade price vs market close on the trade day: beyond ±30 % it is another title. */
const TRADE_PRICE_MAX_RATIO = 1.3

/** False only when the candidate's market price contradicts the trade. */
async function priceMatchesTrade(
  isin: string,
  trade: IdentityInput['trade'],
  sources: ResolverSources,
): Promise<boolean> {
  if (!trade || !sources.closeOn || !(trade.price > 0)) return true
  const close = await safe(sources.closeOn(isin, trade.date), undefined)
  if (close === undefined || !(close > 0)) return true
  const ratio = trade.price / close
  return ratio <= TRADE_PRICE_MAX_RATIO && ratio >= 1 / TRADE_PRICE_MAX_RATIO
}

const PLACE_TO_MIC: Array<[string, string]> = [
  ['euronext paris', 'XPAR'],
  ['euronext amsterdam', 'XAMS'],
  ['euronext brussels', 'XBRU'],
  ['euronext lisbon', 'XLIS'],
  ['frankfurt', 'XFRA'],
  ['xetra', 'XETR'],
  ['milan', 'XMIL'],
  ['madrid', 'XMAD'],
]

function normalizePlace(place?: string): string {
  return normalizeMatchKey(place || '')
}

function samePlace(a?: string, b?: string): boolean {
  const x = normalizePlace(a)
  const y = normalizePlace(b)
  return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)))
}

function micForPlace(place?: string): string | undefined {
  const p = normalizePlace(place)
  return PLACE_TO_MIC.find(([needle]) => p.includes(needle))?.[1]
}

/** Among listings of one ISIN, prefer the history's place, then Paris. */
function pickListing(hits: FortuneoHit[], place?: string): FortuneoHit | undefined {
  const withTicker = hits.filter((h) => guessYahooTicker(h))
  const pool = withTicker.length ? withTicker : hits
  return (
    pool.find((h) => samePlace(h.place, place)) ??
    pool.find((h) => h.codePlace === 23) ??
    pool[0]
  )
}

function pickMorningstar(
  hits: MorningstarHit[],
  name: string,
  place?: string,
): MorningstarHit | undefined {
  const mic = micForPlace(place)
  const scored = hits
    .filter((h) => passesNameQualityGate(name, h.name))
    .filter((h) => !shareClassConflict(name, h.name))
    .map((h) => {
      const bonus = nameMatchBonus(name, h.name)
      let score = bonus
      if (h.currency === 'EUR') score += 30
      if (h.yahooTicker) score += 20
      if (mic && h.mic === mic) score += 40
      score += usListingPenalty(h.isin, h.yahooTicker)
      return { h, bonus, score }
    })
    .filter((x) => x.bonus >= MORNINGSTAR_MIN_NAME_BONUS)
    .sort((a, b) => b.score - a.score)
  return scored[0]?.h
}

function memoize<T>(fn: (term: string) => Promise<T>): (term: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>()
  return (term) => {
    const key = term.trim().toLowerCase()
    let p = cache.get(key)
    if (!p) {
      p = fn(term).catch((e) => {
        cache.delete(key)
        throw e
      })
      cache.set(key, p)
    }
    return p
  }
}

async function safe<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work
  } catch {
    return fallback
  }
}

/** Yahoo ticker for a known ISIN: Fortuneo listing, else Morningstar. */
async function tickerForIsin(
  isin: string,
  place: string | undefined,
  sources: ResolverSources,
): Promise<{ ticker?: string; via?: string }> {
  const ft = await safe(sources.fortuneo(isin), [])
  const listing = pickListing(
    ft.filter((h) => (h.codeIsin || '').toUpperCase() === isin),
    place,
  )
  const fromFt = listing ? guessYahooTicker(listing) : undefined
  if (fromFt) return { ticker: fromFt, via: `fortuneo ${listing?.place ?? ''}`.trim() }

  const ms = await safe(sources.morningstar(isin), [])
  const exact = ms.filter((h) => h.isin === isin && h.yahooTicker)
  const mic = micForPlace(place)
  const best =
    exact.find((h) => mic && h.mic === mic) ??
    exact.find((h) => h.currency === 'EUR') ??
    exact[0]
  if (best?.yahooTicker) return { ticker: best.yahooTicker, via: 'morningstar' }
  return {}
}

export async function resolveIdentity(
  input: IdentityInput,
  sources: ResolverSources = defaultSources,
): Promise<IdentityResult> {
  const { key, name, place, trade } = input
  const knownIsin = isValidIsin(key) ? key.toUpperCase() : undefined
  const base = { key, name }

  const seedIsin = lookupSeedIsin(name)
  const seedTicker = lookupSeedTicker(name)
  if ((knownIsin || seedIsin) && seedTicker) {
    return {
      ...base,
      isin: knownIsin ?? seedIsin,
      ticker: seedTicker,
      source: 'seed',
      detail: 'table locale',
    }
  }

  // Held positions: the ISIN is known, only the listing is missing
  const isinForTicker = knownIsin ?? seedIsin
  if (isinForTicker) {
    const { ticker, via } = await tickerForIsin(isinForTicker, place, sources)
    return {
      ...base,
      isin: isinForTicker,
      ticker: ticker ?? seedTicker,
      source: ticker ? (via?.startsWith('fortuneo') ? 'fortuneo' : 'morningstar') : 'none',
      detail: ticker ? `ISIN → ${via}` : 'ISIN connu, aucun ticker trouvé',
    }
  }

  // Label-only titles (sold positions): Fortuneo libellé, then cleaned libellé
  const queries = [name.trim(), cleanLabelForSearch(name)].filter(
    (q, i, arr) => q.length >= 2 && arr.indexOf(q) === i,
  )
  const rejected: string[] = []
  for (const q of queries) {
    const hits = (await safe(sources.fortuneo(q), [])).filter((h) =>
      isValidIsin((h.codeIsin || '').toUpperCase()),
    )
    if (!hits.length) continue
    const onPlace = place ? hits.filter((h) => samePlace(h.place, place)) : []
    // A known place that no hit trades on is a mismatch (e.g. CSG Amsterdam vs TSX)
    if (place && !onPlace.length) continue
    const pool = onPlace.length ? onPlace : hits
    const best = pickBestFortuneoHit(pool, name)
    if (!best) continue
    const ok =
      fortuneoHitAcceptable(best, name) ||
      (onPlace.length > 0 && passesNameQualityGate(name, best.libelle || ''))
    if (!ok) continue
    const isin = best.codeIsin!.toUpperCase()
    if (rejected.includes(isin)) continue
    if (!(await priceMatchesTrade(isin, trade, sources))) {
      rejected.push(isin)
      continue
    }
    const ticker =
      guessYahooTicker(best) ?? (await tickerForIsin(isin, place, sources)).ticker
    return {
      ...base,
      isin,
      ticker: ticker ?? seedTicker,
      source: 'fortuneo',
      detail: `« ${q} » → ${isin} ${best.mnemo ?? ''} @${best.place ?? '?'}`.trim(),
    }
  }

  const msQuery = cleanLabelForSearch(name) || name
  const ms = await safe(sources.morningstar(msQuery), [])
  const best = pickMorningstar(
    ms.filter((h) => !rejected.includes(h.isin)),
    name,
    place,
  )
  if (best && (await priceMatchesTrade(best.isin, trade, sources))) {
    const ticker =
      best.yahooTicker ?? (await tickerForIsin(best.isin, place, sources)).ticker
    return {
      ...base,
      isin: best.isin,
      ticker: ticker ?? seedTicker,
      source: 'morningstar',
      detail: `« ${msQuery} » → ${best.isin} ${best.name}`,
    }
  }

  return {
    ...base,
    ticker: seedTicker,
    source: seedTicker ? 'seed' : 'none',
    detail: rejected.length || best
      ? `cours incompatible avec l'ordre du ${trade?.date} (${[...rejected, best?.isin].filter(Boolean).join(', ')}) — à valider dans Correspondances`
      : 'aucun candidat fiable — à valider dans Correspondances',
  }
}

export async function resolveIdentities(
  inputs: IdentityInput[],
  options?: {
    concurrency?: number
    sources?: ResolverSources
    onProgress?: (info: { done: number; total: number; name: string }) => void
  },
): Promise<IdentityResult[]> {
  const raw = options?.sources ?? defaultSources
  // Same libellé / ISIN across envelopes → one network call
  const closeOn = raw.closeOn
  const closes = new Map<string, Promise<number | undefined>>()
  const sources: ResolverSources = {
    fortuneo: memoize(raw.fortuneo),
    morningstar: memoize(raw.morningstar),
    closeOn: closeOn
      ? (isin, date) => {
          const k = `${isin}|${date}`
          if (!closes.has(k)) closes.set(k, closeOn(isin, date))
          return closes.get(k)!
        }
      : undefined,
  }
  let done = 0
  return mapPool(inputs, options?.concurrency ?? 6, async (input) => {
    const r = await resolveIdentity(input, sources)
    done++
    options?.onProgress?.({ done, total: inputs.length, name: input.name })
    return r
  })
}

export interface ApplySummary {
  isinResolved: number
  tickersSet: number
}

/** Persist results in one save: LOCAL→ISIN rekeys + missing tickers. */
export function applyIdentitiesInPortfolio(
  portfolio: Portfolio,
  results: IdentityResult[],
  options?: { overwriteTickers?: boolean },
): ApplySummary {
  let isinResolved = 0
  let tickersSet = 0
  for (const r of results) {
    let key = r.key
    if (r.isin && r.isin !== key && !isValidIsin(key)) {
      if (!portfolio.findSupportByKey(key)) continue
      rekeyInPortfolio(portfolio, key, r.isin)
      key = r.isin
      isinResolved++
    }
    if (!r.ticker || !isQualifiedYahooTicker(r.ticker)) continue
    const s = portfolio.findSupportByKey(key)
    if (!s) continue
    if (s.yahooFinanceTicker && !options?.overwriteTickers) continue
    if (s.yahooFinanceTicker === r.ticker) continue
    s.yahooFinanceTicker = r.ticker
    s.googleFinanceTicker = googleTickerFromYahoo(r.ticker) ?? s.googleFinanceTicker
    s.getterType = GetterType.YAHOO_FINANCE
    tickersSet++
  }
  return { isinResolved, tickersSet }
}

export interface AutoResolveReport extends ApplySummary {
  total: number
  results: IdentityResult[]
  /** Still LOCAL:… or without ticker after this pass */
  unresolved: IdentityResult[]
}

/**
 * Resolve every support that lacks a real ISIN or a Yahoo ticker
 * (or all given supports with `force`).
 */
export async function autoResolveSupports(
  supports?: Support[],
  options?: {
    force?: boolean
    onProgress?: (info: { done: number; total: number; name: string }) => void
  },
): Promise<AutoResolveReport> {
  const projected = await loadProjected()
  const list = (supports ?? projected.supports).filter(
    (s) => options?.force || isLocalSupportId(s.isin) || !s.yahooTicker,
  )

  const placeCounts = new Map<string, Map<string, number>>()
  const lastTrade = new Map<string, { date: string; price: number }>()
  for (const o of projected.operations) {
    if (!o.isin || o.synthetic) continue
    if (
      (o.type === 'ACHAT' ||
        o.type === 'VENTE' ||
        o.type === 'SCRIPT' ||
        o.type === 'RACHAT') &&
      o.currency === 'EUR' &&
      o.price !== undefined &&
      o.price > 0 &&
      o.date > (lastTrade.get(o.isin)?.date ?? '')
    ) {
      lastTrade.set(o.isin, { date: o.date, price: o.price })
    }
    if (!o.place) continue
    const counts = placeCounts.get(o.isin) ?? new Map<string, number>()
    counts.set(o.place, (counts.get(o.place) ?? 0) + 1)
    placeCounts.set(o.isin, counts)
  }
  const mainPlace = (key: string) =>
    [...(placeCounts.get(key) ?? new Map<string, number>())].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0]

  const results = await resolveIdentities(
    list.map((s) => ({
      key: s.isin,
      name: s.name,
      place: mainPlace(s.isin),
      trade: lastTrade.get(s.isin),
    })),
    { onProgress: options?.onProgress },
  )

  let summary: ApplySummary = { isinResolved: 0, tickersSet: 0 }
  await updatePortfolio((p) => {
    summary = applyIdentitiesInPortfolio(p, results, {
      overwriteTickers: options?.force,
    })
  })

  const unresolved = results.filter(
    (r) => !r.ticker || (!r.isin && !isValidIsin(r.key)),
  )
  return { ...summary, total: list.length, results, unresolved }
}
