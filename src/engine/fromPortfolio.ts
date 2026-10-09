/**
 * Engine entry points that take a hydrated Portfolio and project to flat DTOs.
 */
import type { Portfolio } from '@/domain/portfolioModel'
import {
  envelopeTypeToKind,
  projectPortfolio,
  virtualOpeningFromEnvelope,
} from '@/domain/flatAdapters'
import type { EnvelopeType } from '@/domain/types'
import { buildHoldingsSeries, type HoldingsSnapshot } from './positions'
import { valueHoldingsSeries, type ValuePoint } from './valuation'
import type { QuoteBar } from '@/domain/types'

export function holdingsFromPortfolio(
  portfolio: Portfolio,
  envelope: EnvelopeType,
  range?: { from?: string; to?: string },
): HoldingsSnapshot[] {
  const { operations } = projectPortfolio(portfolio)
  return buildHoldingsSeries({
    envelope,
    operations,
    virtualOpening: virtualOpeningFromEnvelope(portfolio, envelope),
    from: range?.from,
    to: range?.to,
  })
}

export function valuationFromPortfolio(input: {
  portfolio: Portfolio
  envelope: EnvelopeType
  quotes: Map<string, QuoteBar[]>
  from?: string
  to?: string
  isinFilter?: string[]
}): ValuePoint[] {
  const holdings = holdingsFromPortfolio(input.portfolio, input.envelope, {
    from: input.from,
    to: input.to,
  })
  const { supports } = projectPortfolio(input.portfolio)
  return valueHoldingsSeries({
    holdings,
    supports,
    quotes: input.quotes,
    isinFilter: input.isinFilter,
  })
}

export function envelopeOpsCount(
  portfolio: Portfolio,
  envelope: EnvelopeType,
): number {
  const env = portfolio.envelopeByKind(envelopeTypeToKind(envelope))
  return env?.operations.filter((o) => !o.synthetic).length ?? 0
}
