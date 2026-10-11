import { describe, expect, it } from 'vitest'
import type { Operation } from '@/domain/types'
import {
  buildOperationMarkers,
  formatMarkerTooltipLines,
  prioritizeTradeMarkers,
} from './markers'

function op(partial: Partial<Operation> & Pick<Operation, 'id' | 'type'>): Operation {
  return {
    fingerprint: partial.id,
    envelope: 'PEA',
    date: '2024-06-10',
    label: partial.label ?? partial.type,
    ...partial,
  }
}

describe('buildOperationMarkers', () => {
  it('folds TTF/TAXE into the same-day buy (no gray square)', () => {
    const markers = buildOperationMarkers([
      op({
        id: 'a1',
        type: 'ACHAT',
        isin: 'FR0000125486',
        name: 'VINCI',
        quantity: 4,
        price: 100,
        netAmount: -400,
        label: 'Achat VINCI',
      }),
      op({
        id: 't1',
        type: 'TAXE',
        isin: 'FR0000125486',
        name: 'VINCI',
        netAmount: -1.2,
        label: 'TTF VINCI',
      }),
    ])

    expect(markers).toHaveLength(1)
    expect(markers[0].kind).toBe('entry')
    expect(markers[0].taxAmount).toBeCloseTo(1.2)
    expect(formatMarkerTooltipLines(markers[0]).join('\n')).toMatch(/TTF/)
  })

  it('does not emit orphan TAXE markers without a buy', () => {
    const markers = buildOperationMarkers([
      op({
        id: 't1',
        type: 'TAXE',
        isin: 'FR0000125486',
        netAmount: -0.5,
        label: 'TTF',
      }),
    ])
    expect(markers).toHaveLength(0)
  })

  it('dilutes PRU on free shares (buy at 0 €)', () => {
    const markers = buildOperationMarkers([
      op({
        id: 'a1',
        type: 'ACHAT',
        date: '2025-07-23',
        isin: 'FR0000120073',
        name: 'AIR LIQUIDE',
        quantity: 10,
        price: 100,
        netAmount: -1000,
        label: 'Achat AIR LIQUIDE',
      }),
      op({
        id: 'g1',
        type: 'ACTIONS_GRATUITES',
        date: '2026-06-08',
        isin: 'FR0000120073',
        name: 'AIR LIQUIDE PF28',
        quantity: 1,
        price: 0,
        netAmount: 0,
        label: 'Attribution automatique',
      }),
    ])
    expect(markers).toHaveLength(2)
    expect(markers[0].pruAfter).toBeCloseTo(100, 5)
    expect(markers[1].kind).toBe('entry')
    expect(markers[1].type).toBe('ACTIONS_GRATUITES')
    expect(markers[1].price).toBe(0)
    expect(markers[1].qtyAfter).toBe(11)
    // 1000 € / 11 titres
    expect(markers[1].pruAfter).toBeCloseTo(1000 / 11, 4)
    expect(formatMarkerTooltipLines(markers[1]).join('\n')).toMatch(/PRU/)
  })

  it('hides event squares when a buy/sell triangle exists the same day', () => {
    const markers = prioritizeTradeMarkers([
      {
        date: '2024-06-10',
        seriesId: 'FR0000125486',
        kind: 'entry',
        type: 'ACHAT',
        label: 'achat',
      },
      {
        date: '2024-06-10',
        seriesId: 'FR0000125486',
        kind: 'event',
        type: 'DIVIDENDE',
        label: 'dividende',
      },
      {
        date: '2024-06-10',
        seriesId: 'OTHER',
        kind: 'event',
        type: 'DIVIDENDE',
        label: 'other',
      },
    ])
    expect(markers.map((m) => `${m.seriesId}:${m.kind}`)).toEqual([
      'FR0000125486:entry',
      'OTHER:event',
    ])
  })
})
