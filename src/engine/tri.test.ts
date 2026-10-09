import { describe, expect, it } from 'vitest'
import { computeIrr } from './tri'

describe('computeIrr', () => {
  it('computes ~10% for simple annual flow', () => {
    const irr = computeIrr([
      { date: '2020-01-01', amount: -100, label: 'in' },
      { date: '2021-01-01', amount: 110, label: 'out' },
    ])
    expect(irr).not.toBeNull()
    expect(irr!).toBeCloseTo(0.1, 3)
  })
})
