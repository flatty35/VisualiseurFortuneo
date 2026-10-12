import { reverseQuantityDelta } from '@/domain/classify'
import { makeOperationId, operationFingerprint } from '@/domain/fingerprint'
import type {
  EnvelopeType,
  Operation,
  ParsedPosition,
  VirtualOpening,
  VirtualOpeningPosition,
} from '@/domain/types'
import {
  buildNameToIsin,
  isLocalSupportId,
  lookupIsin,
  nameMatchKeys,
} from './resolveIsin'

/**
 * Reconstruct virtual opening at the start of the known history window
 * by walking backward from current open positions.
 *
 * Titres-only cash model: opening cash = 0 (no cumulative pocket). Optional
 * currentCash is kept as reportedCash (idle cash today).
 *
 * Opening quantities are clamped to ≥ 0: a negative result means the
 * reverse walk saw more buys than current+sells can explain (duplicate
 * ops, mis-keyed ISIN, ignored loyalty lines, etc.) — never seed a short.
 */
export function reconstructVirtualOpening(input: {
  envelope: EnvelopeType
  positions: ParsedPosition[]
  operations: Operation[]
  currentCash?: number
}): VirtualOpening {
  const { envelope, positions, operations } = input

  const qty = new Map<string, { name: string; quantity: number }>()
  for (const p of positions) {
    if (!p.isin || p.isin === 'CASH') continue
    const nameLow = p.name.toLowerCase()
    if (
      nameLow.includes('especes') ||
      nameLow.includes('espèces') ||
      nameLow.includes('liquidit')
    ) {
      continue
    }
    qty.set(p.isin, { name: p.name, quantity: p.quantity })
  }

  // Map LOCAL / label-only ops onto open-position ISINs so reverse walk
  // undoes the same keys as the XLS snapshot (avoids ~2× qty at open).
  const nameToIsin = buildNameToIsin(positions, operations)
  for (const p of positions) {
    if (p.isin && !isLocalSupportId(p.isin)) {
      for (const key of nameMatchKeys(p.name)) {
        nameToIsin.set(key, p.isin)
      }
    }
  }

  const sortedDesc = [...operations]
    .filter((o) => !o.synthetic)
    .sort(
      (a, b) =>
        (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
        a.id.localeCompare(b.id),
    )

  // Titres-only: do not reverse-walk a cash pile. Opening cash = 0;
  // idle cash today is reportedCash.
  for (const op of sortedDesc) {
    const q = op.quantity
    if (q === undefined || !Number.isFinite(q) || Math.abs(q) < 1e-12) continue
    const isin = resolveOpIsin(op, nameToIsin)
    if (!isin) continue
    const delta = reverseQuantityDelta(op.type, q)
    if (delta === 0) continue
    const cur = qty.get(isin) ?? { name: op.name ?? isin, quantity: 0 }
    cur.quantity += delta
    cur.name = op.name ?? cur.name
    qty.set(isin, cur)
  }

  const openingPositions: VirtualOpeningPosition[] = [...qty.entries()]
    .map(([isin, v]) => {
      // Never seed a short position — absorb reverse-walk inconsistencies.
      const quantity = Math.max(0, Math.round(v.quantity * 1e6) / 1e6)
      return { isin, name: v.name, quantity }
    })
    .filter((p) => p.quantity > 1e-8)
    .sort((a, b) => a.isin.localeCompare(b.isin))

  const dates = operations.map((o) => o.date).sort()
  const openingDate = dates[0] ?? new Date().toISOString().slice(0, 10)
  const reported =
    input.currentCash !== undefined && Number.isFinite(input.currentCash)
      ? Math.round(input.currentCash * 100) / 100
      : undefined

  return {
    envelope,
    date: openingDate,
    cash: 0,
    reportedCash: reported,
    positions: openingPositions,
    computedAt: new Date().toISOString(),
  }
}

/**
 * Resolve op → ISIN for reverse walk. Exact normalized name only —
 * fuzzy `includes` used to attach unrelated titles (and invent shorts).
 */
function resolveOpIsin(
  op: Operation,
  nameToIsin: Map<string, string>,
): string | undefined {
  if (op.isin && !isLocalSupportId(op.isin)) return op.isin
  if (op.name) {
    const direct = lookupIsin(op.name, nameToIsin)
    if (direct) return direct
  }
  // Keep LOCAL key if present so reverse walk stays on that lane
  // (forward replay / ensureHistoricalSupports will align later).
  if (op.isin && isLocalSupportId(op.isin)) return op.isin
  return undefined
}

/** Build POSITION_SEED synthetic operations from a VirtualOpening. */
export function seedsFromVirtualOpening(vo: VirtualOpening): Operation[] {
  const seeds: Operation[] = []
  let i = 0

  for (const p of vo.positions) {
    const fingerprint = operationFingerprint({
      envelope: vo.envelope,
      date: vo.date,
      type: 'POSITION_SEED',
      isin: p.isin,
      quantity: p.quantity,
      label: `SEED ${p.isin}`,
    })
    seeds.push({
      id: makeOperationId(fingerprint, i++),
      fingerprint,
      envelope: vo.envelope,
      date: vo.date,
      type: 'POSITION_SEED',
      isin: p.isin,
      name: p.name,
      quantity: p.quantity,
      label: `Position initiale virtuelle — ${p.name}`,
      synthetic: true,
    })
  }

  const cashFp = operationFingerprint({
    envelope: vo.envelope,
    date: vo.date,
    type: 'POSITION_SEED',
    netAmount: vo.cash,
    label: 'SEED CASH',
  })
  seeds.push({
    id: makeOperationId(cashFp, i++),
    fingerprint: cashFp,
    envelope: vo.envelope,
    date: vo.date,
    type: 'POSITION_SEED',
    netAmount: vo.cash,
    label: 'Espèces initiales virtuelles',
    synthetic: true,
  })

  return seeds
}

