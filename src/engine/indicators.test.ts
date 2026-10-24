import { describe, expect, it } from 'vitest'
import type { QuoteBar } from '@/domain/types'
import {
  atrSeries,
  computeIndicators,
  findPivotLows,
  rsiSeries,
  smaAt,
  volumeConfirmAt,
} from './indicators'

function closes(n: number, start = 100, step = 0.5): QuoteBar[] {
  const bars: QuoteBar[] = []
  for (let i = 0; i < n; i++) {
    const c = start + i * step
    bars.push({
      date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      close: c,
      high: c + 1,
      low: c - 1,
      volume: 1000 + i * 10,
    })
  }
  return bars
}

describe('indicators', () => {
  it('computes SMA', () => {
    const c = [1, 2, 3, 4, 5]
    expect(smaAt(c, 4, 3)).toBe(4)
    expect(smaAt(c, 1, 3)).toBeUndefined()
  })

  it('computes RSI on a rising series near 100', () => {
    const bars = closes(30, 50, 1)
    const rsi = rsiSeries(bars.map((b) => b.close), 14)
    const last = rsi[rsi.length - 1]
    expect(last).toBeDefined()
    expect(last!).toBeGreaterThan(70)
  })

  it('detects pivot lows', () => {
    const bars: QuoteBar[] = [
      { date: '2024-01-01', close: 10, low: 10, high: 11 },
      { date: '2024-01-02', close: 9, low: 9, high: 10 },
      { date: '2024-01-03', close: 8, low: 7, high: 9 }, // pivot
      { date: '2024-01-04', close: 9, low: 8.5, high: 10 },
      { date: '2024-01-05', close: 10, low: 9, high: 11 },
    ]
    const piv = findPivotLows(bars, 2)
    expect(piv.some((p) => p.price === 7)).toBe(true)
  })

  it('ATR is positive with high/low', () => {
    const bars = closes(40)
    const atr = atrSeries(bars, 14)
    expect(atr[atr.length - 1]).toBeGreaterThan(0)
  })

  it('volumeConfirm detects spike', () => {
    const bars = closes(30)
    bars[29] = { ...bars[29], volume: 50_000 }
    expect(volumeConfirmAt(bars, 29, 19, 1.5)).toBe(true)
    bars[29] = { ...bars[29], volume: 100 }
    expect(volumeConfirmAt(bars, 29, 19, 1.5)).toBe(false)
  })

  it('computeIndicators returns bull regime on long uptrend', () => {
    const bars = closes(220, 50, 0.4)
    const ind = computeIndicators(bars)
    expect(ind).not.toBeNull()
    expect(ind!.sma190).toBeDefined()
    expect(ind!.regime).toBe('bull')
    expect(ind!.rsi).toBeDefined()
    expect(ind!.atr).toBeDefined()
    expect(ind!.stopLoss).toBeLessThan(ind!.lastClose)
    expect(ind!.takeProfit).toBeGreaterThan(ind!.lastClose)
  })
})
