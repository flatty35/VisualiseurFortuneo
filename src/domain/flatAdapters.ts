/**
 * Bridge between Portfolio classes and flat DTOs used by parsers / engines.
 */
import {
  AssetType,
  EnvelopeKind,
  GetterType,
  Operation,
  OperationType,
  Portfolio,
  Support,
  type EnvelopeKindName,
  type OperationData,
  type SupportData,
} from './portfolioModel'
import {
  legacyToOperationType,
  operationTypeToLegacy,
  type LegacyOpType,
} from './opTypeBridge'
import type {
  EnvelopeMeta,
  EnvelopeType,
  Operation as FlatOperation,
  Support as FlatSupport,
  VirtualOpening,
} from './types'

export function envelopeTypeToKind(t: EnvelopeType): EnvelopeKindName {
  return t === 'PEA_PME' ? 'PEA_PME' : t === 'CTO' ? 'CTO' : 'PEA'
}

export function kindToEnvelopeType(kind: EnvelopeKindName): EnvelopeType {
  return kind
}

function dateToDateTime(date: string): number {
  if (!date) return 0
  const t = Date.parse(`${date}T12:00:00Z`)
  return Number.isFinite(t) ? t : 0
}

/** Flat Fortuneo DTO → domain Operation */
export function flatOpToDomain(
  op: FlatOperation,
  supportUniqueID: number,
): Operation {
  const type = legacyToOperationType(op.type as LegacyOpType)
  const amount =
    op.netAmount !== undefined
      ? op.netAmount
      : op.grossAmount !== undefined
        ? op.grossAmount
        : 0
  return new Operation({
    id: op.id,
    fingerprint: op.fingerprint,
    date: op.date,
    dateTime: dateToDateTime(op.date),
    type,
    supportUniqueID: op.isin ? supportUniqueID : 0,
    quantity: op.quantity ?? 0,
    executionPrice: op.price ?? 0,
    amount,
    fees: op.fees ?? 0,
    taxes: 0,
    label: op.label,
    currency: op.currency ?? 'EUR',
    synthetic: op.synthetic,
    customDetails: {
      name: op.name,
      grossAmount: op.grossAmount,
      isin: op.isin,
    },
  })
}

/** Domain Operation → flat DTO (engines / UI) */
export function domainOpToFlat(
  op: Operation,
  envelope: EnvelopeType,
  support?: Support,
): FlatOperation {
  const legacy = operationTypeToLegacy(op.type)
  const isin =
    support?.supportKey() ||
    (typeof op.customDetails.isin === 'string'
      ? op.customDetails.isin
      : undefined)
  const name =
    support?.niceUniqueName ||
    (typeof op.customDetails.name === 'string'
      ? op.customDetails.name
      : undefined)
  return {
    id: op.id,
    fingerprint: op.fingerprint,
    envelope,
    date: op.date,
    type: legacy,
    isin: isin || undefined,
    name,
    quantity: Number.isFinite(op.quantity) ? op.quantity : undefined,
    // Keep 0 € (actions gratuites) — `|| undefined` would drop it
    price: Number.isFinite(op.executionPrice) ? op.executionPrice : undefined,
    grossAmount:
      typeof op.customDetails.grossAmount === 'number'
        ? op.customDetails.grossAmount
        : undefined,
    fees: op.fees || undefined,
    netAmount:
      op.supportUniqueID === 0 ||
      op.type === OperationType.POSITION_SET ||
      op.amount !== 0
        ? op.amount
        : undefined,
    currency: op.currency,
    label: op.label,
    synthetic: op.synthetic || undefined,
  }
}

