import type {
  EnvelopeType,
  Operation,
  QuoteBar,
  Support,
  VirtualOpening,
} from '@/domain/types'
import { toBusinessDay } from './businessDays'
import { isBuyTrade, isSellTrade, tradeCashAmount } from './cashImpact'
import { buildHoldingsSeries } from './positions'
import { priceOnDate, valueHoldingsSeries } from './valuation'

export interface CashFlow {
  date: string
  amount: number // negative = investment, positive = withdrawal
  label: string
}

export interface CalendarYearTri {
  year: number
  from: string
  to: string
  irr: number | null
  startValue: number
  endValue: number
}

/** Rate bracket scanned when Newton fails (−99.99 % … +10 000 %/an). */
const IRR_BRACKET = [-0.9999, -0.99, -0.9, -0.5, -0.2, 0, 0.2, 0.5, 1, 3, 10, 100]

/**
 * XIRR (Excel convention: actual/365). Newton–Raphson from `guess`, then
 * bisection on the first sign change of NPV when Newton diverges.
 * Cash flows: negative = money in, positive = money out.
 */
export function computeIrr(flows: CashFlow[], guess = 0.05): number | null {
  const live = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0)
  if (live.length < 2) return null
  if (!live.some((f) => f.amount < 0) || !live.some((f) => f.amount > 0)) {
    return null
  }
  const t0 = Math.min(...live.map((f) => Date.parse(`${f.date}T00:00:00Z`)))
  const pts = live.map((f) => ({
    years: (Date.parse(`${f.date}T00:00:00Z`) - t0) / (365 * 86400000),
    amount: f.amount,
  }))
  const scale = Math.max(...pts.map((p) => Math.abs(p.amount)))

  const npv = (r: number) =>
    pts.reduce((acc, p) => acc + p.amount / Math.pow(1 + r, p.years), 0)
  const dNpv = (r: number) =>
    pts.reduce(
      (acc, p) => acc - (p.years * p.amount) / Math.pow(1 + r, p.years + 1),
      0,
    )
  const solved = (r: number) =>
    Number.isFinite(r) && r > -1 && Math.abs(npv(r)) < 1e-7 * scale

  let rate = guess
  for (let i = 0; i < 60; i++) {
    const dy = dNpv(rate)
    if (!Number.isFinite(dy) || Math.abs(dy) < 1e-12) break
    const next = rate - npv(rate) / dy
    if (!Number.isFinite(next) || next <= -1) break
    if (Math.abs(next - rate) < 1e-10) {
      rate = next
      break
    }
    rate = next
  }
  if (solved(rate)) return rate

  for (let i = 0; i < IRR_BRACKET.length - 1; i++) {
    let lo = IRR_BRACKET[i]
    let hi = IRR_BRACKET[i + 1]
    let fLo = npv(lo)
    if (Math.sign(fLo) === Math.sign(npv(hi))) continue
    for (let k = 0; k < 200 && hi - lo > 1e-12; k++) {
      const mid = (lo + hi) / 2
      const fMid = npv(mid)
      if (Math.sign(fMid) === Math.sign(fLo)) {
        lo = mid
        fLo = fMid
      } else {
        hi = mid
      }
    }
    return (lo + hi) / 2
  }
  return null
}

function priceAt(
  date: string,
  isin: string,
  supports: Support[],
  quotes: Map<string, QuoteBar[]>,
): number {
  return (
    priceOnDate(
      date,
      supports.find((x) => x.isin === isin),
      quotes,
    ) ?? 0
  )
}

function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/**
 * External capital for TRI (money crossing the titres boundary).
 * Titres-only: each achat is an apport (cash arrives then is invested);
 * each vente is a retrait (proceeds leave — no cumulative cash pocket).
 * Encaissements (DIVIDENDE, incl. coupon d'amortissement) leave the titres
 * too; TTF / frais on a title are extra money in (not inside the buy's
 * Montant net). DETACHEMENT duplicates the Encaissement and is ignored.
 */
