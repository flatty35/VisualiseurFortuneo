import { describe, expect, it } from 'vitest'
import {
  fortuneoHitAcceptable,
  guessYahooTicker,
  pickBestFortuneoHit,
  pickYahooByProbedPrices,
  pickYahooFromSearchHits,
  scoreFortuneoHit,
  yahooCandidatesFromMnemo,
  type FortuneoHit,
} from './fortuneoSearch'

describe('fortuneoSearch helpers', () => {
  it('maps Euronext Paris mnemo to Yahoo .PA', () => {
    expect(
      guessYahooTicker({
        mnemo: 'SAF',
        place: 'Euronext Paris',
        codePlace: 23,
      }),
    ).toBe('SAF.PA')
  })

  it('maps Xetra / Frankfurt to .DE', () => {
    expect(
      guessYahooTicker({ mnemo: 'RHM', place: 'Xetra' }),
    ).toBe('RHM.DE')
    expect(
      guessYahooTicker({ mnemo: 'RHM', place: 'Frankfurt' }),
    ).toBe('RHM.DE')
  })

  it('maps Warsaw to .WA', () => {
    expect(
      guessYahooTicker({ mnemo: 'KGHA', place: 'Warsaw Stock Exchange' }),
    ).toBe('KGHA.WA')
  })

  it('refuses bare mnemo when place is unknown', () => {
    expect(guessYahooTicker({ mnemo: 'RHM', place: '' })).toBeUndefined()
    expect(
      guessYahooTicker({ mnemo: 'KGHA', place: 'Unknown Venue' }),
    ).toBeUndefined()
  })

  it('picks Paris Action over duplicate without price', () => {
    const hits: FortuneoHit[] = [
      {
        codeIsin: 'FR0000073272',
        mnemo: 'SAF',
        libelle: 'SAFRAN',
        type: 'Action',
        place: 'Euronext Paris',
        codePlace: 23,
        cours: null,
      },
      {
        codeIsin: 'FR0000073272',
        mnemo: 'SAF',
        libelle: 'SAFRAN',
        type: 'Action',
        place: 'Euronext Paris',
        codePlace: 23,
        cours: 316.2,
      },
    ]
    const best = pickBestFortuneoHit(hits, 'SAFRAN')
    expect(best?.codeIsin).toBe('FR0000073272')
    expect(guessYahooTicker(best!)).toBe('SAF.PA')
  })

  it('prefers name match when several ISINs', () => {
    const hits: FortuneoHit[] = [
      {
        codeIsin: 'FR0000120073',
        mnemo: 'AI',
        libelle: 'AIR LIQUIDE',
        type: 'Action',
        place: 'Euronext Paris',
        codePlace: 23,
      },
      {
        codeIsin: 'FR0000130007',
        mnemo: 'OR',
        libelle: 'L OREAL',
        type: 'Action',
        place: 'Euronext Paris',
        codePlace: 23,
      },
    ]
    expect(pickBestFortuneoHit(hits, 'AIR LIQUIDE')?.mnemo).toBe('AI')
  })

  it('rejects weak ETF family hit for early-stop', () => {
    const oil: FortuneoHit = {
      codeIsin: 'JE00B78CGV99',
      mnemo: 'BRNT',
      libelle: 'WisdomTree Brent Crude Oil',
      type: 'ETF',
      place: 'Euronext Paris',
      codePlace: 23,
    }
    const query =
      'WisdomTree Europe High Dividend UCITS ETF - EUR DIS'
    expect(fortuneoHitAcceptable(oil, query)).toBe(false)
    expect(scoreFortuneoHit(oil, query)).toBeLessThan(120)
  })

  it('rejects US ADR Fortuneo hit for early-stop', () => {
    const adr: FortuneoHit = {
      codeIsin: 'US29272H3003',
      mnemo: 'NVO',
      libelle: 'NOVO NORDISK A/S',
      type: 'Action',
      place: 'NYSE',
    }
    expect(fortuneoHitAcceptable(adr, 'NOVO NORDISK')).toBe(false)
  })

  it('builds Yahoo probe candidates with PEA-first suffixes', () => {
    const c = yahooCandidatesFromMnemo('RHM')
    expect(c[0]).toBe('RHM.PA')
    expect(c).toContain('RHM.DE')
    expect(c).toContain('RHM')
  })

  it('picks probed ticker closest to Fortuneo cours', () => {
    const candidates = yahooCandidatesFromMnemo('RHM')
    const prices = {
      'RHM.PA': 12,
      'RHM.DE': 520,
      'RHM.AS': 19,
    }
    expect(pickYahooByProbedPrices(candidates, prices, 515)).toBe('RHM.DE')
  })

  it('falls back to first alive suffix when no cours', () => {
    const candidates = ['KGHA.PA', 'KGHA.AS', 'KGHA.WA']
    expect(
      pickYahooByProbedPrices(candidates, { 'KGHA.WA': 120 }, null),
    ).toBe('KGHA.WA')
  })

  it('picks Yahoo search hit that extends mnemo and matches name', () => {
    const ticker = pickYahooFromSearchHits(
      [
        {
          symbol: 'BRNT.PA',
          shortname: 'WisdomTree Brent Crude Oil',
          quoteType: 'ETF',
        },
        {
          symbol: 'RHM.DE',
          shortname: 'Rheinmetall AG',
          longname: 'Rheinmetall Aktiengesellschaft',
          quoteType: 'EQUITY',
        },
        { symbol: 'RHM', shortname: 'Other', quoteType: 'EQUITY' },
      ],
      'RHM',
      'RHEINMETALL',
    )
    expect(ticker).toBe('RHM.DE')
  })
})
