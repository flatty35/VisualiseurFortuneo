import { describe, expect, it } from 'vitest'
import type { QuoteBar, Support } from '@/domain/types'
import { scoreOpenPositions } from './scoreOpenPositions'

function risingBars(n: number): QuoteBar[] {
  const bars: QuoteBar[] = []
  for (let i = 0; i < n; i++) {
    const c = 50 + i * 0.3
    bars.push({
      date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      close: c,
      high: c + 0.5,
      low: c - 0.5,
      volume: 2000,
    })
  }
  return bars
}

describe('scoreOpenPositions', () => {
  it('scores open equity and skips tradeQuotesOnly', () => {
    const supports: Support[] = [
      {
        isin: 'FR0000120073',
        name: 'Air Liquide',
        manualPrices: [],
        yahooTicker: 'AI.PA',
      },
      {
        isin: 'CH1595275830',
        name: 'Moderna Turbo',
        manualPrices: [],
        tradeQuotesOnly: true,
      },
    ]
    const quotes = new Map<string, QuoteBar[]>([
      ['AI.PA', risingBars(220)],
      ['CH1595275830', risingBars(220)],
    ])
    const rows = scoreOpenPositions({
      positions: [
        { isin: 'FR0000120073', quantity: 10, envelope: 'PEA' },
        { isin: 'CH1595275830', quantity: 5, envelope: 'CTO_SAXO' },
        { isin: 'FR0000120073', quantity: 0, envelope: 'CTO' },
      ],
      supports,
      quotes,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].isin).toBe('FR0000120073')
    expect(rows[0].signal.score).toBeTypeOf('number')
    expect(rows[0].sparkPoints.length).toBeGreaterThan(10)
    expect(rows[0].sparkPoints[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(rows[0].macdHist.length).toBeGreaterThan(5)
  })

  it('merges the same ISIN held in several envelopes into one row', () => {
    const supports: Support[] = [
      {
        isin: 'FR0013416716',
        name: 'Amundi Gold',
        manualPrices: [],
        yahooTicker: 'GOLD.PA',
      },
    ]
    const quotes = new Map<string, QuoteBar[]>([['GOLD.PA', risingBars(220)]])
    const rows = scoreOpenPositions({
      positions: [
        { isin: 'FR0013416716', quantity: 3, envelope: 'PEA' },
        { isin: 'FR0013416716', quantity: 2, envelope: 'CTO' },
      ],
      supports,
      quotes,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].quantity).toBe(5)
    expect(rows[0].envelopes.sort()).toEqual(['CTO', 'PEA'])
  })
})
