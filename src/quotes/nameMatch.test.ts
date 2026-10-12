import { describe, expect, it } from 'vitest'
import {
  cleanLabelForSearch,
  nameCoverage,
  nameMatchBonus,
  passesNameQualityGate,
  sameLibelle,
  shareClassConflict,
  usListingPenalty,
} from './nameMatch'

describe('cleanLabelForSearch', () => {
  it('drops parentheses, share-class tail and wrapper words', () => {
    expect(
      cleanLabelForSearch('AMUNDI PEA MONDE (MSCI World) UCITS ETF - Acc EUR ACC'),
    ).toBe('AMUNDI PEA MONDE')
    expect(
      cleanLabelForSearch('Amundi PEA Japon (TOPIX) UCITS ETF - EUR DIS (PTPXE)'),
    ).toBe('Amundi PEA Japon')
  })

  it('drops an ISIN, accents and a trailing share-class letter', () => {
    expect(cleanLabelForSearch('Indépendance AM Europe Small I')).toBe(
      'Independance AM Europe Small',
    )
    expect(cleanLabelForSearch('TAILOR ACTIONS ENTREPRENEURS C FR0011051598')).toBe(
      'TAILOR ACTIONS ENTREPRENEURS',
    )
  })

  it('keeps a single-letter libellé intact', () => {
    expect(cleanLabelForSearch('X')).toBe('X')
  })
})

describe('shareClassConflict / sameLibelle', () => {
  it('flags a different class letter or a hedged class', () => {
    expect(
      shareClassConflict(
        'Indépendance AM Europe Small I (C)',
        'Indépendance AM Europe Small A (C)',
      ),
    ).toBe(true)
    expect(
      shareClassConflict(
        'iMGP DBi Managed Futures Fund - R UCITS ETF EUR ACC',
        'iMGP DBi Managed Futures Fund - R UCITS ETF EUR ACC H',
      ),
    ).toBe(true)
  })

  it('does not flag ACC vs DIS (Morningstar names are unreliable) or missing letters', () => {
    expect(
      shareClassConflict(
        'Amundi PEA Japon (TOPIX) UCITS ETF - EUR DIS',
        'Amundi PEA Japon Topix ETF EUR Acc',
      ),
    ).toBe(false)
    expect(shareClassConflict('Novo-Nordisk B', 'Novo-Nordisk')).toBe(false)
    expect(shareClassConflict('X-FAB', 'X-FAB Silicon Foundries')).toBe(false)
  })

  it('sameLibelle ignores case, accents and spacing', () => {
    expect(
      sameLibelle(
        'Vanguard FTSE Global All-Cap UCITS ETF - USD ACC',
        'VANGUARD FTSE GLOBAL ALL-CAP UCITS ETF  - USD ACC',
      ),
    ).toBe(true)
    expect(
      sameLibelle(
        'Vanguard FTSE Global All-Cap UCITS ETF - USD ACC',
        'Vanguard FTSE Global All-Cap UCITS ETF - USD DIS',
      ),
    ).toBe(false)
  })
})

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

  it('rejects Amundi S&P 500 without PEA when query is PEA share class', () => {
    expect(
      passesNameQualityGate(
        'Amundi PEA SP 500 UCITS ETF Acc',
        'Amundi Index Solutions - Amundi S&P 500 UCITS ETF',
      ),
    ).toBe(false)
  })

  it('keeps trailing share-class C as a significant token', () => {
    expect(
      passesNameQualityGate(
        'Tailor Actions Entrepreneurs C',
        'TAILOR ACTIONS ENTREPRENEURS I',
      ),
    ).toBe(false)
    expect(
      passesNameQualityGate(
        'Tailor Actions Entrepreneurs C',
        'Tailor Actions Entrepreneurs C',
      ),
    ).toBe(true)
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
