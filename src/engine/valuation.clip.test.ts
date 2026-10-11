import { describe, expect, it } from 'vitest'
import { clipInactivePositionValues } from './valuation'

describe('clipInactivePositionValues', () => {
  it('stays blank before first open and after the closing zero', () => {
    const values = [0, 0, 100, 120, 80, 0, 0, 0]
    const held = [false, false, true, true, true, false, false, false]
    expect(clipInactivePositionValues(values, held)).toEqual([
      null,
      null,
      100,
      120,
      80,
      0,
      null,
      null,
    ])
  })

  it('reconnects after a reopen', () => {
    const values = [50, 0, 0, 40, 45]
    const held = [true, false, false, true, true]
    expect(clipInactivePositionValues(values, held)).toEqual([
      50,
      0,
      null,
      40,
      45,
    ])
  })

  it('is all null when never held', () => {
    expect(
      clipInactivePositionValues([0, 0], [false, false]),
    ).toEqual([null, null])
  })
})
