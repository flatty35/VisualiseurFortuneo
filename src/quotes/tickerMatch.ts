import type { Support } from '@/domain/types'
import { listFlatSupports, putFlatSupports } from '@/persist/portfolioStore'
import {
  isProxyConfigured,
  mapIsinOpenFigi,
  mapIsinsOpenFigiBatch,
  searchYahoo,
  type YahooSearchHit,
} from './gasClient'
import {
  fortuneoHitAcceptable,
  pickBestFortuneoHit,
  resolveYahooTickerFromFortuneoHit,
  searchFortuneoFirstHit,
} from './fortuneoSearch'
import {
  cleanLabelForSearch,
  isQualifiedYahooTicker,
  nameMatchBonus,
  NAME_STOP_WORDS,
  usListingPenalty,
} from './nameMatch'
import { mapPool } from './mapPool'
import { lookupSeedTicker, normalizeMatchKey } from './tickerSeed'

export interface MatchResult {
  isin: string
  name: string
  ticker?: string
  source: 'existing' | 'seed' | 'fortuneo' | 'yahoo' | 'openfigi' | 'none'
  detail?: string
}

export type MatchProgress = (info: {
  current: number
  total: number
  name: string
  status: string
}) => void

const STOP_WORDS = NAME_STOP_WORDS

