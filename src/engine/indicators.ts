import type { QuoteBar } from '@/domain/types'

export const SMA_SHORT = 19
export const SMA_MID = 49
export const SMA_LONG = 190
export const RSI_PERIOD = 14
export const ATR_PERIOD = 14
export const VOL_SMA_PERIOD = 19
export const PIVOT_K = 2
export const SLOPE_LOOKBACK = 19

export type TrendRegime = 'bull' | 'bear' | 'neutral'

export interface PivotLevel {
  index: number
  date: string
  price: number
}

export interface IndicatorSnapshot {
  lastDate: string
  lastClose: number
  sma19?: number
  sma49?: number
  sma190?: number
  sma190Slope?: number
  regime: TrendRegime
  rsi?: number
  rsiReclaimAbove30: boolean
  rsiReclaimBelow70: boolean
  goldenCross: boolean
  deathCross: boolean
  support?: number
  resistance?: number
  distToSupportPct?: number
  distToResistancePct?: number
  bounceSupport: boolean
  breakSupport: boolean
  atr?: number
  stopLoss?: number
  takeProfit?: number
  /** true = volume spike; false = weak; undefined = unknown */
  volumeConfirm?: boolean
}

function barLow(b: QuoteBar): number {
  return b.low !== undefined && Number.isFinite(b.low) ? b.low : b.close
}

function barHigh(b: QuoteBar): number {
  return b.high !== undefined && Number.isFinite(b.high) ? b.high : b.close
}

/** Simple moving average of closes ending at `endIndex` (inclusive). */
export function smaAt(
  closes: number[],
  endIndex: number,
  period: number,
): number | undefined {
  if (endIndex < period - 1 || period <= 0) return undefined
  let sum = 0
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += closes[i]
  return sum / period
}

/** Full SMA series (undefined until warm-up). */
export function smaSeries(closes: number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(closes.length)
  for (let i = 0; i < closes.length; i++) out[i] = smaAt(closes, i, period)
  return out
}

/** Wilder RSI(period). */
export function rsiSeries(
  closes: number[],
  period = RSI_PERIOD,
): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(closes.length)
  if (closes.length < period + 1) return out

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) avgGain += d
    else avgLoss -= d
  }
  avgGain /= period
  avgLoss /= period
  out[period] =
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const gain = d > 0 ? d : 0
    const loss = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/** True range at index i (needs i >= 1). */
export function trueRangeAt(bars: QuoteBar[], i: number): number | undefined {
  if (i < 1) return undefined
  const h = barHigh(bars[i])
  const l = barLow(bars[i])
  const prev = bars[i - 1].close
  return Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev))
}

/** Wilder ATR; falls back to |Δclose| average when no high/low. */
export function atrSeries(
  bars: QuoteBar[],
  period = ATR_PERIOD,
): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(bars.length)
  if (bars.length < period + 1) return out

  const tr: number[] = new Array(bars.length)
  for (let i = 1; i < bars.length; i++) {
    const t = trueRangeAt(bars, i)
    tr[i] =
      t !== undefined
        ? t
        : Math.abs(bars[i].close - bars[i - 1].close)
  }

  let atr = 0
  for (let i = 1; i <= period; i++) atr += tr[i]
  atr /= period
  out[period] = atr
  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period
    out[i] = atr
  }
  return out
}

export function findPivotLows(
  bars: QuoteBar[],
  k = PIVOT_K,
): PivotLevel[] {
  const out: PivotLevel[] = []
  for (let i = k; i < bars.length - k; i++) {
    const v = barLow(bars[i])
    let isPivot = true
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue
      if (barLow(bars[j]) < v) {
        isPivot = false
        break
      }
    }
    if (isPivot) out.push({ index: i, date: bars[i].date, price: v })
  }
  return out
}

export function findPivotHighs(
  bars: QuoteBar[],
  k = PIVOT_K,
): PivotLevel[] {
  const out: PivotLevel[] = []
  for (let i = k; i < bars.length - k; i++) {
    const v = barHigh(bars[i])
    let isPivot = true
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue
      if (barHigh(bars[j]) > v) {
        isPivot = false
        break
      }
    }
    if (isPivot) out.push({ index: i, date: bars[i].date, price: v })
  }
  return out
}

/** Nearest pivot low at or below price (prefer most recent). */
export function activeSupport(
  pivots: PivotLevel[],
  price: number,
): PivotLevel | undefined {
  const below = pivots.filter((p) => p.price <= price * 1.001)
  return below.length ? below[below.length - 1] : undefined
}

export function activeResistance(
  pivots: PivotLevel[],
  price: number,
): PivotLevel | undefined {
  const above = pivots.filter((p) => p.price >= price * 0.999)
  return above.length ? above[above.length - 1] : undefined
}