export function externalCashFlowDirection(
  op: Operation,
): 'in' | 'out' | null {
  if (op.synthetic || !op.isin) return null
  if (isBuyTrade(op.type)) return 'in'
  if (isSellTrade(op.type)) return 'out'
  if (op.type === 'DIVIDENDE' || op.type === 'TAXE' || op.type === 'FRAIS') {
    const net = op.netAmount ?? 0
    if (net > 1e-9) return 'out'
    if (net < -1e-9) return 'in'
  }
  return null
}

/** TRI flow of one operation (sign convention: in = negative). */
function operationFlow(
  op: Operation,
  fallbackPrice?: (op: Operation) => number | undefined,
): CashFlow | null {
  const dir = externalCashFlowDirection(op)
  if (!dir) return null
  let abs = Math.abs(tradeCashAmount(op))
  if (abs < 1e-9 && fallbackPrice && op.quantity) {
    const px = fallbackPrice(op)
    if (px !== undefined && Number.isFinite(px) && px > 0) {
      abs = Math.abs(op.quantity) * px
    }
  }
  if (abs < 1e-9) return null
  return {
    date: toBusinessDay(op.date),
    amount: dir === 'in' ? -abs : abs,
    label: op.label || (dir === 'in' ? 'Apport' : 'Retrait'),
  }
}

function byDateThenLabel(a: CashFlow, b: CashFlow): number {
  return a.date.localeCompare(b.date) || a.label.localeCompare(b.label)
}

/**
 * TRI on [t0, t1]:
 * - synthetic buy of portfolio at first snapshot
 * - each achat (−) / vente (+) after that date through t1
 * - synthetic sell at last snapshot
 *
 * Snapshot values are end-of-day, so external flows on the start day are
 * already inside startValue and must not be counted again.
 */
export function computePortfolioTri(input: {
  envelope: 'PEA' | 'PEA_PME' | 'CTO'
  operations: Operation[]
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  t0: string
  t1: string
  isin?: string
  virtualOpening?: VirtualOpening | null
}): { irr: number | null; flows: CashFlow[]; startValue: number; endValue: number } {
  const holdings = buildHoldingsSeries({
    envelope: input.envelope,
    operations: input.operations,
    virtualOpening: input.virtualOpening,
    from: input.t0,
    to: input.t1,
  })

  const valued = valueHoldingsSeries({
    holdings,
    supports: input.supports,
    quotes: input.quotes,
    isinFilter: input.isin ? [input.isin] : undefined,
    operations: input.operations,
  })

  if (!valued.length) {
    return { irr: null, flows: [], startValue: 0, endValue: 0 }
  }

  const start = valued[0]
  const end = valued[valued.length - 1]
  const startDate = start.date
  const endDate = end.date
  const startValue = input.isin
    ? (start.byIsin[input.isin] ?? 0)
    : start.total
  const endValue = input.isin ? (end.byIsin[input.isin] ?? 0) : end.total

  const flows: CashFlow[] = [
    {
      date: startDate,
      amount: -startValue,
      label: input.isin
        ? `Achat synthétique ${input.isin}`
        : 'Achat synthétique portefeuille',
    },
  ]

  if (!input.isin) {
    flows.push(
      ...listEnvelopeExternalFlows({
        operations: input.operations,
        envelope: input.envelope,
        from: startDate,
        to: endDate,
        includeStartDay: false,
      }),
    )
  } else {
    flows.push(
      ...listPositionTradeFlows({
        operations: input.operations,
        envelope: input.envelope,
        isin: input.isin,
        supports: input.supports,
        quotes: input.quotes,
        from: startDate,
        to: endDate,
      }),
    )
  }

  flows.push({
    date: endDate,
    amount: endValue,
    label: input.isin
      ? `Revente synthétique ${input.isin}`
      : 'Revente synthétique portefeuille',
  })

  return {
    irr: computeIrr(flows),
    flows,
    startValue,
    endValue,
  }
}

