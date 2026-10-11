import { describe, expect, it } from 'vitest'
import {
  guessYahooTicker,
  pickBestFortuneoHit,
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
})
