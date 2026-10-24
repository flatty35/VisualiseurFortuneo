import type { EnvelopeType, QuoteBar, Support } from '@/domain/types'
import {
  computeIndicators,
  downsampleSparkPoints,
  macdHistSpark,
  type IndicatorSnapshot,
} from './indicators'
import { scoreFromIndicators, type SignalScore } from './signalScore'
import { quoteKeyForSupport } from './valuation'

export interface ScoredPosition {
  isin: string
  name: string
  /** Envelopes that hold this ISIN (one row even if held in several). */
  envelopes: EnvelopeType[]
  quantity: number
  quoteCurrency?: string
  indicators: IndicatorSnapshot
  signal: SignalScore
  barsCount: number
  /** ~2Y dated closes downsampled for sparkline (from cache, no network). */
  sparkPoints: Array<{ date: string; close: number }>
  /** @deprecated use sparkPoints — kept for tests / compat */
  sparkCloses: number[]
  /** ~3M MACD histogram for sparkline. */
  macdHist: Array<{ v: number; rising: boolean }>
}

/**
 * Score open (non-zero qty) positions that have enough quote history.
 * Skips tradeQuotesOnly derivatives. Same ISIN across envelopes → one row
 * (quantities summed, envelopes listed).
 */
export function scoreOpenPositions(input: {
  positions: Array<{ isin: string; quantity: number; envelope: EnvelopeType }>
  supports: Support[]
  quotes: Map<string, QuoteBar[]>
}): ScoredPosition[] {
  const byIsin = new Map(input.supports.map((s) => [s.isin, s]))

  // Merge duplicate ISINs (e.g. same ETF in PEA + CTO)
  const merged = new Map<
    string,
    { quantity: number; envelopes: Set<EnvelopeType> }
  >()
  for (const p of input.positions) {
    if (!p.quantity || Math.abs(p.quantity) < 1e-10) continue
    const cur = merged.get(p.isin)
    if (cur) {
      cur.quantity += p.quantity
      cur.envelopes.add(p.envelope)
    } else {
      merged.set(p.isin, {
        quantity: p.quantity,
        envelopes: new Set([p.envelope]),
      })
    }
  }

  const out: ScoredPosition[] = []
  for (const [isin, { quantity, envelopes }] of merged) {
    if (Math.abs(quantity) < 1e-10) continue
    const support = byIsin.get(isin)
    if (!support || support.tradeQuotesOnly) continue
    const key = quoteKeyForSupport(support)
    if (!key) continue
    const bars = input.quotes.get(key) ?? input.quotes.get(support.isin)
    if (!bars || bars.length < 50) continue
    const indicators = computeIndicators(bars)
    if (!indicators) continue
    const closes = bars.map((b) => b.close)
    const sparkPoints = downsampleSparkPoints(
      bars.map((b) => ({ date: b.date, close: b.close })),
      64,
    )
    out.push({
      isin,
      name: support.name,
      envelopes: [...envelopes],
      quantity,
      quoteCurrency: support.quoteCurrency,
      indicators,
      signal: scoreFromIndicators(indicators),
      barsCount: bars.length,
      sparkPoints,
      sparkCloses: sparkPoints.map((p) => p.close),
      macdHist: macdHistSpark(closes, 63),
    })
  }

  return out.sort((a, b) => b.signal.score - a.signal.score)
}
