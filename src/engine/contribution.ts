import type {
  EnvelopeType,
  Operation,
  QuoteBar,
  Support,
  VirtualOpening,
} from '@/domain/types'
import {
  isBuyTrade,
  isSellTrade,
  tradeCashAmount,
} from './cashImpact'
import { toBusinessDay } from './businessDays'
import { buildHoldingsSeries } from './positions'
import { computeIrr, type CashFlow } from './tri'
import { priceOnDate } from './valuation'

export interface PositionContribution {
  envelope: EnvelopeType
  isin: string
  name: string
  status: 'open' | 'closed'
  quantity: number
  invested: number
  proceeds: number
  dividends: number
  marketValue: number
  /** proceeds + dividends + marketValue − invested */
  absolute: number
  /** absolute / invested */
  roi: number | null
  /** Money-weighted annualized return (XIRR) */
  irr: number | null
  from: string
  to: string
}

function supportByIsin(supports: Support[]): Map<string, Support> {
  return new Map(supports.map((s) => [s.isin, s]))
}

function dividendCash(op: Operation): number {
  const n = op.netAmount ?? op.grossAmount
  if (n === undefined || !Number.isFinite(n)) return 0
  return Math.abs(n)
}

function seedUnitCost(
  isin: string,
  date: string,
  support: Support | undefined,
  quotes: Map<string, QuoteBar[]>,
  seedOp?: Operation,
): number | undefined {
  if (seedOp?.price !== undefined && seedOp.price > 0) return seedOp.price
  if (
    seedOp?.netAmount !== undefined &&
    seedOp.quantity !== undefined &&
    Math.abs(seedOp.quantity) > 1e-12 &&
    Math.abs(seedOp.netAmount) > 1e-9
  ) {
    return Math.abs(seedOp.netAmount) / Math.abs(seedOp.quantity)
  }
  return priceOnDate(date, support, quotes)
}

/**
 * Per-position contribution to date (open + closed), one row per (envelope, ISIN).
 */
export function computePositionContributions(input: {
  operations: Operation[]
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  virtualOpenings: VirtualOpening[]
  asOf: string
  envelopes?: EnvelopeType[]
}): PositionContribution[] {
  const asOf = toBusinessDay(input.asOf)
  const envelopes =
    input.envelopes ??
    ([...new Set([
      ...input.virtualOpenings.map((v) => v.envelope),
      ...input.operations.map((o) => o.envelope),
    ])] as EnvelopeType[])

  const byIsin = supportByIsin(input.supports)
  const out: PositionContribution[] = []

  for (const envelope of envelopes) {
    const vo =
      input.virtualOpenings.find((v) => v.envelope === envelope) ?? null
    const ops = input.operations.filter(
      (o) => o.envelope === envelope && toBusinessDay(o.date) <= asOf,
    )

    const holdings = buildHoldingsSeries({
      envelope,
      operations: ops,
      virtualOpening: vo,
      from: vo?.date ?? ops.map((o) => o.date).sort()[0],
      to: asOf,
    })
    const last = holdings[holdings.length - 1]
    const qtyAtAsOf = last?.quantities ?? new Map<string, number>()

    const isins = new Set<string>()
    for (const o of ops) if (o.isin) isins.add(o.isin)
    if (vo) for (const p of vo.positions) isins.add(p.isin)

    for (const isin of isins) {
      const support = byIsin.get(isin)
      const name =
        support?.name ??
        ops.find((o) => o.isin === isin && o.name)?.name ??
        vo?.positions.find((p) => p.isin === isin)?.name ??
        isin

      let invested = 0
      let proceeds = 0
      let dividends = 0
      const flows: CashFlow[] = []
      let from = ''
      let lastActivity = ''

      const touch = (day: string) => {
        if (!from || day < from) from = day
        if (!lastActivity || day > lastActivity) lastActivity = day
      }

      // Virtual opening seed = capital immobilized at start
      const seedPos = vo?.positions.find((p) => p.isin === isin)
      if (seedPos && Math.abs(seedPos.quantity) > 1e-8 && vo) {
        const seedOp = ops.find(
          (o) =>
            o.isin === isin &&
            o.type === 'POSITION_SEED' &&
            toBusinessDay(o.date) === toBusinessDay(vo.date),
        )
        const day = toBusinessDay(vo.date)
        const px = seedUnitCost(isin, day, support, input.quotes, seedOp)
        if (px !== undefined && px > 0) {
          const cost = Math.abs(seedPos.quantity) * px
          invested += cost
          flows.push({
            date: day,
            amount: -cost,
            label: 'Position initiale',
          })
          touch(day)
        }
      }

      for (const op of ops) {
        if (op.isin !== isin) continue
        // VO already applied — ignore synthetic seeds
        if (op.synthetic && op.type === 'POSITION_SEED') continue
        const day = toBusinessDay(op.date)

        if (op.type === 'DIVIDENDE') {
          const cash = dividendCash(op)
          if (cash < 1e-9) continue
          dividends += cash
          flows.push({ date: day, amount: cash, label: op.label || 'Dividende' })
          touch(day)
          continue
        }

        if (isBuyTrade(op.type)) {
          const cash = Math.abs(tradeCashAmount(op))
          if (cash < 1e-9) continue
          invested += cash
          flows.push({ date: day, amount: -cash, label: op.label || 'Achat' })
          touch(day)
          continue
        }

        if (isSellTrade(op.type)) {
          const cash = Math.abs(tradeCashAmount(op))
          if (cash < 1e-9) continue
          proceeds += cash
          flows.push({ date: day, amount: cash, label: op.label || 'Vente' })
          touch(day)
          continue
        }

        // Non-synthetic seed without VO (rare) — count as invested
        if (op.type === 'POSITION_SEED' && !op.synthetic) {
          const q = Math.abs(op.quantity ?? 0)
          const px = seedUnitCost(isin, day, support, input.quotes, op)
          if (q > 1e-8 && px !== undefined && px > 0) {
            const cost = q * px
            invested += cost
            flows.push({
              date: day,
              amount: -cost,
              label: op.label || 'Position initiale',
            })
            touch(day)
          }
        }
      }

      const quantity = qtyAtAsOf.get(isin) ?? 0
      const open = Math.abs(quantity) > 1e-8
      let marketValue = 0
      if (open) {
        const px = priceOnDate(asOf, support, input.quotes)
        if (px !== undefined && px > 0) {
          marketValue = Math.abs(quantity) * px
          flows.push({
            date: asOf,
            amount: marketValue,
            label: 'Valeur actuelle',
          })
          touch(asOf)
        }
      }

      // Skip empty shells (never traded / no seed priced)
      if (invested < 1e-9 && proceeds < 1e-9 && dividends < 1e-9 && marketValue < 1e-9) {
        continue
      }

      const absolute = proceeds + dividends + marketValue - invested
      const roi = invested > 1e-9 ? absolute / invested : null
      const irr = computeIrr(
        [...flows].sort(
          (a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label),
        ),
      )

      out.push({
        envelope,
        isin,
        name,
        status: open ? 'open' : 'closed',
        quantity,
        invested,
        proceeds,
        dividends,
        marketValue,
        absolute,
        roi,
        irr,
        from: from || asOf,
        to: open ? asOf : lastActivity || asOf,
      })
    }
  }

  return out.sort(
    (a, b) =>
      b.absolute - a.absolute ||
      a.name.localeCompare(b.name, 'fr') ||
      a.envelope.localeCompare(b.envelope),
  )
}
