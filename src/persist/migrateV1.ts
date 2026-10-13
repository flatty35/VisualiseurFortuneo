import {
  AssetType,
  EnvelopeKind,
  GetterType,
  Portfolio,
  Support,
} from '@/domain/portfolioModel'
import {
  applyVirtualOpeningSeeds,
  envelopeTypeToKind,
  flatOpToDomain,
} from '@/domain/flatAdapters'
import type {
  EnvelopeMeta,
  EnvelopeType,
  Operation as FlatOperation,
  Support as FlatSupport,
  VirtualOpening,
} from '@/domain/types'

/**
 * Build a Portfolio from Dexie v1 flat tables (one-shot migration).
 */
export function portfolioFromV1(input: {
  envelopes?: EnvelopeMeta[]
  operations: FlatOperation[]
  supports: FlatSupport[]
  virtualOpenings?: VirtualOpening[]
}): Portfolio {
  const portfolio = new Portfolio()

  for (const meta of input.envelopes ?? []) {
    const env = portfolio.getOrCreateEnvelope(envelopeTypeToKind(meta.type))
    env.niceUniqueName = meta.label || env.niceUniqueName
    env.createdAt = meta.createdAt || env.createdAt
    env.updatedAt = meta.updatedAt || env.updatedAt
  }

  // Supports first (preserve order for stable IDs)
  for (const s of input.supports) {
    portfolio.upsertSupport({
      niceUniqueName: s.name,
      ISIN: s.isin.startsWith('LOCAL:') ? '' : s.isin,
      localKey: s.isin.startsWith('LOCAL:') ? s.isin : '',
      assetType: AssetType.ACTIONS,
      getterType: s.yahooTicker
        ? GetterType.YAHOO_FINANCE
        : s.staticPrice !== undefined
          ? GetterType.STATIC
          : GetterType.END,
      yahooFinanceTicker: s.yahooTicker ?? '',
      googleFinanceTicker: s.googleTicker ?? '',
      boursoramaTicker: s.boursoramaTicker ?? '',
      staticDatedValues: [
        ...(s.manualPrices ?? []).map(
          (p) =>
            [Date.parse(`${p.date}T12:00:00Z`) || 0, p.price] as [number, number],
        ),
        ...(s.staticPrice !== undefined
          ? ([[0, s.staticPrice]] as Array<[number, number]>)
          : []),
      ],
      lastKnownValue:
        s.staticPrice !== undefined
          ? ([0, s.staticPrice] as [number, number])
          : ([0, 0] as [number, number]),
    })
  }

  // Group ops by envelope; skip synthetic seeds (rebuilt from VO)
  const byEnv = new Map<EnvelopeType, FlatOperation[]>()
  for (const op of input.operations) {
    if (op.synthetic && op.type === 'POSITION_SEED') continue
    const list = byEnv.get(op.envelope) ?? []
    list.push(op)
    byEnv.set(op.envelope, list)
  }

  for (const [envelope, ops] of byEnv) {
    const env = portfolio.getOrCreateEnvelope(envelopeTypeToKind(envelope))
    for (const flat of ops) {
      let supportId = 0
      if (flat.isin) {
        let s = portfolio.findSupportByKey(flat.isin)
        if (!s) {
          s = portfolio.upsertSupport({
            niceUniqueName: flat.name ?? flat.isin,
            ISIN: flat.isin.startsWith('LOCAL:') ? '' : flat.isin,
            localKey: flat.isin.startsWith('LOCAL:') ? flat.isin : '',
            assetType: AssetType.ACTIONS,
          })
        }
        supportId = s.uniqueID
      }
      env.operations.push(flatOpToDomain(flat, supportId))
    }
  }

  for (const vo of input.virtualOpenings ?? []) {
    applyVirtualOpeningSeeds(portfolio, vo)
  }

  // Ensure ESPECES support exists if any cash-only ops
  const hasCash = input.operations.some((o) => !o.isin && !o.synthetic)
  if (hasCash && !Object.values(portfolio.supports).some((s) => s.assetType === AssetType.ESPECES)) {
    const id = portfolio.nextSupportId()
    portfolio.supports[id] = new Support({
      uniqueID: id,
      niceUniqueName: 'Espèces',
      assetType: AssetType.ESPECES,
      getterType: GetterType.STATIC,
      staticDatedValues: [[0, 1]],
    })
  }

  return portfolio
}

/** @deprecated helper kept for tests */
export function emptyPortfolioWithEnvelopes(
  types: EnvelopeType[] = [
    'PEA',
    'PEA_PME',
    'CTO',
    'PEA_SAXO',
    'PEA_PME_SAXO',
    'CTO_SAXO',
  ],
): Portfolio {
  const p = new Portfolio()
  for (const t of types) p.getOrCreateEnvelope(envelopeTypeToKind(t))
  return p
}

export function envelopeKindLabel(kind: number): string {
  if (kind === EnvelopeKind.PEA_PME) return 'PEA-PME Fortuneo'
  if (kind === EnvelopeKind.CTO) return 'CTO Fortuneo'
  if (kind === EnvelopeKind.CTO_SAXO) return 'CTO Saxo'
  if (kind === EnvelopeKind.PEA_SAXO) return 'PEA Saxo'
  if (kind === EnvelopeKind.PEA_PME_SAXO) return 'PEA-PME Saxo'
  return 'PEA Fortuneo'
}
