import { describe, expect, it } from 'vitest'
import { buildCashSpikeSeries } from './cashSeries'
import type { Operation } from '@/domain/types'

function op(
  partial: Partial<Operation> & Pick<Operation, 'type' | 'date' | 'label' | 'netAmount'>,
): Operation {
  return {
    id: `${partial.date}-${partial.type}-${partial.netAmount}`,
    fingerprint: `${partial.date}-${partial.type}`,
    envelope: 'PEA',
    ...partial,
  }
}

describe('buildCashSpikeSeries', () => {
  it('shows a spike when versement precedes buy on the same day (espèces ledger)', () => {
    const points = buildCashSpikeSeries({
      openingCash: 0,
      from: '2024-01-15',
      to: '2024-01-16',
      operations: [
        op({
          type: 'VERSEMENT',
          date: '2024-01-15',
          label: 'versement',
          netAmount: 1000,
        }),
        // Espèces achat line — no ISIN (cash ledger)
        op({
          type: 'ACHAT',
          date: '2024-01-15',
          label: 'achat',
          netAmount: -600,
        }),
      ],
    })
    const spike = points.find((p) => p.isSpike)
    expect(spike?.cash).toBe(1000)
    const eod = points.filter((p) => p.day === '2024-01-15' && !p.isSpike).pop()
    expect(eod?.cash).toBe(400)
  })

  it('ignores titres ISIN rows so cash is not double-counted', () => {
    const points = buildCashSpikeSeries({
      openingCash: 1000,
      from: '2024-01-15',
      to: '2024-01-15',
      operations: [
        op({
          type: 'ACHAT',
          date: '2024-01-15',
          label: 'achat espece',
          netAmount: -600,
        }),
        op({
          type: 'ACHAT',
          date: '2024-01-15',
          label: 'achat titre',
          netAmount: -600,
          isin: 'FR0000120271',
          quantity: 10,
        }),
      ],
    })
    const eod = points.filter((p) => !p.isSpike).pop()
    expect(eod?.cash).toBe(400)
  })
})
