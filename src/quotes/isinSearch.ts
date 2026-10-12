import {
  isProxyConfigured,
  searchIsinProxyDetailed,
  searchYahoo,
  type IsinSearchHit,
} from './gasClient'
import {
  buildSearchQueries,
  scoreYahooHit,
} from './tickerMatch'
import {
  fortuneoHitAcceptable,
  guessYahooTicker,
  pickBestFortuneoHit,
  resolveYahooTickerFromFortuneoHit,
  scoreFortuneoHit,
  searchFortuneoFirstHit,
} from './fortuneoSearch'
import { nameMatchBonus, usListingPenalty } from './nameMatch'
import { lookupSeedIsin, lookupSeedTicker } from './tickerSeed'
import { isValidIsin } from '@/persist/rekeySupport'
import { searchMorningstar } from './morningstarScreener'

/** Let the browser paint React progress between network-bound steps. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export interface IsinCandidate {
  isin: string
  name?: string
  ticker?: string
  exch?: string
  quoteType?: string
  score: number
  sources: Array<
    | 'seed'
    | 'fortuneo'
    | 'morningstar'
    | 'boursorama'
    | 'openfigi'
    | 'yahoo'
    | 'proxy'
  >
  /** True when listing looks EUR / Europe */
  eurListed?: boolean
}

export interface IsinSearchDebugStep {
  phase: string
  query?: string
  ok: boolean
  detail: string
  count?: number
}

export interface IsinSearchReport {
  queries: string[]
  candidates: IsinCandidate[]
  /** Best default pick (EUR-preferred) */
  suggested?: IsinCandidate
  error?: string
  debug: IsinSearchDebugStep[]
}

/** EEA ISIN country codes (PEA-eligible issuers), not only FR. */
const EUR_ISIN_PREFIX = new Set([
  'FR',
  'DE',
  'NL',
  'BE',
  'ES',
  'IT',
  'IE',
  'AT',
  'PT',
  'FI',
  'LU',
  'GR',
  'PL',
  'SE',
  'DK',
  'CZ',
  'HU',
  'RO',
  'SK',
  'SI',
  'EE',
  'LV',
  'LT',
  'CY',
  'MT',
  'HR',
  'BG',
])

const EUR_EXCHANGES = new Set([
  'XPAR',
  'XAMS',
  'XBRU',
  'XMAD',
  'XMIL',
  'XETR',
  'XFRA',
  'XLIS',
  'XVIE',
  'XHEL',
  'XDUB',
  'XWAR',
  'FP',
  'PAR',
  'PA',
  'GY',
  'GF',
  'SM',
  'NA',
  'AS',
])

const EUR_COUNTRIES = new Set([
  'FRA',
  'DEU',
  'NLD',
  'BEL',
  'ESP',
  'ITA',
  'IRL',
  'AUT',
  'PRT',
  'FIN',
  'LUX',
  'POL',
  'SWE',
  'DNK',
  'CZE',
  'HUN',
  'GRC',
])

function isEurListed(h: {
  isin?: string
  exchange?: string
  exchangeCountry?: string
  ticker?: string
  exch?: string
}): boolean {
  const isin = (h.isin || '').toUpperCase()
  if (isin.length >= 2 && EUR_ISIN_PREFIX.has(isin.slice(0, 2))) return true
  const ex = String(h.exchange || h.exch || '').toUpperCase()
  if (EUR_EXCHANGES.has(ex)) return true
  const country = String(h.exchangeCountry || '').toUpperCase()
  if (EUR_COUNTRIES.has(country)) return true
  // Yahoo / MIC-style suffixes used on European regulated markets
  const t = String(h.ticker || '').toUpperCase()
  if (/\.(PA|AS|BR|MC|MI|DE|F|WA|LS|HE|VI|OL|ST|CO)$/.test(t)) return true
  return false
}

