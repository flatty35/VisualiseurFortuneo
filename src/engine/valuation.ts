import type { Operation, QuoteBar, Support } from '@/domain/types'
import { toBusinessDay } from './businessDays'
import type { HoldingsSnapshot } from './positions'

export interface ValuePoint {
  date: string
  securities: number
  cash: number
  total: number
  byIsin: Record<string, number>
}

/** Max calendar days to forward-fill before the first Yahoo bar (weekends / late feed). */
const FORWARD_FILL_MAX_DAYS = 14

/**
 * Reject Yahoo closes that are absurd vs the broker NAV / static price
 * (e.g. wrong ticker → 772 € while Fortuneo VL is ~97 €).
 */
const YAHOO_VS_STATIC_MAX_RATIO = 3

function calendarDaysBetween(a: string, b: string): number {
  const ms =
    Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY
  return Math.round(ms / 86_400_000)
}

/** Last strictly positive trade/static price (ignore 0€ worthless exits). */
function anchorPrice(support: Support, onOrBefore?: string): number | undefined {
  const manuals = support.manualPrices
  if (manuals?.length) {
    const positive = manuals
      .filter(
        (p) =>
          p.price > 0 &&
          (onOrBefore === undefined || p.date <= onOrBefore),
      )
      .sort((a, b) => b.date.localeCompare(a.date))
    if (positive[0]) return positive[0].price
    // No trade yet on/before date — allow a later seed as soft anchor
    if (onOrBefore !== undefined) {
      const later = manuals
        .filter((p) => p.price > 0 && p.date > onOrBefore)
        .sort((a, b) => a.date.localeCompare(b.date))
      if (later[0]) return later[0].price
    }
  }
  if (support.staticPrice !== undefined && support.staticPrice > 0) {
    return support.staticPrice
  }
  return undefined
}

function yahooBelievable(
  yahooPx: number,
  support: Support,
  onDate?: string,
): boolean {
  const anchor = anchorPrice(support, onDate)
  if (anchor === undefined || !(anchor > 0) || !(yahooPx > 0)) return true
  const ratio = yahooPx / anchor
  return (
    ratio <= YAHOO_VS_STATIC_MAX_RATIO &&
    ratio >= 1 / YAHOO_VS_STATIC_MAX_RATIO
  )
}

/** Name heuristic when `tradeQuotesOnly` was not persisted (older imports). */
export function looksLikeDerivativeName(name: string | undefined): boolean {
  if (!name) return false
  // "8 P" / "171.95 C" = Saxo option/turbo style; TurboXL / Warrant / Put…
  return /turbo|warrant|knock.?out|\bputs?\b|\bcalls?\b|certificat|\boption\b|\b\d+(?:\.\d+)?\s*[PC]\b|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*20\d{2}/i.test(
    name,
  )
}

/**
 * Quote-cache key of a support: its Yahoo ticker, else its real ISIN
 * (Morningstar history needs no ticker — e.g. OPCVM absent from Yahoo).
 * Derivatives never use the market feed (underlying × contract size ≠ premium).
 */
export function quoteKeyForSupport(
  support: Pick<
    Support,
    'isin' | 'name' | 'yahooTicker' | 'tradeQuotesOnly'
  >,
): string | undefined {
  if (support.tradeQuotesOnly || looksLikeDerivativeName(support.name)) {
    return undefined
  }
  if (support.yahooTicker) return support.yahooTicker
  const isin = support.isin.trim().toUpperCase()
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin) ? isin : undefined
}

/**
 * Market / manual / static price for a support on a calendar day.
 * Forward-fills at most {@link FORWARD_FILL_MAX_DAYS} before the first bar
 * (weekend / late listing). A single spot bar must NOT paint the whole history.
 */
