import { describe, expect, it } from 'vitest'
import { Portfolio } from '@/domain/portfolioModel'
import { seedTradePricesFromOperations } from './seedTradePrices'
import type { Operation } from '@/domain/types'

describe('seedTradePricesFromOperations', () => {
  it('seeds buy/sell prices and keeps knockout at 0', () => {
    const p = new Portfolio()
    p.upsertSupport({
      niceUniqueName: 'Moderna Turbo',
      ISIN: 'CH1595275830',
    })
    const ops: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'CTO_SAXO',
        date: '2026-01-10',
        type: 'ACHAT',
        isin: 'CH1595275830',
        quantity: 76,
        price: 1.21,
        label: 'Acheter',
      },
      {
        id: '2',
        fingerprint: '2',
        envelope: 'CTO_SAXO',
        date: '2026-10-01',
        type: 'VENTE',
        isin: 'CH1595275830',
        quantity: 76,
        price: 0,
        label: 'Sortie sans valeur',
      },
    ]
    const n = seedTradePricesFromOperations(p, ops)
    expect(n).toBe(2)
    const s = p.findSupportByIsin('CH1595275830')!
    const dates = s.staticDatedValues
      .filter(([ts]) => ts > 0)
      .map(([ts, px]) => [
        new Date(ts).toISOString().slice(0, 10),
        px,
      ])
    expect(dates).toContainEqual(['2026-01-10', 1.21])
    expect(dates).toContainEqual(['2026-10-01', 0])
  })
})
