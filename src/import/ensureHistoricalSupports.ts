import type { Operation, Support } from '@/domain/types'
import { AssetType } from '@/domain/portfolioModel'
import { projectPortfolio } from '@/domain/flatAdapters'
import { loadPortfolio, savePortfolio } from '@/persist/portfolioStore'
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
  const portfolio = await loadPortfolio()
  const projected = projectPortfolio(portfolio)
  const ops = projected.operations
  const supports = projected.supports
  const openings = projected.virtualOpenings

  const supportMap = new Map(supports.map((s) => [s.isin, s]))
  const positions = openings.flatMap((vo) =>
    vo.positions.map((p) => ({
      isin: p.isin,
      name: p.name,
      quantity: p.quantity,
    })),
  )

  const nameToIsin = buildNameToIsin(positions, ops)
  for (const s of supports) {
    if (!isLocalSupportId(s.isin)) {
      nameToIsin.set(normalizeName(s.name), s.isin)
    }
  }

  const keyed = assignSupportKeys(ops, nameToIsin)

  let migratedToRealIsin = 0
  const remap = new Map<string, string>()
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
  for (let i = 0; i < ops.length; i++) {
    const before = ops[i]
    const after = finalOps[i]
    if (before.isin === after.isin) continue
    opsUpdated++
    // Update domain op customDetails + supportUniqueID
    for (const env of portfolio.envelopes) {
      const dop = env.operations.find((x) => x.id === before.id)
      if (!dop) continue
      const key = after.isin!
      const s = portfolio.upsertSupport({
        niceUniqueName: after.name ?? key,
        ISIN: key.startsWith('LOCAL:') ? '' : key,
        localKey: key.startsWith('LOCAL:') ? key : '',
        assetType: AssetType.ACTIONS,
      })
      dop.supportUniqueID = s.uniqueID
      dop.customDetails = { ...dop.customDetails, isin: key, name: after.name }
    }
  }

  let supportsCreated = 0
  const beforeCount = Object.keys(portfolio.supports).length
  const seen = new Set<string>()
  for (const o of finalOps) {
    if (!o.isin || !o.name) continue
    if (seen.has(o.isin)) continue
    seen.add(o.isin)
    const cur = supportMap.get(o.isin)
    if (!cur) {
      let yahooTicker = ''
      let googleTicker = ''
      let boursoramaTicker = ''
      let staticDatedValues: Array<[number, number]> = []
      let lastKnown: [number, number] = [0, 0]
      for (const [from, to] of remap) {
        if (to !== o.isin) continue
        const old = portfolio.findSupportByKey(from)
        if (old) {
          yahooTicker = old.yahooFinanceTicker
          googleTicker = old.googleFinanceTicker
          boursoramaTicker = old.boursoramaTicker
          staticDatedValues = old.staticDatedValues
          lastKnown = old.lastKnownValue
        }
      }
      portfolio.upsertSupport({
        niceUniqueName: o.name,
        ISIN: o.isin.startsWith('LOCAL:') ? '' : o.isin,
        localKey: o.isin.startsWith('LOCAL:') ? o.isin : '',
        assetType: AssetType.ACTIONS,
        yahooFinanceTicker: yahooTicker,
        googleFinanceTicker: googleTicker,
        boursoramaTicker: boursoramaTicker,
        staticDatedValues,
        lastKnownValue: lastKnown,
      })
    } else if (o.name && cur.name !== o.name && isLocalSupportId(cur.isin)) {
      const s = portfolio.findSupportByKey(o.isin)
      if (s) s.niceUniqueName = o.name
    }
  }

  for (const o of finalOps) {
    if (!o.name || o.isin) continue
    const id = localSupportId(o.name)
    if (supportMap.has(id) || portfolio.findSupportByKey(id)) continue
    portfolio.upsertSupport({
      niceUniqueName: o.name,
      localKey: id,
      assetType: AssetType.ACTIONS,
    })
  }

  for (const [from, to] of remap) {
    if (from === to) continue
    const old = portfolio.findSupportByKey(from)
    const neu = portfolio.findSupportByKey(to)
    if (old && neu) {
      if (!neu.yahooFinanceTicker) neu.yahooFinanceTicker = old.yahooFinanceTicker
      if (!neu.googleFinanceTicker)
        neu.googleFinanceTicker = old.googleFinanceTicker
      if (!neu.boursoramaTicker) neu.boursoramaTicker = old.boursoramaTicker
      if (!neu.staticDatedValues.length)
        neu.staticDatedValues = old.staticDatedValues
      // Remap ops still pointing at old support
      for (const env of portfolio.envelopes) {
        for (const op of env.operations) {
          if (op.supportUniqueID === old.uniqueID) {
            op.supportUniqueID = neu.uniqueID
          }
        }
      }
      delete portfolio.supports[old.uniqueID]
      supportMap.delete(from)
    }
  }

  supportsCreated = Math.max(
    0,
    Object.keys(portfolio.supports).length - beforeCount,
  )

  await savePortfolio(portfolio)
  await applySeedMatches(projectPortfolio(portfolio).supports)

  return { opsUpdated, supportsCreated, migratedToRealIsin }
}
