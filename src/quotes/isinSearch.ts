import {
  isProxyConfigured,
  searchIsinProxyDetailed,
  searchYahoo,
  type IsinSearchHit,
} from './gasClient'
import {
  buildSearchQueries,
  googleTickerFromYahoo,
  scoreYahooHit,
} from './tickerMatch'
import { isValidIsin, rekeySupport } from '@/persist/rekeySupport'
import { isLocalSupportId } from '@/import/resolveIsin'
import type { Support } from '@/domain/types'
import { listFlatSupports } from '@/persist/portfolioStore'

export interface IsinCandidate {
  isin: string
  name?: string
  ticker?: string
  exch?: string
  quoteType?: string
  score: number
  sources: Array<'morningstar' | 'boursorama' | 'openfigi' | 'yahoo' | 'proxy'>
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
  'FP',
  'PAR',
  'PA',
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
  if (['FRA', 'DEU', 'NLD', 'BEL', 'ESP', 'ITA', 'IRL', 'AUT', 'PRT', 'FIN', 'LUX'].includes(country)) {
    return true
  }
  const t = String(h.ticker || '').toUpperCase()
  if (/\.(PA|AS|BR|MC|MI|DE|LS|HE|VI|LS)$/.test(t)) return true
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

/** Score a hit — strongly prefer EUR / Euronext listings. */
export function scoreIsinHit(h: IsinSearchHit, name: string): number {
  let score = 10 + Math.min(40, Number(h.score) || 0)
  const eur = isEurListed(h)
  if (eur) score += 100
  else score -= 30 // OTC / US ADR etc.

  if (h.exchange === 'XPAR' || h.exchangeCountry === 'FRA') score += 40
  if (h.investmentType === 'EQ') score += 25
  if (h.ticker?.endsWith('.PA')) score += 30
  if ((h.isin || '').toUpperCase().startsWith('FR')) score += 20
  if ((h.isin || '').toUpperCase().startsWith('US')) score -= 25

  const label = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const hitName = (h.name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (hitName && label) {
    if (hitName === label) score += 60
    else if (hitName.includes(label) || label.includes(hitName)) score += 40
    else {
      const parts = label.split(' ').filter((w) => w.length > 2)
      score += parts.filter((w) => hitName.includes(w)).length * 10
    }
  }
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

/**
 * Morningstar via Vite dev proxy (browser → localhost → Morningstar).
 * Avoids GAS IP 403. Only available when `npm run dev` proxy is up.
 */
export async function searchIsinMorningstarLocal(
  query: string,
): Promise<{ hits: IsinSearchHit[]; debug: IsinSearchDebugStep }> {
  const q = query.trim().slice(0, 80)
  if (q.length < 2) {
    return {
      hits: [],
      debug: {
        phase: 'morningstar-local',
        query: q,
        ok: false,
        detail: 'query trop courte',
      },
    }
  }
  // Morningstar often returns HTTP 202 + empty body (bot challenge). Retry a few times.
  let lastDetail = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt === 1) {
        // Warm-up cookies via Vite middleware
        await fetch('/api/morningstar-warmup', {
          signal: AbortSignal.timeout(10000),
        }).catch(() => undefined)
      }
      const url = `/api/morningstar?q=${encodeURIComponent(q)}`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      if (!res.ok) {
        lastDetail = `HTTP ${res.status}`
        continue
      }
      if (!text || !text.trim()) {
        lastDetail = `HTTP ${res.status} corps vide (challenge bot)`
        await new Promise((r) => setTimeout(r, 400 * attempt))
        continue
      }
      let json: {
        results?: Array<{
          type?: string
          score?: number
          value?: {
            isin?: string
            name?: string
            shortName?: string
            companyName?: string
            ticker?: string
            exchange?: string
            exchangeCountry?: string
            investmentType?: string
          }
        }>
      }
      try {
        json = JSON.parse(text) as typeof json
      } catch {
        lastDetail = `JSON invalide (${text.slice(0, 80)}…)`
        continue
      }
      const hits: IsinSearchHit[] = []
      for (const item of json.results ?? []) {
        if (item.type !== 'security' || !item.value?.isin) continue
        const v = item.value
        const isin = v.isin!.toUpperCase()
        if (!isValidIsin(isin)) continue
        let ticker = (v.ticker || '').replace(/\s+/g, '')
        if (ticker && !ticker.includes('.')) {
          if (v.exchange === 'XPAR' || v.exchangeCountry === 'FRA') {
            ticker = `${ticker}.PA`
          } else if (v.exchange === 'XMAD' || v.exchangeCountry === 'ESP') {
            ticker = `${ticker}.MC`
          }
        }
        hits.push({
          isin,
          name: v.name || v.shortName || v.companyName,
          ticker,
          figiTicker: v.ticker,
          exchange: v.exchange,
          exchangeCountry: v.exchangeCountry,
          investmentType: v.investmentType,
          score: item.score,
          source: 'morningstar',
        })
      }
      return {
        hits,
        debug: {
          phase: 'morningstar-local',
          query: q,
          ok: hits.length > 0,
          detail:
            hits.length > 0
              ? `${hits.length} hit(s), 1er=${hits[0].isin} (essai ${attempt})`
              : `réponse OK mais aucun ISIN (essai ${attempt})`,
          count: hits.length,
        },
      }
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e)
    }
  }
  return {
    hits: [],
    debug: {
      phase: 'morningstar-local',
      query: q,
      ok: false,
      detail: lastDetail || 'échec',
    },
  }
}