/** Mid-period external capital (excludes synthetic buy/sell). */
export function isExternalTriFlow(flow: CashFlow): boolean {
  const lib = normalizeLabel(flow.label)
  return !lib.includes('synthetique')
}

/**
 * Net money contributed by the investor over the TRI window:
 * apports positive, retraits negative (TRI flow amounts are inverted).
 * Only mid-period flows (excludes synthetic buy/sell).
 */
export function netExternalContribution(flows: CashFlow[]): {
  net: number
  apports: number
  retraits: number
  count: number
} {
  let apports = 0
  let retraits = 0
  let count = 0
  for (const f of flows) {
    if (!isExternalTriFlow(f)) continue
    count += 1
    if (f.amount < 0) apports += -f.amount
    else if (f.amount > 0) retraits += f.amount
  }
  return { net: apports - retraits, apports, retraits, count }
}

/**
 * List achat/vente titres for one envelope on [from, to].
 * Amounts use TRI sign convention (in = negative).
 */
export function listEnvelopeExternalFlows(input: {
  operations: Operation[]
  envelope: EnvelopeType
  from: string
  to: string
  /** When true (default), include flows on `from` — for KPI sums. */
  includeStartDay?: boolean
}): CashFlow[] {
  const from = toBusinessDay(input.from)
  const to = toBusinessDay(input.to)
  const includeStart = input.includeStartDay !== false
  const out: CashFlow[] = []
  for (const op of input.operations) {
    if (op.envelope !== input.envelope) continue
    const flow = operationFlow(op)
    if (!flow || flow.date < from || flow.date > to) continue
    if (!includeStart && flow.date <= from) continue
    out.push(flow)
  }
  return out.sort(byDateThenLabel)
}

/**
 * Sum achat/vente titres for one envelope on [from, to] (inclusive).
 */
export function sumEnvelopeExternalFlows(input: {
  operations: Operation[]
  envelope: EnvelopeType
  from: string
  to: string
}): { net: number; apports: number; retraits: number; count: number } {
  const flows = listEnvelopeExternalFlows({ ...input, includeStartDay: true })
  return netExternalContribution(flows)
}

/**
 * Mid-period flows for one position, same definition as the envelope TRI
 * (Montant net incl. courtage, dividendes, TTF). Start day excluded.
 * Market price × qty only when the operation carries no amount.
 */
export function listPositionTradeFlows(input: {
  operations: Operation[]
  envelope?: EnvelopeType
  isin: string
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  from: string
  to: string
}): CashFlow[] {
  const from = toBusinessDay(input.from)
  const to = toBusinessDay(input.to)
  const marketPrice = (op: Operation) =>
    priceAt(op.date, input.isin, input.supports, input.quotes)
  const out: CashFlow[] = []
  for (const op of input.operations) {
    if (op.isin !== input.isin) continue
    if (input.envelope && op.envelope !== input.envelope) continue
    const flow = operationFlow(op, marketPrice)
    if (!flow || flow.date <= from || flow.date > to) continue
    out.push(flow)
  }
  return out.sort(byDateThenLabel)
}

/** Last calendar day of YYYY-MM (UTC). */
export function lastCivilDayOfMonth(year: number, monthIndex0: number): string {
  // day 0 of next month = last day of this month
  const d = new Date(Date.UTC(year, monthIndex0 + 1, 0))
  return d.toISOString().slice(0, 10)
}

/**
 * Valuation sample dates for monthly TRI: last available valued day on or
 * before each civil month-end in [from, to], plus `to` if missing.
 */
export function monthEndDates(
  from: string,
  to: string,
  availableDates: string[],
): string[] {
  const dates = [...availableDates].filter((d) => d >= from && d <= to).sort()
  if (!dates.length) return []

  const byDay = new Set(dates)
  const out: string[] = []
  const seen = new Set<string>()

  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  let y = start.getUTCFullYear()
  let m = start.getUTCMonth()

  while (
    y < end.getUTCFullYear() ||
    (y === end.getUTCFullYear() && m <= end.getUTCMonth())
  ) {
    const civilEnd = lastCivilDayOfMonth(y, m)
    const capped = civilEnd > to ? to : civilEnd
    // last available date ≤ capped
    let pick: string | undefined
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= capped) {
        pick = dates[i]
        break
      }
    }
    if (pick && pick > from && !seen.has(pick)) {
      seen.add(pick)
      out.push(pick)
    }
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
  }

  if (byDay.has(to) && !seen.has(to) && to > from) {
    out.push(to)
  }
  return out.sort()
}

