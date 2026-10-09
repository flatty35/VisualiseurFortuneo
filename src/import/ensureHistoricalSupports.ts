import type { Operation, Support } from '@/domain/types'
import { db } from '@/persist/db'
import {
  assignSupportKeys,
  buildNameToIsin,
  isLocalSupportId,
  localSupportId,
  normalizeName,
} from './resolveIsin'
import { applySeedMatches } from '@/quotes/tickerMatch'

export interface HistoricalSupportsReport {
  opsUpdated: number
  supportsCreated: number
  migratedToRealIsin: number
}

let inflight: Promise<HistoricalSupportsReport> | null = null

/**
 * Backfill supports + op.isin for historical titres that Fortuneo exports
 * without an ISIN in the libellé (label-only rows). Safe to run on every
 * import / Correspondances load.
 */
export async function ensureHistoricalSupports(): Promise<HistoricalSupportsReport> {
  if (inflight) return inflight
  inflight = ensureHistoricalSupportsInner().finally(() => {
    inflight = null
  })
  return inflight
}

async function ensureHistoricalSupportsInner(): Promise<HistoricalSupportsReport> {
  const [ops, supports, openings] = await Promise.all([
    db.operations.toArray(),
    db.supports.toArray(),
    db.virtualOpenings.toArray(),
  ])

  const supportMap = new Map(supports.map((s) => [s.isin, s]))
  const positions = openings.flatMap((vo) =>
    vo.positions.map((p) => ({
      isin: p.isin,
      name: p.name,
      quantity: p.quantity,
    })),
  )

  // Prefer real ISINs already known on supports / VO / ops
  const nameToIsin = buildNameToIsin(positions, ops)
  for (const s of supports) {
    if (!isLocalSupportId(s.isin)) {
      nameToIsin.set(normalizeName(s.name), s.isin)
    }
  }

  const keyed = assignSupportKeys(ops, nameToIsin)

  // Migrate LOCAL:* → real ISIN when a name match appears later
  let migratedToRealIsin = 0
  const remap = new Map<string, string>() // oldIsin → newIsin
  for (const o of keyed) {
    if (!o.isin || !o.name) continue
    if (!isLocalSupportId(o.isin)) continue
    const real = nameToIsin.get(normalizeName(o.name))
    if (real && real !== o.isin) {
      remap.set(o.isin, real)
    }
  }

  const finalOps: Operation[] = keyed.map((o) => {
    if (o.isin && remap.has(o.isin)) {
      migratedToRealIsin++
      return { ...o, isin: remap.get(o.isin)! }
    }
    // Also: op already LOCAL but name now resolves — assignSupportKeys
    // only fills missing; upgrade LOCAL when real is known
    if (o.isin && isLocalSupportId(o.isin) && o.name) {
      const real = nameToIsin.get(normalizeName(o.name))
      if (real && !isLocalSupportId(real)) {
        migratedToRealIsin++
        remap.set(o.isin, real)
        return { ...o, isin: real }
      }
    }
    return o
  })

  let opsUpdated = 0
  const toPut: Operation[] = []
  for (let i = 0; i < ops.length; i++) {
    const before = ops[i]
    const after = finalOps[i]
    if (before.isin !== after.isin) {
      toPut.push(after)
      opsUpdated++
    }
  }
  if (toPut.length) await db.operations.bulkPut(toPut)

  // Upsert supports for every distinct isin on ops + migrate LOCAL shells
  let supportsCreated = 0
  const seen = new Set<string>()
  for (const o of finalOps) {
    if (!o.isin || !o.name) continue
    if (seen.has(o.isin)) continue
    seen.add(o.isin)
    const cur = supportMap.get(o.isin)
    if (!cur) {
      // If we migrated away from a LOCAL id, reuse ticker from the old row
      let yahooTicker: string | undefined
      let googleTicker: string | undefined
      let boursoramaTicker: string | undefined
      let manualPrices: Support['manualPrices'] = []
      let staticPrice: number | undefined
      for (const [from, to] of remap) {
        if (to !== o.isin) continue
        const old = supportMap.get(from)
        if (old) {
          yahooTicker = old.yahooTicker
          googleTicker = old.googleTicker
          boursoramaTicker = old.boursoramaTicker
          manualPrices = old.manualPrices
          staticPrice = old.staticPrice
        }
      }
      const created: Support = {
        isin: o.isin,
        name: o.name,
        yahooTicker,
        googleTicker,
        boursoramaTicker,
        manualPrices,
        staticPrice,
      }
      supportMap.set(o.isin, created)
      await db.supports.put(created)
      supportsCreated++
    } else if (o.name && cur.name !== o.name && isLocalSupportId(cur.isin)) {
      // keep clearer name from ops
      const updated = { ...cur, name: o.name }
      supportMap.set(o.isin, updated)
      await db.supports.put(updated)
    }
  }

  // Also ensure a LOCAL support exists for every unique trade name
  // (covers names only seen on dividends etc. after keying)
  for (const o of finalOps) {
    if (!o.name || o.isin) continue
    const id = localSupportId(o.name)
    if (supportMap.has(id)) continue
    const created: Support = {
      isin: id,
      name: o.name,
      manualPrices: [],
    }
    supportMap.set(id, created)
    await db.supports.put(created)
    supportsCreated++
  }

  // Drop orphan LOCAL supports that were fully migrated
  for (const [from, to] of remap) {
    if (from === to) continue
    const old = supportMap.get(from)
    const neu = supportMap.get(to)
    if (old && neu) {
      // merge tickers into real ISIN if missing
      const merged: Support = {
        ...neu,
        yahooTicker: neu.yahooTicker ?? old.yahooTicker,
        googleTicker: neu.googleTicker ?? old.googleTicker,
        boursoramaTicker: neu.boursoramaTicker ?? old.boursoramaTicker,
        staticPrice: neu.staticPrice ?? old.staticPrice,
        manualPrices:
          neu.manualPrices.length > 0 ? neu.manualPrices : old.manualPrices,
      }
      await db.supports.put(merged)
      await db.supports.delete(from)
      supportMap.delete(from)
    }
  }

  await applySeedMatches([...supportMap.values()])

  return { opsUpdated, supportsCreated, migratedToRealIsin }
}