export function priceOnDate(
  date: string,
  support: Support | undefined,
  quotes: Map<string, QuoteBar[]>,
): number | undefined {
  if (!support) return undefined

  // 1) Market history — preferred when believable vs broker NAV
  const ticker = quoteKeyForSupport(support)
  if (ticker) {
    const bars = quotes.get(ticker)
    if (bars?.length) {
      let lo = 0
      let hi = bars.length - 1
      let bestBefore: number | undefined
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (bars[mid].date <= date) {
          bestBefore = bars[mid].close
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      if (bestBefore !== undefined && yahooBelievable(bestBefore, support, date)) {
        return bestBefore
      }
      // Short forward-fill only — not years of a lone "last price" bar
      const first = bars[0]
      if (
        first &&
        first.date >= date &&
        calendarDaysBetween(date, first.date) <= FORWARD_FILL_MAX_DAYS &&
        yahooBelievable(first.close, support, date)
      ) {
        return first.close
      }
    }
  }

  // 2) Manual dated override (on/before, else first on/after)
  const manuals = support.manualPrices
  if (manuals?.length) {
    const before = manuals
      .filter((p) => p.date <= date)
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    if (before) return before.price
    const after = [...manuals]
      .filter((p) => p.date >= date)
      .sort((a, b) => a.date.localeCompare(b.date))[0]
    if (after) return after.price
  }

  // 3) Constant import/PRU fallback (flat series if used alone)
  return support.staticPrice
}

function labelHasAmortissement(label: string | undefined): boolean {
  if (!label) return false
  return label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .includes('amortissement')
}


/**
 * Average unit cost per ISIN after each business day (from titres ops).
 * Used when Yahoo/manual/static prices are missing so cash→titres does not
 * erase portfolio value (which inflated TRI when start value ≪ reality).
 */
export function buildAverageUnitCostByDate(
  operations: Operation[],
  dates: string[],
): Map<string, Map<string, number>> {
  type Book = { qty: number; cost: number }
  const book = new Map<string, Book>()
  const ops = [...operations]
    .filter(
      (o) =>
        o.isin &&
        (o.type === 'ACHAT' ||
          o.type === 'VENTE' ||
          o.type === 'SCRIPT' ||
          o.type === 'RACHAT' ||
          o.type === 'ACTIONS_GRATUITES' ||
          o.type === 'AUGMENTATION_CAPITAL' ||
          (o.type === 'POSITION_SEED' && !o.synthetic) ||
          // Coupon d'amortissement: capital return (qty unchanged, cost ↓)
          ((o.type === 'DIVIDENDE' || o.type === 'DETACHEMENT') &&
            labelHasAmortissement(o.label))),
    )
    .filter(
      (o) =>
        o.quantity !== undefined ||
        ((o.type === 'DIVIDENDE' || o.type === 'DETACHEMENT') &&
          labelHasAmortissement(o.label)),
    )
    .map((o) => ({ op: o, day: toBusinessDay(o.date) }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) || a.op.id.localeCompare(b.op.id),
    )

  let oi = 0
  const out = new Map<string, Map<string, number>>()

  const unitCosts = (): Map<string, number> => {
    const m = new Map<string, number>()
    for (const [isin, b] of book) {
      if (Math.abs(b.qty) > 1e-8) m.set(isin, b.cost / b.qty)
    }
    return m
  }

  for (const date of dates) {
    while (oi < ops.length && ops[oi].day <= date) {
      const o = ops[oi].op
      const isin = o.isin!
      const cur = book.get(isin) ?? { qty: 0, cost: 0 }

      if (
        (o.type === 'DIVIDENDE' || o.type === 'DETACHEMENT') &&
        labelHasAmortissement(o.label)
      ) {
        // Remise de capital: Fortuneo baisse le PRU, la quantité de parts reste.
        const returned = Math.abs(o.netAmount ?? o.grossAmount ?? 0)
        if (returned > 1e-9 && cur.cost > 0) {
          cur.cost = Math.max(0, cur.cost - returned)
        }
        book.set(isin, cur)
        oi += 1
        continue
      }

      const q = Math.abs(o.quantity ?? 0)
      const px =
        o.price ??
        (o.netAmount !== undefined && q > 0
          ? Math.abs(o.netAmount) / q
          : undefined)
      if (o.type === 'ACTIONS_GRATUITES') {
        // Buy at 0 € — dilutes PRU, no cash outlay
        cur.qty += q
      } else if (
        o.type === 'ACHAT' ||
        o.type === 'SCRIPT' ||
        o.type === 'AUGMENTATION_CAPITAL'
      ) {
        const addCost = px !== undefined ? q * px : 0
        cur.qty += q
        cur.cost += addCost
      } else if (o.type === 'VENTE' || o.type === 'RACHAT') {
        if (cur.qty > 1e-8) {
          const frac = Math.min(1, q / cur.qty)
          cur.cost *= 1 - frac
          cur.qty -= q
          if (cur.qty < 1e-8) {
            cur.qty = 0
            cur.cost = 0
          }
        }
      }
      book.set(isin, cur)
      oi += 1
    }
    out.set(date, unitCosts())
  }
  return out
}

/**
 * Latest FX (account per 1 instrument unit) on/before date, per ISIN.
 * Built from operation.fxRate (Saxo « Taux de change »).
 */
export function buildFxRateByDate(
  operations: Operation[],
  dates: string[],
): Map<string, Map<string, number>> {
  const events = operations
    .filter(
      (o) =>
        o.isin &&
        o.fxRate !== undefined &&
        Number.isFinite(o.fxRate) &&
        o.fxRate > 0,
    )
    .map((o) => ({
      isin: o.isin!,
      day: toBusinessDay(o.date),
      fx: o.fxRate!,
    }))
    .sort((a, b) => a.day.localeCompare(b.day))

  const last = new Map<string, number>()
  let ei = 0
  const out = new Map<string, Map<string, number>>()
  for (const date of dates) {
    while (ei < events.length && events[ei].day <= date) {
      last.set(events[ei].isin, events[ei].fx)
      ei += 1
    }
    out.set(date, new Map(last))
  }
  return out
}

/** Last account-per-instrument FX rate seen on or before `date` for an ISIN. */
export function lastFxRate(
  operations: Operation[],
  isin: string,
  date: string,
): number | undefined {
  let best: { date: string; fx: number } | undefined
  for (const o of operations) {
    if (o.isin !== isin || o.date > date) continue
    if (o.fxRate === undefined || !(o.fxRate > 0)) continue
    if (!best || o.date >= best.date) best = { date: o.date, fx: o.fxRate }
  }
  return best?.fx
}

function isEuroCurrency(c: string | undefined): boolean {
  if (!c) return true
  const u = c.toUpperCase()
  return u === 'EUR' || u === '€'
}

export function valueHoldingsSeries(input: {
  holdings: HoldingsSnapshot[]
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  isinFilter?: string[]
  /** Optional: average cost fallback when no market price */
  operations?: Operation[]
}): ValuePoint[] {
  const supportByIsin = new Map(input.supports.map((s) => [s.isin, s]))
  const filter = input.isinFilter ? new Set(input.isinFilter) : null
  const dates = input.holdings.map((h) => h.date)
  const costByDate =
    input.operations && input.operations.length > 0
      ? buildAverageUnitCostByDate(input.operations, dates)
      : null
  const fxByDate =
    input.operations && input.operations.length > 0
      ? buildFxRateByDate(input.operations, dates)
      : null

  return input.holdings.map((h) => {
    let securities = 0
    const byIsin: Record<string, number> = {}
    const costs = costByDate?.get(h.date)
    const fxMap = fxByDate?.get(h.date)
    for (const [isin, qty] of h.quantities) {
      if (filter && !filter.has(isin)) continue
      if (Math.abs(qty) < 1e-10) continue
      const support = supportByIsin.get(isin)
      const px =
        priceOnDate(h.date, support, input.quotes) ?? costs?.get(isin)
      // Native quote currency (USD curve stays in USD for per-line charts)
      const native = px !== undefined ? qty * px : 0
      byIsin[isin] = native
      if (isEuroCurrency(support?.quoteCurrency)) {
        securities += native
      } else {
        const fx = fxMap?.get(isin)
        securities += fx !== undefined ? native * fx : native
      }
    }
    const cash = filter ? 0 : h.cash
    return {
      date: h.date,
      securities,
      cash,
      total: securities + cash,
      byIsin,
    }
  })
}

/** Normalize series to base 100 at first non-zero / first point. */
export function toBase100(values: number[]): number[] {
  const base = values.find((v) => v !== 0 && Number.isFinite(v))
  if (base === undefined || base === 0) return values.map(() => 100)
  return values.map((v) => (v / base) * 100)
}

/**
 * Chart values for a position: no line before first open, drop to 0 on close,
 * then stay blank (null) while flat — reconnects if the position reopens.
 */
export function clipInactivePositionValues(
  values: number[],
  held: boolean[],
): Array<number | null> {
  const n = Math.min(values.length, held.length)
  const out: Array<number | null> = Array(values.length).fill(null)
  let everHeld = false
  /** True after emitting the closing zero of a flat stretch. */
  let afterCloseZero = false

  for (let i = 0; i < n; i++) {
    if (held[i]) {
      everHeld = true
      afterCloseZero = false
      out[i] = values[i]
    } else if (everHeld && !afterCloseZero) {
      out[i] = 0
      afterCloseZero = true
    }
  }
  return out
}

/**
 * Sum several valued series on a shared calendar (forward-fill each series).
 */
export function mergeValuedSeries(seriesList: ValuePoint[][]): ValuePoint[] {
  const lists = seriesList.filter((s) => s.length > 0)
  if (!lists.length) return []
  if (lists.length === 1) return lists[0]

  const dateSet = new Set<string>()
  for (const series of lists) for (const v of series) dateSet.add(v.date)
  const dates = [...dateSet].sort()

  const cursors = lists.map(() => 0)
  const last: Array<ValuePoint | null> = lists.map(() => null)
  const out: ValuePoint[] = []

  for (const date of dates) {
    let securities = 0
    let cash = 0
    const byIsin: Record<string, number> = {}
    for (let i = 0; i < lists.length; i++) {
      const series = lists[i]
      while (
        cursors[i] < series.length &&
        series[cursors[i]].date <= date
      ) {
        last[i] = series[cursors[i]]
        cursors[i] += 1
      }
      const v = last[i]
      if (!v) continue
      securities += v.securities
      cash += v.cash
      for (const [isin, val] of Object.entries(v.byIsin)) {
        byIsin[isin] = (byIsin[isin] ?? 0) + val
      }
    }
    out.push({
      date,
      securities,
      cash,
      total: securities + cash,
      byIsin,
    })
  }
  return out
}

export function sliceByPeriod(
  dates: string[],
  period: '1M' | '3M' | '1Y' | '2Y',
): { from: string; to: string } {
  if (!dates.length) {
    const today = new Date().toISOString().slice(0, 10)
    return { from: today, to: today }
  }
  const to = dates[dates.length - 1]

  const end = new Date(to + 'T00:00:00Z')
  const start = new Date(end)
  switch (period) {
    case '1M':
      start.setUTCMonth(start.getUTCMonth() - 1)
      break
    case '3M':
      start.setUTCMonth(start.getUTCMonth() - 3)
      break
    case '1Y':
      start.setUTCFullYear(start.getUTCFullYear() - 1)
      break
    case '2Y':
      start.setUTCFullYear(start.getUTCFullYear() - 2)
      break
  }
  const from = start.toISOString().slice(0, 10)
  return { from: from < dates[0] ? dates[0] : from, to }
}
