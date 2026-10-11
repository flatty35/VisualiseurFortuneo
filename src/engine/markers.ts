import type { Operation, OperationType } from '@/domain/types'

export type MarkerKind = 'entry' | 'exit' | 'event'

export interface OperationMarker {
  date: string
  seriesId: string // ISIN — only attach to that position series
  kind: MarkerKind
  type: OperationType
  label: string
  quantity?: number
  price?: number
  netAmount?: number
  fees?: number
  /** TTF / taxes folded into this trade (no separate square marker) */
  taxAmount?: number
  taxLabel?: string
  /** Quantity held after this op */
  qtyAfter?: number
  /** Average cost (PRU) after this op, if computable */
  pruAfter?: number
  name?: string
}

function isQtyOp(type: OperationType): boolean {
  return (
    type === 'ACHAT' ||
    type === 'VENTE' ||
    type === 'SCRIPT' ||
    type === 'RACHAT' ||
    type === 'ACTIONS_GRATUITES' ||
    type === 'AUGMENTATION_CAPITAL' ||
    type === 'POSITION_SEED'
  )
}

function isEventOp(type: OperationType): boolean {
  return (
    type === 'DIVIDENDE' ||
    type === 'DETACHEMENT' ||
    type === 'FRAIS' ||
    type === 'SCRIPT' ||
    type === 'AUGMENTATION_CAPITAL' ||
    type === 'OST_OTHER' ||
    type === 'OST_SPLIT' ||
    type === 'OST_FUSION' ||
    type === 'UNKNOWN'
  )
}

function markerKind(type: OperationType): MarkerKind | null {
  // Free shares = buy at 0 € (green entry triangle)
  if (type === 'ACHAT' || type === 'ACTIONS_GRATUITES') return 'entry'
  if (type === 'VENTE' || type === 'RACHAT') return 'exit'
  if (isEventOp(type)) return 'event'
  return null
}

function signedQty(type: OperationType, qty: number): number {
  const q = Math.abs(qty)
  if (
    type === 'ACHAT' ||
    type === 'SCRIPT' ||
    type === 'ACTIONS_GRATUITES' ||
    type === 'AUGMENTATION_CAPITAL' ||
    type === 'POSITION_SEED'
  ) {
    return q
  }
  if (type === 'VENTE' || type === 'RACHAT') return -q
  return 0
}

function taxAbsAmount(op: Operation): number {
  const raw =
    op.netAmount !== undefined
      ? Math.abs(op.netAmount)
      : op.fees !== undefined
        ? Math.abs(op.fees)
        : op.grossAmount !== undefined
          ? Math.abs(op.grossAmount)
          : 0
  return Number.isFinite(raw) ? raw : 0
}

/**
 * Attach TTF/TAXE to the matching buy on the same ISIN (prefer same day),
 * so charts keep a single green triangle instead of a covering gray square.
 */
function attachTaxesToEntries(
  markers: OperationMarker[],
  taxOps: Operation[],
): void {
  for (const tax of taxOps) {
    const isin = tax.isin
    if (!isin) continue
    const amount = taxAbsAmount(tax)
    if (amount <= 0 && !tax.label) continue

    const sameDay = markers.filter(
      (m) =>
        m.seriesId === isin &&
        m.kind === 'entry' &&
        m.type !== 'ACTIONS_GRATUITES' &&
        m.date === tax.date,
    )
    let target =
      sameDay.length > 0 ? sameDay[sameDay.length - 1] : undefined

    if (!target) {
      // Fallback: most recent buy on or before the tax date
      const earlier = markers
        .filter(
          (m) =>
            m.seriesId === isin &&
            m.kind === 'entry' &&
            m.type !== 'ACTIONS_GRATUITES' &&
            m.date <= tax.date,
        )
        .sort((a, b) => a.date.localeCompare(b.date))
      target = earlier[earlier.length - 1]
    }

    if (!target) continue

    target.taxAmount = (target.taxAmount ?? 0) + amount
    if (tax.label) {
      target.taxLabel = target.taxLabel
        ? `${target.taxLabel} · ${tax.label}`
        : tax.label
    }
  }
}

/**
 * Build chart markers per ISIN:
 * - ACHAT → green triangle (entry); TTF/TAXE folded into tooltip
 * - VENTE / RACHAT → red triangle (exit)
 * - dividendes, scripts, OST… → gray square (event)
 * - TAXE alone → no square (attached to corresponding buy)
 */
