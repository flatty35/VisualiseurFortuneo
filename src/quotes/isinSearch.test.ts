import { describe, expect, it } from 'vitest'
import { pickBestIsinCandidate, scoreIsinHit, type IsinCandidate } from './isinSearch'

describe('ISIN EUR preference', () => {
  it('scores FR / XPAR higher than US OTC', () => {
    const fr = scoreIsinHit(
      {
        isin: 'FR0013341781',
        name: '2CRSI SA',
        ticker: 'AL2SI.PA',
        exchange: 'XPAR',
        exchangeCountry: 'FRA',
        investmentType: 'EQ',
        score: 38,
      },
      '2CRSI',
    )
    const us = scoreIsinHit(
      {
        isin: 'US1234567890',
        name: '2CRSI SA',
        ticker: 'TCSIF',
        exchange: 'OTCM',
        exchangeCountry: 'USA',
        investmentType: 'EQ',
        score: 34,
      },
      '2CRSI',
    )
    expect(fr).toBeGreaterThan(us)
  })

  it('picks EUR listed ISIN as default', () => {
    const candidates: IsinCandidate[] = [
      {
        isin: 'US1234567890',
        name: 'Foo ADR',
        ticker: 'FOO',
        score: 200,
        sources: ['morningstar'],
        eurListed: false,
      },
      {
        isin: 'FR0013341781',
        name: '2CRSI SA',
        ticker: 'AL2SI.PA',
        score: 150,
        sources: ['morningstar'],
        eurListed: true,
      },
    ]
    expect(pickBestIsinCandidate(candidates)?.isin).toBe('FR0013341781')
  })

  it('treats EEA ISIN prefixes (e.g. PL) as EUR-eligible', () => {
    const pl = scoreIsinHit(
      {
        isin: 'PLKGHM000017',
        name: 'KGHM Polska Miedz',
        investmentType: 'EQ',
        score: 30,
      },
      'KGHM POLSKA MIEDZ',
    )
    expect(pl).toBeGreaterThanOrEqual(120)
  })
})
