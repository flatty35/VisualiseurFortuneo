import { describe, expect, it } from 'vitest'
import { splitHeldSegments } from './priceCompare'

describe('splitHeldSegments', () => {
  it('shares boundary points between solid and dashed parts', () => {
    const pts = [
      { date: '2024-01-01', value: 100, held: true },
      { date: '2024-01-02', value: 110, held: true },
      { date: '2024-01-03', value: 105, held: false },
      { date: '2024-01-04', value: 108, held: false },
      { date: '2024-01-05', value: 112, held: true },
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
