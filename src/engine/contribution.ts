import type {
  EnvelopeType,
  Operation,
  QuoteBar,
  Support,
  VirtualOpening,
} from '@/domain/types'
import {
  cashImpact,
  cashModeForEnvelope,
  isBuyTrade,
  isSellTrade,
  tradeCashAmount,
} from './cashImpact'
import { toBusinessDay } from './businessDays'
import { buildHoldingsSeries } from './positions'
import { computeIrr, type CashFlow } from './tri'
import { lastFxRate, priceOnDate } from './valuation'

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

/** TTF / frais attached to a title (negative Montant net) — part of its cost. */
function titleCharge(op: Operation): number {
  if (op.type !== 'TAXE' && op.type !== 'FRAIS') return 0
  const n = op.netAmount
  return n !== undefined && Number.isFinite(n) && n < 0 ? -n : 0
}

export interface EnvelopeCapital {
  envelope: EnvelopeType
  /** Apports nets: positions initiales + part des achats non couverte par les espèces */
  invested: number
  /** Achats + TTF/frais cumulés (somme des « Investi » par ligne) */
  grossBuys: number
  /** Part des achats financée par des ventes / dividendes antérieurs */
  reinvested: number
  /** Espèces restantes (ventes + dividendes non réinvestis) */
  cash: number
}

/**
 * Capital réellement apporté à une enveloppe, avec une poche d'espèces qui ne
 * peut jamais être négative : ventes et dividendes l'alimentent, chaque achat
 * (et TTF) y puise d'abord ; seul le reste est un nouvel apport.
 * Le même jour, les entrées passent avant les sorties (vente → rachat).
 */
export function computeEnvelopeCapital(input: {
  operations: Operation[]
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
  virtualOpenings: VirtualOpening[]
  asOf: string
  envelopes: EnvelopeType[]
}): EnvelopeCapital[] {
  const asOf = toBusinessDay(input.asOf)
  const byIsin = supportByIsin(input.supports)

  return input.envelopes.map((envelope) => {
    const vo = input.virtualOpenings.find((v) => v.envelope === envelope) ?? null
    const ops = input.operations.filter(
      (o) => o.envelope === envelope && toBusinessDay(o.date) <= asOf,
    )
    let invested = 0
    let grossBuys = 0
    let reinvested = 0
    let cash = 0

    // Saxo: the file is the full cash journal — apports = versements − retraits
    if (cashModeForEnvelope(envelope) === 'ledger') {
      for (const op of ops) {
        if (op.synthetic) continue
        if (op.type === 'VERSEMENT' || op.type === 'RETRAIT') {
          invested += op.netAmount ?? 0
        }
        if (isBuyTrade(op.type)) grossBuys += Math.abs(tradeCashAmount(op))
        cash += cashImpact(op, 'ledger')
      }
      reinvested = Math.max(0, grossBuys - Math.max(0, invested))
      return { envelope, invested, grossBuys, reinvested, cash }
    }

    if (vo) {
      const day = toBusinessDay(vo.date)
      for (const p of vo.positions) {
        if (Math.abs(p.quantity) < 1e-8) continue
        const seedOp = ops.find(
          (o) =>
            o.isin === p.isin &&
            o.type === 'POSITION_SEED' &&
            toBusinessDay(o.date) === day,
        )
        const px = seedUnitCost(day, byIsin.get(p.isin), input.quotes, seedOp)
        if (px !== undefined && px > 0) {
          const cost = Math.abs(p.quantity) * px
          invested += cost
          grossBuys += cost
        }
      }
    }

    const moves: Array<{ day: string; amount: number }> = []
    for (const op of ops) {
      if (!op.isin) continue
      if (op.synthetic && op.type === 'POSITION_SEED') continue
      const day = toBusinessDay(op.date)
      if (op.type === 'DIVIDENDE') {
        const c = dividendCash(op)
        if (c > 1e-9) moves.push({ day, amount: c })
      } else if (isSellTrade(op.type)) {
        const c = Math.abs(tradeCashAmount(op))
        if (c > 1e-9) moves.push({ day, amount: c })
      } else if (isBuyTrade(op.type)) {
        const c = Math.abs(tradeCashAmount(op))
        if (c > 1e-9) moves.push({ day, amount: -c })
      } else if (titleCharge(op) > 1e-9) {
        moves.push({ day, amount: -titleCharge(op) })
      } else if (op.type === 'POSITION_SEED') {
        const q = Math.abs(op.quantity ?? 0)
        const px = seedUnitCost(day, byIsin.get(op.isin), input.quotes, op)
        if (q > 1e-8 && px !== undefined && px > 0) {
          invested += q * px
          grossBuys += q * px
        }
      }
    }
    moves.sort((a, b) => a.day.localeCompare(b.day) || b.amount - a.amount)

    for (const m of moves) {
      if (m.amount > 0) {
        cash += m.amount
        continue
      }
      const need = -m.amount
      const fromCash = Math.min(cash, need)
      cash -= fromCash
      reinvested += fromCash
      invested += need - fromCash
      grossBuys += need
    }

    return { envelope, invested, grossBuys, reinvested, cash }
  })
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
        const px = seedUnitCost(day, support, input.quotes, seedOp)
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

        if (isBuyTrade(op.type) || titleCharge(op) > 1e-9) {
          const cash = isBuyTrade(op.type)
            ? Math.abs(tradeCashAmount(op))
            : titleCharge(op)
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
          const px = seedUnitCost(day, support, input.quotes, op)
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
          // Invested / proceeds are booked in EUR: convert USD lines
          const fx =
            support?.quoteCurrency && support.quoteCurrency !== 'EUR'
              ? lastFxRate(ops, isin, asOf)
              : undefined
          marketValue = Math.abs(quantity) * px * (fx ?? 1)
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
