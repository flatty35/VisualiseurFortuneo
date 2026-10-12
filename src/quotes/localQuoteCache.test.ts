import { describe, expect, it } from 'vitest'
import type { QuoteSeries } from '@/domain/types'
import { historyIsFresh, previousWeekday } from './localQuoteCache'

function series(first: string, last: string, updatedAt: string): QuoteSeries {
  const bars = []
  const d = new Date(`${first}T00:00:00Z`)
  const end = new Date(`${last}T00:00:00Z`)
  while (d <= end) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      bars.push({ date: d.toISOString().slice(0, 10), close: 10 })
    }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return { ticker: 'X', bars, updatedAt }
}

describe('previousWeekday', () => {
  it('skips weekends', () => {
    expect(previousWeekday('2026-10-12')).toBe('2026-10-09') // Mon → Fri
    expect(previousWeekday('2026-10-11')).toBe('2026-10-09') // Sun → Fri
    expect(previousWeekday('2026-10-14')).toBe('2026-10-13')
  })
})

describe('historyIsFresh', () => {
  const longAgo = '2026-01-01T00:00:00Z'

  it('is fresh on a weekend when the last bar is Friday', () => {
    const s = series('2024-10-14', '2026-10-09', longAgo)
    expect(historyIsFresh(s, '2024-10-12', '2026-10-11')).toBe(true)
  })

  it('accepts Morningstar one-session lag on Monday', () => {
    const s = series('2024-10-14', '2026-10-09', longAgo)
    expect(historyIsFresh(s, '2024-10-12', '2026-10-12')).toBe(true)
  })

  it('is stale when bars stop a week ago and the fetch is old', () => {
    const s = series('2024-10-14', '2026-10-02', longAgo)
    expect(historyIsFresh(s, '2024-10-12', '2026-10-12')).toBe(false)
  })

  it('is fresh for 6 h after a fetch even if the feed lags (funds)', () => {
    const now = Date.parse('2026-10-12T18:00:00Z')
    const s = series('2024-10-14', '2026-10-02', '2026-10-12T15:00:00Z')
    expect(historyIsFresh(s, '2024-10-12', '2026-10-12', now)).toBe(true)
  })

  it('rejects short or late-starting series', () => {
    expect(
      historyIsFresh(series('2026-09-01', '2026-10-09', longAgo), '2024-10-12', '2026-10-12'),
    ).toBe(false)
    expect(historyIsFresh(undefined, '2024-10-12', '2026-10-12')).toBe(false)
  })
})
