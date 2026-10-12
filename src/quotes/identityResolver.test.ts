import { describe, expect, it } from 'vitest'
import type { FortuneoHit } from './fortuneoSearch'
import { resolveIdentity, type ResolverSources } from './identityResolver'

const ACME: FortuneoHit = {
  codeIsin: 'FR0000000001',
  mnemo: 'ACME',
  libelle: 'ACME INDUSTRIES',
  type: 'ACTION',
  place: 'Euronext Paris',
  codePlace: 23,
}

function sources(
  hits: Record<string, FortuneoHit[]>,
  closes: Record<string, number> = {},
): ResolverSources {
  return {
    fortuneo: async (term) => hits[term] ?? [],
    morningstar: async () => [],
    closeOn: async (isin) => closes[isin],
  }
}

describe('resolveIdentity', () => {
  it('known ISIN → Fortuneo listing on the history place', async () => {
    const r = await resolveIdentity(
      { key: 'FR0000000001', name: 'ACME INDUSTRIES', place: 'Euronext Paris' },
      sources({ FR0000000001: [ACME] }),
    )
    expect(r.isin).toBe('FR0000000001')
    expect(r.ticker).toBe('ACME.PA')
    expect(r.source).toBe('fortuneo')
  })

  it('label-only match accepted when the trade price agrees', async () => {
    const r = await resolveIdentity(
      {
        key: 'LOCAL:PEA:ACME INDUSTRIES',
        name: 'ACME INDUSTRIES',
        place: 'Euronext Paris',
        trade: { date: '2025-03-04', price: 41.2 },
      },
      sources({ 'ACME INDUSTRIES': [ACME] }, { FR0000000001: 40 }),
    )
    expect(r.isin).toBe('FR0000000001')
    expect(r.ticker).toBe('ACME.PA')
  })

  it('label-only match rejected when the market price is 3× the trade', async () => {
    const r = await resolveIdentity(
      {
        key: 'LOCAL:PEA:ACME INDUSTRIES',
        name: 'ACME INDUSTRIES',
        place: 'Euronext Paris',
        trade: { date: '2025-03-04', price: 13 },
      },
      sources({ 'ACME INDUSTRIES': [ACME] }, { FR0000000001: 40 }),
    )
    expect(r.isin).toBeUndefined()
    expect(r.source).toBe('none')
    expect(r.detail).toContain('FR0000000001')
  })

  it('no market data → the price check is skipped', async () => {
    const r = await resolveIdentity(
      {
        key: 'LOCAL:PEA:ACME INDUSTRIES',
        name: 'ACME INDUSTRIES',
        place: 'Euronext Paris',
        trade: { date: '2025-03-04', price: 13 },
      },
      sources({ 'ACME INDUSTRIES': [ACME] }),
    )
    expect(r.isin).toBe('FR0000000001')
  })

  it('a place no hit trades on is a mismatch', async () => {
    const r = await resolveIdentity(
      { key: 'LOCAL:PEA:ACME INDUSTRIES', name: 'ACME INDUSTRIES', place: 'Euronext Amsterdam' },
      sources({ 'ACME INDUSTRIES': [ACME] }),
    )
    expect(r.isin).toBeUndefined()
  })
})