/** Clean Fortuneo label for search queries. ISIN first when available (Yahoo accepts it). */
export function buildSearchQueries(name: string, isin?: string): string[] {
  const raw = name
    .replace(/\b[A-Z]{2}[A-Z0-9]{10}\b/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const queries: string[] = []
  const push = (q?: string) => {
    const t = (q || '').trim()
    if (t.length >= 2 && !queries.includes(t)) queries.push(t)
  }

  // 1) Real ISIN first — unambiguous public key (skip LOCAL:… synthetic keys)
  if (isin && /^[A-Z]{2}[A-Z0-9]{10}$/i.test(isin)) push(isin.toUpperCase())

  // 2) Full name, then without ETF wrapper words / legal suffixes
  push(raw)
  push(cleanLabelForSearch(name))
  push(raw.replace(/\b(SA|SE|SAS|NV|PLC|AG|LTD|INC)\b\.?/gi, '').replace(/\s+/g, ' ').trim())

  // 3) Significant tokens (DASSAULT from DASSAULT AVIATION)
  const tokens = normalizeMatchKey(raw)
    .split(' ')
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
  for (const tok of tokens.slice(0, 3)) push(tok)
  if (tokens.length >= 2) push(tokens.slice(0, 2).join(' '))

  return queries
}

function normalizeLabel(s: string): string {
  return normalizeMatchKey(s)
}

/** Score a Yahoo hit against the Fortuneo name — prefer .PA + name match. */
export function scoreYahooHit(hit: YahooSearchHit, name: string): number {
  const symbol = (hit.symbol || '').toUpperCase()
  if (!symbol) return -1

  const qt = (hit.quoteType || '').toUpperCase()
  // Soft filter: strongly prefer securities, but don't hard-reject empty type
  if (qt && !['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(qt)) return -1

  let score = 0
  if (symbol.endsWith('.PA')) score += 50
  else if (/\.(AS|BR|MI|MC|DE|F|WA|LS|SW|CO|ST|OL|VI|HE)$/.test(symbol))
    score += 20
  else if (!symbol.includes('.')) score -= 25

  if (qt === 'EQUITY') score += 10
  if (qt === 'ETF' || qt === 'MUTUALFUND') score += 8

  const shortn = normalizeLabel(hit.shortname || '')
  const longn = normalizeLabel(hit.longname || '')
  const bestName = [shortn, longn].filter(Boolean).sort((a, b) => {
    return nameMatchBonus(name, b) - nameMatchBonus(name, a)
  })[0]
  if (bestName) score += nameMatchBonus(name, bestName)
  score += usListingPenalty(hit.isin, symbol)

  // Penalize warrants / crazy symbols
  if (/[-=]/.test(symbol) && !symbol.includes('.')) score -= 20

  return score
}

export function pickBestTicker(hits: YahooSearchHit[], name: string): string | undefined {
  if (!hits.length) return undefined
  const scored = hits
    .map((h) => ({ h, score: scoreYahooHit(h, name) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) {
    // Fallback: first .PA then first symbol (old behaviour)
    return hits.find((h) => h.symbol?.endsWith('.PA'))?.symbol ?? hits[0]?.symbol
  }
  // Require a minimal score unless it's a clear .PA equity
  const best = scored[0]
  if (best.score < 10 && !best.h.symbol.endsWith('.PA')) {
    const pa = scored.find((x) => x.h.symbol.endsWith('.PA'))
    return pa?.h.symbol ?? best.h.symbol
  }
  return best.h.symbol
}

function isRealIsin(isin?: string): isin is string {
  return Boolean(isin && /^[A-Z]{2}[A-Z0-9]{10}$/i.test(isin))
}

export async function resolveTickerForSupport(
  support: Support,
  options?: {
    force?: boolean
    /** Skip OpenFIGI PA/AM (already tried in a batch pass). */
    skipOpenFigiEuronext?: boolean
  },
): Promise<MatchResult> {
  if (support.yahooTicker && !options?.force) {
    return {
      isin: support.isin,
      name: support.name,
      ticker: support.yahooTicker,
      source: 'existing',
    }
  }

  const seeded = lookupSeedTicker(support.name)
  if (seeded) {
    return { isin: support.isin, name: support.name, ticker: seeded, source: 'seed' }
  }

  // 0) OpenFIGI Euronext Paris/Amsterdam when ISIN is known
  if (
    !options?.skipOpenFigiEuronext &&
    isProxyConfigured() &&
    isRealIsin(support.isin)
  ) {
    try {
      const figi = await mapIsinOpenFigi(support.isin, { euronextOnly: true })
      if (figi?.ticker) {
        return {
          isin: support.isin,
          name: support.name,
          ticker: figi.ticker,
          source: 'openfigi',
          detail: `pa-am ${figi.exchCode || ''}`.trim(),
        }
      }
    } catch {
      // cascade
    }
  }

  // 1) Fortuneo Accès Marchés — place map, else probe Yahoo suffixes
  {
    const queries = buildSearchQueries(support.name, support.isin)
    const { hits, query } = await searchFortuneoFirstHit({
      name: support.name,
      queries,
    })
    const best = pickBestFortuneoHit(hits, support.name)
    if (best && fortuneoHitAcceptable(best, support.name)) {
      const resolved = await resolveYahooTickerFromFortuneoHit(best)
      const yahoo = resolved.ticker
      if (yahoo && isQualifiedYahooTicker(yahoo)) {
        return {
          isin: support.isin,
          name: support.name,
          ticker: yahoo,
          source: 'fortuneo',
          detail: `q=${query || support.name} isin=${best.codeIsin || ''} ${resolved.detail || ''}`.trim(),
        }
      }
    }
  }

  if (!isProxyConfigured()) {
    return {
      isin: support.isin,
      name: support.name,
      source: 'none',
      detail: 'Proxy non configuré',
    }
  }

  // 2) Yahoo: ISIN first, then name / keywords
  const queries = buildSearchQueries(support.name, support.isin)
  for (const q of queries) {
    try {
      const hits = await searchYahoo(q)
      const ticker = pickBestTicker(hits, support.name)
      if (ticker) {
        return {
          isin: support.isin,
          name: support.name,
          ticker,
          source: 'yahoo',
          detail: `q=${q}`,
        }
      }
    } catch {
      // continue — next query / openfigi
    }
  }

  // 3) OpenFIGI any venue (last resort)
  if (isRealIsin(support.isin)) {
    try {
      const figi = await mapIsinOpenFigi(support.isin)
      if (figi?.ticker) {
        return {
          isin: support.isin,
          name: support.name,
          ticker: figi.ticker,
          source: 'openfigi',
          detail: figi.exchCode,
        }
      }
    } catch {
      // ignore
    }
  }

  return { isin: support.isin, name: support.name, source: 'none' }
}

export interface TickerCandidate {
  symbol: string
  shortname?: string
  longname?: string
  quoteType?: string
  exch?: string
  /** Best score across queries (higher = better name / .PA fit) */
  score: number
  /** How this candidate was found */
  sources: Array<'seed' | 'fortuneo' | 'yahoo' | 'openfigi'>
  /** Queries that returned this symbol */
  queries: string[]
}

export interface TickerSearchReport {
  queries: string[]
  candidates: TickerCandidate[]
  error?: string
}

/**
 * Collect selectable ticker candidates (ISIN + name Yahoo search, OpenFIGI, seed).
 * Does not write to the DB — for the Correspondances edit UI.
 */
export async function searchTickerCandidates(input: {
  name: string
  isin?: string
  onStatus?: (msg: string) => void
}): Promise<TickerSearchReport> {
  const name = input.name.trim()
  const isin =
    input.isin && /^[A-Z]{2}[A-Z0-9]{10}$/i.test(input.isin)
      ? input.isin.toUpperCase()
      : undefined

  const bySymbol = new Map<string, TickerCandidate>()

  const upsert = (
    hit: {
      symbol: string
      shortname?: string
      longname?: string
      quoteType?: string
      exch?: string
    },
    source: 'seed' | 'fortuneo' | 'yahoo' | 'openfigi',
    query: string,
    scoreBoost = 0,
  ) => {
    const symbol = (hit.symbol || '').trim()
    if (!symbol) return
    const score = Math.max(0, scoreYahooHit(hit as YahooSearchHit, name) + scoreBoost)
    const cur = bySymbol.get(symbol)
    if (!cur) {
      bySymbol.set(symbol, {
        symbol,
        shortname: hit.shortname,
        longname: hit.longname,
        quoteType: hit.quoteType,
        exch: hit.exch,
        score,
        sources: [source],
        queries: [query],
      })
      return
    }
    cur.score = Math.max(cur.score, score)
    if (!cur.sources.includes(source)) cur.sources.push(source)
    if (!cur.queries.includes(query)) cur.queries.push(query)
    if (!cur.shortname && hit.shortname) cur.shortname = hit.shortname
    if (!cur.longname && hit.longname) cur.longname = hit.longname
    if (!cur.quoteType && hit.quoteType) cur.quoteType = hit.quoteType
    if (!cur.exch && hit.exch) cur.exch = hit.exch
  }

  const seeded = lookupSeedTicker(name)
  if (seeded) {
    upsert(
      { symbol: seeded, shortname: name, quoteType: 'EQUITY' },
      'seed',
      'seed locale',
      40,
    )
  }

  const queries = buildSearchQueries(name, isin)

  // OpenFIGI Euronext first when ISIN known — stop cascade on PAR/AMS hit
  if (isin && isProxyConfigured()) {
    input.onStatus?.(`OpenFIGI PA/AM ${isin}…`)
    try {
      const figi = await mapIsinOpenFigi(isin, { euronextOnly: true })
      if (figi?.ticker) {
        upsert(
          {
            symbol: figi.ticker,
            shortname: name,
            quoteType: 'EQUITY',
            exch: figi.exchCode,
          },
          'openfigi',
          `openfigi-pa-am:${isin}`,
          70,
        )
        const candidates = [...bySymbol.values()].sort((a, b) => b.score - a.score)
        return { queries, candidates }
      }
    } catch {
      // cascade
    }
  }

  // Fortuneo — place map or suffix probe; early-stop on quality gate
  {
    input.onStatus?.('Fortuneo…')
    const { hits, query } = await searchFortuneoFirstHit({
      name,
      queries,
      onStatus: input.onStatus,
    })
    const best = pickBestFortuneoHit(hits, name)
    if (best) {
      input.onStatus?.('Fortuneo → Yahoo (place / search / probe)…')
      const resolved = await resolveYahooTickerFromFortuneoHit(best)
      const yahoo = resolved.ticker
      if (yahoo && isQualifiedYahooTicker(yahoo)) {
        const strong = fortuneoHitAcceptable(best, name)
        upsert(
          {
            symbol: yahoo,
            shortname: best.libelle || name,
            quoteType: best.type || 'EQUITY',
            exch: best.place,
          },
          'fortuneo',
          `${query || name}${resolved.detail ? ` · ${resolved.detail}` : ''}`,
          strong ? 60 : 15,
        )
        if (strong) {
          const candidates = [...bySymbol.values()].sort(
            (a, b) => b.score - a.score,
          )
          return { queries, candidates }
        }
      }
    }
  }

  if (!isProxyConfigured()) {
    const candidates = [...bySymbol.values()].sort((a, b) => b.score - a.score)
    return {
      queries,
      candidates,
      error: candidates.length
        ? undefined
        : 'Proxy non configuré — seule la table locale est disponible.',
    }
  }

  for (const q of queries) {
    input.onStatus?.(`Yahoo « ${q} »…`)
    try {
      const hits = await searchYahoo(q)
      for (const h of hits) {
        if (!h.symbol) continue
        upsert(h, 'yahoo', q)
      }
    } catch {
      // continue other queries
    }
  }

  if (isin) {
    input.onStatus?.(`OpenFIGI ${isin}…`)
    try {
      const figi = await mapIsinOpenFigi(isin)
      if (figi?.ticker) {
        upsert(
          {
            symbol: figi.ticker,
            shortname: name,
            quoteType: 'EQUITY',
            exch: figi.exchCode,
          },
          'openfigi',
          `openfigi:${isin}`,
          30,
        )
      }
    } catch {
      // ignore
    }
  }

  const candidates = [...bySymbol.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Prefer .PA on ties
    const pa = Number(b.symbol.endsWith('.PA')) - Number(a.symbol.endsWith('.PA'))
    if (pa) return pa
    return a.symbol.localeCompare(b.symbol)
  })

  return { queries, candidates }
}

/** Instant local seed match only (no network) — safe during import. */
export async function applySeedMatches(supports?: Support[]): Promise<number> {
  const list = supports ?? (await listFlatSupports())
  const updates: Support[] = []
  for (const s of list) {
    if (s.yahooTicker) continue
    const seeded = lookupSeedTicker(s.name)
    if (!seeded) continue
    updates.push({
      ...s,
      yahooTicker: seeded,
      googleTicker: s.googleTicker ?? googleTickerFromYahoo(seeded),
    })
  }
  await putFlatSupports(updates)
  return updates.length
}

export interface AutoMatchOptions {
  /** Re-run search even if a ticker is already set */
  force?: boolean
  onProgress?: MatchProgress
}

/** Auto-fill yahooTicker; by default only missing ones unless `force` or an explicit list is rematched. */
export async function autoMatchSupports(
  supports?: Support[],
  onProgressOrOptions?: MatchProgress | AutoMatchOptions,
): Promise<{
  updated: number
  failed: number
  results: MatchResult[]
}> {
  const options: AutoMatchOptions =
    typeof onProgressOrOptions === 'function'
      ? { onProgress: onProgressOrOptions }
      : (onProgressOrOptions ?? {})
  const force = Boolean(options.force)
  const onProgress = options.onProgress

  let list = supports ?? (await listFlatSupports())
  if (!force) {
    list = list.filter((s) => !s.yahooTicker)
  }

  const results: MatchResult[] = []
  let updated = 0
  let failed = 0
  const total = list.length
  const writes: Support[] = []

  const applyTicker = async (
    s: Support,
    r: MatchResult,
  ): Promise<void> => {
    results.push(r)
    if (r.ticker && (force || r.source !== 'existing')) {
      const g = googleTickerFromYahoo(r.ticker)
      writes.push({
        ...s,
        yahooTicker: r.ticker,
        googleTicker: force ? g : (s.googleTicker ?? g),
      })
      updated++
    } else if (!r.ticker) {
      if (force) {
        writes.push({
          ...s,
          yahooTicker: undefined,
          googleTicker: undefined,
        })
      }
      failed++
    }
  }
  const flushWrites = async () => {
    await putFlatSupports(writes.splice(0, writes.length))
  }

  // --- Pass 0: local seed (instant) ---
  const pending: Support[] = []
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (s.yahooTicker && !force) {
      await applyTicker(s, {
        isin: s.isin,
        name: s.name,
        ticker: s.yahooTicker,
        source: 'existing',
      })
      continue
    }
    const seeded = lookupSeedTicker(s.name)
    if (seeded) {
      onProgress?.({
        current: i + 1,
        total,
        name: s.name,
        status: `Seed ${seeded}…`,
      })
      await applyTicker(s, {
        isin: s.isin,
        name: s.name,
        ticker: seeded,
        source: 'seed',
      })
      continue
    }
    pending.push(s)
  }
  await flushWrites()

  // --- Pass 1: OpenFIGI batch Euronext Paris / Amsterdam ---
  const withIsin = pending.filter((s) => isRealIsin(s.isin))
  const figiHits = new Map<string, { ticker: string; exchCode?: string }>()
  if (withIsin.length && isProxyConfigured()) {
    onProgress?.({
      current: results.length + 1,
      total,
      name: withIsin[0].name,
      status: `OpenFIGI batch PAR/AMS (${withIsin.length})…`,
    })
    try {
      const mapped = await mapIsinsOpenFigiBatch(withIsin.map((s) => s.isin))
      for (const [isin, hit] of mapped) figiHits.set(isin, hit)
    } catch {
      // cascade will retry per-title
    }
  }

  const stillPending: Support[] = []
  for (const s of pending) {
    const hit = isRealIsin(s.isin) ? figiHits.get(s.isin.toUpperCase()) : undefined
    if (hit?.ticker) {
      await applyTicker(s, {
        isin: s.isin,
        name: s.name,
        ticker: hit.ticker,
        source: 'openfigi',
        detail: `batch pa-am ${hit.exchCode || ''}`.trim(),
      })
    } else {
      stillPending.push(s)
    }
  }
  await flushWrites()

  // --- Pass 2: cascade (Fortuneo → Yahoo → OpenFIGI any) for misses ---
  await mapPool(stillPending, 4, async (s) => {
    const r = await resolveTickerForSupport(s, {
      force,
      // Batch already covered PA/AM; skip duplicate OpenFIGI euronext call
      skipOpenFigiEuronext: isRealIsin(s.isin),
    })
    await applyTicker(s, r)
    onProgress?.({
      current: results.length,
      total,
      name: s.name,
      status: `Cascade ticker… (${results.length}/${total})`,
    })
    // Keep partial progress if the slow cascade is interrupted
    if (writes.length >= 5) await flushWrites()
  })
  await flushWrites()

  return { updated, failed, results }
}

/** Clear Yahoo/Google tickers for the given supports. */
export async function resetSupportTickers(supports: Support[]): Promise<number> {
  await putFlatSupports(
    supports.map((s) => ({
      ...s,
      yahooTicker: undefined,
      googleTicker: undefined,
    })),
  )
  return supports.length
}

export function googleTickerFromYahoo(yahoo: string): string | undefined {
  const m = yahoo.match(/^([A-Z0-9.-]+)\.PA$/i)
  if (m) return `EPA:${m[1].toUpperCase()}`
  const as = yahoo.match(/^([A-Z0-9.-]+)\.AS$/i)
  if (as) return `AMS:${as[1].toUpperCase()}`
  const mc = yahoo.match(/^([A-Z0-9.-]+)\.MC$/i)
  if (mc) return `BME:${mc[1].toUpperCase()}`
  const de = yahoo.match(/^([A-Z0-9.-]+)\.DE$/i)
  if (de) return `ETR:${de[1].toUpperCase()}`
  return undefined
}

export { normalizeMatchKey }
