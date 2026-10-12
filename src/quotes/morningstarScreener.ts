import { isValidIsin } from '@/persist/rekeySupport'

/**
 * Morningstar public screener (lt.morningstar.com) — answers with
 * `Access-Control-Allow-Origin: *`, so the browser calls it directly in dev
 * and on GitHub Pages (no Vite / GAS proxy). Accepts a name or an ISIN.
 */
const SCREENER_URL =
  'https://lt.morningstar.com/api/rest.svc/klr5zyak8x/security/screener'

const DATA_POINTS = [
  'SecId',
  'PerformanceId',
  'Name',
  'ISIN',
  'PriceCurrency',
  'ClosePrice',
  'Ticker',
  'ExchangeId',
  'InvestmentType',
].join('|')

/** Morningstar ExchangeId MIC → Yahoo suffix (European venues only). */
const MIC_TO_YAHOO_SUFFIX: Record<string, string> = {
  XPAR: '.PA',
  XAMS: '.AS',
  XBRU: '.BR',
  XLIS: '.LS',
  XMAD: '.MC',
  XMIL: '.MI',
  XETR: '.DE',
  XFRA: '.F',
  XLON: '.L',
  XSWX: '.SW',
  XHEL: '.HE',
  XSTO: '.ST',
  XCSE: '.CO',
  XOSL: '.OL',
  XWAR: '.WA',
  XWBO: '.VI',
}

export interface MorningstarRow {
  SecId?: string
  PerformanceId?: string
  Name?: string
  ISIN?: string
  PriceCurrency?: string
  ClosePrice?: number
  Ticker?: string
  ExchangeId?: string
  InvestmentType?: string
}

export interface MorningstarHit {
  isin: string
  name: string
  currency?: string
  /** MIC, e.g. XPAR */
  mic?: string
  /** Key of the price time series (≠ PerformanceId for OPCVM: `F0000…`) */
  secId?: string
  performanceId?: string
  investmentType?: string
  closePrice?: number
  yahooTicker?: string
}

export function micFromExchangeId(exchangeId?: string): string | undefined {
  const mic = String(exchangeId || '')
    .replace(/^EX\$+/, '')
    .toUpperCase()
  return mic || undefined
}

/**
 * Yahoo symbol for a screener row: `TICKER.SUFFIX` on European venues, or
 * `PERFORMANCEID.F` for funds (Yahoo lists OPCVM by Morningstar id).
 */
export function yahooTickerFromMorningstar(row: MorningstarRow): string | undefined {
  const ticker = String(row.Ticker || '').replace(/\s+/g, '')
  const suffix = MIC_TO_YAHOO_SUFFIX[micFromExchangeId(row.ExchangeId) ?? '']
  if (ticker && suffix) return `${ticker}${suffix}`
  const perf = String(row.PerformanceId || '').toUpperCase()
  if (!ticker && /^0P[0-9A-Z]{8}$/.test(perf)) return `${perf}.F`
  return undefined
}