function valueOnDate(
  valued: Array<{ date: string; total: number }>,
  date: string,
): number | undefined {
  const exact = valued.find((v) => v.date === date)
  if (exact) return exact.total
  // last on or before
  let best: number | undefined
  for (const v of valued) {
    if (v.date <= date) best = v.total
    else break
  }
  return best
}

/**
 * Running annualized TRI from period start to each month-end (and period end).
 * Each point: −V0 + mid-flows ≤ M + +V(M).
 */
export function computeMonthlyTriSeries(input: {
  valued: Array<{ date: string; total: number }>
  /** External flows after the start EOD snapshot (TRI mid-flows). */
  midFlows: CashFlow[]
}): Array<{ date: string; rate: number | null }> {
  const valued = [...input.valued].sort((a, b) => a.date.localeCompare(b.date))
  if (valued.length < 2) {
    return valued.map((v) => ({ date: v.date, rate: null }))
  }

  const startDate = valued[0].date
  const startValue = valued[0].total
  const endDate = valued[valued.length - 1].date
  const sampleDates = monthEndDates(
    startDate,
    endDate,
    valued.map((v) => v.date),
  )
  const mid = [...input.midFlows]
    .filter((f) => f.date > startDate)
    .sort((a, b) => a.date.localeCompare(b.date))

  let guess = 0.05
  const out: Array<{ date: string; rate: number | null }> = []

  for (const day of sampleDates) {
    const endValue = valueOnDate(valued, day)
    if (endValue === undefined) {
      out.push({ date: day, rate: null })
      continue
    }
    const active = mid.filter((f) => f.date <= day)
    const flows: CashFlow[] = [
      {
        date: startDate,
        amount: -startValue,
        label: 'Achat synthétique portefeuille',
      },
      ...active,
      {
        date: day,
        amount: endValue,
        label: 'Revente synthétique portefeuille',
      },
    ]
    const irr = computeIrr(flows, guess)
    if (irr != null && Number.isFinite(irr) && Math.abs(irr) < 100) {
      guess = irr
      out.push({ date: day, rate: irr })
    } else {
      out.push({ date: day, rate: null })
    }
  }
  return out
}

function dayMs(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime()
}

/**
 * Linear interpolation of the monthly TRI polyline onto an arbitrary date axis.
 * Matches the dashed curve drawn with connectNulls between month-end samples.
 * Outside the first/last defined sample → null.
 */
export function densifyTriSeries(
  samples: Array<{ date: string; rate: number | null }>,
  dates: string[],
): Array<{ date: string; rate: number | null }> {
  const knots = samples
    .filter((p): p is { date: string; rate: number } => p.rate != null)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
  if (!knots.length) {
    return dates.map((date) => ({ date, rate: null }))
  }

  return dates.map((date) => {
    if (date < knots[0].date || date > knots[knots.length - 1].date) {
      return { date, rate: null }
    }
    // Exact sample
    const exact = knots.find((k) => k.date === date)
    if (exact) return { date, rate: exact.rate }

    let i = 0
    while (i < knots.length - 1 && knots[i + 1].date < date) i += 1
    const a = knots[i]
    const b = knots[i + 1]
    if (!b || date < a.date) return { date, rate: null }
    const t0 = dayMs(a.date)
    const t1 = dayMs(b.date)
    if (t1 <= t0) return { date, rate: a.rate }
    const t = (dayMs(date) - t0) / (t1 - t0)
    return { date, rate: a.rate + t * (b.rate - a.rate) }
  })
}