function pushIsin(
  map: Map<string, IsinCandidate>,
  hit: {
    isin: string
    name?: string
    ticker?: string
    exch?: string
    quoteType?: string
    score: number
    source: IsinCandidate['sources'][number]
  },
) {
  const isin = hit.isin.trim().toUpperCase()
  if (!isValidIsin(isin)) return
  const eurListed = isEurListed({
    isin,
    exch: hit.exch,
    ticker: hit.ticker,
  })
  const cur = map.get(isin)
  if (!cur) {
    map.set(isin, {
      isin,
      name: hit.name,
      ticker: hit.ticker,
      exch: hit.exch,
      quoteType: hit.quoteType,
      score: hit.score,
      sources: [hit.source],
      eurListed,
    })
    return
  }
  cur.score = Math.max(cur.score, hit.score)
  if (!cur.sources.includes(hit.source)) cur.sources.push(hit.source)
  if (!cur.name && hit.name) cur.name = hit.name
  if (
    hit.ticker &&
    (!cur.ticker ||
      (hit.ticker.endsWith('.PA') && !cur.ticker.endsWith('.PA')))
  ) {
    cur.ticker = hit.ticker
  }
  if (!cur.exch && hit.exch) cur.exch = hit.exch
  if (!cur.quoteType && hit.quoteType) cur.quoteType = hit.quoteType
  cur.eurListed = cur.eurListed || eurListed
}

/** Score a hit — prefer EEA listings; light bias to Euronext Paris for PEA UX. */
export function scoreIsinHit(h: IsinSearchHit, name: string): number {
  let score = 10 + Math.min(40, Number(h.score) || 0)
  const eur = isEurListed(h)
  if (eur) score += 100
  else score -= 30 // OTC / US ADR etc.

  if (h.exchange === 'XPAR' || h.exchangeCountry === 'FRA') score += 40
  if (h.investmentType === 'EQ') score += 25
  if (h.ticker?.endsWith('.PA')) score += 30
  if ((h.isin || '').toUpperCase().startsWith('FR')) score += 20
  score += usListingPenalty(h.isin, h.ticker)
  score += nameMatchBonus(name, h.name || '')
  return score
}

export function pickBestIsinCandidate(
  candidates: IsinCandidate[],
): IsinCandidate | undefined {
  if (!candidates.length) return undefined
  const sorted = [...candidates].sort((a, b) => {
    // EUR first
    if (Boolean(a.eurListed) !== Boolean(b.eurListed)) {
      return a.eurListed ? -1 : 1
    }
    if (b.score !== a.score) return b.score - a.score
    return a.isin.localeCompare(b.isin)
  })
  return sorted[0]
}

/** Minimum score to auto-apply without asking (EUR name match). */
export const AUTO_ISIN_SCORE_MIN = 120

/** Morningstar screener, called directly from the browser (CORS *). */
export async function searchIsinMorningstar(
  query: string,
): Promise<{ hits: IsinSearchHit[]; debug: IsinSearchDebugStep }> {
  const q = query.trim().slice(0, 80)
  try {
    const rows = await searchMorningstar(q)
    const hits: IsinSearchHit[] = rows.map((h) => ({
      isin: h.isin,
      name: h.name,
      ticker: h.yahooTicker,
      exchange: h.mic,
      investmentType: h.investmentType,
      source: 'morningstar',
    }))
    return {
      hits,
      debug: {
        phase: 'morningstar',
        query: q,
        ok: hits.length > 0,
        detail: hits.length ? `${hits.length} hit(s), 1er=${hits[0].isin}` : '0 résultat',
        count: hits.length,
      },
    }
  } catch (e) {
    return {
      hits: [],
      debug: {
        phase: 'morningstar',
        query: q,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      },
    }
  }
}


/**
 * Search ISIN candidates — Fortuneo Accès Marchés first, then Morningstar / GAS.
 * Prefers EUR listings for the suggested default.
 * If Fortuneo returns an ISIN, that guess wins and the cascade stops.
 */
