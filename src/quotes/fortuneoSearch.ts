import { isValidIsin } from '@/persist/rekeySupport'
import {
  fetchBulkPrices,
  isProxyConfigured,
  searchYahoo,
  type YahooSearchHit,
} from './gasClient'
import {
  isQualifiedYahooTicker,
  nameMatchBonus,
  passesNameQualityGate,
  usListingPenalty,
} from './nameMatch'
import { normalizeMatchKey } from './tickerSeed'

/**
 * Yahoo suffixes to try when Fortuneo gives a mnemo but no usable place.
 * Order = PEA / Europe preference.
 */
export const YAHOO_PROBE_SUFFIXES = [
  '.PA',
  '.AS',
  '.DE',
  '.MC',
  '.MI',
  '.BR',
  '.WA',
  '.CO',
  '.L',
  '.SW',
  '.F',
  '.HE',
  '.ST',
  '.OL',
  '.VI',
  '.LS',
] as const

const API = 'https://bourse.fortuneo.fr/api/search'

/**
 * Place label fragments → Yahoo suffix.
 * Matched case-insensitively via `includes` (longest match wins).
 */
const PLACE_SUFFIX_RULES: Array<{ needles: string[]; suffix: string }> = [
  { needles: ['euronext paris', 'paris'], suffix: '.PA' },
  { needles: ['euronext amsterdam', 'amsterdam'], suffix: '.AS' },
  { needles: ['euronext brussels', 'brussels', 'bruxelles'], suffix: '.BR' },
  { needles: ['euronext lisbon', 'lisbon', 'lisbonne'], suffix: '.LS' },
  { needles: ['xetra', 'frankfurt', 'deutsche börse', 'deutsche borse'], suffix: '.DE' },
  { needles: ['london stock exchange', 'london', 'lse'], suffix: '.L' },
  { needles: ['warsaw', 'varsovie', 'gpw'], suffix: '.WA' },
  { needles: ['copenhagen', 'copenhague', 'nasdaq copenhagen'], suffix: '.CO' },
  { needles: ['madrid', 'bolsa de madrid', 'continuous market'], suffix: '.MC' },
  { needles: ['milan', 'milano', 'borsa italiana'], suffix: '.MI' },
  { needles: ['stockholm', 'nasdaq stockholm'], suffix: '.ST' },
  { needles: ['oslo'], suffix: '.OL' },
  { needles: ['zurich', 'six swiss'], suffix: '.SW' },
  { needles: ['vienna', 'wiener'], suffix: '.VI' },
  { needles: ['helsinki'], suffix: '.HE' },
  { needles: ['nyse', 'new york stock'], suffix: '' },
  { needles: ['nasdaq'], suffix: '' },
]

export interface FortuneoHit {
  codeIsin?: string
  mnemo?: string
  libelle?: string
  type?: string
  place?: string
  codePlace?: number
  cours?: number | null
  devise?: string | null
  codeRef?: string
}

export interface FortuneoSearchDebug {
  phase: 'fortuneo'
  query: string
  ok: boolean
  detail: string
  count?: number
}

function placeSuffix(place: string): string | undefined {
  const p = place.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  if (!p) return undefined
  let best: { len: number; suffix: string } | undefined
  for (const rule of PLACE_SUFFIX_RULES) {
    for (const needle of rule.needles) {
      if (p.includes(needle) && (!best || needle.length > best.len)) {
        best = { len: needle.length, suffix: rule.suffix }
      }
    }
  }
  return best?.suffix
}

/** Guess Yahoo Finance ticker from Fortuneo mnemo + place. Never returns a bare mnemo. */
export function guessYahooTicker(hit: FortuneoHit): string | undefined {
  const mnemo = (hit.mnemo || '').trim()
  if (!mnemo) return undefined
  // codePlace 23 = Euronext Paris (empirique Accès Marchés)
  if (hit.codePlace === 23) {
    const t = `${mnemo}.PA`
    return isQualifiedYahooTicker(t) ? t : undefined
  }
  const suffix = placeSuffix(hit.place || '')
  if (suffix === undefined) return undefined
  // NYSE / NASDAQ → bare ticker is intentional
  if (suffix === '') {
    return /^[A-Za-z]{1,5}$/.test(mnemo) ? mnemo.toUpperCase() : undefined
  }
  const t = `${mnemo}${suffix}`
  return isQualifiedYahooTicker(t) ? t : undefined
}

/** Candidate Yahoo symbols from a Fortuneo mnemo (suffix probe list). */
export function yahooCandidatesFromMnemo(mnemo: string): string[] {
  const m = mnemo.trim()
  if (!m || !/^[A-Za-z0-9.^_=/-]{1,24}$/.test(m)) return []
  const out: string[] = []
  for (const s of YAHOO_PROBE_SUFFIXES) {
    out.push(`${m}${s}`)
  }
  if (/^[A-Za-z]{1,5}$/.test(m)) out.push(m.toUpperCase())
  return out
}

