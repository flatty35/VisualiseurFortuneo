import type { Operation, QuoteBar, Support, VirtualOpening } from '@/domain/types'
import { buildHoldingsSeries } from './positions'
import { valueHoldingsSeries } from './valuation'

export interface CashFlow {
  date: string
  amount: number // negative = investment, positive = withdrawal
  label: string
}

/**
 * IRR / TRI via Newton–Raphson on annualized rate.
 * Cash flows: negative = money in, positive = money out.
 */
export function computeIrr(flows: CashFlow[], guess = 0.05): number | null {
  if (flows.length < 2) return null
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date))
  const t0 = new Date(sorted[0].date + 'T00:00:00Z').getTime()
  const yearMs = 365.25 * 86400000

  const npv = (r: number) =>
    sorted.reduce((acc, f) => {
      const years = (new Date(f.date + 'T00:00:00Z').getTime() - t0) / yearMs
      return acc + f.amount / Math.pow(1 + r, years)
    }, 0)

  const dNpv = (r: number) =>
    sorted.reduce((acc, f) => {
      const years = (new Date(f.date + 'T00:00:00Z').getTime() - t0) / yearMs
      if (years === 0) return acc
      return acc - (years * f.amount) / Math.pow(1 + r, years + 1)
    }, 0)

  let rate = guess
  for (let i = 0; i < 80; i++) {
    const y = npv(rate)
    const dy = dNpv(rate)
    if (Math.abs(dy) < 1e-12) break
    const next = rate - y / dy
    if (!Number.isFinite(next)) return null
    if (Math.abs(next - rate) < 1e-10) return next
    rate = next
  }
  return Number.isFinite(rate) ? rate : null
}

function priceAt(
  date: string,
  isin: string,
  supports: Support[],
  quotes: Map<string, QuoteBar[]>,
): number {
  const s = supports.find((x) => x.isin === isin)
  if (!s) return 0
  const manual = s.manualPrices
    ?.filter((p) => p.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0]
  if (manual) return manual.price
  if (s.yahooTicker) {
    const bars = quotes.get(s.yahooTicker) ?? []
    let best: number | undefined
    for (const b of bars) {
      if (b.date <= date) best = b.close
      else break
    }
    // bars may not be sorted in loop if unsorted — ensure
    const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date))
    best = undefined
    for (const b of sorted) {
      if (b.date <= date) best = b.close
      else break
    }
    if (best !== undefined) return best
  }
  return s.staticPrice ?? 0
}

/**
 * TRI on [t0, t1]: synthetic buy of open positions at t0, real external cash flows,
 * synthetic sell at t1. No trading fees.
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
  })

  if (!valued.length) {
    return { irr: null, flows: [], startValue: 0, endValue: 0 }
  }

  const start = valued[0]
  const end = valued[valued.length - 1]
  const startValue = input.isin
    ? (start.byIsin[input.isin] ?? 0)
    : start.total
  const endValue = input.isin ? (end.byIsin[input.isin] ?? 0) : end.total

  const flows: CashFlow[] = [
    {
      date: input.t0,
      amount: -startValue,
      label: input.isin
        ? `Achat synthétique ${input.isin}`
        : 'Achat synthétique portefeuille',
    },
  ]

  // External cash flows during period (envelope level)
  if (!input.isin) {
    for (const op of input.operations) {
      if (op.date < input.t0 || op.date > input.t1) continue
      if (op.synthetic) continue
      if (op.type === 'VERSEMENT') {
        flows.push({
          date: op.date,
          amount: -Math.abs(op.netAmount ?? 0),
          label: op.label,
        })
      } else if (op.type === 'RETRAIT') {
        flows.push({
          date: op.date,
          amount: Math.abs(op.netAmount ?? 0),
          label: op.label,
        })
      }
    }
  } else {
    // Position-level: treat buys as capital in, sells as capital out (no fees)
    for (const op of input.operations) {
      if (op.isin !== input.isin) continue
      if (op.date < input.t0 || op.date > input.t1) continue
      if (op.synthetic) continue
      const px = op.price ?? priceAt(op.date, input.isin, input.supports, input.quotes)
      const qty = op.quantity ?? 0
      if (op.type === 'ACHAT' || op.type === 'SCRIPT') {
        flows.push({
          date: op.date,
          amount: -(qty * px),
          label: op.label,
        })
      } else if (op.type === 'VENTE' || op.type === 'RACHAT') {
        flows.push({
          date: op.date,
          amount: qty * px,
          label: op.label,
        })
      }
    }
  }

  flows.push({
    date: input.t1,
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
