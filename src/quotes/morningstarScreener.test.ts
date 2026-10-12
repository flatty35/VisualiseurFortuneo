import { describe, expect, it } from 'vitest'
import {
  micFromExchangeId,
  morningstarRowToHit,
  parseMorningstarCloses,
  pickHistoryListing,
  yahooTickerFromMorningstar,
  type MorningstarHit,
} from './morningstarScreener'

describe('yahooTickerFromMorningstar', () => {
  it('maps European venues to Yahoo suffixes', () => {
    expect(
      yahooTickerFromMorningstar({ Ticker: 'CRI', ExchangeId: 'EX$$$$XPAR' }),
    ).toBe('CRI.PA')
    expect(
      yahooTickerFromMorningstar({ Ticker: 'CSG', ExchangeId: 'EX$$$$XAMS' }),
    ).toBe('CSG.AS')
  })

  it('uses PerformanceId.F for funds without ticker', () => {
    expect(yahooTickerFromMorningstar({ PerformanceId: '0P0000A94X' })).toBe(
      '0P0000A94X.F',
    )
  })

  it('returns nothing for venues Yahoo suffixing does not cover', () => {
    expect(
      yahooTickerFromMorningstar({ Ticker: 'AAPL', ExchangeId: 'EX$$$$XNAS' }),
    ).toBeUndefined()
  })
})

describe('micFromExchangeId', () => {
  it('strips the EX$$$$ prefix', () => {
    expect(micFromExchangeId('EX$$$$XETR')).toBe('XETR')
    expect(micFromExchangeId(undefined)).toBeUndefined()
  })
})

function hit(isin: string, secId: string, mic?: string, ticker?: string): MorningstarHit {
  return morningstarRowToHit({
    ISIN: isin,
    SecId: secId,
    PerformanceId: secId,
    Name: isin,
    Ticker: ticker,
    ExchangeId: mic ? `EX$$$$${mic}` : undefined,
  })!
}

describe('pickHistoryListing', () => {
  it('prefers the issuer home venue over listing order', () => {
    // Screener order is not primary-first (EssilorLuxottica came back SIX first)
    const rows = [
      hit('FR0000121667', '0P0000CB0A', 'XSWX', 'EL'),
      hit('FR0000121667', '0P0000JOOV', 'XWBO', 'EL'),
      hit('FR0000121667', '0P00009WFV', 'XPAR', 'EL'),
    ]
    expect(pickHistoryListing(rows, 'FR0000121667')?.secId).toBe('0P00009WFV')
  })

  it('prefers Paris for IE/LU ETFs and avoids MTF copies', () => {
    const rows = [
      hit('DE000A0H0728', '0P00016SUS', 'CHIX', 'CMSE'),
      hit('IE000OV4XWA3', '0P0001XYDS', 'XLON', 'NTSZ'),
      hit('IE000OV4XWA3', '0P0001XYDY', 'XPAR', 'NTSZ'),
    ]
    expect(pickHistoryListing(rows, 'IE000OV4XWA3')?.secId).toBe('0P0001XYDY')
    expect(pickHistoryListing(rows, 'DE000A0H0728')?.secId).toBe('0P00016SUS')
  })

  it('follows the Yahoo ticker already chosen by the user', () => {
    const rows = [
      hit('FR0013416716', '0P0001HPAW', 'XPAR', 'GOLD'),
      hit('FR0013416716', '0P0001HP9W', 'XAMS', 'GOLD'),
    ]
    expect(pickHistoryListing(rows, 'FR0013416716', 'GOLD.AS')?.secId).toBe(
      '0P0001HP9W',
    )
  })

  it('takes the single venue-less row of a fund (SecId F0000…)', () => {
    const fund = morningstarRowToHit({
      ISIN: 'LU1832175001',
      SecId: 'F000010PEF',
      PerformanceId: '0P0001R7A6',
      Name: 'Indépendance AM Europe Small',
    })!
    expect(pickHistoryListing([fund], 'LU1832175001')?.secId).toBe('F000010PEF')
  })
})

describe('parseMorningstarCloses', () => {
  it('converts epoch-ms pairs to ISO bars', () => {
    expect(
      parseMorningstarCloses([
        [1727740800000, 11.46],
        [1727827200000, 11.42],
      ]),
    ).toEqual([
      { date: '2024-10-01', close: 11.46 },
      { date: '2024-10-02', close: 11.42 },
    ])
  })

  it('treats the unknown-id answer [[]] and junk as empty', () => {
    expect(parseMorningstarCloses([[]])).toEqual([])
    expect(parseMorningstarCloses({ error: 'x' })).toEqual([])
    expect(parseMorningstarCloses([[1727740800000, 0]])).toEqual([])
  })
})
