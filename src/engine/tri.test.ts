import { describe, expect, it } from 'vitest'
import type { Operation, Support } from '@/domain/types'
import {
  computeConsolidatedPortfolioTri,
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

  it('matches Excel XIRR (actual/365)', () => {
    // Excel: XIRR({-1000;1100},{2023-01-01;2024-01-01}) = 10.00 %
    const irr = computeIrr([
      { date: '2023-01-01', amount: -1000, label: 'in' },
      { date: '2024-01-01', amount: 1100, label: 'out' },
    ])
    expect(irr!).toBeCloseTo(0.1, 8)
  })

  it('solves a −95 % year where Newton from 5 % overshoots below −100 %', () => {
    const irr = computeIrr([
      { date: '2024-01-01', amount: -1000, label: 'in' },
      { date: '2024-02-01', amount: 400, label: 'out' },
      { date: '2025-01-01', amount: 30, label: 'out' },
    ])
    expect(irr).not.toBeNull()
    expect(irr!).toBeGreaterThan(-1)
    expect(irr!).toBeLessThan(-0.9)
  })

  it('returns null when every flow has the same sign', () => {
    expect(
      computeIrr([
        { date: '2024-01-01', amount: -10, label: 'a' },
        { date: '2024-06-01', amount: -10, label: 'b' },
      ]),
    ).toBeNull()
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

  it('counts encaissements as retrait and TTF as apport, ignores détachement', () => {
    const base = {
      fingerprint: 'x',
      envelope: 'PEA' as const,
      date: '2024-01-01',
      isin: 'FR0000125486',
      label: 'x',
    }
    expect(
      externalCashFlowDirection({ ...base, id: 'd', type: 'DIVIDENDE', netAmount: 33.3 }),
    ).toBe('out')
    expect(
      externalCashFlowDirection({ ...base, id: 't', type: 'TAXE', netAmount: -1.46 }),
    ).toBe('in')
    expect(
      externalCashFlowDirection({ ...base, id: 'o', type: 'DETACHEMENT', netAmount: 33.3 }),
    ).toBeNull()
    expect(
      externalCashFlowDirection({ ...base, isin: undefined, id: 'c', type: 'DIVIDENDE', netAmount: 5 }),
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

  const vo = {
    envelope: 'PEA' as const,
    date: '2024-01-02',
    cash: 0,
    positions: [{ isin: 'FR0000125486', name: 'VINCI', quantity: 10 }],
    computedAt: '2024-01-02T00:00:00Z',
  }

  it('carries trades made before a later window start (t0 > opening)', () => {
    const operations: Operation[] = [
      op({
        id: 'a1',
        type: 'ACHAT',
        date: '2024-03-01',
        isin: 'FR0000125486',
        quantity: 10,
        price: 100,
        netAmount: -1000,
      }),
    ]
    const tri = computePortfolioTri({
      envelope: 'PEA',
      operations,
      supports: [support],
      quotes: new Map(),
      t0: '2024-06-03',
      t1: '2024-12-31',
      virtualOpening: vo,
    })
    expect(tri.startValue).toBeCloseTo(2000, 0)
    expect(tri.endValue).toBeCloseTo(2000, 0)
    expect(tri.irr!).toBeCloseTo(0, 6)
  })

  it('a dividend lifts the TRI of a flat-priced holding', () => {
    const operations: Operation[] = [
      op({
        id: 'd1',
        type: 'DIVIDENDE',
        date: '2024-07-01',
        isin: 'FR0000125486',
        quantity: 10,
        netAmount: 40,
        label: 'Encaissement coupons',
      }),
      op({
        id: 'det',
        type: 'DETACHEMENT',
        date: '2024-06-27',
        isin: 'FR0000125486',
        quantity: 10,
        netAmount: 40,
        label: 'Détachement coupon optionnel',
      }),
    ]
    for (const isin of [undefined, 'FR0000125486']) {
      const tri = computePortfolioTri({
        envelope: 'PEA',
        operations,
        supports: [support],
        quotes: new Map(),
        t0: '2024-01-02',
        t1: '2024-12-31',
        isin,
        virtualOpening: vo,
      })
      // 1000 € flat + 40 € cash out mid-year ≈ +4 %/an
      expect(tri.flows.filter((f) => f.amount === 40)).toHaveLength(1)
      expect(tri.irr!).toBeGreaterThan(0.039)
      expect(tri.irr!).toBeLessThan(0.042)
    }
  })

  it('position TRI uses Montant net (courtage) like the envelope TRI', () => {
    const operations: Operation[] = [
      op({
        id: 'a1',
        type: 'ACHAT',
        date: '2024-07-01',
        isin: 'FR0000125486',
        quantity: 10,
        price: 100,
        netAmount: -1005,
      }),
    ]
    const args = {
      envelope: 'PEA' as const,
      operations,
      supports: [support],
      quotes: new Map(),
      t0: '2024-01-02',
      t1: '2024-12-31',
      virtualOpening: vo,
    }
    const env = computePortfolioTri(args)
    const pos = computePortfolioTri({ ...args, isin: 'FR0000125486' })
    expect(pos.flows.find((f) => f.label === 'ACHAT')?.amount).toBe(-1005)
    expect(pos.irr!).toBeCloseTo(env.irr!, 10)
    expect(pos.irr!).toBeLessThan(0)
  })

  it('consolidated TRI merges envelope flows (later-opened envelope)', () => {
    const pme: Operation = {
      id: 'p1',
      fingerprint: 'p1',
      envelope: 'PEA_PME',
      date: '2024-06-03',
      type: 'ACHAT',
      isin: 'FR0010282822',
      quantity: 10,
      price: 100,
      netAmount: -1000,
      label: 'achat',
    }
    const tri = computeConsolidatedPortfolioTri({
      operations: [pme],
      supports: [support, { ...support, isin: 'FR0010282822', name: 'VU' }],
      quotes: new Map(),
      t0: '2024-01-02',
      t1: '2024-12-31',
      envelopes: ['PEA', 'PEA_PME'],
      virtualOpenings: [
        vo,
        { ...vo, envelope: 'PEA_PME', date: '2024-06-03', positions: [] },
      ],
    })
    // Flat prices on both envelopes → 0 %; the PEA-PME buy is a mid flow
    expect(tri.irr!).toBeCloseTo(0, 6)
    expect(tri.flows.some((f) => f.amount === -1000 && f.date === '2024-06-03')).toBe(true)
    expect(tri.startValue).toBeCloseTo(1000, 0)
    expect(tri.endValue).toBeCloseTo(2000, 0)
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
