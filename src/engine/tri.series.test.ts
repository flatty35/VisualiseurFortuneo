import { describe, expect, it } from 'vitest'
import {
  computeCalendarYearTris,
  computeMonthlyTriSeries,
  densifyTriSeries,
  monthEndDates,
  spansMoreThanOneMonth,
  type CashFlow,
} from './tri'

describe('monthEndDates', () => {
  it('picks last available day on or before each civil month-end', () => {
    const available = [
      '2024-01-02',
      '2024-01-31',
      '2024-02-15',
      '2024-02-29',
      '2024-03-10',
    ]
    const ends = monthEndDates('2024-01-02', '2024-03-10', available)
    expect(ends).toEqual(['2024-01-31', '2024-02-29', '2024-03-10'])
  })
})

describe('computeMonthlyTriSeries', () => {
  it('stays near 0% when value grows only via mid-period apports', () => {
    const valued = [
      { date: '2024-01-02', total: 1000 },
      { date: '2024-01-31', total: 1000 },
      { date: '2024-06-28', total: 1000 },
      { date: '2024-07-01', total: 2000 },
      { date: '2024-07-31', total: 2000 },
      { date: '2024-12-31', total: 2000 },
    ]
    const midFlows: CashFlow[] = [
      { date: '2024-07-01', amount: -1000, label: 'achat' },
    ]
    const series = computeMonthlyTriSeries({ valued, midFlows })
    const last = series[series.length - 1]
    expect(last.rate).not.toBeNull()
    expect(Math.abs(last.rate!)).toBeLessThan(0.05)
    // No daily noise: fewer points than valued days
    expect(series.length).toBeLessThan(valued.length)
  })

  it('rises when portfolio doubles with no external flows over ~1 year', () => {
    const valued = [
      { date: '2024-01-02', total: 1000 },
      { date: '2024-06-28', total: 1400 },
      { date: '2025-01-02', total: 2000 },
    ]
    const series = computeMonthlyTriSeries({ valued, midFlows: [] })
    const last = series[series.length - 1]
    expect(last.rate).not.toBeNull()
    expect(last.rate!).toBeCloseTo(1, 1)
  })

  it('does not spike when a mid-month achat is included as apport', () => {
    const valued = [
      { date: '2025-01-02', total: 20000 },
      { date: '2025-06-30', total: 21000 },
      { date: '2025-12-31', total: 22000 },
      { date: '2026-08-29', total: 23000 },
      { date: '2026-09-25', total: 36000 },
      { date: '2026-09-30', total: 36000 },
    ]
    const midFlows: CashFlow[] = [
      { date: '2026-09-25', amount: -13000, label: 'achat' },
    ]
    const series = computeMonthlyTriSeries({ valued, midFlows })
    const before = series.find((p) => p.date === '2026-08-29')
    const after = series.find((p) => p.date === '2026-09-30')
    expect(before?.rate).not.toBeNull()
    expect(after?.rate).not.toBeNull()
    expect(Math.abs(after!.rate! - before!.rate!)).toBeLessThan(0.08)
  })
})

describe('densifyTriSeries', () => {
  it('interpolates linearly between month-end knots', () => {
    const samples = [
      { date: '2024-01-31', rate: 0.1 },
      { date: '2024-02-29', rate: 0.2 },
    ]
    const dense = densifyTriSeries(samples, [
      '2024-01-15',
      '2024-01-31',
      '2024-02-14',
      '2024-02-29',
      '2024-03-01',
    ])
    expect(dense.find((p) => p.date === '2024-01-15')?.rate).toBeNull()
    expect(dense.find((p) => p.date === '2024-01-31')?.rate).toBeCloseTo(0.1)
    expect(dense.find((p) => p.date === '2024-02-29')?.rate).toBeCloseTo(0.2)
    expect(dense.find((p) => p.date === '2024-03-01')?.rate).toBeNull()
    // Midpoint of Jan 31 → Feb 29 (29 days): ~halfway
    const mid = dense.find((p) => p.date === '2024-02-14')?.rate
    expect(mid).not.toBeNull()
    expect(mid!).toBeCloseTo(0.1 + (14 / 29) * 0.1, 5)
  })
})

describe('computeCalendarYearTris', () => {
  it('returns N, N-1, N-2 with standalone yearly IRR', () => {
    const valued = [
      { date: '2024-01-02', total: 1000 },
      { date: '2024-12-31', total: 1100 },
      { date: '2025-01-02', total: 1100 },
      { date: '2025-12-31', total: 1210 },
      { date: '2026-01-02', total: 1210 },
      { date: '2026-06-30', total: 1270 },
    ]
    const years = computeCalendarYearTris({
      valued,
      midFlows: [],
      asOf: '2026-06-30',
    })
    expect(years.map((y) => y.year)).toEqual([2026, 2025, 2024])
    // 2024: 1000 → 1100 ≈ 10%
    expect(years[2].irr).not.toBeNull()
    expect(years[2].irr!).toBeCloseTo(0.1, 1)
    // 2025: 1100 → 1210 ≈ 10%
    expect(years[1].irr).not.toBeNull()
    expect(years[1].irr!).toBeCloseTo(0.1, 1)
  })
})

describe('spansMoreThanOneMonth', () => {
  it('is false for a short window', () => {
    expect(spansMoreThanOneMonth('2026-09-01', '2026-09-20')).toBe(false)
  })
  it('is true across months', () => {
    expect(spansMoreThanOneMonth('2026-08-15', '2026-09-20')).toBe(true)
  })
})
