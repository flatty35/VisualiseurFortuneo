import { describe, expect, it } from 'vitest'
import { classifyTitresOperation, quantityDelta, reverseQuantityDelta } from './classify'

describe('classifyTitresOperation — actions gratuites', () => {
  it('classifies Fortuneo Air Liquide attribution OST as ACTIONS_GRATUITES', () => {
    expect(
      classifyTitresOperation(
        'OST de création avec ou sans droits - Attribution automatique',
        'AIR LIQUIDE PF28',
      ),
    ).toBe('ACTIONS_GRATUITES')
  })

  it('classifies explicit action gratuite labels', () => {
    expect(
      classifyTitresOperation('Attribution', 'Actions gratuites AIR LIQUIDE'),
    ).toBe('ACTIONS_GRATUITES')
  })

  it('counts free shares as +qty (buy at 0)', () => {
    expect(quantityDelta('ACTIONS_GRATUITES', 1)).toBe(1)
    expect(quantityDelta('ACTIONS_GRATUITES', -1)).toBe(1)
  })
})

describe('classifyTitresOperation — coupons', () => {
  it('classifies détachement coupon amortissement as DIVIDENDE (combined)', () => {
    expect(
      classifyTitresOperation(
        'OST de création de coupons - Détachement coupon amortissement',
        'BPIFR.ENTR.3 A2 3D',
      ),
    ).toBe('DIVIDENDE')
  })

  it('keeps détachement coupon optionnel as DETACHEMENT', () => {
    expect(
      classifyTitresOperation(
        'OST de création de coupons - Détachement coupon optionnel',
        'VINCI',
      ),
    ).toBe('DETACHEMENT')
  })

  it('classifies Encaissement as DIVIDENDE', () => {
    expect(
      classifyTitresOperation(
        'Encaissement coupons intérêt/dividende',
        'VINCI',
      ),
    ).toBe('DIVIDENDE')
  })
})

describe('classifyTitresOperation — SICAV externe', () => {
  it('classifies SCRIPT-PARTS as SCRIPT (+qty buy)', () => {
    expect(
      classifyTitresOperation(
        'SCRIPT-PARTS SICAV EXTERNE',
        'Indosuez Allocation PEA C',
      ),
    ).toBe('SCRIPT')
    expect(quantityDelta('SCRIPT', 4)).toBe(4)
  })

  it('classifies RACHAT PART as RACHAT (−qty), not ACHAT (rachat⊃achat)', () => {
    expect(
      classifyTitresOperation(
        'RACHAT PART SICAV EXTERNE',
        'Indosuez Allocation PEA C',
      ),
    ).toBe('RACHAT')
    expect(quantityDelta('RACHAT', 8)).toBe(-8)
  })

  it('classifies ANNUL. SCRIPT-PARTS as RACHAT (cancel buy)', () => {
    expect(
      classifyTitresOperation(
        'ANNUL. SCRIPT-PARTS SICAV EXTERNE',
        'Indépendance AM Europe Small I (C)',
      ),
    ).toBe('RACHAT')
  })

  it('backward walk from flat Indosuez history opens at 0 (not −16)', () => {
    // Real PEA export: +4 SCRIPT, +4 SCRIPT, −8 RACHAT → flat today.
    const ops: Array<{ type: ReturnType<typeof classifyTitresOperation>; qty: number }> = [
      {
        type: classifyTitresOperation(
          'RACHAT PART SICAV EXTERNE',
          'Indosuez Allocation PEA C',
        ),
        qty: 8,
      },
      {
        type: classifyTitresOperation(
          'SCRIPT-PARTS SICAV EXTERNE',
          'Indosuez Allocation PEA C',
        ),
        qty: 4,
      },
      {
        type: classifyTitresOperation(
          'SCRIPT-PARTS SICAV EXTERNE',
          'Indosuez Allocation PEA C',
        ),
        qty: 4,
      },
    ]
    let q = 0
    for (const o of ops) q += reverseQuantityDelta(o.type, o.qty)
    expect(q).toBe(0)
  })
})
