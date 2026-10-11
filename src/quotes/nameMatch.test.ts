import { describe, expect, it } from 'vitest'
import {
  nameCoverage,
  nameMatchBonus,
  passesNameQualityGate,
  usListingPenalty,
} from './nameMatch'

describe('nameCoverage / quality gate', () => {
  it('rejects ETF family collisions (WisdomTree oil vs dividend)', () => {
    const query =
      'WisdomTree Europe High Dividend UCITS ETF - EUR DIS'
    const oil = 'WisdomTree Brent Crude Oil'
    expect(passesNameQualityGate(query, oil)).toBe(false)
    expect(nameCoverage(query, oil).coverage).toBeLessThan(0.45)
    expect(nameMatchBonus(query, oil)).toBeLessThan(
      nameMatchBonus(query, 'WisdomTree Europe Equity Income UCITS ETF'),
    )
  })

  it('accepts a strong multi-token match', () => {
    expect(
      passesNameQualityGate('AIR LIQUIDE', 'AIR LIQUIDE SA'),
    ).toBe(true)
    expect(
      passesNameQualityGate(
        'Amundi PEA S&P 500 UCITS ETF Acc',
        'Amundi PEA S&P 500 UCITS ETF',
      ),
    ).toBe(true)
  })

  it('penalizes US ADR listings', () => {
    expect(usListingPenalty('US29272H3003', 'NVO')).toBeLessThan(-30)
    expect(usListingPenalty('DK0060534915', 'NOVO-B.CO')).toBe(0)
  })
})