export function morningstarRowToHit(row: MorningstarRow): MorningstarHit | undefined {
  const isin = String(row.ISIN || '').toUpperCase()
  if (!isValidIsin(isin)) return undefined
  return {
    isin,
    name: String(row.Name || ''),
    currency: row.PriceCurrency || undefined,
    mic: micFromExchangeId(row.ExchangeId),
    secId: row.SecId || undefined,
    performanceId: row.PerformanceId || undefined,
    investmentType: row.InvestmentType || undefined,
    closePrice:
      typeof row.ClosePrice === 'number' && Number.isFinite(row.ClosePrice)
        ? row.ClosePrice
        : undefined,
    yahooTicker: yahooTickerFromMorningstar(row),
  }
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/

async function screener(
  query: Record<string, string>,
  pageSize: number,
  timeoutMs: number,
): Promise<MorningstarHit[]> {
  const params = new URLSearchParams({
    page: '1',
    pageSize: String(pageSize),
    outputType: 'json',
    version: '1',
    languageId: 'fr-FR',
    securityDataPoints: DATA_POINTS,
    ...query,
  })
  const res = await fetch(`${SCREENER_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Morningstar HTTP ${res.status}`)
  const data = (await res.json()) as { rows?: MorningstarRow[] }
  const seen = new Set<string>()
  const hits: MorningstarHit[] = []
  for (const row of data.rows ?? []) {
    const hit = morningstarRowToHit(row)
    if (!hit) continue
    const key = `${hit.isin}|${hit.secId ?? ''}|${hit.mic ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(hit)
  }
  return hits
}

/**
 * All listings of many ISINs. Uses the `ISIN:IN:` filter (~100 ms, 40 ISINs
 * per call) instead of full-text `term` search (5–10 s per call).
 */
export async function searchMorningstarByIsins(
  isins: string[],
  options?: { timeoutMs?: number },
): Promise<MorningstarHit[]> {
  const unique = [
    ...new Set(isins.map((i) => i.trim().toUpperCase()).filter((i) => ISIN_RE.test(i))),
  ]
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += 40) chunks.push(unique.slice(i, i + 40))
  const parts = await Promise.all(
    chunks.map((chunk) =>
      screener(
        { filters: `ISIN:IN:${chunk.join(':')}` },
        500,
        options?.timeoutMs ?? 15_000,
      ),
    ),
  )
  return parts.flat()
}

/** Name or ISIN search; ISINs go through the fast filter path. */
export async function searchMorningstar(
  term: string,
  options?: { pageSize?: number; timeoutMs?: number },
): Promise<MorningstarHit[]> {
  const q = term.trim().slice(0, 80)
  if (q.length < 2) return []
  if (ISIN_RE.test(q.toUpperCase())) {
    return searchMorningstarByIsins([q], options)
  }
  return screener({ term: q }, options?.pageSize ?? 10, options?.timeoutMs ?? 15_000)
}

/** ISIN country → home venue (reference listing of a stock). */
const HOME_MIC: Record<string, string[]> = {
  FR: ['XPAR'],
  NL: ['XAMS'],
  BE: ['XBRU'],
  PT: ['XLIS'],
  DE: ['XETR', 'XFRA'],
  IT: ['XMIL'],
  ES: ['XMAD'],
  GB: ['XLON'],
  CH: ['XSWX'],
  FI: ['XHEL'],
  SE: ['XSTO'],
  DK: ['XCSE'],
  NO: ['XOSL'],
  PL: ['XWAR'],
  AT: ['XWBO'],
  US: ['XNAS', 'XNYS'],
}

/**
 * Best listing of one ISIN for its price series: the Yahoo ticker already
 * chosen, else the issuer's home venue, else Euronext Paris (ETFs / funds
 * domiciled in IE / LU), else any regulated venue. MTF copies (CHIX, BATS…)
 * come last — their series are often stale. Funds have no venue.
 */
export function pickHistoryListing(
  hits: MorningstarHit[],
  isin: string,
  yahooTicker?: string,
): MorningstarHit | undefined {
  const rows = hits.filter((h) => h.isin === isin && h.secId)
  const home = HOME_MIC[isin.slice(0, 2)] ?? []
  const score = (h: MorningstarHit) => {
    if (yahooTicker && h.yahooTicker === yahooTicker) return 100
    if (!h.mic) return 60
    if (home.includes(h.mic)) return 50
    if (h.mic === 'XPAR') return 40
    if (MIC_TO_YAHOO_SUFFIX[h.mic]) return 20
    return 0
  }
  return rows
    .map((h, i) => ({ h, s: score(h), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)[0]?.h
}

const TIMESERIES_URL =
  'https://lt.morningstar.com/api/rest.svc/timeseries_price/klr5zyak8x'

/**
 * Daily closes of one Morningstar series, converted to `currency`
 * (EUR by default — the portfolio currency; without it Morningstar answers GBP).
 */
export async function fetchMorningstarCloses(
  secId: string,
  options: {
    start: string
    end?: string
    currency?: string
    timeoutMs?: number
  },
): Promise<Array<{ date: string; close: number }>> {
  if (!/^[0-9A-Z]{10}$/i.test(secId)) return []
  const params = new URLSearchParams({
    id: secId,
    idtype: 'Morningstar',
    currencyId: options.currency ?? 'EUR',
    frequency: 'daily',
    startDate: options.start,
    outputType: 'COMPACTJSON',
  })
  if (options.end) params.set('endDate', options.end)
  const res = await fetch(`${TIMESERIES_URL}?${params}`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  if (!res.ok) throw new Error(`Morningstar HTTP ${res.status}`)
  return parseMorningstarCloses(await res.json())
}

/**
 * EUR close of an ISIN's main listing on `date` (last bar on/before, else the
 * first within 10 days after). Undefined when Morningstar has no series.
 */
export async function morningstarCloseOn(
  isin: string,
  date: string,
): Promise<number | undefined> {
  const listing = pickHistoryListing(await searchMorningstarByIsins([isin]), isin)
  if (!listing?.secId) return undefined
  const day = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(day)) return undefined
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const bars = await fetchMorningstarCloses(listing.secId, {
    start: iso(day - 10 * 86400000),
    end: iso(day + 10 * 86400000),
  })
  return (
    bars.filter((b) => b.date <= date).at(-1)?.close ??
    bars.find((b) => b.date > date)?.close
  )
}

/** `[[epochMs, close], …]` → bars; unknown ids answer `[[]]`. */
export function parseMorningstarCloses(
  data: unknown,
): Array<{ date: string; close: number }> {
  if (!Array.isArray(data)) return []
  const bars: Array<{ date: string; close: number }> = []
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 2) continue
    const [ms, close] = row as [unknown, unknown]
    if (typeof ms !== 'number' || typeof close !== 'number') continue
    if (!Number.isFinite(close) || close <= 0) continue
    bars.push({ date: new Date(ms).toISOString().slice(0, 10), close })
  }
  return bars
}
