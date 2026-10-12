import { describe, expect, it } from 'vitest'
import { parseTitresText } from './fortuneoTitres'
import {
  assignSupportKeys,
  buildNameToIsin,
  isLocalSupportId,
  localSupportId,
} from './resolveIsin'

const SAMPLE_NO_ISIN = `libellé;Opération;Place;Date;Qté;Prix d'éxé;Montant brut;Courtage/Prélèvement;Montant net;Devise
SAFRAN;Achat Comptant;Euronext Paris;08/04/2025;4.0;212.4;-849.6;-2.97;-852.57;EUR
SAFRAN;Vente comptant;Euronext Paris;03/06/2025;2.0;262.4;524.8;-1.84;522.96;EUR
CARREFOUR;Vente comptant;Euronext Paris;13/05/2025;36.0;13.825;497.7;-1.74;495.96;EUR
CARREFOUR;Achat Comptant;Euronext Paris;01/03/2025;36.0;14.0;-504.0;-1.5;-505.5;EUR
`

describe('assignSupportKeys', () => {
  it('uses real ISIN from open positions when names match', () => {
    const ops = parseTitresText(SAMPLE_NO_ISIN, 'PEA')
    const map = buildNameToIsin(
      [{ isin: 'FR0000073272', name: 'SAFRAN', quantity: 2 }],
      [],
    )
    const keyed = assignSupportKeys(ops, map)
    const safran = keyed.filter((o) => o.name === 'SAFRAN')
    expect(safran.every((o) => o.isin === 'FR0000073272')).toBe(true)
  })

  it('assigns LOCAL keys for sold titles without ISIN (Fortuneo label-only)', () => {
    const ops = parseTitresText(SAMPLE_NO_ISIN, 'PEA')
    const keyed = assignSupportKeys(ops, new Map())
    const carrefour = keyed.filter((o) => o.name === 'CARREFOUR')
    expect(carrefour.length).toBeGreaterThan(0)
    expect(carrefour.every((o) => o.isin === localSupportId('CARREFOUR'))).toBe(
      true,
    )
    expect(isLocalSupportId(carrefour[0].isin!)).toBe(true)
  })

  it('upgrades LOCAL keys to real ISIN when an open position name matches', () => {
    const ops = parseTitresText(SAMPLE_NO_ISIN, 'PEA').map((o) =>
      o.name === 'SAFRAN' ? { ...o, isin: localSupportId('SAFRAN') } : o,
    )
    const map = buildNameToIsin(
      [{ isin: 'FR0000073272', name: 'SAFRAN', quantity: 2 }],
      [],
    )
    const keyed = assignSupportKeys(ops, map)
    const safran = keyed.filter((o) => o.name === 'SAFRAN')
    expect(safran.every((o) => o.isin === 'FR0000073272')).toBe(true)
  })

  it('matches CSV name to XLS libellé with Fortuneo (MNEMO) suffix', () => {
    const csv = `libellé;Opération;Place;Date;Qté;Prix d'éxé;Montant brut;Courtage/Prélèvement;Montant net;Devise
CIECHARGEURSINVEST;Achat Comptant;Euronext Paris;06/10/2026;12.0;7.57;-90.84;-0.45;-91.29;EUR
MEDIANTECHNOLOGIES;Achat Comptant;Euronext Paris;02/10/2026;220.0;3.27;-719.4;-3.59;-722.99;EUR
`
    const ops = parseTitresText(csv, 'PEA_PME')
    const map = buildNameToIsin(
      [
        {
          isin: 'FR0000130692',
          name: 'CIECHARGEURSINVEST (CRI)',
          quantity: 105,
        },
        {
          isin: 'FR0011049824',
          name: 'MEDIANTECHNOLOGIES (ALMDT)',
          quantity: 1000,
        },
      ],
      [],
    )
    const keyed = assignSupportKeys(ops, map)
    expect(
      keyed.find((o) => o.name === 'CIECHARGEURSINVEST')?.isin,
    ).toBe('FR0000130692')
    expect(
      keyed.find((o) => o.name === 'MEDIANTECHNOLOGIES')?.isin,
    ).toBe('FR0011049824')
    expect(keyed.every((o) => o.isin && !isLocalSupportId(o.isin))).toBe(true)
  })
})
