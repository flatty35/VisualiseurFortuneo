import { describe, expect, it } from 'vitest'
import { cashImpact } from './cashImpact'
import type { Operation } from '@/domain/types'
import { parseEspecesText } from '@/import/fortuneoEspeces'
import { parseTitresText } from '@/import/fortuneoTitres'
import { reconstructVirtualOpening } from '@/import/reconstructBackward'

function op(partial: Partial<Operation> & Pick<Operation, 'type' | 'label'>): Operation {
  return {
    id: 'x',
    fingerprint: 'x',
    envelope: 'PEA',
    date: '2024-01-15',
    ...partial,
  }
}

describe('cashImpact anti double-count', () => {
  it('uses signed titres Montant net and ignores OST/détachement', () => {
    expect(
      cashImpact(op({ type: 'ACHAT', label: 'achat', netAmount: -606.5 })),
    ).toBeCloseTo(-606.5)
    expect(
      cashImpact(op({ type: 'VENTE', label: 'vente', netAmount: 324 })),
    ).toBeCloseTo(324)
    expect(
      cashImpact(op({ type: 'DETACHEMENT', label: 'OST', netAmount: 29 })),
    ).toBe(0)
    expect(
      cashImpact(op({ type: 'DIVIDENDE', label: 'encaissement', netAmount: 29 })),
    ).toBeCloseTo(29)
  })

  it('keeps only versements from espèces CSV', () => {
    const text = `Date opération;Date valeur;libellé;Débit;Crédit;
10/01/2024;10/01/2024;versement;;2000;
15/01/2024;15/01/2024;achat totalenergies;-606,50;
20/06/2024;20/06/2024;vente totalenergies;;324;
`
    const ops = parseEspecesText(text, 'PEA')
    expect(ops).toHaveLength(1)
    expect(ops[0].type).toBe('VERSEMENT')
    expect(ops[0].netAmount).toBe(2000)
  })

  it('ends at ~0 cash when currentCash=0 and history is self-contained', () => {
    const titres = parseTitresText(
      `libellé;Opération;Place;Date;Qté;Prix d'éxé;Montant brut;Courtage/Prélèvement;Montant net;Devise
TOTALENERGIES SE;Achat Comptant;Euronext Paris;15/01/2024;10.0;60.50;-605.00;-1.50;-606.50;EUR
TOTALENERGIES SE;Vente comptant;Euronext Paris;20/06/2024;10.0;65.00;650.00;-1.00;649.00;EUR
`,
      'PEA',
    )
    const especes = parseEspecesText(
      `Date opération;Date valeur;libellé;Débit;Crédit;
10/01/2024;10/01/2024;versement;;1000;
`,
      'PEA',
    )
    const all = [...titres, ...especes]
    // Attach fake ISIN
    const withIsin = all.map((o) =>
      o.type === 'VERSEMENT' ? o : { ...o, isin: 'FR0000120271' },
    )
    const vo = reconstructVirtualOpening({
      envelope: 'PEA',
      positions: [{ isin: 'FR0000120271', name: 'TOTALENERGIES SE', quantity: 0 }],
      operations: withIsin,
      currentCash: 0,
    })
    // Forward from VO should reach currentCash 0
    let cash = vo.cash
    for (const o of withIsin.sort((a, b) => a.date.localeCompare(b.date))) {
      cash += cashImpact(o)
    }
    expect(cash).toBeCloseTo(0, 1)
  })
})