/**
 * Pick among probed Yahoo prices. Prefer closest to Fortuneo `cours` (±20%),
 * else first alive candidate in PEA-oriented order.
 */
export function pickYahooByProbedPrices(
  candidates: string[],
  prices: Record<string, number>,
  preferPrice?: number | null,
): string | undefined {
  const alive = candidates.filter((c) => {
    const p = prices[c]
    return p !== undefined && Number.isFinite(p) && p > 0
  })
  if (!alive.length) return undefined

  if (preferPrice != null && Number.isFinite(preferPrice) && preferPrice > 0) {
    const scored = alive
      .map((c) => ({
        c,
        rel: Math.abs(prices[c] - preferPrice) / preferPrice,
      }))
      .filter((x) => x.rel <= 0.2)
      .sort(
        (a, b) =>
          a.rel - b.rel ||
          candidates.indexOf(a.c) - candidates.indexOf(b.c),
      )
    if (scored.length) return scored[0].c
  }
  return alive.sort(
    (a, b) => candidates.indexOf(a) - candidates.indexOf(b),
  )[0]
}

/**
 * Among Yahoo search hits, prefer symbols that extend the Fortuneo mnemo
 * and match the libellé (coverage scoring).
 */
export function pickYahooFromSearchHits(
  hits: YahooSearchHit[],
  mnemo: string,
  name: string,
): string | undefined {
  const m = mnemo.trim().toUpperCase()
  if (!m || !hits.length) return undefined

  const scored = hits
    .filter((h) => h.symbol)
    .map((h) => {
      const sym = h.symbol!
      const up = sym.toUpperCase()
      let score = nameMatchBonus(
        name,
        h.longname || h.shortname || '',
      )
      score += nameMatchBonus(name, h.shortname || '')
      if (up === m || up.startsWith(`${m}.`)) score += 45
      else if (up.includes(m)) score += 10
      else score -= 20
      if (up.endsWith('.PA')) score += 25
      else if (/\.(AS|DE|MC|MI|BR|WA|CO|L|SW|F)$/.test(up)) score += 12
      score += usListingPenalty(h.isin, up)
      if (!isQualifiedYahooTicker(sym)) score -= 60
      return { sym, score }
    })
    .filter((x) => x.score >= 25 && isQualifiedYahooTicker(x.sym))
    .sort((a, b) => b.score - a.score)

  return scored[0]?.sym
}

/**
 * Resolve a Yahoo ticker from a Fortuneo hit:
 * 1) place → suffix map
 * 2) Yahoo search on mnemo (+ libellé)
 * 3) suffix probe + optional Fortuneo cours match
 */
export async function resolveYahooTickerFromFortuneoHit(
  hit: FortuneoHit,
): Promise<{ ticker?: string; detail?: string }> {
  const guessed = guessYahooTicker(hit)
  if (guessed) return { ticker: guessed, detail: 'place' }

  const mnemo = (hit.mnemo || '').trim()
  if (!mnemo || !isProxyConfigured()) return {}

  const name = (hit.libelle || mnemo).trim()
  const searchQueries = [
    mnemo,
    name.length > mnemo.length ? `${mnemo} ${name}` : '',
  ].filter((q, i, arr) => q.length >= 2 && arr.indexOf(q) === i)

  for (const q of searchQueries) {
    try {
      const hits = await searchYahoo(q)
      const ticker = pickYahooFromSearchHits(hits, mnemo, name)
      if (ticker) {
        return { ticker, detail: `yahoo-search:${q}→${ticker}` }
      }
    } catch {
      // try next query / probe
    }
  }

  const candidates = yahooCandidatesFromMnemo(mnemo)
  if (!candidates.length) return {}

  try {
    const prices = await fetchBulkPrices(candidates)
    const cours =
      hit.cours != null && Number.isFinite(hit.cours)
        ? Number(hit.cours)
        : undefined
    const ticker = pickYahooByProbedPrices(candidates, prices, cours)
    if (!ticker) return {}
    return {
      ticker,
      detail:
        cours != null
          ? `probe+cours(${cours})→${ticker}`
          : `probe→${ticker}`,
    }
  } catch {
    return {}
  }
}

