import { makeOperationId, operationFingerprint } from '@/domain/fingerprint'
import type { Operation, ParsedPosition } from '@/domain/types'

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Stable synthetic key for titles that have no Fortuneo ISIN in the CSV
 * (common: libellé = "SAFRAN" only). Same approach as FortuneoPEAViewer
 * which keyed charts/mappings by libellé.
 */
export function localSupportId(name: string): string {
  const slug = normalizeName(name).replace(/\s+/g, '-').slice(0, 48)
  return `LOCAL:${slug || 'unknown'}`
}

export function isLocalSupportId(isin: string): boolean {
  return isin.startsWith('LOCAL:')
}

/** Build lookup from open positions + known ops to attach ISIN to name-only rows. */
export function buildNameToIsin(
  positions: ParsedPosition[],
  ops: Operation[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const p of positions) {
    if (!p.isin || isLocalSupportId(p.isin)) continue
    map.set(normalizeName(p.name), p.isin)
  }
  for (const o of ops) {
    if (o.isin && o.name && !isLocalSupportId(o.isin)) {
      map.set(normalizeName(o.name), o.isin)
    }
  }
  return map
}

function lookupIsin(
  name: string,
  nameToIsin: Map<string, string>,
): string | undefined {
  const key = normalizeName(name)
  let isin = nameToIsin.get(key)
  if (isin) return isin
  for (const [n, i] of nameToIsin) {
    if (key.includes(n) || n.includes(key)) return i
  }
  return undefined
}

export function attachMissingIsins(
  ops: Operation[],
  nameToIsin: Map<string, string>,
): Operation[] {
  return ops.map((o, idx) => {
    if (o.isin || !o.name) return o
    const isin = lookupIsin(o.name, nameToIsin)
    if (!isin) return o
    // Keep original fingerprint (based on name) so re-imports stay idempotent
    // even after ISIN enrichment.
    return {
      ...o,
      isin,
      id: o.id || makeOperationId(o.fingerprint || operationFingerprint(o), idx),
    }
  })
}

const TRADE_TYPES = new Set([
  'ACHAT',
  'VENTE',
  'SCRIPT',
  'RACHAT',
  'ACTIONS_GRATUITES',
  'AUGMENTATION_CAPITAL',
  'DIVIDENDE',
  'DETACHEMENT',
  'TAXE',
  'OST_OTHER',
  'OST_SPLIT',
  'OST_FUSION',
])

/**
 * Ensure every titre line has a support key: real ISIN when known,
 * otherwise LOCAL:{slug} from the libellé (so sold / historical names
 * still appear in charts and Correspondances).
 */
export function assignSupportKeys(
  ops: Operation[],
  nameToIsin: Map<string, string>,
): Operation[] {
  const withReal = attachMissingIsins(ops, nameToIsin)
  return withReal.map((o, idx) => {
    if (o.isin) return o
    if (!o.name) return o
    if (!TRADE_TYPES.has(o.type) && o.quantity === undefined) return o
    const isin = localSupportId(o.name)
    return {
      ...o,
      isin,
      id: o.id || makeOperationId(o.fingerprint || operationFingerprint(o), idx),
    }
  })
}
