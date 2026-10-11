import { isValidIsin } from '@/persist/rekeySupport'
import { normalizeMatchKey } from './tickerSeed'

const API = 'https://bourse.fortuneo.fr/api/search'

/** Euronext / places → suffixe Yahoo Finance courant */
const PLACE_TO_YAHOO = new Map([
  ['Euronext Paris', '.PA'],
  ['Euronext Amsterdam', '.AS'],
  ['Euronext Brussels', '.BR'],
  ['Euronext Lisbon', '.LS'],
  ['Xetra', '.DE'],
  ['London Stock Exchange', '.L'],
  ['NYSE', ''],
  ['NASDAQ', ''],
])

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

/** Guess Yahoo Finance ticker from Fortuneo mnemo + place. */
export function guessYahooTicker(hit: FortuneoHit): string | undefined {
  const mnemo = (hit.mnemo || '').trim()
  if (!mnemo) return undefined
  const place = hit.place || ''
  if (PLACE_TO_YAHOO.has(place)) {
    return `${mnemo}${PLACE_TO_YAHOO.get(place)}`
  }
  // codePlace 23 = Euronext Paris (empirique Accès Marchés)
  if (hit.codePlace === 23) return `${mnemo}.PA`
  return mnemo
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

function scoreHit(hit: FortuneoHit, name: string): number {
  let score = 50
  const place = hit.place || ''
  if (place === 'Euronext Paris' || hit.codePlace === 23) score += 40
  else if (/Euronext/i.test(place)) score += 20
  if ((hit.type || '').toLowerCase() === 'action') score += 15

  const isin = (hit.codeIsin || '').toUpperCase()
  if (isin.startsWith('FR')) score += 20
  if (isValidIsin(isin)) score += 30

  const label = normalizeMatchKey(name)
  const hitName = normalizeMatchKey(hit.libelle || '')
  if (hitName && label) {
    if (hitName === label) score += 80
    else if (hitName.includes(label) || label.includes(hitName)) score += 45
    else {
      const parts = label.split(' ').filter((w) => w.length > 2)
      score += parts.filter((w) => hitName.includes(w)).length * 12
    }
  }
  return score
}

/** Pick best Fortuneo hit for a Fortuneo libellé (Paris / name match). */
export function pickBestFortuneoHit(
  hits: FortuneoHit[],
  name: string,
): FortuneoHit | undefined {
  const withIsin = hits.filter((h) => isValidIsin((h.codeIsin || '').toUpperCase()))
  const pool = withIsin.length ? withIsin : hits
  if (!pool.length) return undefined
  return [...pool].sort((a, b) => scoreHit(b, name) - scoreHit(a, name))[0]
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
 * First queries until Fortuneo returns at least one hit with ISIN.
 * Returns empty hits if nothing found (caller continues cascade).
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
  const queries =
    input.queries?.length && input.queries.length > 0
      ? input.queries
      : [input.name]
  const debug: FortuneoSearchDebug[] = []
  for (const q of queries.slice(0, 3)) {
    input.onStatus?.(`Fortuneo « ${q} »…`)
    const { hits, debug: step } = await searchFortuneo(q)
    debug.push(step)
    const usable = hits.filter((h) =>
      isValidIsin((h.codeIsin || '').toUpperCase()),
    )
    if (usable.length) {
      return { hits: usable, query: q, debug }
    }
  }
  return { hits: [], debug }
}
