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

/** Trailing fund share-class letters kept even if length ≤ 2. */
const SHARE_CLASS_TOKENS = new Set(['c', 'd', 'i', 'r', 'a', 'p', 'n'])

/** Tokens that must appear in the hit when present in the query. */
const CRITICAL_TOKENS = new Set(['pea', 'pme', 'banks', 'bank'])

export function significantTokens(raw: string): string[] {
  const parts = normalizeMatchKey(raw).split(' ').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i]
    if (NAME_STOP_WORDS.has(w)) continue
    if (w.length > 2) {
      out.push(w)
      continue
    }
    // Keep trailing share class (… Entrepreneurs C)
    if (SHARE_CLASS_TOKENS.has(w) && i === parts.length - 1) out.push(w)
  }
  return out
}

function tokenInHit(token: string, hitTokens: string[]): boolean {
  return (
    hitTokens.includes(token) ||
    hitTokens.some((h) => h.includes(token) || token.includes(h))
  )
}

/** Heavy penalty when PEA/PME/Banks (or share class) is in the query but missing in the hit. */
export function criticalTokenPenalty(query: string, hitLabel: string): number {
  const qTokens = significantTokens(query)
  const hTokens = significantTokens(hitLabel)
  let pen = 0
  for (const t of qTokens) {
    if (!CRITICAL_TOKENS.has(t) && !(SHARE_CLASS_TOKENS.has(t) && t.length <= 1)) {
      continue
    }
    // share class: only last-token c/d/i already in qTokens
    if (SHARE_CLASS_TOKENS.has(t) && t.length === 1) {
      if (!tokenInHit(t, hTokens)) pen -= 50
      continue
    }
    if (CRITICAL_TOKENS.has(t) && !tokenInHit(t, hTokens)) pen -= 70
  }
  return pen
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
  if (criticalTokenPenalty(query, hitLabel) < 0) return false
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

  bonus += criticalTokenPenalty(query, hitLabel)
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