export function flatSupportToDomain(s: FlatSupport, uniqueID: number): Support {
  const isLocal = s.isin.startsWith('LOCAL:')
  const manualAsStatic: Array<[number, number]> = (s.manualPrices ?? []).map(
    (p) => [dateToDateTime(p.date), p.price],
  )
  if (s.staticPrice !== undefined && Number.isFinite(s.staticPrice)) {
    manualAsStatic.push([0, s.staticPrice])
  }
  let getterType: number = GetterType.END
  if (s.yahooTicker) getterType = GetterType.YAHOO_FINANCE
  else if (s.staticPrice !== undefined || s.manualPrices?.length)
    getterType = GetterType.STATIC
  else if (s.boursoramaTicker) getterType = GetterType.BOURSORAMA

  return new Support({
    uniqueID,
    niceUniqueName: s.name,
    searchName: s.name,
    assetType: AssetType.ACTIONS,
    getterType,
    ISIN: isLocal ? '' : s.isin.toUpperCase(),
    localKey: isLocal ? s.isin : '',
    yahooFinanceTicker: s.yahooTicker ?? '',
    googleFinanceTicker: s.googleTicker ?? '',
    boursoramaTicker: s.boursoramaTicker ?? '',
    staticDatedValues: manualAsStatic,
    lastKnownValue:
      s.staticPrice !== undefined ? [0, s.staticPrice] : ([0, 0] as [number, number]),
  })
}

export function domainSupportToFlat(s: Support): FlatSupport {
  const manualPrices = s.staticDatedValues
    .filter(([ts]) => ts > 0)
    .map(([ts, price]) => ({
      date: new Date(ts).toISOString().slice(0, 10),
      price,
    }))
  const staticFromZero = s.staticDatedValues.find(([ts]) => ts === 0)?.[1]
  const staticPrice =
    staticFromZero ??
    (s.lastKnownValue[1] > 0 ? s.lastKnownValue[1] : undefined)
  return {
    isin: s.supportKey(),
    uniqueID: s.uniqueID,
    name: s.niceUniqueName,
    yahooTicker: s.yahooFinanceTicker || undefined,
    googleTicker: s.googleFinanceTicker || undefined,
    boursoramaTicker: s.boursoramaTicker || undefined,
    manualPrices,
    staticPrice,
  }
}

/** Extract VirtualOpening view from POSITION_SET / seed ops in an envelope. */
export function virtualOpeningFromEnvelope(
  portfolio: Portfolio,
  envelope: EnvelopeType,
): VirtualOpening | null {
  const env = portfolio.envelopeByKind(envelopeTypeToKind(envelope))
  if (!env) return null
  const seeds = env.operations.filter(
    (o) => o.synthetic && o.type === OperationType.POSITION_SET,
  )
  if (!seeds.length) return null

  const positions = seeds
    .filter((o) => o.supportUniqueID > 0)
    .map((o) => {
      const s = portfolio.getSupport(o.supportUniqueID)
      return {
        isin: s?.supportKey() ?? `ID:${o.supportUniqueID}`,
        name: s?.niceUniqueName ?? String(o.supportUniqueID),
        quantity: o.quantity,
      }
    })
    .filter((p) => Math.abs(p.quantity) > 1e-8)

  const cashSeed = seeds.find((o) => o.supportUniqueID === 0)
  const date =
    seeds.map((o) => o.date).sort()[0] ?? new Date().toISOString().slice(0, 10)
  const reported =
    typeof env.customState.currentCash === 'number'
      ? env.customState.currentCash
      : undefined

  return {
    envelope,
    date,
    cash: cashSeed?.amount ?? 0,
    reportedCash: reported,
    positions,
    computedAt: env.updatedAt,
  }
}

export function projectPortfolio(portfolio: Portfolio): {
  operations: FlatOperation[]
  supports: FlatSupport[]
  virtualOpenings: VirtualOpening[]
  envelopes: EnvelopeMeta[]
} {
  const supports = Object.values(portfolio.supports).map(domainSupportToFlat)
  const operations: FlatOperation[] = []
  const virtualOpenings: VirtualOpening[] = []
  const envelopes: EnvelopeMeta[] = []

  for (const env of portfolio.envelopes) {
    const kind = env.kindName()
    const envelope = kindToEnvelopeType(kind)
    envelopes.push({
      type: envelope,
      label: env.niceUniqueName,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
    })
    for (const op of env.operations) {
      const support =
        op.supportUniqueID > 0
          ? portfolio.getSupport(op.supportUniqueID)
          : undefined
      operations.push(domainOpToFlat(op, envelope, support))
    }
    const vo = virtualOpeningFromEnvelope(portfolio, envelope)
    if (vo) virtualOpenings.push(vo)
  }

  return { operations, supports, virtualOpenings, envelopes }
}