export function volumeConfirmAt(
  bars: QuoteBar[],
  index: number,
  period = VOL_SMA_PERIOD,
  mult = 1.5,
): boolean | undefined {
  if (index < period - 1) return undefined
  const vols: number[] = []
  for (let i = index - period + 1; i <= index; i++) {
    const v = bars[i].volume
    if (v === undefined || !Number.isFinite(v)) return undefined
    vols.push(v)
  }
  const avg = vols.reduce((a, b) => a + b, 0) / vols.length
  if (!(avg > 0)) return undefined
  return vols[vols.length - 1] >= mult * avg
}

function crossedUp(
  aPrev: number,
  aNow: number,
  bPrev: number,
  bNow: number,
): boolean {
  return aPrev <= bPrev && aNow > bNow
}

function crossedDown(
  aPrev: number,
  aNow: number,
  bPrev: number,
  bNow: number,
): boolean {
  return aPrev >= bPrev && aNow < bNow
}

/**
 * Compute the latest indicator snapshot for a daily OHLCV (or close-only) series.
 * Needs enough history for MM190 (~190+ bars ideal).
 */
export function computeIndicators(bars: QuoteBar[]): IndicatorSnapshot | null {
  if (!bars.length) return null
  const n = bars.length
  const last = n - 1
  const closes = bars.map((b) => b.close)

  const sma19 = smaAt(closes, last, SMA_SHORT)
  const sma49 = smaAt(closes, last, SMA_MID)
  const sma190 = smaAt(closes, last, SMA_LONG)
  const sma190Prev =
    last >= SLOPE_LOOKBACK
      ? smaAt(closes, last - SLOPE_LOOKBACK, SMA_LONG)
      : undefined
  const sma190Slope =
    sma190 !== undefined &&
    sma190Prev !== undefined &&
    sma190Prev !== 0
      ? (sma190 - sma190Prev) / sma190Prev
      : undefined

  let regime: TrendRegime = 'neutral'
  if (
    sma49 !== undefined &&
    sma190 !== undefined &&
    sma190Slope !== undefined
  ) {
    if (sma49 > sma190 && sma190Slope >= 0) regime = 'bull'
    else if (sma49 < sma190 && sma190Slope < 0) regime = 'bear'
  }

  const rsiArr = rsiSeries(closes, RSI_PERIOD)
  const rsi = rsiArr[last]
  const rsiPrev = last >= 1 ? rsiArr[last - 1] : undefined
  const rsiReclaimAbove30 =
    rsi !== undefined &&
    rsiPrev !== undefined &&
    rsiPrev <= 30 &&
    rsi > 30
  const rsiReclaimBelow70 =
    rsi !== undefined &&
    rsiPrev !== undefined &&
    rsiPrev >= 70 &&
    rsi < 70

  let goldenCross = false
  let deathCross = false
  if (last >= 1) {
    const m49p = smaAt(closes, last - 1, SMA_MID)
    const m190p = smaAt(closes, last - 1, SMA_LONG)
    if (
      sma49 !== undefined &&
      sma190 !== undefined &&
      m49p !== undefined &&
      m190p !== undefined
    ) {
      goldenCross = crossedUp(m49p, sma49, m190p, sma190)
      deathCross = crossedDown(m49p, sma49, m190p, sma190)
    }
  }

  const atrArr = atrSeries(bars, ATR_PERIOD)
  const atr = atrArr[last]
  const lastClose = closes[last]
  const stopLoss =
    atr !== undefined ? lastClose - 2 * atr : undefined
  const takeProfit =
    atr !== undefined ? lastClose + 3 * atr : undefined

  const pivLows = findPivotLows(bars, PIVOT_K)
  const pivHighs = findPivotHighs(bars, PIVOT_K)
  const supportLvl = activeSupport(pivLows, lastClose)
  const resistLvl = activeResistance(pivHighs, lastClose)
  const support = supportLvl?.price
  const resistance = resistLvl?.price
  const distToSupportPct =
    support !== undefined && support > 0
      ? ((lastClose - support) / support) * 100
      : undefined
  const distToResistancePct =
    resistance !== undefined && resistance > 0
      ? ((resistance - lastClose) / resistance) * 100
      : undefined

  const margin = atr !== undefined ? 0.5 * atr : lastClose * 0.01
  const breakMargin = atr !== undefined ? atr : lastClose * 0.01
  let bounceSupport = false
  let breakSupport = false
  if (support !== undefined && last >= 1) {
    const prevLow = barLow(bars[last - 1])
    const curLow = barLow(bars[last])
    const touched =
      Math.min(prevLow, curLow) <= support + margin
    bounceSupport = touched && lastClose > support
    breakSupport = lastClose < support - breakMargin
  }

  const volumeConfirm = volumeConfirmAt(bars, last, VOL_SMA_PERIOD)

  return {
    lastDate: bars[last].date,
    lastClose,
    sma19,
    sma49,
    sma190,
    sma190Slope,
    regime,
    rsi,
    rsiReclaimAbove30,
    rsiReclaimBelow70,
    goldenCross,
    deathCross,
    support,
    resistance,
    distToSupportPct,
    distToResistancePct,
    bounceSupport,
    breakSupport,
    atr,
    stopLoss,
    takeProfit,
    volumeConfirm,
  }
}
