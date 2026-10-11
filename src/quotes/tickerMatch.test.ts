import { describe, expect, it } from 'vitest'
import { isOpenFigiPaAm } from './gasClient'
import { buildSearchQueries, pickBestTicker, scoreYahooHit } from './tickerMatch'
import { lookupSeedTicker } from './tickerSeed'

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
