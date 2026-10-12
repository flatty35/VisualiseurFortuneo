import { describe, expect, it } from 'vitest'
import { Operation, OperationType, Portfolio } from '@/domain/portfolioModel'
import { isValidIsin, normalizeSupportKey, rekeyInPortfolio } from './rekeySupport'

describe('rekeySupport helpers', () => {
  it('validates real ISINs', () => {
    expect(isValidIsin('FR0000120073')).toBe(true)
    expect(isValidIsin('fr0000120073')).toBe(true)
    expect(isValidIsin('LOCAL:2crsi')).toBe(false)
    expect(isValidIsin('FR123')).toBe(false)
  })

  it('normalizes keys', () => {
    expect(normalizeSupportKey('fr0000120073')).toBe('FR0000120073')
    expect(normalizeSupportKey('LOCAL:2CRSI')).toBe('LOCAL:2crsi')
  })
})

function portfolioWithLocalAndIsin() {
  const p = new Portfolio()
  const env = p.getOrCreateEnvelope('PEA_PME')
  const local = p.upsertSupport({
    niceUniqueName: 'MEDIANTECHNOLOGIES',
    localKey: 'LOCAL:mediantechnologies',
  })
  const real = p.upsertSupport({
    niceUniqueName: 'MEDIAN TECHNOLOGIES',
    ISIN: 'FR0011049824',
    yahooFinanceTicker: 'ALMDT.PA',
  })
  env.operations.push(
    new Operation({
      id: 'a',
      date: '2025-01-10',
      type: OperationType.PEA_ACHAT,
      supportUniqueID: local.uniqueID,
      quantity: 100,
      executionPrice: 2,
      amount: -200,
    }),
    new Operation({
      id: 'b',
      date: '2025-02-10',
      type: OperationType.PEA_ACHAT,
      supportUniqueID: real.uniqueID,
      quantity: 50,
      executionPrice: 2.5,
      amount: -125,
    }),
  )
  return { p, local, real }
}

describe('rekeyInPortfolio', () => {
  it('merges a LOCAL support into the existing ISIN support', () => {
    const { p, local, real } = portfolioWithLocalAndIsin()
    const r = rekeyInPortfolio(p, 'LOCAL:mediantechnologies', 'fr0011049824')
    expect(r.to).toBe('FR0011049824')
    expect(r.mergedIntoExisting).toBe(true)
    expect(r.opsUpdated).toBe(1)
    expect(p.supports[local.uniqueID]).toBeUndefined()
    const ops = p.envelopeByKind('PEA_PME')!.operations
    expect(ops.every((o) => o.supportUniqueID === real.uniqueID)).toBe(true)
    // Target keeps its own ticker
    expect(p.findSupportByKey('FR0011049824')?.yahooFinanceTicker).toBe('ALMDT.PA')
  })

  it('creates the ISIN support and carries the ticker when none exists', () => {
    const p = new Portfolio()
    p.upsertSupport({
      niceUniqueName: 'CSG',
      localKey: 'LOCAL:csg',
      yahooFinanceTicker: 'CSG.AS',
    })
    const r = rekeyInPortfolio(p, 'LOCAL:csg', 'NL0015073TS8')
    expect(r.mergedIntoExisting).toBe(false)
    expect(p.findSupportByKey('LOCAL:csg')).toBeUndefined()
    expect(p.findSupportByKey('NL0015073TS8')?.yahooFinanceTicker).toBe('CSG.AS')
  })

  it('rejects an invalid target key', () => {
    const { p } = portfolioWithLocalAndIsin()
    expect(() => rekeyInPortfolio(p, 'LOCAL:mediantechnologies', 'ALMDT')).toThrow()
  })
})