/** Merge flat ops into portfolio (import path). Returns count added. */
export function mergeFlatOpsIntoPortfolio(
  portfolio: Portfolio,
  envelope: EnvelopeType,
  ops: FlatOperation[],
): number {
  const env = portfolio.getOrCreateEnvelope(envelopeTypeToKind(envelope))
  const existingFp = new Set(env.operations.map((o) => o.fingerprint))
  let added = 0
  for (const flat of ops) {
    if (existingFp.has(flat.fingerprint)) continue
    let supportId = 0
    if (flat.isin) {
      const s = portfolio.upsertSupport({
        niceUniqueName: flat.name ?? flat.isin,
        ISIN: flat.isin.startsWith('LOCAL:') ? '' : flat.isin,
        localKey: flat.isin.startsWith('LOCAL:') ? flat.isin : '',
        assetType: AssetType.ACTIONS,
      })
      supportId = s.uniqueID
    }
    env.operations.push(flatOpToDomain(flat, supportId))
    existingFp.add(flat.fingerprint)
    added++
  }
  env.updatedAt = new Date().toISOString()
  return added
}

export function applyVirtualOpeningSeeds(
  portfolio: Portfolio,
  vo: VirtualOpening,
): void {
  const env = portfolio.getOrCreateEnvelope(envelopeTypeToKind(vo.envelope))
  // Drop previous synthetic POSITION_SET
  env.operations = env.operations.filter(
    (o) => !(o.synthetic && o.type === OperationType.POSITION_SET),
  )

  for (const p of vo.positions) {
    const s = portfolio.upsertSupport({
      niceUniqueName: p.name,
      ISIN: p.isin.startsWith('LOCAL:') ? '' : p.isin,
      localKey: p.isin.startsWith('LOCAL:') ? p.isin : '',
      assetType: AssetType.ACTIONS,
    })
    env.operations.push(
      new Operation({
        id: `seed-${vo.envelope}-${s.uniqueID}-${vo.date}`,
        fingerprint: `seed:${vo.envelope}:${vo.date}:${s.uniqueID}:${p.quantity}`,
        date: vo.date,
        dateTime: dateToDateTime(vo.date),
        type: OperationType.POSITION_SET,
        supportUniqueID: s.uniqueID,
        quantity: p.quantity,
        amount: 0,
        label: `Position initiale virtuelle — ${p.name}`,
        synthetic: true,
      }),
    )
  }

  env.operations.push(
    new Operation({
      id: `seed-cash-${vo.envelope}-${vo.date}`,
      fingerprint: `seed:${vo.envelope}:${vo.date}:cash:${vo.cash}`,
      date: vo.date,
      dateTime: dateToDateTime(vo.date),
      type: OperationType.POSITION_SET,
      supportUniqueID: 0,
      quantity: 0,
      amount: vo.cash,
      label: 'Espèces initiales virtuelles',
      synthetic: true,
    }),
  )
  env.customState.virtualOpeningCash = vo.cash
  env.customState.virtualOpeningDate = vo.date
  if (vo.reportedCash !== undefined) {
    env.customState.currentCash = vo.reportedCash
  }
  env.updatedAt = new Date().toISOString()
}

export function supportDataFromV1Flat(
  s: FlatSupport,
  uniqueID: number,
): SupportData {
  return flatSupportToDomain(s, uniqueID).toJSON()
}

export function operationDataFromV1Flat(
  op: FlatOperation,
  supportUniqueID: number,
): OperationData {
  return flatOpToDomain(op, supportUniqueID).toJSON()
}

export { EnvelopeKind }