/**
 * Search ISIN candidates — Morningstar local (dev proxy) + GAS multi-source.
 * Prefers EUR listings for the suggested default.
 */
export async function searchIsinCandidates(input: {
  name: string
  yahooTicker?: string
  onStatus?: (msg: string) => void
  /** Skip Vite Morningstar proxy (force GAS only) */
  skipLocalMorningstar?: boolean
}): Promise<IsinSearchReport> {
  const name = input.name.trim()
  const map = new Map<string, IsinCandidate>()
  const debug: IsinSearchDebugStep[] = []
  const errors: string[] = []
  const queries = buildSearchQueries(name)

  // Prefer full Yahoo ticker first (IBE.MC) so GAS can hit Boursorama Madrid/etc.
  if (input.yahooTicker?.trim()) {
    const yt = input.yahooTicker.trim()
    if (!queries.includes(yt)) queries.unshift(yt)
    const bareTicker = yt.replace(/\.[A-Za-z]{1,4}$/, '')
    if (bareTicker && !queries.includes(bareTicker)) queries.splice(1, 0, bareTicker)
  }

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

  // 1) Morningstar via Vite proxy (browser path — works in npm run dev)
  if (!input.skipLocalMorningstar && import.meta.env.DEV) {
    for (const q of queries.slice(0, 3)) {
      input.onStatus?.(`Morningstar local « ${q} »…`)
      const { hits, debug: step } = await searchIsinMorningstarLocal(q)
      debug.push(step)
      if (hits.length) {
        ingest(hits, 'morningstar')
        break
      }
    }
  } else {
    debug.push({
      phase: 'morningstar-local',
      ok: false,
      detail: input.skipLocalMorningstar
        ? 'ignoré (skipLocalMorningstar)'
        : 'hors mode dev — pas de proxy Vite /api/morningstar',
    })
  }

  // 2) GAS proxy (Morningstar may 403; OpenFIGI+Boursorama fallback)
  if (isProxyConfigured()) {
    for (const q of queries.slice(0, 4)) {
      if (map.size > 0) break
      input.onStatus?.(`Proxy GAS « ${q} »…`)
      try {
        const detailed = await searchIsinProxyDetailed(q)
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
  } else {
    debug.push({
      phase: 'gas-isinsearch',
      ok: false,
      detail: 'VITE_PROXY_URL non configuré',
    })
  }

  // 3) Yahoo symbols → GAS by bare ticker
  if (map.size === 0 && isProxyConfigured()) {
    input.onStatus?.('Yahoo puis ISIN…')
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
        .map((h) => ({ h, score: scoreYahooHit(h, name) }))
        .filter((x) => x.score >= 0 && x.h.symbol)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
      for (const { h } of symbols) {
        // Pass full Yahoo ticker (IBE.MC) so GAS prefers Madrid FF55- paths
        const qGas = h.symbol
        input.onStatus?.(`ISIN via ${h.symbol}…`)
        try {
          const detailed = await searchIsinProxyDetailed(qGas)
          debug.push({
            phase: 'gas-via-yahoo',
            query: qGas,
            ok: detailed.results.length > 0,
            detail: detailed.debug || `${detailed.results.length} hit(s)`,
            count: detailed.results.length,
          })
          ingest(detailed.results, 'proxy')
          if (map.size > 0) break
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
  }

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
      detail: `défaut ${suggested.isin} (score=${suggested.score}${suggested.eurListed ? ', EUR' : ''})`,
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
          'Aucun ISIN trouvé. En dev, vérifiez le proxy Vite /api/morningstar ; en prod, redéployez le GAS (OpenFIGI+Boursorama).'
        : undefined,
  }
}

export interface AutoIsinResult {
  updated: number
  skipped: number
  failed: number
  details: Array<{
    from: string
    name: string
    to?: string
    status: 'ok' | 'skip' | 'fail'
    detail: string
  }>
}

/**
 * Auto-resolve LOCAL:… supports to real ISINs (EUR preferred).
 * Only applies when confidence ≥ AUTO_ISIN_SCORE_MIN; otherwise leaves for edit.
 */
export async function autoResolveLocalIsins(
  supports?: Support[],
  options?: {
    force?: boolean
    onProgress?: (info: {
      current: number
      total: number
      name: string
      status: string
    }) => void
  },
): Promise<AutoIsinResult> {
  let list = supports ?? (await listFlatSupports())
  if (!options?.force) {
    list = list.filter((s) => isLocalSupportId(s.isin))
  } else {
    // force: only LOCAL (never rekey a real ISIN automatically)
    list = list.filter((s) => isLocalSupportId(s.isin))
  }

  const details: AutoIsinResult['details'] = []
  let updated = 0
  let skipped = 0
  let failed = 0
  const total = list.length

  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    options?.onProgress?.({
      current: i + 1,
      total,
      name: s.name,
      status: `ISIN… (${i + 1}/${total})`,
    })
    try {
      const report = await searchIsinCandidates({
        name: s.name,
        yahooTicker: s.yahooTicker,
      })
      const best = report.suggested
      if (!best) {
        failed++
        details.push({
          from: s.isin,
          name: s.name,
          status: 'fail',
          detail: report.error || 'aucun candidat',
        })
        continue
      }
      if (best.score < AUTO_ISIN_SCORE_MIN) {
        skipped++
        details.push({
          from: s.isin,
          name: s.name,
          to: best.isin,
          status: 'skip',
          detail: `score ${best.score} < ${AUTO_ISIN_SCORE_MIN} — choisir à l’édition`,
        })
        continue
      }
      const g = best.ticker
        ? googleTickerFromYahoo(best.ticker)
        : undefined
      await rekeySupport(s.isin, best.isin, {
        name: s.name,
        yahooTicker: best.ticker || s.yahooTicker,
        googleTicker: g ?? s.googleTicker,
        boursoramaTicker: s.boursoramaTicker,
        manualPrices: s.manualPrices,
        staticPrice: s.staticPrice,
      })
      updated++
      details.push({
        from: s.isin,
        name: s.name,
        to: best.isin,
        status: 'ok',
        detail: `${best.isin}${best.eurListed ? ' (EUR)' : ''} score=${best.score}`,
      })
    } catch (e) {
      failed++
      details.push({
        from: s.isin,
        name: s.name,
        status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
    if (i < list.length - 1) {
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  return { updated, skipped, failed, details }
}
