import type { EnvelopeType, Operation } from '@/domain/types'
import { AssetType } from '@/domain/portfolioModel'
import {
  envelopeTypeToKind,
  kindToEnvelopeType,
  projectPortfolio,
} from '@/domain/flatAdapters'
import { loadPortfolio, savePortfolio } from '@/persist/portfolioStore'
import {
  assignSupportKeys,
  buildNameToIsin,
  isLocalSupportId,
  localSupportId,
  lookupIsin,
  nameMatchKeys,
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
 *
 * Name→ISIN remapping is **per envelope** so a PEA-PME resolve cannot
 * rewrite PEA history (and vice versa).
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
  const supportMap = new Map(projected.supports.map((s) => [s.isin, s]))

  let opsUpdated = 0
  let migratedToRealIsin = 0
  const remap = new Map<string, string>()
  const finalById = new Map<string, Operation>()

  const envelopes: EnvelopeType[] = portfolio.envelopes.map((e) =>
    kindToEnvelopeType(e.kindName()),
  )

  for (const envType of envelopes) {
    const envOps = projected.operations.filter((o) => o.envelope === envType)
    if (!envOps.length) continue
    const vo = projected.virtualOpenings.find((v) => v.envelope === envType)
    const positions = (vo?.positions ?? []).map((p) => ({
      isin: p.isin,
      name: p.name,
      quantity: p.quantity,
    }))

    // Envelope-local only — never fold in other envelopes' supports/ISINs.
    // Index real-ISIN supports linked to this envelope (XLS holdings) so CSV
    // names without « (MNEMO) » still resolve onto the known ISIN.
    const nameToIsin = buildNameToIsin(positions, envOps)
    const env = portfolio.envelopeByKind(envelopeTypeToKind(envType))
    if (env) {
      const seenSid = new Set<number>()
      for (const op of env.operations) {
        if (op.supportUniqueID <= 0 || seenSid.has(op.supportUniqueID)) continue
        seenSid.add(op.supportUniqueID)
        const s = portfolio.getSupport(op.supportUniqueID)
        if (!s) continue
        const key = s.supportKey()
        if (!key || isLocalSupportId(key)) continue
        for (const nk of nameMatchKeys(s.niceUniqueName || key)) {
          nameToIsin.set(nk, key)
        }
      }
    }

    const keyed = assignSupportKeys(envOps, nameToIsin)

    for (const o of keyed) {
      if (o.isin && isLocalSupportId(o.isin) && o.name) {
        const real = lookupIsin(o.name, nameToIsin)
        if (real && real !== o.isin && !isLocalSupportId(real)) {
          remap.set(o.isin, real)
          migratedToRealIsin++
          finalById.set(o.id, { ...o, isin: real })
          continue
        }
      }
      finalById.set(o.id, o)
    }
  }

  for (const before of projected.operations) {
    const after = finalById.get(before.id) ?? before
    if (before.isin === after.isin) continue
    opsUpdated++
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

  const beforeCount = Object.keys(portfolio.supports).length
  const seen = new Set<string>()
  for (const o of finalById.values()) {
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

  for (const o of finalById.values()) {
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
      // Only remap ops that were migrated to `to` (keep other envelopes intact
      // if they still legitimately use a different key — supportUniqueID match
      // after per-op update above already points at `neu` for migrated ops).
      for (const env of portfolio.envelopes) {
        for (const op of env.operations) {
          if (op.supportUniqueID === old.uniqueID) {
            const flatIsin =
              typeof op.customDetails.isin === 'string'
                ? op.customDetails.isin
                : ''
            if (flatIsin === to || flatIsin === from) {
              op.supportUniqueID = neu.uniqueID
              if (flatIsin === from) {
                op.customDetails = { ...op.customDetails, isin: to }
              }
            }
          }
        }
      }
      const stillUsed = portfolio.envelopes.some((env) =>
        env.operations.some((op) => op.supportUniqueID === old.uniqueID),
      )
      if (!stillUsed) {
        delete portfolio.supports[old.uniqueID]
        supportMap.delete(from)
      }
    }
  }

  const supportsCreated = Math.max(
    0,
    Object.keys(portfolio.supports).length - beforeCount,
  )

  await savePortfolio(portfolio)
  await applySeedMatches(projectPortfolio(portfolio).supports)

  return { opsUpdated, supportsCreated, migratedToRealIsin }
}
