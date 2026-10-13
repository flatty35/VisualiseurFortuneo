import { describe, expect, it } from 'vitest'
import { cashImpact, tradeCashAmount } from './cashImpact'
import type { Operation } from '@/domain/types'

function op(partial: Partial<Operation> & Pick<Operation, 'type' | 'label'>): Operation {
  return {
    id: 'x',
    fingerprint: 'x',
    envelope: 'PEA',
    date: '2024-01-15',
    ...partial,
  }
}

describe('titres-only cash model', () => {
  it('cashImpact never accumulates a pocket from trades', () => {
    expect(
      cashImpact(
        op({
          type: 'ACHAT',
          label: 'achat',
          netAmount: -606.5,
          isin: 'FR0000120271',
        }),
      ),
    ).toBe(0)
    expect(
      cashImpact(
        op({
          type: 'VENTE',
          label: 'vente',
          netAmount: 649,
          isin: 'FR0000120271',
        }),
      ),
    ).toBe(0)
  })

  it('titres mode ignores frais / dividendes (Fortuneo idle cash = reportedCash)', () => {
    expect(
      cashImpact(
        op({ type: 'FRAIS', label: 'Intérêts client', netAmount: -0.2 }),
      ),
    ).toBe(0)
  })

  it('ledger mode applies trades + frais + dividendes (Saxo)', () => {
    expect(
      cashImpact(
        op({
          type: 'ACHAT',
          label: 'achat',
          netAmount: -100,
          isin: 'US0231351067',
        }),
        'ledger',
      ),
    ).toBeCloseTo(-100)
    expect(
      cashImpact(
        op({ type: 'FRAIS', label: 'Intérêts client', netAmount: -0.2 }),
        'ledger',
      ),
    ).toBeCloseTo(-0.2)
    expect(
      cashImpact(
        op({
          type: 'DIVIDENDE',
          label: 'Réinvestissement',
          netAmount: 4.41,
          isin: 'GB0031348658',
        }),
        'ledger',
      ),
    ).toBeCloseTo(4.41)
  })

  it('tradeCashAmount keeps signed Montant net for TRI apports', () => {
    expect(
      tradeCashAmount(
        op({
          type: 'ACHAT',
          label: 'achat',
          netAmount: -606.5,
          isin: 'FR0000120271',
        }),
      ),
    ).toBeCloseTo(-606.5)
    expect(
      tradeCashAmount(
        op({
          type: 'VENTE',
          label: 'vente',
          netAmount: 649,
          isin: 'FR0000120271',
        }),
      ),
    ).toBeCloseTo(649)
  })
})