function dedupeHits(items: FortuneoHit[]): FortuneoHit[] {
  const seen = new Set<string>()
  const out: FortuneoHit[] = []
  for (const it of items) {
    const key = `${it.codeIsin || ''}|${it.mnemo || ''}|${it.place || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/** Public score for tests / ISIN ingest (aligned with scoreIsinHit scale). */
export function scoreFortuneoHit(hit: FortuneoHit, name: string): number {
  let score = 40
  const place = hit.place || ''
  if (place === 'Euronext Paris' || hit.codePlace === 23) score += 35
  else if (/Euronext/i.test(place)) score += 20
  if ((hit.type || '').toLowerCase() === 'action') score += 15

  const isin = (hit.codeIsin || '').toUpperCase()
  if (isin.startsWith('FR')) score += 20
  if (isValidIsin(isin)) score += 25

  const yahoo = guessYahooTicker(hit)
  score += nameMatchBonus(name, hit.libelle || '')
  score += usListingPenalty(isin, yahoo)

  // Reject weak name matches for multi-token queries
  if (!passesNameQualityGate(name, hit.libelle || '')) {
    score = Math.min(score, 90)
  }
  return score
}

/** Pick best Fortuneo hit for a Fortuneo libellé (Paris / name match). */
export function pickBestFortuneoHit(
  hits: FortuneoHit[],
  name: string,
): FortuneoHit | undefined {
  const withIsin = hits.filter((h) =>
    isValidIsin((h.codeIsin || '').toUpperCase()),
  )
  const pool = withIsin.length ? withIsin : hits
  if (!pool.length) return undefined
  const ranked = [...pool].sort(
    (a, b) => scoreFortuneoHit(b, name) - scoreFortuneoHit(a, name),
  )
  const best = ranked[0]
  // Prefer a hit that passes the name gate when available
  const gated = ranked.find((h) =>
    passesNameQualityGate(name, h.libelle || ''),
  )
  return gated ?? best
}

/**
 * True when the best Fortuneo hit is good enough to short-circuit other sources.
 */
export function fortuneoHitAcceptable(
  hit: FortuneoHit | undefined,
  name: string,
): boolean {
  if (!hit) return false
  if (!passesNameQualityGate(name, hit.libelle || '')) return false
  const isin = (hit.codeIsin || '').toUpperCase()
  if (isin.startsWith('US')) return false
  return scoreFortuneoHit(hit, name) >= 120
}

/**
 * Recherche publique Accès Marchés Fortuneo (CORS *).
 * Pas de login.
 */
export async function searchFortuneo(
  term: string,
  options?: { signal?: AbortSignal },
): Promise<{ hits: FortuneoHit[]; debug: FortuneoSearchDebug }> {
  const q = term.trim().slice(0, 80)
  if (q.length < 2) {
    return {
      hits: [],
      debug: {
        phase: 'fortuneo',
        query: q,
        ok: false,
        detail: 'query trop courte',
      },
    }
  }
  try {
    const url = `${API}?term=${encodeURIComponent(q)}`
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: 'https://bourse.fortuneo.fr/',
      },
      signal: options?.signal ?? AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      return {
        hits: [],
        debug: {
          phase: 'fortuneo',
          query: q,
          ok: false,
          detail: `HTTP ${res.status}`,
        },
      }
    }
    const data = (await res.json()) as {
      market?: { fortuneo?: { items?: FortuneoHit[] } }
    }
    const items = data?.market?.fortuneo?.items
    const hits = Array.isArray(items) ? dedupeHits(items) : []
    const best = pickBestFortuneoHit(hits, q)
    return {
      hits,
      debug: {
        phase: 'fortuneo',
        query: q,
        ok: hits.length > 0,
        detail: hits.length
          ? `${hits.length} hit(s), meilleur=${best?.codeIsin || '—'} ${best?.mnemo || ''}`
          : '0 résultat',
        count: hits.length,
      },
    }
  } catch (e) {
    return {
      hits: [],
      debug: {
        phase: 'fortuneo',
        query: q,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/**
 * Prefer full-name queries first; only fall back to short tokens if nothing usable.
 * "Usable" = valid ISIN + name quality gate on the best hit.
 */
export async function searchFortuneoFirstHit(input: {
  name: string
  queries?: string[]
  onStatus?: (msg: string) => void
}): Promise<{
  hits: FortuneoHit[]
  query?: string
  debug: FortuneoSearchDebug[]
}> {
  const raw =
    input.queries?.length && input.queries.length > 0
      ? input.queries
      : [input.name]

  // Full / longer queries first; single-token last
  const sorted = [...raw].sort((a, b) => {
    const ta = normalizeMatchKey(a).split(' ').filter(Boolean).length
    const tb = normalizeMatchKey(b).split(' ').filter(Boolean).length
    if (tb !== ta) return tb - ta
    return b.length - a.length
  })

  const debug: FortuneoSearchDebug[] = []
  let weakFallback: { hits: FortuneoHit[]; query: string } | undefined

  for (const q of sorted.slice(0, 4)) {
    input.onStatus?.(`Fortuneo « ${q} »…`)
    const { hits, debug: step } = await searchFortuneo(q)
    debug.push(step)
    const usable = hits.filter((h) =>
      isValidIsin((h.codeIsin || '').toUpperCase()),
    )
    if (!usable.length) continue
    const best = pickBestFortuneoHit(usable, input.name)
    if (fortuneoHitAcceptable(best, input.name)) {
      return { hits: usable, query: q, debug }
    }
    if (!weakFallback) weakFallback = { hits: usable, query: q }
  }

  // Return weak hits for ingest/scoring, but caller must not early-stop on them
  if (weakFallback) {
    return { hits: weakFallback.hits, query: weakFallback.query, debug }
  }
  return { hits: [], debug }
}
