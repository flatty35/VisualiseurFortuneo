import { describe, expect, it } from 'vitest'
import type { Operation, QuoteBar, Support } from '@/domain/types'
import {
  buildPriceCompareSeries,
  buildPruStepSeries,
  splitHeldSegments,
} from './priceCompare'
import type { HoldingsSnapshot } from './positions'

describe('splitHeldSegments', () => {
  it('shares boundary points between solid and dashed parts', () => {
    const pts = [
      { date: '2024-01-01', value: 0, held: true },
      { date: '2024-01-02', value: 10, held: true },
      { date: '2024-01-03', value: 5, held: false },
      { date: '2024-01-04', value: 8, held: false },
      { date: '2024-01-05', value: 12, held: true },
    ]
    const segs = splitHeldSegments(pts)
    expect(segs).toHaveLength(3)
    expect(segs[0].held).toBe(true)
    expect(segs[0].points.map((p) => p.date)).toEqual(['2024-01-01', '2024-01-02'])
    expect(segs[1].held).toBe(false)
    // connects from last held day
    expect(segs[1].points[0].date).toBe('2024-01-02')
    expect(segs[1].points.map((p) => p.date)).toEqual([
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
    ])
    expect(segs[2].held).toBe(true)
    expect(segs[2].points[0].date).toBe('2024-01-04')
    expect(segs[2].points.at(-1)?.date).toBe('2024-01-05')
  })
})

describe('buildPriceCompareSeries', () => {
  it('starts at 0 % on first buy and rises with price', () => {
    const support: Support = {
      isin: 'FR0000125486',
      name: 'VINCI',
      manualPrices: [],
    }
    const quotes = new Map<string, QuoteBar[]>([
      [
        'VNC.PA',
        [
          { date: '2024-01-02', close: 100 },
          { date: '2024-06-01', close: 110 },
        ],
      ],
    ])
    support.yahooTicker = 'VNC.PA'
    const operations: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'PEA',
        date: '2024-01-02',
        type: 'ACHAT',
        isin: 'FR0000125486',
        quantity: 1,
        price: 100,
        label: 'achat',
      },
    ]
    const holdings: HoldingsSnapshot[] = [
      {
        date: '2024-01-02',
        quantities: new Map([['FR0000125486', 1]]),
        cash: 0,
      },
      {
        date: '2024-06-01',
        quantities: new Map([['FR0000125486', 1]]),
        cash: 0,
      },
    ]
    const series = buildPriceCompareSeries({
      isins: ['FR0000125486'],
      holdings,
      supports: [support],
      quotes,
      operations,
      names: { FR0000125486: 'VINCI' },
      from: '2024-01-02',
      to: '2024-06-01',
    })
    expect(series[0]?.valueUnit).toBe('pct')
    expect(series[0]?.values[0]).toBeCloseTo(0, 5)
    expect(series[0]?.values.at(-1)).toBeCloseTo(10, 5)
  })
})

describe('buildPruStepSeries', () => {
  it('steps PRU after each buy (same % scale as first buy)', () => {
    const support: Support = {
      isin: 'FR0000125486',
      name: 'VINCI',
      yahooTicker: 'VNC.PA',
      manualPrices: [],
    }
    const quotes = new Map<string, QuoteBar[]>([
      [
        'VNC.PA',
        [
          { date: '2024-01-02', close: 100 },
          { date: '2024-03-01', close: 100 },
          { date: '2024-06-01', close: 120 },
        ],
      ],
    ])
    const operations: Operation[] = [
      {
        id: '1',
        fingerprint: '1',
        envelope: 'PEA',
        date: '2024-01-02',
        type: 'ACHAT',
        isin: 'FR0000125486',
        quantity: 1,
        price: 100,
        label: 'achat1',
      },
      {
        id: '2',
        fingerprint: '2',
        envelope: 'PEA',
        date: '2024-03-01',
        type: 'ACHAT',
        isin: 'FR0000125486',
        quantity: 1,
        price: 120,
        label: 'achat2',
      },
    ]
    const days = ['2024-01-02', '2024-03-01', '2024-06-01']
    const pru = buildPruStepSeries({
      isin: 'FR0000125486',
      operations,
      supports: [support],
      quotes,
      days,
      from: '2024-01-02',
      to: '2024-06-01',
    })
    expect(pru?.step).toBe('end')
    expect(pru?.name).toBe('PRU')
    // After 1st buy: PRU 100 → 0 % vs base
    expect(pru?.values[0]).toBeCloseTo(0, 5)
    expect(pru?.realPrices?.[0]).toBeCloseTo(100, 5)
    // After 2nd buy: PRU 110 → +10 %
    expect(pru?.values[1]).toBeCloseTo(10, 5)
    expect(pru?.realPrices?.[1]).toBeCloseTo(110, 5)
    // Unchanged until next trade
    expect(pru?.values[2]).toBeCloseTo(10, 5)
  })
})
