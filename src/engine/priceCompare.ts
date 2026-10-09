import type { Operation, QuoteBar, Support } from '@/domain/types'
import type { HoldingsSnapshot } from './positions'
import type { ChartSeries } from '@/ui/components/PortfolioChart'

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

function closeOnOrBefore(
  date: string,
  bars: QuoteBar[] | undefined,
): number | undefined {
  if (!bars?.length) return undefined
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date))
  let best: number | undefined
  for (const b of sorted) {
    if (b.date <= date) best = b.close
    else break
  }
  return best
}

function priceOnDate(
  date: string,
  support: Support | undefined,
  quotes: Map<string, QuoteBar[]>,
): number | undefined {
  if (!support) return undefined
  if (support.yahooTicker) {
    const px = closeOnOrBefore(date, quotes.get(support.yahooTicker))
    if (px !== undefined) return px
  }
  const manual = support.manualPrices
    ?.filter((p) => p.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  if (manual) return manual.price
  return support.staticPrice
}

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
 * Price comparison in base 100 at first buy.
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

    // Points from first buy (base 100); shared axisDates pads earlier period days with null.
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
        value: (px / basePx) * 100,
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
        showInLegend: segIdx === 0,
        connectGroup: isin,
      })
    })
  })

  return out
}
