import {
  AssetType,
  GetterType,
  Portfolio,
  type CustomFilterData,
  type EnvelopeData,
  type PortfolioData,
  type SupportData,
} from '@/domain/portfolioModel'
import {
  domainSupportToFlat,
  envelopeTypeToKind,
  projectPortfolio,
} from '@/domain/flatAdapters'
import type {
  EnvelopeMeta,
  EnvelopeType,
  Operation,
  Support,
  VirtualOpening,
} from '@/domain/types'
import { db } from './db'

const META_SUPPORT_ID = 'currentSupportID'
const META_FILTER_ID = 'currentCustomFiltersID'

export async function loadPortfolio(): Promise<Portfolio> {
  await db.open()
  const [envelopeRows, supportRows, filterRows, supportIdMeta, filterIdMeta] =
    await Promise.all([
      db.envelopes.toArray(),
      db.supports.toArray(),
      db.customFilters.toArray(),
      db.meta.get(META_SUPPORT_ID),
      db.meta.get(META_FILTER_ID),
    ])

  const data: PortfolioData = {
    envelopes: envelopeRows as EnvelopeData[],
    supports: supportRows as SupportData[],
    customFilters: filterRows as CustomFilterData[],
    currentSupportID:
      typeof supportIdMeta?.value === 'number' ? supportIdMeta.value : 1,
    currentCustomFiltersID:
      typeof filterIdMeta?.value === 'number' ? filterIdMeta.value : 1,
  }
  return Portfolio.fromJSON(data)
}

export async function savePortfolio(portfolio: Portfolio): Promise<void> {
  const json = portfolio.toJSON()
  await db.transaction(
    'rw',
    [db.envelopes, db.supports, db.customFilters, db.meta],
    async () => {
      await db.envelopes.clear()
      await db.supports.clear()
      await db.customFilters.clear()
      if (json.envelopes?.length) {
        await db.envelopes.bulkPut(
          json.envelopes.map((e) => ({
            ...e,
            niceUniqueName: e.niceUniqueName || `env-${e.envelopeType}`,
          })),
        )
      }
      if (json.supports?.length) {
        await db.supports.bulkPut(
          json.supports.filter((s) => s.uniqueID != null) as SupportData[],
        )
      }
      if (json.customFilters?.length) {
        await db.customFilters.bulkPut(
          json.customFilters.filter(
            (f) => f.uniqueID != null,
          ) as CustomFilterData[],
        )
      }
      await db.meta.put({
        key: META_SUPPORT_ID,
        value: json.currentSupportID ?? 1,
      })
      await db.meta.put({
        key: META_FILTER_ID,
        value: json.currentCustomFiltersID ?? 1,
      })
    },
  )
}

/** Load → mutate → save. */
export async function updatePortfolio(
  fn: (p: Portfolio) => void | Promise<void>,
): Promise<Portfolio> {
  const p = await loadPortfolio()
  await fn(p)
  await savePortfolio(p)
  return p
}

export async function loadProjected(): Promise<{
  portfolio: Portfolio
  operations: Operation[]
  supports: Support[]
  virtualOpenings: VirtualOpening[]
  envelopes: EnvelopeMeta[]
}> {
  const portfolio = await loadPortfolio()
  const projected = projectPortfolio(portfolio)
  // Titres-only cash: ignore legacy espèces rows (no ISIN)
  return {
    portfolio,
    ...projected,
    operations: projected.operations.filter((o) => o.synthetic || !!o.isin),
  }
}

export async function loadEnvelopeProjected(envelope: EnvelopeType): Promise<{
  portfolio: Portfolio
  operations: Operation[]
  supports: Support[]
  virtualOpening: VirtualOpening | null
}> {
  const { portfolio, operations, supports, virtualOpenings } =
    await loadProjected()
  return {
    portfolio,
    operations: operations.filter((o) => o.envelope === envelope),
    supports,
    virtualOpening:
      virtualOpenings.find((v) => v.envelope === envelope) ?? null,
  }
}

/**
 * Clear all operations (+ virtual opening) for one envelope.
 * Keeps global supports / tickers (Correspondances).
 */
export async function clearEnvelopeOperations(
  envelope: EnvelopeType,
): Promise<{ removed: number }> {
  let removed = 0
  await updatePortfolio((p) => {
    const env = p.envelopeByKind(envelopeTypeToKind(envelope))
    if (!env) return
    removed = env.operations.length
    env.operations = []
    delete env.customState.virtualOpeningCash
    delete env.customState.virtualOpeningDate
    env.updatedAt = new Date().toISOString()
  })
  return { removed }
}

/** Upsert a flat Support DTO into the Portfolio store (ticker / name edits). */
export async function putFlatSupport(flat: Support): Promise<void> {
  await updatePortfolio((p) => {
    const existing =
      (flat.uniqueID ? p.getSupport(flat.uniqueID) : undefined) ??
      p.findSupportByKey(flat.isin)
    const isLocal = flat.isin.startsWith('LOCAL:')
    const manualAsStatic: Array<[number, number]> = (flat.manualPrices ?? []).map(
      (mp) => [Date.parse(`${mp.date}T12:00:00Z`) || 0, mp.price],
    )
    if (flat.staticPrice !== undefined) {
      manualAsStatic.push([0, flat.staticPrice])
    }
    let getterType: number = GetterType.END
    if (flat.yahooTicker) getterType = GetterType.YAHOO_FINANCE
    else if (flat.staticPrice !== undefined || flat.manualPrices?.length)
      getterType = GetterType.STATIC
    else if (flat.boursoramaTicker) getterType = GetterType.BOURSORAMA

    if (existing) {
      existing.niceUniqueName = flat.name || existing.niceUniqueName
      existing.searchName = flat.name || existing.searchName
      existing.yahooFinanceTicker = flat.yahooTicker ?? ''
      existing.googleFinanceTicker = flat.googleTicker ?? ''
      existing.boursoramaTicker = flat.boursoramaTicker ?? ''
      existing.getterType = getterType
      existing.staticDatedValues = manualAsStatic
      if (flat.staticPrice !== undefined) {
        existing.lastKnownValue = [0, flat.staticPrice]
      }
      if (isLocal) {
        existing.localKey = flat.isin
        existing.ISIN = ''
      } else if (!flat.isin.startsWith('ID:')) {
        existing.ISIN = flat.isin.toUpperCase()
        existing.localKey = ''
      }
    } else {
      p.upsertSupport({
        niceUniqueName: flat.name,
        ISIN: isLocal ? '' : flat.isin,
        localKey: isLocal ? flat.isin : '',
        assetType: AssetType.ACTIONS,
        getterType,
        yahooFinanceTicker: flat.yahooTicker ?? '',
        googleFinanceTicker: flat.googleTicker ?? '',
        boursoramaTicker: flat.boursoramaTicker ?? '',
        staticDatedValues: manualAsStatic,
        lastKnownValue:
          flat.staticPrice !== undefined
            ? ([0, flat.staticPrice] as [number, number])
            : ([0, 0] as [number, number]),
      })
    }
  })
}

export async function listFlatSupports(): Promise<Support[]> {
  const p = await loadPortfolio()
  return Object.values(p.supports).map(domainSupportToFlat)
}