export function buildOperationMarkers(operations: Operation[]): OperationMarker[] {
  const sorted = [...operations]
    .filter(
      (o) =>
        !o.synthetic &&
        o.isin &&
        (isQtyOp(o.type) || isEventOp(o.type) || o.type === 'TAXE'),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  const state = new Map<string, { qty: number; cost: number }>()
  const markers: OperationMarker[] = []
  const taxOps: Operation[] = []

  for (const op of sorted) {
    if (op.type === 'TAXE') {
      taxOps.push(op)
      continue
    }

    const isin = op.isin!
    const cur = state.get(isin) ?? { qty: 0, cost: 0 }
    const kind = markerKind(op.type)
    if (!kind) continue

    if (isQtyOp(op.type)) {
      const q = op.quantity ?? 0
      const delta = signedQty(op.type, q)
      const px = op.price ?? 0
      const fees = Math.abs(op.fees ?? 0)
      const freeShare = op.type === 'ACTIONS_GRATUITES'

      if (delta > 0) {
        // Free shares = buy at 0 € → cost unchanged, qty up → PRU drops
        const addCost = freeShare ? 0 : delta * px + fees
        cur.cost += addCost
        cur.qty += delta
      } else if (delta < 0) {
        const sellQty = Math.min(cur.qty, -delta)
        if (cur.qty > 1e-12) {
          const fraction = sellQty / cur.qty
          cur.cost *= 1 - fraction
        }
        cur.qty = Math.max(0, cur.qty + delta)
        if (cur.qty < 1e-12) {
          cur.qty = 0
          cur.cost = 0
        }
      }
      state.set(isin, cur)
    }

    const pruAfter = cur.qty > 1e-12 ? cur.cost / cur.qty : undefined
    const freeShare = op.type === 'ACTIONS_GRATUITES'

    markers.push({
      date: op.date,
      seriesId: isin,
      kind,
      type: op.type,
      label: op.label,
      quantity: op.quantity,
      price: freeShare ? 0 : op.price,
      netAmount: freeShare ? 0 : op.netAmount,
      fees: freeShare ? 0 : op.fees,
      qtyAfter: Math.round(cur.qty * 1e6) / 1e6,
      pruAfter:
        pruAfter !== undefined ? Math.round(pruAfter * 10000) / 10000 : undefined,
      name: op.name,
    })
  }

  attachTaxesToEntries(markers, taxOps)
  return prioritizeTradeMarkers(markers)
}

/**
 * Same day + same ISIN: keep buy/sell triangles; drop gray event squares
 * so they do not cover the trade markers.
 */
export function prioritizeTradeMarkers(
  markers: OperationMarker[],
): OperationMarker[] {
  const tradeKeys = new Set(
    markers
      .filter((m) => m.kind === 'entry' || m.kind === 'exit')
      .map((m) => `${m.seriesId}|${m.date}`),
  )
  return markers.filter((m) => {
    if (m.kind !== 'event') return true
    return !tradeKeys.has(`${m.seriesId}|${m.date}`)
  })
}

function kindLabel(m: OperationMarker): string {
  if (m.type === 'ACTIONS_GRATUITES') return '▲ Action gratuite (0 €)'
  if (m.kind === 'entry') {
    return m.taxAmount && m.taxAmount > 0 ? '▲ Achat (+ TTF)' : '▲ Achat'
  }
  if (m.kind === 'exit') return '▼ Vente'
  return `■ ${m.type}`
}

export function formatMarkerTooltipLines(m: OperationMarker): string[] {
  const lines: string[] = [`${kindLabel(m)} — ${m.type}`, `Date : ${m.date}`]
  if (m.name) lines.push(`Titre : ${m.name}`)
  if (m.quantity !== undefined) lines.push(`Quantité : ${m.quantity}`)
  if (m.price !== undefined) {
    lines.push(
      `Cours : ${m.price.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`,
    )
  }
  if (m.netAmount !== undefined) {
    lines.push(
      `Montant net : ${m.netAmount.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`,
    )
  }
  if (m.fees !== undefined && m.fees !== 0) {
    lines.push(
      `Frais : ${m.fees.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`,
    )
  }
  if (m.taxAmount !== undefined && m.taxAmount > 0) {
    lines.push(
      `TTF / taxe : ${m.taxAmount.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`,
    )
  }
  if (m.qtyAfter !== undefined && m.kind !== 'event') {
    lines.push(`Qté après : ${m.qtyAfter}`)
  }
  if (m.pruAfter !== undefined && m.kind !== 'event') {
    lines.push(
      `PRU après : ${m.pruAfter.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`,
    )
  }
  if (m.label) lines.push(m.label)
  if (m.taxLabel && m.taxLabel !== m.label) lines.push(m.taxLabel)
  return lines
}

export function formatMarkerTooltip(m: OperationMarker): string {
  return formatMarkerTooltipLines(m)
    .map((l, i) => (i === 0 ? `<b>${escapeHtml(l)}</b>` : escapeHtml(l)))
    .join('<br/>')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
