import { normalizeMatchKey } from './tickerSeed'

/** Noise tokens ignored for coverage / scoring. */
export const NAME_STOP_WORDS = new Set([
  'sa',
  'se',
  'sas',
  'nv',
  'plc',
  'ag',
  'ltd',
  'inc',
  'the',
  'and',
  'et',
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'ucits',
  'etf',
  'acc',
  'dis',
  'eur',
  'class',
  'part',
  'actions',
  'shares',
  'fund',
  'fonds',
])

export function significantTokens(raw: string): string[] {
  return normalizeMatchKey(raw)
    .split(' ')
    .filter((w) => w.length > 2 && !NAME_STOP_WORDS.has(w))
}

export interface NameCoverage {
  /** Fraction of query tokens found in the hit (0–1). */
  coverage: number
  matched: number
  total: number
  jaccard: number
}

/**
 * Token coverage of `query` against `hitLabel` after normalization.
 * Prefer coverage (how much of the query is explained) over raw includes.
 */
export function nameCoverage(query: string, hitLabel: string): NameCoverage {
  const qTokens = significantTokens(query)
  const hTokens = significantTokens(hitLabel)
  if (!qTokens.length) {
    return { coverage: 1, matched: 0, total: 0, jaccard: 0 }
  }
  if (!hTokens.length) {
    return { coverage: 0, matched: 0, total: qTokens.length, jaccard: 0 }
  }
  const hSet = new Set(hTokens)
  const matched = qTokens.filter((t) => hSet.has(t) || hTokens.some((h) => h.includes(t) || t.includes(h))).length
  const qSet = new Set(qTokens)
  const inter = hTokens.filter((t) => qSet.has(t)).length
  const union = new Set([...qTokens, ...hTokens]).size
  return {
    coverage: matched / qTokens.length,
    matched,
    total: qTokens.length,
    jaccard: union > 0 ? inter / union : 0,
  }
}

/**
 * Accept a broker/search hit as "good enough" to short-circuit the cascade.
 * Single-token queries always pass; multi-token names need ≥50% coverage
 * (or ≥2 matched tokens when the query is long).
 */
export function passesNameQualityGate(query: string, hitLabel: string): boolean {
  const { coverage, matched, total } = nameCoverage(query, hitLabel)
  if (total <= 1) return matched >= 1 || total === 0
  if (total >= 3) return matched >= 2 && coverage >= 0.45
  return coverage >= 0.5
}

/**
 * Score contribution from name similarity (0–100-ish), coverage-based.
 * Penalizes issuer-only / brand-only hits on multi-token product names.
 */
export function nameMatchBonus(query: string, hitLabel: string): number {
  const q = normalizeMatchKey(query)
  const h = normalizeMatchKey(hitLabel)
  if (!q || !h) return 0
  if (q === h) return 80

  const { coverage, matched, total, jaccard } = nameCoverage(query, hitLabel)
  if (total === 0) return 0

  let bonus = Math.round(coverage * 70 + jaccard * 20)
  if (h.includes(q) || q.includes(h)) bonus = Math.max(bonus, 45)

  // Brand-only: few matched tokens vs a rich query (ETF family collisions)
  if (total >= 3 && matched <= 1) bonus = Math.min(bonus, 12)
  if (total >= 4 && coverage < 0.4) bonus = Math.min(bonus, 18)

  return bonus
}

/** Yahoo symbol has an exchange suffix, or is an explicit US primary listing. */
export function isQualifiedYahooTicker(
  ticker: string,
  options?: { allowBareUs?: boolean },
): boolean {
  const t = ticker.trim()
  if (!t) return false
  if (/\.[A-Za-z]{1,4}$/.test(t)) return true
  // Mutual-fund style Morningstar codes often have a dot already; bare OK only if allowed
  if (options?.allowBareUs && /^[A-Z]{1,5}$/i.test(t)) return true
  return false
}

/** Soft US / ADR demotion for PEA-oriented resolution. */
export function usListingPenalty(isin?: string, ticker?: string): number {
  let p = 0
  const id = (isin || '').toUpperCase()
  if (id.startsWith('US')) p -= 35
  const sym = (ticker || '').toUpperCase()
  if (/\.(N|O|PK|OB|OTC)$/.test(sym)) p -= 25
  if (sym && !sym.includes('.') && /^[A-Z]{1,5}$/.test(sym)) p -= 15
  return p
}
