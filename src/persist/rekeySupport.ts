import type { Support } from '@/domain/types'
import { AssetType, GetterType } from '@/domain/portfolioModel'
import { isLocalSupportId } from '@/import/resolveIsin'
import { loadPortfolio, savePortfolio } from './portfolioStore'

export function isValidIsin(isin: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin.trim().toUpperCase())
}

export function normalizeSupportKey(raw: string): string {
  const t = raw.trim()
  if (isLocalSupportId(t)) {
    const slug = t.slice('LOCAL:'.length).trim().toLowerCase()
    return `LOCAL:${slug}`
  }
  return t.toUpperCase()
}

export interface RekeyResult {
  from: string
  to: string
  opsUpdated: number
  voUpdated: number
  mergedIntoExisting: boolean
}

/**
 * Change a support's primary key (ISIN / LOCAL:…).
 * Updates linked operations. Merges into an existing support if `to` exists.
 */
export async function rekeySupport(
  fromIsin: string,
  toIsin: string,
  patch?: Partial<Omit<Support, 'isin'>>,
): Promise<RekeyResult> {
  const from = fromIsin.trim()
  const to = normalizeSupportKey(toIsin)
  if (!from) throw new Error('Clé source vide')
  if (!to) throw new Error('Nouvelle clé vide')
  if (!isLocalSupportId(to) && !isValidIsin(to)) {
    throw new Error(
      'ISIN invalide (12 caractères, ex. FR0000120073) ou LOCAL:…',
    )
  }

  const portfolio = await loadPortfolio()
  const source = portfolio.findSupportByKey(from)
  if (!source) throw new Error(`Support introuvable: ${from}`)

  if (from === to) {
    if (patch) {
      if (patch.name) source.niceUniqueName = patch.name
      if (patch.yahooTicker !== undefined)
        source.yahooFinanceTicker = patch.yahooTicker ?? ''
      if (patch.googleTicker !== undefined)
        source.googleFinanceTicker = patch.googleTicker ?? ''
      if (patch.boursoramaTicker !== undefined)
        source.boursoramaTicker = patch.boursoramaTicker ?? ''
      if (patch.staticPrice !== undefined) {
        source.lastKnownValue = [0, patch.staticPrice]
        source.staticDatedValues = [
          ...source.staticDatedValues.filter(([ts]) => ts !== 0),
          [0, patch.staticPrice],
        ]
        source.getterType = GetterType.STATIC
      }
      if (patch.manualPrices) {
        source.staticDatedValues = patch.manualPrices.map(
          (p) =>
            [Date.parse(`${p.date}T12:00:00Z`) || 0, p.price] as [
              number,
              number,
            ],
        )
      }
      if (patch.yahooTicker) source.getterType = GetterType.YAHOO_FINANCE
    }
    await savePortfolio(portfolio)
    return { from, to, opsUpdated: 0, voUpdated: 0, mergedIntoExisting: false }
  }

  const existingTarget = portfolio.findSupportByKey(to)
  const isLocal = to.startsWith('LOCAL:')

  let target = existingTarget
  if (!target) {
    target = portfolio.upsertSupport({
      niceUniqueName: patch?.name ?? source.niceUniqueName,
      ISIN: isLocal ? '' : to,
      localKey: isLocal ? to : '',
      assetType: AssetType.ACTIONS,
      getterType: source.getterType,
      yahooFinanceTicker:
        patch?.yahooTicker ?? source.yahooFinanceTicker,
      googleFinanceTicker:
        patch?.googleTicker ?? source.googleFinanceTicker,
      boursoramaTicker:
        patch?.boursoramaTicker ?? source.boursoramaTicker,
      staticDatedValues: source.staticDatedValues,
      lastKnownValue: source.lastKnownValue,
    })
  } else {
    target.niceUniqueName =
      patch?.name ?? (target.niceUniqueName || source.niceUniqueName)
    if (!target.yahooFinanceTicker)
      target.yahooFinanceTicker =
        patch?.yahooTicker ?? source.yahooFinanceTicker
    if (!target.googleFinanceTicker)
      target.googleFinanceTicker =
        patch?.googleTicker ?? source.googleFinanceTicker
    if (!target.boursoramaTicker)
      target.boursoramaTicker =
        patch?.boursoramaTicker ?? source.boursoramaTicker
    if (!target.staticDatedValues.length)
      target.staticDatedValues = source.staticDatedValues
  }

  let opsUpdated = 0
  let voUpdated = 0
  for (const env of portfolio.envelopes) {
    for (const op of env.operations) {
      if (op.supportUniqueID === source.uniqueID) {
        op.supportUniqueID = target.uniqueID
        op.customDetails = {
          ...op.customDetails,
          isin: to,
          name: target.niceUniqueName,
        }
        opsUpdated++
        if (op.synthetic) voUpdated++
      }
    }
  }

  if (source.uniqueID !== target.uniqueID) {
    delete portfolio.supports[source.uniqueID]
  }

  await savePortfolio(portfolio)
  return {
    from,
    to,
    opsUpdated,
    voUpdated,
    mergedIntoExisting: Boolean(existingTarget),
  }
}
