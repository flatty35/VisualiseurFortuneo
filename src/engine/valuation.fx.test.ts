import { describe, expect, it } from 'vitest'
import { buildFxRateByDate, valueHoldingsSeries } from './valuation'
import type { HoldingsSnapshot } from './positions'
import type { Operation, Support } from '@/domain/types'

describe('USD valuation', () => {
  it('keeps byIsin in USD and converts securities total via fxRate', () => {
    const support: Support = {
      isin: 'US0231351067',
      name: 'Amazon',
      manualPrices: [{ date: '2026-01-15', price: 200 }],
      quoteCurrency: 'USD',
    }
    const ops: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'CTO_SAXO',
        date: '2026-01-10',
        type: 'ACHAT',
        isin: 'US0231351067',
        quantity: 2,
        price: 200,
        netAmount: -340,
        currency: 'EUR',
        instrumentCurrency: 'USD',
        instrumentAmount: -400,
        fxRate: 0.85,
        label: 'Acheter',
      },
    ]
    const holdings: HoldingsSnapshot[] = [
      {
        date: '2026-01-15',
        quantities: new Map([['US0231351067', 2]]),
        cash: 100,
      },
    ]
    const valued = valueHoldingsSeries({
      holdings,
      supports: [support],
      quotes: new Map(),
      operations: ops,
    })
    expect(valued[0].byIsin['US0231351067']).toBeCloseTo(400) // 2×200 USD
    expect(valued[0].securities).toBeCloseTo(340) // 400×0.85 EUR
    expect(valued[0].total).toBeCloseTo(440)
  })

  it('buildFxRateByDate forward-fills last known rate', () => {
    const ops: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'CTO_SAXO',
        date: '2026-01-10',
        type: 'ACHAT',
        isin: 'US0231351067',
        fxRate: 0.9,
        label: 'a',
      },
      {
        id: '2',
        fingerprint: '2',
        envelope: 'CTO_SAXO',
        date: '2026-02-01',
        type: 'VENTE',
        isin: 'US0231351067',
        fxRate: 0.8,
        label: 'b',
      },
    ]
    const map = buildFxRateByDate(ops, ['2026-01-15', '2026-02-10'])
    expect(map.get('2026-01-15')?.get('US0231351067')).toBeCloseTo(0.9)
    expect(map.get('2026-02-10')?.get('US0231351067')).toBeCloseTo(0.8)
  })
})
