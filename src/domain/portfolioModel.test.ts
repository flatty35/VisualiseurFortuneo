import { describe, expect, it } from 'vitest'
import {
  AssetType,
  EnvelopeKind,
  GetterType,
  Operation,
  OperationType,
  Portfolio,
  Support,
} from './portfolioModel'

describe('Portfolio model', () => {
  it('round-trips toJSON/fromJSON', () => {
    const p = new Portfolio()
    const env = p.getOrCreateEnvelope('PEA')
    const s = p.upsertSupport({
      niceUniqueName: 'VINCI',
      ISIN: 'FR0000125486',
      assetType: AssetType.ACTIONS,
      getterType: GetterType.YAHOO_FINANCE,
      yahooFinanceTicker: 'DG.PA',
    })
    env.operations.push(
      new Operation({
        id: '1',
        date: '2024-01-15',
        type: OperationType.PEA_ACHAT,
        supportUniqueID: s.uniqueID,
        quantity: 4,
        executionPrice: 100,
        amount: -400,
      }),
    )
    const json = p.toJSON()
    const p2 = Portfolio.fromJSON(json)
    expect(p2.findSupportByIsin('FR0000125486')?.yahooFinanceTicker).toBe(
      'DG.PA',
    )
    expect(p2.envelopeByKind('PEA')?.operations).toHaveLength(1)
    expect(p2.envelopeByKind('PEA')?.envelopeType).toBe(EnvelopeKind.PEA)
  })

  it('reuses support by ISIN on upsert', () => {
    const p = new Portfolio()
    const a = p.upsertSupport({ niceUniqueName: 'A', ISIN: 'FR0000125486' })
    const b = p.upsertSupport({ niceUniqueName: 'VINCI', ISIN: 'fr0000125486' })
    expect(a.uniqueID).toBe(b.uniqueID)
    expect(b.niceUniqueName).toBe('VINCI')
  })

  it('supportKey prefers ISIN then localKey', () => {
    expect(
      new Support({ uniqueID: 1, ISIN: 'FR0000125486' }).supportKey(),
    ).toBe('FR0000125486')
    expect(
      new Support({ uniqueID: 2, localKey: 'LOCAL:foo' }).supportKey(),
    ).toBe('LOCAL:foo')
  })
})
