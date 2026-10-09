import { describe, expect, it } from 'vitest'
import { isValidIsin, normalizeSupportKey } from './rekeySupport'

describe('rekeySupport helpers', () => {
  it('validates real ISINs', () => {
    expect(isValidIsin('FR0000120073')).toBe(true)
    expect(isValidIsin('fr0000120073')).toBe(true)
    expect(isValidIsin('LOCAL:2crsi')).toBe(false)
    expect(isValidIsin('FR123')).toBe(false)
  })

  it('normalizes keys', () => {
    expect(normalizeSupportKey('fr0000120073')).toBe('FR0000120073')
    expect(normalizeSupportKey('LOCAL:2CRSI')).toBe('LOCAL:2crsi')
  })
})
