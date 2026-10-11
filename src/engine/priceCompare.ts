import type { Operation, OperationType, QuoteBar, Support } from '@/domain/types'
import type { HoldingsSnapshot } from './positions'
import type { ChartSeries } from '@/ui/components/PortfolioChart'
import { priceOnDate } from './valuation'

const PALETTE = [
  '#7dcea0',
  '#c4a35a',
  '#6eb5ff',
  '#e07a5f',
  '#b39ddb',
  '#4db6ac',
  '#ffb74d',
  '#90a4ae',
]

/** First real purchase date, else POSITION_SEED. */
export function firstBuyDate(operations: Operation[], isin: string): string | undefined {
  const real = operations
    .filter(
      (o) =>
        o.isin === isin &&
        !o.synthetic &&
        (o.type === 'ACHAT' || o.type === 'SCRIPT' || o.type === 'AUGMENTATION_CAPITAL'),
    )
    .map((o) => o.date)
    .sort()
  if (real[0]) return real[0]
  const seed = operations
    .filter((o) => o.isin === isin && o.type === 'POSITION_SEED')
    .map((o) => o.date)
    .sort()
  return seed[0]
}

export interface PriceCompareInput {
  isins: string[]
  names: Record<string, string>
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  operations: Operation[]
  holdings: HoldingsSnapshot[]
  from: string
  to: string
}

type Pt = {
  date: string
  value: number
  held: boolean
  price?: number
  valuation?: number
}

/**
 * Split points into solid (held) / dashed (flat) segments.
 * Consecutive segments share the boundary point so the polyline connects.
 */
export function splitHeldSegments(points: Pt[]): { held: boolean; points: Pt[] }[] {
  if (!points.length) return []
  const segments: { held: boolean; points: Pt[] }[] = []
  let i = 0
  while (i < points.length) {
    const held = points[i].held
    let j = i + 1
    while (j < points.length && points[j].held === held) j++
    // [i .. j-1]
    const slice = points.slice(i, j)
    if (segments.length > 0) {
      // Prepend previous segment's last point for continuity
      const prevLast = segments[segments.length - 1].points.at(-1)!
      segments.push({ held, points: [prevLast, ...slice] })
    } else {
      segments.push({ held, points: slice })
    }
    i = j
  }
  return segments
}

/**
 * Price comparison in % vs first buy (0 % at first purchase).
 * Solid while net qty > 0, dashed while flat — segments join at boundaries.
 */
export function buildPriceCompareSeries(input: PriceCompareInput): ChartSeries[] {
  const { holdings, from, to } = input
  const days = holdings.map((h) => h.date).filter((d) => d >= from && d <= to)
  if (!days.length) return []

  const qtyByDay = new Map<string, Map<string, number>>()
  for (const h of holdings) {
    if (h.date < from || h.date > to) continue
    qtyByDay.set(h.date, h.quantities)
  }

  const out: ChartSeries[] = []

  input.isins.forEach((isin, colorIdx) => {
    const support = input.supports.find((s) => s.isin === isin)
    const name = input.names[isin] ?? support?.name ?? isin
    const buyDate = firstBuyDate(input.operations, isin)
    if (!buyDate) return

    const basePx =
      priceOnDate(buyDate, support, input.quotes) ??
      input.operations.find(
        (o) =>
          o.isin === isin &&
          o.price &&
          (o.type === 'ACHAT' || o.type === 'SCRIPT'),
      )?.price
    if (!basePx || basePx === 0) return

    // Points from first buy (0 %); shared axisDates pads earlier period days with null.
    const start = buyDate > from ? buyDate : from
    const points: Pt[] = []
    for (const day of days) {
      if (day < start) continue
      const px = priceOnDate(day, support, input.quotes)
      if (px === undefined) continue
      const qty = qtyByDay.get(day)?.get(isin) ?? 0
      const held = Math.abs(qty) > 1e-8
      points.push({
        date: day,
        value: (px / basePx - 1) * 100,
        held,
        price: px,
        valuation: held ? qty * px : 0,
      })
    }
    if (points.length < 1) return

    const color = PALETTE[colorIdx % PALETTE.length]
    const segments = splitHeldSegments(points)
    segments.forEach((seg, segIdx) => {
      if (seg.points.length < 1) return
      out.push({
        id: `${isin}-seg${segIdx}`,
        name,
        dates: seg.points.map((p) => p.date),
        values: seg.points.map((p) => p.value),
        realPrices: seg.points.map((p) => p.price ?? 0),
        valuations: seg.points.map((p) => p.valuation ?? 0),
        dashed: !seg.held,
        color,
        valueUnit: 'pct',
        showInLegend: segIdx === 0,
        connectGroup: isin,
      })
    })
  })

  return out
}

