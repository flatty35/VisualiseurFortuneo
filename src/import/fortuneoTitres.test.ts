import { describe, expect, it } from 'vitest'
import { parseTitresText } from './fortuneoTitres'
import { reconstructVirtualOpening } from './reconstructBackward'
import { operationFingerprint } from '@/domain/fingerprint'

const SAMPLE = `libellé;Opération;Place;Date;Qté;Prix d'éxé;Montant brut;Courtage/Prélèvement;Montant net;Devise;
TOTALENERGIES SE - FR0000120271;Achat;PARIS;15/01/2024;10;60,50;-605,00;1,50;-606,50;EUR;
TOTALENERGIES SE - FR0000120271;Vente;PARIS;20/06/2024;5;65,00;325,00;1,00;324,00;EUR;
AIR LIQUIDE - FR0000120073;Achat;PARIS;10/03/2024;2;160,00;-320,00;0,00;-320,00;EUR;
OST Detachement dividende TOTAL;OST Detachement;;;0;;;;EUR;
`

describe('parseTitresText', () => {
  it('parses buys/sells and extracts ISIN', () => {
    const ops = parseTitresText(SAMPLE, 'PEA')
    expect(ops.length).toBeGreaterThanOrEqual(3)
    const buy = ops.find((o) => o.type === 'ACHAT' && o.isin === 'FR0000120271')
    expect(buy?.quantity).toBe(10)
    expect(buy?.price).toBeCloseTo(60.5)
    const sell = ops.find((o) => o.type === 'VENTE')
    expect(sell?.quantity).toBe(5)
  })

  it('produces stable fingerprints', () => {
    const ops = parseTitresText(SAMPLE, 'PEA')
    const fp = ops[0].fingerprint
    expect(fp).toBe(
      operationFingerprint({
        envelope: ops[0].envelope,
        date: ops[0].date,
        type: ops[0].type,
        isin: ops[0].isin,
        name: ops[0].name,
        quantity: ops[0].quantity,
        price: ops[0].price,
        netAmount: ops[0].netAmount,
        label: ops[0].label,
      }),
    )
  })
})

describe('reconstructVirtualOpening', () => {
  it('walks backward from current positions', () => {
    const ops = parseTitresText(SAMPLE, 'PEA')
    const vo = reconstructVirtualOpening({
      envelope: 'PEA',
      positions: [
        { isin: 'FR0000120271', name: 'TOTALENERGIES SE', quantity: 5 },
        { isin: 'FR0000120073', name: 'AIR LIQUIDE', quantity: 2 },
      ],
      operations: ops,
      currentCash: 1000,
    })
    // Current TOTAL 5; undo sell +5 → 10; undo buy -10 → 0
    const total = vo.positions.find((p) => p.isin === 'FR0000120271')
    expect(total?.quantity ?? 0).toBeCloseTo(0)
    // AIR: current 2; undo buy -2 → 0
    const air = vo.positions.find((p) => p.isin === 'FR0000120073')
    expect(air?.quantity ?? 0).toBeCloseTo(0)
  })
})