export async function searchIsinCandidates(input: {
  name: string
  yahooTicker?: string
  onStatus?: (msg: string) => void
  /**
   * Faster path for bulk import / auto-resolve: fewer queries / shorter
   * timeouts on primary sources. Yahoo→ISIN runs only if no acceptable hit.
   */
  batch?: boolean
}): Promise<IsinSearchReport> {
  const name = input.name.trim()
  const batch = Boolean(input.batch)
  const map = new Map<string, IsinCandidate>()
  const debug: IsinSearchDebugStep[] = []
  const errors: string[] = []
  const queries = buildSearchQueries(name)

  const seededIsin = lookupSeedIsin(name)
  const seededTicker =
    lookupSeedTicker(name) ||
    (input.yahooTicker?.trim() &&
    /\.[A-Za-z]{1,4}$/.test(input.yahooTicker.trim())
      ? input.yahooTicker.trim()
      : undefined)

  // Prefer exchange-qualified Yahoo ticker first (IBE.MC). Never promote bare
  // symbols (IBE) — they collide across venues and poison Fortuneo/Yahoo search.
  if (seededTicker && !queries.includes(seededTicker)) {
    queries.unshift(seededTicker)
  } else if (input.yahooTicker?.trim()) {
    const yt = input.yahooTicker.trim()
    if (/\.[A-Za-z]{1,4}$/.test(yt) && !queries.includes(yt)) {
      queries.unshift(yt)
    }
  }

  const localQueryCap = batch ? 2 : 3
  const gasQueryCap = batch ? 3 : 4
  const gasTimeoutMs = batch ? 18_000 : 45_000
  const yahooCascadeCap = batch ? 3 : 5

  const ingest = (
    hits: IsinSearchHit[],
    sourceHint: IsinCandidate['sources'][number],
  ) => {
    for (const h of hits) {
      if (!h.isin) continue
      const src =
        h.source?.includes('boursorama')
          ? 'boursorama'
          : h.source === 'morningstar'
            ? 'morningstar'
            : h.source?.includes('openfigi')
              ? 'openfigi'
              : sourceHint
      pushIsin(map, {
        isin: h.isin,
        name: h.name,
        ticker: h.ticker,
        exch: h.exchange || h.exchangeCountry,
        quoteType: h.investmentType,
        score: scoreIsinHit(h, name),
        source: src,
      })
    }
  }

  const acceptableFromMap = (): IsinCandidate | undefined => {
    const best = pickBestIsinCandidate([...map.values()])
    if (!best || best.score < AUTO_ISIN_SCORE_MIN) return undefined
    return best
  }

  const finishReport = (): IsinSearchReport => {
    const candidates = [...map.values()].sort((a, b) => {
      if (Boolean(a.eurListed) !== Boolean(b.eurListed)) {
        return a.eurListed ? -1 : 1
      }
      if (b.score !== a.score) return b.score - a.score
      return a.isin.localeCompare(b.isin)
    })
    const suggested = pickBestIsinCandidate(candidates)
    if (suggested) {
      debug.push({
        phase: 'suggest',
        ok: true,
        detail: `défaut ${suggested.isin} (score=${suggested.score}${suggested.eurListed ? ', EUR' : ''}${suggested.sources.includes('fortuneo') ? ', Fortuneo' : ''}${suggested.sources.includes('seed') ? ', seed' : ''})`,
      })
    }
    return {
      queries,
      candidates,
      suggested,
      debug,
      error:
        candidates.length === 0
          ? errors[0] ||
            'Aucun ISIN trouvé (Fortuneo, Morningstar, proxy GAS). Saisissez-le manuellement.'
          : undefined,
    }
  }

  // Local ISIN seed — authoritative for known PEA/fonds collisions
  if (seededIsin && isValidIsin(seededIsin)) {
    pushIsin(map, {
      isin: seededIsin,
      name,
      ticker: seededTicker,
      score: 250,
      source: 'seed',
    })
    debug.push({
      phase: 'isin-seed',
      ok: true,
      detail: `table locale → ${seededIsin}${seededTicker ? ` / ${seededTicker}` : ''}`,
    })
    return finishReport()
  }

  // 0) Fortuneo Accès Marchés — ingest always; early-stop only on quality gate
  {
    const { hits, debug: ftDebug } = await searchFortuneoFirstHit({
      name,
      queries,
      onStatus: input.onStatus,
    })
    debug.push(...ftDebug)
    if (hits.length) {
      const best = pickBestFortuneoHit(hits, name)
      const bestResolved = best
        ? await resolveYahooTickerFromFortuneoHit(best)
        : {}
      for (const h of hits) {
        const isin = (h.codeIsin || '').toUpperCase()
        if (!isValidIsin(isin)) continue
        const yahoo =
          h === best
            ? bestResolved.ticker ?? guessYahooTicker(h)
            : guessYahooTicker(h)
        pushIsin(map, {
          isin,
          name: h.libelle || name,
          ticker: yahoo,
          exch: h.place,
          quoteType: h.type,
          score: scoreFortuneoHit(h, name),
          source: 'fortuneo',
        })
      }
      if (fortuneoHitAcceptable(best, name)) {
        debug.push({
          phase: 'fortuneo-stop',
          ok: true,
          detail: `arrêt cascade — ISIN Fortuneo ${best?.codeIsin || hits[0].codeIsin}`,
        })
        return finishReport()
      }
      debug.push({
        phase: 'fortuneo-weak',
        ok: false,
        detail:
          'hit Fortuneo faible (qualité nominale / US) — cascade continue',
      })
    }
  }

  // 1) Morningstar screener (direct, CORS)
  for (const q of queries.slice(0, localQueryCap)) {
    input.onStatus?.(`Morningstar « ${q} »…`)
    await yieldToUi()
    const { hits, debug: step } = await searchIsinMorningstar(q)
    debug.push(step)
    if (hits.length) {
      ingest(hits, 'morningstar')
      break
    }
  }

  // 2) GAS proxy (Morningstar may 403; OpenFIGI+Boursorama fallback)
  if (!acceptableFromMap() && isProxyConfigured()) {
    for (const q of queries.slice(0, gasQueryCap)) {
      if (acceptableFromMap()) break
      input.onStatus?.(`Proxy GAS « ${q} »…`)
      await yieldToUi()
      try {
        const detailed = await searchIsinProxyDetailed(q, {
          timeoutMs: gasTimeoutMs,
        })
        debug.push({
          phase: 'gas-isinsearch',
          query: q,
          ok: detailed.results.length > 0,
          detail:
            detailed.debug ||
            (detailed.results.length
              ? `${detailed.results.length} résultat(s)`
              : '0 résultat'),
          count: detailed.results.length,
        })
        ingest(detailed.results, 'proxy')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`GAS « ${q} »: ${msg}`)
        debug.push({
          phase: 'gas-isinsearch',
          query: q,
          ok: false,
          detail: msg,
        })
      }
    }
  } else if (!isProxyConfigured()) {
    debug.push({
      phase: 'gas-isinsearch',
      ok: false,
      detail: 'VITE_PROXY_URL non configuré',
    })
  } else {
    debug.push({
      phase: 'gas-isinsearch',
      ok: true,
      detail: 'ignoré — ISIN acceptable déjà trouvé',
    })
  }

  // 3) Slow fallback: Yahoo symbol search → resolve each ticker to ISIN via GAS.
  // Only when faster paths did not yield an acceptable candidate.
  if (!acceptableFromMap() && isProxyConfigured()) {
    input.onStatus?.('Fallback Yahoo → ISIN…')
    await yieldToUi()
    try {
      const yHits = await searchYahoo(name)
      debug.push({
        phase: 'yahoo-search',
        query: name,
        ok: yHits.length > 0,
        detail: `${yHits.length} symbole(s)`,
        count: yHits.length,
      })
      const symbols = yHits
        .map((h) => {
          let score = scoreYahooHit(h, name)
          // Prefer any exchange-qualified symbol over bare OTC tickers
          if (/\.[A-Za-z]{1,4}$/.test(h.symbol || '')) score += 25
          return { h, score }
        })
        .filter((x) => x.score >= 0 && x.h.symbol)
        .sort((a, b) => b.score - a.score)
        .slice(0, yahooCascadeCap)
      for (const { h } of symbols) {
        if (acceptableFromMap()) break
        const qGas = h.symbol
        input.onStatus?.(`ISIN via ${h.symbol}…`)
        await yieldToUi()
        try {
          const detailed = await searchIsinProxyDetailed(qGas, {
            timeoutMs: gasTimeoutMs,
          })
          debug.push({
            phase: 'gas-via-yahoo',
            query: qGas,
            ok: detailed.results.length > 0,
            detail: detailed.debug || `${detailed.results.length} hit(s)`,
            count: detailed.results.length,
          })
          ingest(detailed.results, 'proxy')
        } catch (e) {
          debug.push({
            phase: 'gas-via-yahoo',
            query: qGas,
            ok: false,
            detail: e instanceof Error ? e.message : String(e),
          })
        }
      }
    } catch (e) {
      debug.push({
        phase: 'yahoo-search',
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  } else if (acceptableFromMap()) {
    debug.push({
      phase: 'yahoo-search',
      ok: true,
      detail: 'ignoré — ISIN acceptable déjà trouvé',
    })
  }

  return finishReport()
}

