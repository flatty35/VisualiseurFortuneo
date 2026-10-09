import { describe, expect, it } from 'vitest'
import { OperationType } from '@/domain/portfolioModel'
import { projectPortfolio, virtualOpeningFromEnvelope } from '@/domain/flatAdapters'
import { portfolioFromV1 } from './migrateV1'
import { SCHEMA_VERSION } from '@/domain/types'
import type { Operation, Support, VirtualOpening } from '@/domain/types'

describe('migrate v1 → Portfolio', () => {
  it('maps flat ops/supports and POSITION_SET from virtual opening', () => {
    const supports: Support[] = [
      {
        isin: 'FR0000125486',
        name: 'VINCI',
        yahooTicker: 'DG.PA',
        manualPrices: [],
      },
    ]
    const operations: Operation[] = [
      {
        id: '1',
        fingerprint: 'fp1',
        envelope: 'PEA',
        date: '2024-06-01',
        type: 'VERSEMENT',
        netAmount: 1000,
        label: 'Versement',
      },
      {
        id: '2',
        fingerprint: 'fp2',
        envelope: 'PEA',
        date: '2024-06-02',
        type: 'ACHAT',
        isin: 'FR0000125486',
        name: 'VINCI',
        quantity: 4,
        price: 100,
        netAmount: -400,
        label: 'Achat VINCI',
      },
      {
        id: 'seed',
        fingerprint: 'seed-old',
        envelope: 'PEA',
        date: '2024-01-01',
        type: 'POSITION_SEED',
        netAmount: 3400,
        label: 'Espèces initiales',
        synthetic: true,
      },
    ]
    const vo: VirtualOpening = {
      envelope: 'PEA',
      date: '2024-01-01',
      cash: 3400,
      positions: [
        { isin: 'FR0000125486', name: 'VINCI', quantity: 10 },
      ],
      computedAt: '2024-06-03T00:00:00.000Z',
    }

    const p = portfolioFromV1({
      envelopes: [
        {
          type: 'PEA',
          label: 'PEA',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-06-03T00:00:00.000Z',
        },
      ],
      operations,
      supports,
      virtualOpenings: [vo],
    })

    expect(p.findSupportByIsin('FR0000125486')?.yahooFinanceTicker).toBe(
      'DG.PA',
    )
    const env = p.envelopeByKind('PEA')
    expect(env).toBeTruthy()
    // Synthetic v1 seeds dropped; rebuilt as POSITION_SET
    const sets = env!.operations.filter(
      (o) => o.type === OperationType.POSITION_SET,
    )
    expect(sets.some((o) => o.supportUniqueID === 0 && o.amount === 3400)).toBe(
      true,
    )
    expect(sets.some((o) => o.quantity === 10)).toBe(true)
    // Non-synthetic ops kept
    expect(
      env!.operations.filter((o) => !o.synthetic),
    ).toHaveLength(2)

    const projected = projectPortfolio(p)
    expect(projected.supports[0].yahooTicker).toBe('DG.PA')
    const opening = virtualOpeningFromEnvelope(p, 'PEA')
    expect(opening?.cash).toBe(3400)
    expect(opening?.positions[0]?.quantity).toBe(10)
  })

  it('export schemaVersion is 2', () => {
    expect(SCHEMA_VERSION).toBe(2)
  })
})
