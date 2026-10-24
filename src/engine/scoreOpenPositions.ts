import type { EnvelopeType, QuoteBar, Support } from '@/domain/types'
import { computeIndicators } from './indicators'
import { scoreFromIndicators, type SignalScore } from './signalScore'
import type { IndicatorSnapshot } from './indicators'
import { quoteKeyForSupport } from './valuation'

export interface ScoredPosition {
  isin: string
  name: string
  envelope: EnvelopeType
  quantity: number
  quoteCurrency?: string
  indicators: IndicatorSnapshot
  signal: SignalScore
  barsCount: number
}

/**
 * Score open (non-zero qty) positions that have enough quote history.
 * Skips tradeQuotesOnly derivatives.
 */
export function scoreOpenPositions(input: {
  positions: Array<{ isin: string; quantity: number; envelope: EnvelopeType }>
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
}): ScoredPosition[] {
  const byIsin = new Map(input.supports.map((s) => [s.isin, s]))
  const out: ScoredPosition[] = []

  for (const p of input.positions) {
    if (!p.quantity || Math.abs(p.quantity) < 1e-10) continue
    const support = byIsin.get(p.isin)
    if (!support || support.tradeQuotesOnly) continue
    const key = quoteKeyForSupport(support)
    if (!key) continue
    const bars = input.quotes.get(key) ?? input.quotes.get(support.isin)
    if (!bars || bars.length < 50) continue
    const indicators = computeIndicators(bars)
    if (!indicators) continue
    out.push({
      isin: p.isin,
      name: support.name,
      envelope: p.envelope,
      quantity: p.quantity,
      quoteCurrency: support.quoteCurrency,
      indicators,
      signal: scoreFromIndicators(indicators),
      barsCount: bars.length,
    })
  }

  return out.sort((a, b) => b.signal.score - a.signal.score)
}
