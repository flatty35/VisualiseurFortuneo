import { describe, expect, it } from 'vitest'
import type { Operation, QuoteBar, Support } from '@/domain/types'
import { priceOnDate, valueHoldingsSeries } from './valuation'
import type { HoldingsSnapshot } from './positions'

const support: Support = {
  isin: 'FR0000125486',
  name: 'VINCI',
  yahooTicker: 'DG.PA',
  manualPrices: [],
}

describe('priceOnDate', () => {
  it('forward-fills only a short gap before the first quote', () => {
    const quotes = new Map<string, QuoteBar[]>([
      [
        'DG.PA',
        [
          { date: '2025-01-10', close: 100 },
          { date: '2025-06-01', close: 110 },
        ],
      ],
    ])
    // 3 days before first bar → OK
    expect(priceOnDate('2025-01-07', support, quotes)).toBe(100)
    expect(priceOnDate('2025-03-01', support, quotes)).toBe(100)
    expect(priceOnDate('2025-06-01', support, quotes)).toBe(110)
  })

  it('does not paint a lone spot bar across the whole history', () => {
    const quotes = new Map<string, QuoteBar[]>([
      ['DG.PA', [{ date: '2026-10-09', close: 99.4 }]],
    ])
    expect(priceOnDate('2025-01-15', support, quotes)).toBeUndefined()
    expect(priceOnDate('2026-10-09', support, quotes)).toBe(99.4)
  })

  it('rejects Yahoo closes absurd vs Fortuneo static NAV (BPI-like)', () => {
    const bpi: Support = {
      isin: 'FR001400QFA4',
      name: 'BPIFR.ENTR.3 A2 3D',
      yahooTicker: 'WRONG.PA',
      manualPrices: [],
      staticPrice: 97.58,
    }
    const quotes = new Map<string, QuoteBar[]>([
      ['WRONG.PA', [{ date: '2026-09-25', close: 772.87 }]],
    ])
    expect(priceOnDate('2026-09-25', bpi, quotes)).toBe(97.58)
  })
})

describe('valueHoldingsSeries TRI asymmetry', () => {
  it('uses average cost when quotes start long after the holding', () => {
    const holdings: HoldingsSnapshot[] = [
      {
        date: '2024-10-09',
        cash: 1000,
        quantities: new Map([['FR0000125486', 10]]),
      },
      {
        date: '2025-06-01',
        cash: 0,
        quantities: new Map([['FR0000125486', 10]]),
      },
    ]
    const quotes = new Map<string, QuoteBar[]>([
      ['DG.PA', [{ date: '2025-01-10', close: 100 }]],
    ])
    const operations: Operation[] = [
      {
        id: 'b1',
        fingerprint: 'b1',
        date: '2024-10-09',
        type: 'ACHAT',
        envelope: 'PEA',
        isin: 'FR0000125486',
        quantity: 10,
        price: 95,
        netAmount: -950,
        label: 'achat',
      },
    ]
    const valued = valueHoldingsSeries({
      holdings,
      supports: [support],
      quotes,
      operations,
    })
    // Before first Yahoo bar (>>14d): PRU 95
    expect(valued[0].securities).toBeCloseTo(950, 0)
    // On/after first Yahoo bar: market 100
    expect(valued[1].securities).toBeCloseTo(1000, 0)
  })
})