/**
 * Standalone calendar-year TRIs for years N, N−1, N−2 (relative to `asOf`).
 * Each year: synthetic buy at first valo in Y, mid-flows in ]t0,t1], +V(t1).
 */
export function computeCalendarYearTris(input: {
  valued: Array<{ date: string; total: number }>
  midFlows: CashFlow[]
  /** Reference date for "année N" (usually period end). */
  asOf: string
  years?: number
}): CalendarYearTri[] {
  const nYears = input.years ?? 3
  const valued = [...input.valued].sort((a, b) => a.date.localeCompare(b.date))
  if (valued.length < 2) return []

  const asOfYear = Number(input.asOf.slice(0, 4))
  if (!Number.isFinite(asOfYear)) return []

  const mid = [...input.midFlows].sort((a, b) => a.date.localeCompare(b.date))
  const out: CalendarYearTri[] = []

  for (let i = 0; i < nYears; i++) {
    const year = asOfYear - i
    const yearStart = `${year}-01-01`
    const yearEnd = `${year}-12-31`
    const inYear = valued.filter((v) => v.date >= yearStart && v.date <= yearEnd)
    if (inYear.length < 2) {
      out.push({
        year,
        from: yearStart,
        to: yearEnd,
        irr: null,
        startValue: inYear[0]?.total ?? 0,
        endValue: inYear.at(-1)?.total ?? 0,
      })
      continue
    }
    const t0 = inYear[0].date
    const t1 = inYear[inYear.length - 1].date
    const startValue = inYear[0].total
    const endValue = inYear[inYear.length - 1].total
    const yearFlows: CashFlow[] = [
      {
        date: t0,
        amount: -startValue,
        label: `Achat synthétique ${year}`,
      },
      ...mid.filter((f) => f.date > t0 && f.date <= t1),
      {
        date: t1,
        amount: endValue,
        label: `Revente synthétique ${year}`,
      },
    ]
    const irr = computeIrr(yearFlows)
    out.push({
      year,
      from: t0,
      to: t1,
      irr: irr != null && Number.isFinite(irr) && Math.abs(irr) < 100 ? irr : null,
      startValue,
      endValue,
    })
  }
  return out
}

/** True when the valued window spans more than one calendar month. */
export function spansMoreThanOneMonth(
  from: string,
  to: string,
): boolean {
  if (!from || !to || to <= from) return false
  const a = new Date(`${from}T00:00:00Z`)
  const b = new Date(`${to}T00:00:00Z`)
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth())
  return months >= 1
}

const ALL_ENVELOPES: EnvelopeType[] = ['PEA', 'PEA_PME', 'CTO']

/**
 * Consolidated TRI across envelopes: every envelope's own synthetic buy /
 * sell (at its own first / last valued day) plus all mid-period flows.
 */
export function computeConsolidatedPortfolioTri(input: {
  operations: Operation[]
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  t0: string
  t1: string
  virtualOpenings: VirtualOpening[]
  envelopes?: EnvelopeType[]
}): { irr: number | null; flows: CashFlow[]; startValue: number; endValue: number } {
  const envelopes = input.envelopes ?? ALL_ENVELOPES
  const parts = envelopes.map((envelope) =>
    computePortfolioTri({
      envelope,
      operations: input.operations,
      supports: input.supports,
      quotes: input.quotes,
      t0: input.t0,
      t1: input.t1,
      virtualOpening:
        input.virtualOpenings.find((v) => v.envelope === envelope) ?? null,
    }),
  )

  const startValue = parts.reduce((s, p) => s + p.startValue, 0)
  const endValue = parts.reduce((s, p) => s + p.endValue, 0)
  if (parts.every((p) => p.flows.length === 0) || (startValue === 0 && endValue === 0)) {
    return { irr: null, flows: [], startValue, endValue }
  }

  const flows = parts
    .flatMap((p) => p.flows)
    .filter((f) => Math.abs(f.amount) > 1e-9)
    .sort(byDateThenLabel)

  return {
    irr: computeIrr(flows),
    flows,
    startValue,
    endValue,
  }
}
