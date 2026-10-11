import { describe, expect, it } from 'vitest'
import type { Operation } from '@/domain/types'
import {
  buildAverageUnitCostByDate,
  valueHoldingsSeries,
} from './valuation'
import type { HoldingsSnapshot } from './positions'

describe('cost-basis valuation fallback', () => {
  it('keeps portfolio value when market prices are missing after a buy', () => {
    const ops: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'PEA',
        date: '2024-10-10',
        type: 'ACHAT',
        isin: 'FR0000125486',
        quantity: 10,
        price: 100,
        netAmount: -1000,
        label: 'achat vinci',
      },
    ]
    const holdings: HoldingsSnapshot[] = [
      {
        date: '2024-10-09',
        cash: 5000,
        quantities: new Map(),
      },
      {
        date: '2024-10-10',
        cash: 4000,
        quantities: new Map([['FR0000125486', 10]]),
      },
    ]
    const valued = valueHoldingsSeries({
      holdings,
      supports: [
        { isin: 'FR0000125486', name: 'VINCI', manualPrices: [] },
      ],
      quotes: new Map(),
      operations: ops,
    })
    expect(valued[0].total).toBeCloseTo(5000, 0)
    // 4000 cash + 10×100 cost = 5000 (not 4000)
    expect(valued[1].total).toBeCloseTo(5000, 0)
    expect(valued[1].securities).toBeCloseTo(1000, 0)
  })

  it('tracks average unit cost across buys', () => {
    const ops: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'PEA',
        date: '2024-01-02',
        type: 'ACHAT',
        isin: 'FR0000125486',
        quantity: 10,
        price: 100,
        label: 'a1',
      },
      {
        id: '2',
        fingerprint: '2',
        envelope: 'PEA',
        date: '2024-02-01',
        type: 'ACHAT',
        isin: 'FR0000125486',
        quantity: 10,
        price: 200,
        label: 'a2',
      },
    ]
    const costs = buildAverageUnitCostByDate(ops, [
      '2024-01-02',
      '2024-02-01',
    ])
    expect(costs.get('2024-01-02')?.get('FR0000125486')).toBeCloseTo(100, 5)
    expect(costs.get('2024-02-01')?.get('FR0000125486')).toBeCloseTo(150, 5)
  })

  it('reduces PRU on coupon amortissement without changing quantity', () => {
    const ops: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'PEA_PME',
        date: '2025-07-01',
        type: 'SCRIPT',
        isin: 'FR001400QFA4',
        quantity: 20,
        price: 100,
        netAmount: -2000,
        label: 'SCRIPT-PARTS · BPIFR',
      },
      {
        id: '2',
        fingerprint: '2',
        envelope: 'PEA_PME',
        date: '2025-11-28',
        type: 'DIVIDENDE',
        isin: 'FR001400QFA4',
        quantity: 0.02,
        price: 0,
        netAmount: 337.2,
        label:
          'OST de création de coupons - Détachement coupon amortissement · BPIFR',
      },
    ]
    const costs = buildAverageUnitCostByDate(ops, [
      '2025-07-01',
      '2025-11-28',
    ])
    // 2000 − 337.2 = 1662.8 → PRU 83.14 (matches Fortuneo export)
    expect(costs.get('2025-11-28')?.get('FR001400QFA4')).toBeCloseTo(83.14, 2)
  })
})
