import { describe, expect, it } from 'vitest'
import type { IndicatorSnapshot } from './indicators'
import { scoreFromIndicators } from './signalScore'

function base(over: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    lastDate: '2026-01-15',
    lastClose: 100,
    regime: 'neutral',
    rsiReclaimAbove30: false,
    rsiReclaimBelow70: false,
    goldenCross: false,
    deathCross: false,
    bounceSupport: false,
    breakSupport: false,
    macdBullCross: false,
    macdBearCross: false,
    ...over,
  }
}

describe('scoreFromIndicators', () => {
  it('scores bull + strong buy high', () => {
    const s = scoreFromIndicators(
      base({
        regime: 'bull',
        rsiReclaimAbove30: true,
        bounceSupport: true,
        volumeConfirm: true,
      }),
    )
    expect(s.score).toBe(65)
    expect(s.label).toBe('Achat fort')
    expect(s.reasonsFor.length).toBeGreaterThanOrEqual(2)
    expect(s.reasonsAgainst).toHaveLength(0)
  })

  it('reduces buy points when volume is weak', () => {
    const strong = scoreFromIndicators(
      base({
        regime: 'bull',
        rsiReclaimAbove30: true,
        bounceSupport: true,
        volumeConfirm: true,
      }),
    )
    const weak = scoreFromIndicators(
      base({
        regime: 'bull',
        rsiReclaimAbove30: true,
        bounceSupport: true,
        volumeConfirm: false,
      }),
    )
    expect(weak.score).toBeLessThan(strong.score)
  })

  it('scores death + break support low', () => {
    const s = scoreFromIndicators(
      base({
        regime: 'bear',
        deathCross: true,
        breakSupport: true,
      }),
    )
    expect(s.score).toBeLessThanOrEqual(-50)
    expect(s.label).toBe('Vente')
    expect(s.reasonsAgainst.length).toBeGreaterThanOrEqual(2)
  })

  it('exposes volume n/a as info', () => {
    const s = scoreFromIndicators(base({ volumeConfirm: undefined }))
    expect(s.reasonsInfo.some((r) => /volume n\/a/i.test(r.label))).toBe(true)
  })

  it('adds MACD bull / bear cross points', () => {
    const bull = scoreFromIndicators(base({ macdBullCross: true }))
    const bear = scoreFromIndicators(base({ macdBearCross: true }))
    expect(bull.score).toBe(15)
    expect(bear.score).toBe(-15)
    expect(bull.reasonsFor.some((r) => /MACD/i.test(r.label))).toBe(true)
    expect(bear.reasonsAgainst.some((r) => /MACD/i.test(r.label))).toBe(true)
  })
})
