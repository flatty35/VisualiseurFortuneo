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
    type === 'TAXE' ||
    type === 'FRAIS' ||
    type === 'SCRIPT' ||
    type === 'ACTIONS_GRATUITES' ||
    type === 'AUGMENTATION_CAPITAL' ||
    type === 'OST_OTHER' ||
    type === 'OST_SPLIT' ||
    type === 'OST_FUSION' ||
    type === 'UNKNOWN'
  )
}

function markerKind(type: OperationType): MarkerKind | null {
  if (type === 'ACHAT') return 'entry'
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

/**
 * Build chart markers per ISIN:
 * - ACHAT → green triangle (entry)
 * - VENTE / RACHAT → red triangle (exit)
 * - dividendes, taxes, scripts, OST… → gray square (event)
 */
export function buildOperationMarkers(operations: Operation[]): OperationMarker[] {
  const sorted = [...operations]
    .filter((o) => !o.synthetic && o.isin && (isQtyOp(o.type) || isEventOp(o.type)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  const state = new Map<string, { qty: number; cost: number }>()
  const markers: OperationMarker[] = []

  for (const op of sorted) {
    const isin = op.isin!
    const cur = state.get(isin) ?? { qty: 0, cost: 0 }
    const kind = markerKind(op.type)
    if (!kind) continue

    if (isQtyOp(op.type)) {
      const q = op.quantity ?? 0
      const delta = signedQty(op.type, q)
      const px = op.price ?? 0
      const fees = Math.abs(op.fees ?? 0)

      if (delta > 0) {
        const addCost = op.type === 'ACTIONS_GRATUITES' ? 0 : delta * px + fees
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

    markers.push({
      date: op.date,
      seriesId: isin,
      kind,
      type: op.type,
      label: op.label,
      quantity: op.quantity,
      price: op.price,
      netAmount: op.netAmount,
      fees: op.fees,
      qtyAfter: Math.round(cur.qty * 1e6) / 1e6,
      pruAfter:
        pruAfter !== undefined ? Math.round(pruAfter * 10000) / 10000 : undefined,
      name: op.name,
    })
  }

  return markers
}

function kindLabel(m: OperationMarker): string {
  if (m.kind === 'entry') return '▲ Achat'
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
  if (m.qtyAfter !== undefined && m.kind !== 'event') {
    lines.push(`Qté après : ${m.qtyAfter}`)
  }
  if (m.pruAfter !== undefined && m.kind !== 'event') {
    lines.push(
      `PRU après : ${m.pruAfter.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`,
    )
  }
  if (m.label) lines.push(m.label)
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
