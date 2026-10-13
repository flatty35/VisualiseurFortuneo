import { describe, expect, it } from 'vitest'
import {
  ALL_ENVELOPES,
  brokerForEnvelope,
  envelopeLabel,
  envelopesForBroker,
  isSaxoEnvelope,
} from './envelopes'

describe('envelopes', () => {
  it('offers PEA / PEA-PME / CTO Saxo for Saxo broker', () => {
    expect(envelopesForBroker('saxo')).toEqual([
      'PEA_SAXO',
      'PEA_PME_SAXO',
      'CTO_SAXO',
    ])
    expect(envelopesForBroker('fortuneo')).toEqual(['PEA', 'PEA_PME', 'CTO'])
  })

  it('labels distinguish broker', () => {
    expect(envelopeLabel('PEA')).toContain('Fortuneo')
    expect(envelopeLabel('PEA_SAXO')).toContain('Saxo')
    expect(envelopeLabel('PEA_PME_SAXO')).toContain('Saxo')
  })

  it('marks Saxo envelopes for ledger cash', () => {
    expect(isSaxoEnvelope('PEA_SAXO')).toBe(true)
    expect(isSaxoEnvelope('PEA_PME_SAXO')).toBe(true)
    expect(isSaxoEnvelope('CTO_SAXO')).toBe(true)
    expect(isSaxoEnvelope('PEA')).toBe(false)
    expect(brokerForEnvelope('PEA_SAXO')).toBe('saxo')
    expect(brokerForEnvelope('CTO')).toBe('fortuneo')
  })

  it('lists every envelope once', () => {
    expect(new Set(ALL_ENVELOPES).size).toBe(ALL_ENVELOPES.length)
    expect(ALL_ENVELOPES).toContain('PEA_SAXO')
    expect(ALL_ENVELOPES).toContain('PEA_PME_SAXO')
  })
})
