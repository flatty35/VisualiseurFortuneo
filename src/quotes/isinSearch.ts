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
import {
  fortuneoHitAcceptable,
  guessYahooTicker,
  pickBestFortuneoHit,
  resolveYahooTickerFromFortuneoHit,
  scoreFortuneoHit,
  searchFortuneoFirstHit,
} from './fortuneoSearch'
import { nameMatchBonus, usListingPenalty } from './nameMatch'
import { isValidIsin } from '@/persist/rekeySupport'
import { isLocalSupportId } from '@/import/resolveIsin'
import type { Support } from '@/domain/types'
import {
  listFlatSupports,
  updatePortfolio,
} from '@/persist/portfolioStore'
import { AssetType, GetterType } from '@/domain/portfolioModel'

/** Let the browser paint React progress between network-bound steps. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function withDeadline<T>(
  ms: number,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout ${label} (${ms}ms)`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface IsinCandidate {
  isin: string
  name?: string
  ticker?: string
  exch?: string
  quoteType?: string
  score: number
  sources: Array<
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

/**
 * Morningstar via Vite dev proxy (browser → localhost → Morningstar).
 * Avoids GAS IP 403. Only available when `npm run dev` proxy is up.
 */
let morningstarWarmed = false

export async function searchIsinMorningstarLocal(
  query: string,
  options?: { maxAttempts?: number },
): Promise<{ hits: IsinSearchHit[]; debug: IsinSearchDebugStep }> {
  const q = query.trim().slice(0, 80)
  const maxAttempts = options?.maxAttempts ?? 3
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
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!morningstarWarmed) {
        await fetch('/api/morningstar-warmup', {
          signal: AbortSignal.timeout(10000),
        }).catch(() => undefined)
        morningstarWarmed = true
      }
      const url = `/api/morningstar?q=${encodeURIComponent(q)}`
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      const text = await res.text()
      if (!res.ok) {
        lastDetail = `HTTP ${res.status}`
        continue
      }
      if (!text || !text.trim()) {
        lastDetail = `HTTP ${res.status} corps vide (challenge bot)`
        morningstarWarmed = false
        await new Promise((r) => setTimeout(r, 200 * attempt))
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
 * Search ISIN candidates — Fortuneo Accès Marchés first, then Morningstar / GAS.
 * Prefers EUR listings for the suggested default.
 * If Fortuneo returns an ISIN, that guess wins and the cascade stops.
 */
export async function searchIsinCandidates(input: {
  name: string
  yahooTicker?: string
  onStatus?: (msg: string) => void
  /** Skip Vite Morningstar proxy (force GAS only) */
  skipLocalMorningstar?: boolean
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

  // Prefer exchange-qualified Yahoo ticker first (IBE.MC). Never promote bare
  // symbols (IBE) — they collide across venues and poison Fortuneo/Yahoo search.
  if (input.yahooTicker?.trim()) {
    const yt = input.yahooTicker.trim()
    if (/\.[A-Za-z]{1,4}$/.test(yt) && !queries.includes(yt)) {
      queries.unshift(yt)
    }
  }

  const localQueryCap = batch ? 2 : 3
  const gasQueryCap = batch ? 3 : 4
  const gasTimeoutMs = batch ? 18_000 : 45_000
  const msAttempts = batch ? 1 : 3
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
        detail: `défaut ${suggested.isin} (score=${suggested.score}${suggested.eurListed ? ', EUR' : ''}${suggested.sources.includes('fortuneo') ? ', Fortuneo' : ''})`,
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

  // 1) Morningstar via Vite proxy (browser path — works in npm run dev)
  if (!input.skipLocalMorningstar && import.meta.env.DEV) {
    for (const q of queries.slice(0, localQueryCap)) {
      input.onStatus?.(`Morningstar local « ${q} »…`)
      await yieldToUi()
      const { hits, debug: step } = await searchIsinMorningstarLocal(q, {
        maxAttempts: msAttempts,
      })
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

/** Per-title budget in bulk mode (search + scoring). */
const BATCH_ITEM_DEADLINE_MS = 35_000

/**
 * Auto-resolve LOCAL:… supports to real ISINs (EUR preferred).
 * Only applies when confidence ≥ AUTO_ISIN_SCORE_MIN; otherwise leaves for edit.
 * Uses a fast batch search path and flushes rekeys in groups so the UI stays responsive.
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
  list = list.filter((s) => isLocalSupportId(s.isin))

  const details: AutoIsinResult['details'] = []
  let updated = 0
  let skipped = 0
  let failed = 0
  const total = list.length

  type PendingRekey = {
    from: string
    to: string
    name: string
    yahooTicker?: string
    googleTicker?: string
    boursoramaTicker?: string
    manualPrices: Support['manualPrices']
    staticPrice?: number
  }
  const pending: PendingRekey[] = []

  const flushPending = async () => {
    if (!pending.length) return
    const batch = pending.splice(0, pending.length)
    await updatePortfolio((p) => {
      for (const item of batch) {
        const source = p.findSupportByKey(item.from)
        if (!source) continue
        const isLocal = item.to.startsWith('LOCAL:')
        let target = p.findSupportByKey(item.to)
        if (!target) {
          target = p.upsertSupport({
            niceUniqueName: item.name || source.niceUniqueName,
            ISIN: isLocal ? '' : item.to,
            localKey: isLocal ? item.to : '',
            assetType: AssetType.ACTIONS,
            getterType: item.yahooTicker
              ? GetterType.YAHOO_FINANCE
              : source.getterType,
            yahooFinanceTicker:
              item.yahooTicker ?? source.yahooFinanceTicker,
            googleFinanceTicker:
              item.googleTicker ?? source.googleFinanceTicker,
            boursoramaTicker:
              item.boursoramaTicker ?? source.boursoramaTicker,
            staticDatedValues: source.staticDatedValues,
            lastKnownValue: source.lastKnownValue,
          })
        } else {
          if (item.yahooTicker) target.yahooFinanceTicker = item.yahooTicker
          if (item.googleTicker) target.googleFinanceTicker = item.googleTicker
          if (!target.niceUniqueName) target.niceUniqueName = item.name
        }
        for (const env of p.envelopes) {
          for (const op of env.operations) {
            if (op.supportUniqueID === source.uniqueID) {
              op.supportUniqueID = target.uniqueID
              op.customDetails = {
                ...op.customDetails,
                isin: item.to,
                name: target.niceUniqueName,
              }
            }
          }
        }
        if (source.uniqueID !== target.uniqueID) {
          delete p.supports[source.uniqueID]
        }
      }
    })
  }

  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    options?.onProgress?.({
      current: i + 1,
      total,
      name: s.name,
      status: `ISIN… (${i + 1}/${total})`,
    })
    await yieldToUi()
    try {
      const report = await withDeadline(
        BATCH_ITEM_DEADLINE_MS,
        s.name,
        () =>
          searchIsinCandidates({
            name: s.name,
            yahooTicker: s.yahooTicker,
            batch: true,
            onStatus: (msg) =>
              options?.onProgress?.({
                current: i + 1,
                total,
                name: s.name,
                status: msg,
              }),
          }),
      )
      const best = report.suggested
      if (!best) {
        failed++
        details.push({
          from: s.isin,
          name: s.name,
          status: 'fail',
          detail: report.error || 'aucun candidat',
        })
      } else if (best.score < AUTO_ISIN_SCORE_MIN) {
        skipped++
        details.push({
          from: s.isin,
          name: s.name,
          to: best.isin,
          status: 'skip',
          detail: `score ${best.score} < ${AUTO_ISIN_SCORE_MIN} — choisir à l’édition`,
        })
      } else {
        const g = best.ticker
          ? googleTickerFromYahoo(best.ticker)
          : undefined
        pending.push({
          from: s.isin,
          to: best.isin,
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
      }
    } catch (e) {
      failed++
      details.push({
        from: s.isin,
        name: s.name,
        status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
      })
    }

    // Flush every few hits so a crash mid-run keeps partial progress
    if (pending.length >= 5) {
      await flushPending()
      await yieldToUi()
    } else if (i < list.length - 1) {
      await new Promise((r) => setTimeout(r, 80))
    }
  }

  await flushPending()
  return { updated, skipped, failed, details }
}
