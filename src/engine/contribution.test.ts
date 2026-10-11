import { describe, expect, it } from 'vitest'
import type { Operation, Support, VirtualOpening } from '@/domain/types'
import { computePositionContributions } from './contribution'

const support: Support = {
  isin: 'FR0000120073',
  name: 'Air Liquide',
  manualPrices: [],
  staticPrice: 100,
}

function op(partial: Partial<Operation> & Pick<Operation, 'id' | 'type' | 'date'>): Operation {
  return {
    fingerprint: partial.id,
    envelope: 'PEA',
    label: partial.label ?? partial.type,
    ...partial,
  }
}

describe('computePositionContributions', () => {
  it('open winning position: absolute = market − invested, positive ROI/IRR', () => {
    const operations: Operation[] = [
      op({
        id: 'b1',
        type: 'ACHAT',
        date: '2024-01-02',
        isin: support.isin,
        name: support.name,
        quantity: 10,
        price: 100,
        netAmount: -1000,
      }),
    ]
    const rows = computePositionContributions({
      operations,
      supports: [support],
      quotes: new Map(),
      virtualOpenings: [],
      asOf: '2025-01-02',
      envelopes: ['PEA'],
    })
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.status).toBe('open')
    expect(r.invested).toBeCloseTo(1000)
    expect(r.marketValue).toBeCloseTo(1000) // static 100 × 10
    expect(r.absolute).toBeCloseTo(0)
    // Flat price over 1y → IRR ~ 0
    expect(r.irr).not.toBeNull()
    expect(Math.abs(r.irr!)).toBeLessThan(0.02)
  })

  it('closed position: contribution = sells − buys', () => {
    const operations: Operation[] = [
      op({
        id: 'b1',
        type: 'ACHAT',
        date: '2024-01-02',
        isin: support.isin,
        quantity: 10,
        price: 100,
        netAmount: -1000,
      }),
      op({
        id: 's1',
        type: 'VENTE',
        date: '2024-07-01',
        isin: support.isin,
        quantity: 10,
        price: 120,
        netAmount: 1200,
      }),
    ]
    const rows = computePositionContributions({
      operations,
      supports: [support],
      quotes: new Map(),
      virtualOpenings: [],
      asOf: '2025-01-02',
      envelopes: ['PEA'],
    })
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.status).toBe('closed')
    expect(r.marketValue).toBe(0)
    expect(r.invested).toBeCloseTo(1000)
    expect(r.proceeds).toBeCloseTo(1200)
    expect(r.absolute).toBeCloseTo(200)
    expect(r.roi).toBeCloseTo(0.2)
    expect(r.irr).not.toBeNull()
    expect(r.irr!).toBeGreaterThan(0.3) // ~6 months, +20% → high annualized
  })

  it('includes dividends in absolute contribution', () => {
    const operations: Operation[] = [
      op({
        id: 'b1',
        type: 'ACHAT',
        date: '2024-01-02',
        isin: support.isin,
        quantity: 10,
        price: 100,
        netAmount: -1000,
      }),
      op({
        id: 'd1',
        type: 'DIVIDENDE',
        date: '2024-06-15',
        isin: support.isin,
        netAmount: 50,
        label: 'Dividende',
      }),
      op({
        id: 's1',
        type: 'VENTE',
        date: '2024-12-31',
        isin: support.isin,
        quantity: 10,
        price: 100,
        netAmount: 1000,
      }),
    ]
    const rows = computePositionContributions({
      operations,
      supports: [support],
      quotes: new Map(),
      virtualOpenings: [],
      asOf: '2025-01-02',
      envelopes: ['PEA'],
    })
    expect(rows[0].dividends).toBeCloseTo(50)
    expect(rows[0].absolute).toBeCloseTo(50)
    expect(rows[0].roi).toBeCloseTo(0.05)
  })

  it('counts virtual opening seed as invested capital', () => {
    const vo: VirtualOpening = {
      envelope: 'PEA',
      date: '2024-01-02',
      cash: 0,
      positions: [{ isin: support.isin, name: support.name, quantity: 5 }],
      computedAt: '2024-01-02T00:00:00Z',
    }
    const operations: Operation[] = [
      op({
        id: 'seed',
        type: 'POSITION_SEED',
        date: '2024-01-02',
        isin: support.isin,
        quantity: 5,
        synthetic: true,
        label: 'Position initiale virtuelle',
      }),
      op({
        id: 's1',
        type: 'VENTE',
        date: '2024-07-01',
        isin: support.isin,
        quantity: 5,
        price: 110,
        netAmount: 550,
      }),
    ]
    const rows = computePositionContributions({
      operations,
      supports: [support],
      quotes: new Map(),
      virtualOpenings: [vo],
      asOf: '2025-01-02',
      envelopes: ['PEA'],
    })
    expect(rows).toHaveLength(1)
    // Seed at static 100 × 5 = 500 invested
    expect(rows[0].invested).toBeCloseTo(500)
    expect(rows[0].proceeds).toBeCloseTo(550)
    expect(rows[0].absolute).toBeCloseTo(50)
    expect(rows[0].status).toBe('closed')
  })
})