function isPruQtyOp(type: OperationType): boolean {
  return (
    type === 'ACHAT' ||
    type === 'VENTE' ||
    type === 'SCRIPT' ||
    type === 'RACHAT' ||
    type === 'ACTIONS_GRATUITES' ||
    type === 'AUGMENTATION_CAPITAL'
  )
}

function signedPruQty(type: OperationType, qty: number): number {
  const q = Math.abs(qty)
  if (
    type === 'ACHAT' ||
    type === 'SCRIPT' ||
    type === 'ACTIONS_GRATUITES' ||
    type === 'AUGMENTATION_CAPITAL'
  ) {
    return q
  }
  if (type === 'VENTE' || type === 'RACHAT') return -q
  return 0
}

/**
 * Running average cost (PRU) after each buy/sell, as a step series.
 * Values are % vs first-buy price (same scale as the cours curve); `realPrices`
 * holds the PRU in € for the tooltip. Only meaningful for a single ISIN.
 */
export function buildPruStepSeries(input: {
  isin: string
  operations: Operation[]
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  days: string[]
  from: string
  to: string
}): ChartSeries | null {
  const { isin, days, from, to } = input
  if (!days.length) return null

  const buyDate = firstBuyDate(input.operations, isin)
  if (!buyDate) return null
  const support = input.supports.find((s) => s.isin === isin)
  const basePx =
    priceOnDate(buyDate, support, input.quotes) ??
    input.operations.find(
      (o) =>
        o.isin === isin &&
        o.price &&
        (o.type === 'ACHAT' || o.type === 'SCRIPT'),
    )?.price
  if (!basePx || basePx === 0) return null

  const ops = input.operations
    .filter(
      (o) =>
        o.isin === isin &&
        !o.synthetic &&
        o.quantity !== undefined &&
        isPruQtyOp(o.type),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  // PRU after each trade day (last op of the day wins).
  const pruByDay = new Map<string, number | null>()
  let qty = 0
  let cost = 0
  for (const op of ops) {
    const delta = signedPruQty(op.type, op.quantity ?? 0)
    const px = op.price ?? 0
    const fees = Math.abs(op.fees ?? 0)
    const freeShare = op.type === 'ACTIONS_GRATUITES'
    if (delta > 0) {
      cost += freeShare ? 0 : delta * px + fees
      qty += delta
    } else if (delta < 0) {
      const sellQty = Math.min(qty, -delta)
      if (qty > 1e-12) cost *= 1 - sellQty / qty
      qty = Math.max(0, qty + delta)
      if (qty < 1e-12) {
        qty = 0
        cost = 0
      }
    }
    pruByDay.set(op.date, qty > 1e-12 ? cost / qty : null)
  }

  const dates: string[] = []
  const values: Array<number | null> = []
  const realPrices: number[] = []
  let current: number | null = null

  // Seed PRU from trades before the visible window.
  for (const [day, pru] of [...pruByDay.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (day >= from) break
    current = pru
  }

  for (const day of days) {
    if (day < from || day > to) continue
    if (day < buyDate) continue
    if (pruByDay.has(day)) current = pruByDay.get(day) ?? null
    dates.push(day)
    if (current != null && current > 0) {
      values.push((current / basePx - 1) * 100)
      realPrices.push(Math.round(current * 10000) / 10000)
    } else {
      values.push(null)
      realPrices.push(0)
    }
  }

  if (!dates.some((_, i) => values[i] != null)) return null

  return {
    id: `${isin}-pru`,
    name: 'PRU',
    dates,
    values,
    realPrices,
    color: '#c4a35a',
    dashed: false,
    step: 'end',
    valueUnit: 'pct',
    showInLegend: true,
  }
}
