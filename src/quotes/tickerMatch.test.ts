import { describe, expect, it } from 'vitest'
import { isOpenFigiPaAm } from './gasClient'
import { buildSearchQueries, pickBestTicker, scoreYahooHit } from './tickerMatch'
import { lookupSeedIsin, lookupSeedTicker } from './tickerSeed'

describe('ticker matching', () => {
  it('seeds Dassault Aviation', () => {
    expect(lookupSeedTicker('DASSAULT AVIATION')).toBe('AM.PA')
  })

  it('exact short seeds still work; short reverse-includes do not', () => {
    expect(lookupSeedTicker('ASML')).toBe('ASML.AS')
    expect(lookupSeedTicker('IBERDROLA')).toBe('IBE.MC')
    // "ca" must not match carrefour via reverse includes
    expect(lookupSeedTicker('CA')).toBeUndefined()
  })

  it('seeds PEA Amundi / Banks / Tailor ISINs (not lookalikes)', () => {
    expect(lookupSeedIsin('Amundi PEA SP 500 UCITS ETF Acc')).toBe(
      'FR0011871128',
    )
    expect(lookupSeedTicker('Amundi PEA SP 500 UCITS ETF Acc')).toBe(
      'PSP5.PA',
    )
    expect(
      lookupSeedIsin(
        'Amundi STOXX Europe 600 Banks - UCITS ETF Acc EUR ACC',
      ),
    ).toBe('LU1834983477')
    expect(lookupSeedTicker('Amundi STOXX Europe 600 Banks UCITS ETF Acc')).toBe(
      'BNK.PA',
    )
    expect(lookupSeedIsin('Tailor Actions Entrepreneurs C')).toBe(
      'FR0013333580',
    )
    expect(lookupSeedTicker('Tailor Actions Entrepreneurs C')).toBe(
      '0P0001E03F.F',
    )
  })

  it('builds ISIN-first queries then name tokens', () => {
    const q = buildSearchQueries('DASSAULT AVIATION', 'FR0014004L86')
    expect(q[0]).toBe('FR0014004L86')
    expect(q.some((x) => /dassault/i.test(x))).toBe(true)
  })

  it('ignores LOCAL synthetic keys in search queries', () => {
    const q = buildSearchQueries('SAFRAN', 'LOCAL:safran')
    expect(q.every((x) => !x.startsWith('LOCAL'))).toBe(true)
    expect(q[0].toLowerCase()).toContain('safran')
  })

  it('prefers .PA with name score', () => {
    const hits = [
      {
        symbol: 'AM',
        shortname: 'Dassault Aviation',
        quoteType: 'EQUITY',
      },
      {
        symbol: 'AM.PA',
        shortname: 'DASSAULT AVIATION',
        longname: 'Dassault Aviation SA',
        quoteType: 'EQUITY',
      },
      {
        symbol: 'DSY.PA',
        shortname: 'Dassault Systemes',
        quoteType: 'EQUITY',
      },
    ]
    expect(pickBestTicker(hits, 'DASSAULT AVIATION')).toBe('AM.PA')
    expect(scoreYahooHit(hits[1], 'DASSAULT AVIATION')).toBeGreaterThan(
      scoreYahooHit(hits[2], 'DASSAULT AVIATION'),
    )
  })

  it('recognizes OpenFIGI Paris / Amsterdam venue codes', () => {
    expect(isOpenFigiPaAm('PAR')).toBe(true)
    expect(isOpenFigiPaAm('FP')).toBe(true)
    expect(isOpenFigiPaAm('NA')).toBe(true)
    expect(isOpenFigiPaAm('US')).toBe(false)
  })
})
