import { describe, expect, it } from 'vitest'
import { parseTitresText } from './fortuneoTitres'
import { reconstructVirtualOpening } from './reconstructBackward'

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

  it('produces stable fingerprints across re-parse', () => {
    const a = parseTitresText(SAMPLE, 'PEA')
    const b = parseTitresText(SAMPLE, 'PEA')
    expect(a[0].fingerprint).toBe(b[0].fingerprint)
    expect(a.map((o) => o.fingerprint)).toEqual(b.map((o) => o.fingerprint))
  })

  it('keeps Opération text in label for amortissement / OST', () => {
    const csv = `libellé;Opération;Place;Date;Qté;Prix d'éxé;Montant brut;Courtage/Prélèvement;Montant net;Devise;
BPIFR.ENTR.3 A2 3D;OST de création de coupons - Détachement coupon amortissement;null;29/06/2026;20.0;0.0;227.4;0.0;227.4;EUR;
`
    const ops = parseTitresText(csv, 'PEA_PME')
    expect(ops[0]?.type).toBe('DIVIDENDE')
    expect(ops[0]?.label).toMatch(/amortissement/i)
    expect(ops[0]?.name).toMatch(/BPIFR/i)
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
    expect(vo.cash).toBe(0)
    expect(vo.reportedCash).toBe(1000)
  })

  it('maps LOCAL ops onto position ISIN so opening qty is not left at current', () => {
    const ops = parseTitresText(
      `libellé;Opération;Place;Date;Qté;Prix d'éxé;Montant brut;Courtage/Prélèvement;Montant net;Devise
SAFRAN;Achat Comptant;Euronext Paris;08/04/2025;4.0;212.4;-849.6;-2.97;-852.57;EUR
`,
      'PEA',
    ).map((o) => ({ ...o, isin: 'LOCAL:safran' }))
    const vo = reconstructVirtualOpening({
      envelope: 'PEA',
      positions: [{ isin: 'FR0000073272', name: 'SAFRAN', quantity: 4 }],
      operations: ops,
      currentCash: 0,
    })
    // Current 4; undo buy -4 → 0 (must use FR key, not leave 4 on FR)
    expect(vo.positions.find((p) => p.isin === 'FR0000073272')?.quantity ?? 0).toBeCloseTo(
      0,
    )
    expect(
      vo.positions.find((p) => p.isin === 'LOCAL:safran')?.quantity ?? 0,
    ).toBeCloseTo(0)
  })
})
