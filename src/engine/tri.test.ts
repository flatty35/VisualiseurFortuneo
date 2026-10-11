import { describe, expect, it } from 'vitest'
import type { Operation, Support } from '@/domain/types'
import {
  computeIrr,
  computePortfolioTri,
  externalCashFlowDirection,
  sumEnvelopeExternalFlows,
} from './tri'

describe('computeIrr', () => {
  it('computes ~10% for simple annual flow', () => {
    const irr = computeIrr([
      { date: '2020-01-01', amount: -100, label: 'in' },
      { date: '2021-01-01', amount: 110, label: 'out' },
    ])
    expect(irr).not.toBeNull()
    expect(irr!).toBeCloseTo(0.1, 3)
  })
})

describe('externalCashFlowDirection', () => {
  it('treats titre achat as apport and vente as retrait', () => {
    expect(
      externalCashFlowDirection({
        id: '1',
        fingerprint: '1',
        envelope: 'PEA',
        date: '2024-01-01',
        type: 'ACHAT',
        isin: 'FR0000125486',
        netAmount: -400,
        label: 'achat vinci',
      }),
    ).toBe('in')
    expect(
      externalCashFlowDirection({
        id: '2',
        fingerprint: '2',
        envelope: 'PEA',
        date: '2024-01-01',
        type: 'VENTE',
        isin: 'FR0000125486',
        netAmount: 500,
        label: 'vente vinci',
      }),
    ).toBe('out')
    expect(
      externalCashFlowDirection({
        id: '3',
        fingerprint: '3',
        envelope: 'PEA',
        date: '2024-01-01',
        type: 'VERSEMENT',
        netAmount: 1000,
        label: 'versement',
      }),
    ).toBeNull()
  })
})

describe('computePortfolioTri', () => {
  const support: Support = {
    isin: 'FR0000125486',
    name: 'VINCI',
    manualPrices: [],
    staticPrice: 100,
  }

  function op(
    partial: Partial<Operation> & Pick<Operation, 'id' | 'type' | 'date'>,
  ): Operation {
    return {
      fingerprint: partial.id,
      envelope: 'PEA',
      label: partial.label ?? partial.type,
      ...partial,
    }
  }

  it('counts mid-period achat as apport so TRI is not inflated', () => {
    // t0: 10×100 = 1000€, cash 0
    // mid: buy 10 more for 1000€ (apport) → 20×100 = 2000€
    // Without apport, IRR looks like +100%; with apport ≈ 0%.
    const operations: Operation[] = [
      op({
        id: 'seed-q',
        type: 'POSITION_SEED',
        date: '2024-01-02',
        isin: 'FR0000125486',
        name: 'VINCI',
        quantity: 10,
        synthetic: true,
        label: 'seed qty',
      }),
      op({
        id: 'a1',
        type: 'ACHAT',
        date: '2024-07-01',
        isin: 'FR0000125486',
        quantity: 10,
        price: 100,
        netAmount: -1000,
        label: 'achat vinci',
      }),
    ]

    const tri = computePortfolioTri({
      envelope: 'PEA',
      operations,
      supports: [support],
      quotes: new Map(),
      t0: '2024-01-02',
      t1: '2024-12-31',
      virtualOpening: {
        envelope: 'PEA',
        date: '2024-01-02',
        cash: 0,
        positions: [{ isin: 'FR0000125486', name: 'VINCI', quantity: 10 }],
        computedAt: '2024-01-02T00:00:00Z',
      },
    })
    expect(tri.startValue).toBeCloseTo(1000, 0)
    expect(tri.endValue).toBeCloseTo(2000, 0)
    const apports = tri.flows.filter(
      (f) => f.amount < -500 && !f.label.toLowerCase().includes('synth'),
    )
    expect(apports.length).toBeGreaterThanOrEqual(1)
    expect(tri.irr).not.toBeNull()
    expect(Math.abs(tri.irr!)).toBeLessThan(0.05)
  })

  it('sumEnvelopeExternalFlows counts titre buys/sells', () => {
    const sum = sumEnvelopeExternalFlows({
      operations: [
        op({
          id: 'a1',
          type: 'ACHAT',
          date: '2024-06-02',
          isin: 'FR0000125486',
          netAmount: -400,
          label: 'achat',
        }),
        op({
          id: 'v1',
          type: 'VENTE',
          date: '2024-08-01',
          isin: 'FR0000125486',
          netAmount: 100,
          label: 'vente',
        }),
      ],
      envelope: 'PEA',
      from: '2024-01-01',
      to: '2024-12-31',
    })
    expect(sum.count).toBe(2)
    expect(sum.apports).toBeCloseTo(400)
    expect(sum.retraits).toBeCloseTo(100)
    expect(sum.net).toBeCloseTo(300)
  })
})
