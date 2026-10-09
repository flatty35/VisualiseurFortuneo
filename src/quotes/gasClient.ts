/**
 * Client for the VisualiseurFortuneo Yahoo proxy (Google Apps Script).
 * PRIVACY: only public market identifiers (tickers, date ranges, ISIN/name for
 * search). Never quantities, valuations, operations, or personal identifiers.
 */

import type { QuoteBar } from '@/domain/types'

const PROXY_URL = import.meta.env.VITE_PROXY_URL as string | undefined

export class QuoteProxyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuoteProxyError'
  }
}

function assertProxyConfigured(): string {
  if (!PROXY_URL || PROXY_URL.includes('YOUR_DEPLOYMENT')) {
    throw new QuoteProxyError(
      'Proxy non configuré. Définissez VITE_PROXY_URL dans .env (voir .env.example et gas/README.md).',
    )
  }
  return PROXY_URL
}

/** Allowed ticker charset — reject anything else before network. */
function assertSafeTicker(ticker: string): string {
  const t = ticker.trim()
  if (!/^[A-Za-z0-9.^_=/-]{1,32}$/.test(t)) {
    throw new QuoteProxyError(`Ticker invalide: ${ticker}`)
  }
  return t
}

async function gasGet<T>(
  params: Record<string, string>,
  timeoutMs = 45000,
): Promise<T> {
  const base = assertProxyConfigured()
  const url = new URL(base)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new QuoteProxyError(`Proxy HTTP ${res.status}`)
  }
  const text = await res.text()
  let data: T & { error?: string }
  try {
    data = JSON.parse(text) as T & { error?: string }
  } catch {
    throw new QuoteProxyError(
      'Réponse proxy non-JSON (vérifiez le déploiement GAS /exec et CORS)',
    )
  }
  if (data && typeof data === 'object' && 'error' in data && data.error) {
    throw new QuoteProxyError(String(data.error))
  }
  return data
}

export async function fetchLivePrice(ticker: string): Promise<number> {
  const t = assertSafeTicker(ticker)
  const data = await gasGet<{ price: number }>({ action: 'price', ticker: t })
  return data.price
}

export async function fetchBulkPrices(
  tickers: string[],
): Promise<Record<string, number>> {
  const clean = [...new Set(tickers.map(assertSafeTicker))]
  if (!clean.length) return {}
  const data = await gasGet<{ prices: Record<string, number> }>({
    action: 'bulk',
    tickers: clean.join(','),
  })
  return data.prices ?? {}
}

export async function fetchHistory(
  ticker: string,
  days: number,
): Promise<QuoteBar[]> {
  const t = assertSafeTicker(ticker)
  const d = Math.min(730, Math.max(1, Math.floor(days)))
  const data = await gasGet<{ bars: QuoteBar[] }>({
    action: 'history',
    ticker: t,
    days: String(d),
  })
  return (data.bars ?? []).map((b) => ({
    date: b.date,
    close: b.close,
  }))
}

export async function fetchHistoryRange(
  ticker: string,
  period1: string,
  period2: string,
): Promise<QuoteBar[]> {
  const t = assertSafeTicker(ticker)
  // Only ISO dates — no other payload
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period1) || !/^\d{4}-\d{2}-\d{2}$/.test(period2)) {
    throw new QuoteProxyError('Plage de dates invalide')
  }
  const data = await gasGet<{ bars: QuoteBar[] }>({
    action: 'history',
    ticker: t,
    period1,
    period2,
  })
  return (data.bars ?? []).map((b) => ({
    date: b.date,
    close: b.close,
  }))
}

export interface YahooSearchHit {
  symbol: string
  shortname?: string
  longname?: string
  quoteType?: string
  exch?: string
  isin?: string
}

/** Public ticker search (name or ISIN as free-text q). No portfolio data. */
export async function searchYahoo(query: string): Promise<YahooSearchHit[]> {
  const q = query.trim().slice(0, 80)
  if (!q) return []
  const data = await gasGet<{ quotes: YahooSearchHit[] }>({
    action: 'search',
    q,
  })
  return data.quotes ?? []
}

export interface QuoteMeta {
  symbol: string
  shortname?: string
  longname?: string
  quoteType?: string
  exch?: string
  isin?: string
}

/** Public quote metadata (may include ISIN). */
export async function fetchQuoteMeta(ticker: string): Promise<QuoteMeta> {
  const t = assertSafeTicker(ticker)
  return gasGet<QuoteMeta>({ action: 'quotemeta', ticker: t })
}

export interface OpenFigiMap {
  ticker: string
  exchCode?: string
}

/** Map public ISIN → Yahoo-style ticker via OpenFIGI (PAR → .PA). */
export async function mapIsinOpenFigi(isin: string): Promise<OpenFigiMap | null> {
  const id = isin.trim().toUpperCase()
  if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(id)) return null
  const data = await gasGet<{ ticker?: string; exchCode?: string; error?: string }>({
    action: 'openfigi',
    q: id,
  })
  if (!data.ticker) return null
  return { ticker: data.ticker, exchCode: data.exchCode }
}

export interface OpenFigiSearchHit {
  ticker: string
  figiTicker?: string
  name?: string
  exchCode?: string
  isin?: string
  securityType?: string
}

/** OpenFIGI name/ticker search (public identifiers only). */
export async function searchOpenFigi(query: string): Promise<OpenFigiSearchHit[]> {
  const q = query.trim().slice(0, 80)
  if (q.length < 2) return []
  const data = await gasGet<{ results: OpenFigiSearchHit[] }>({
    action: 'openfigisearch',
    q,
  })
  return data.results ?? []
}

export interface IsinSearchHit {
  isin: string
  name?: string
  ticker?: string
  figiTicker?: string
  exchange?: string
  exchangeCountry?: string
  investmentType?: string
  score?: number
  source?: string
}

export interface IsinSearchProxyResponse {
  results: IsinSearchHit[]
  /** Human-readable debug from GAS (sources tried, errors) */
  debug?: string
}

/**
 * Name/ticker → ISIN candidates via GAS (Morningstar / OpenFIGI / Boursorama).
 * Public market identifiers only — no portfolio data.
 */
export async function searchIsinProxyDetailed(
  query: string,
): Promise<IsinSearchProxyResponse> {
  const q = query.trim().slice(0, 80)
  if (q.length < 2) return { results: [] }
  const data = await gasGet<{
    results?: IsinSearchHit[]
    debug?: string | Record<string, unknown>
    error?: string
  }>({
    action: 'isinsearch',
    q,
  })
  const debug =
    typeof data.debug === 'string'
      ? data.debug
      : data.debug
        ? JSON.stringify(data.debug)
        : undefined
  return { results: data.results ?? [], debug }
}

export async function searchIsinProxy(query: string): Promise<IsinSearchHit[]> {
  const { results } = await searchIsinProxyDetailed(query)
  return results
}

export function isProxyConfigured(): boolean {
  return Boolean(PROXY_URL && !PROXY_URL.includes('YOUR_DEPLOYMENT'))
}
