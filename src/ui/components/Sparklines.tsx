import { memo, type ReactNode } from 'react'
import { THEME } from '@/ui/theme'

const PRICE_W = 108
const PRICE_H = 40
const MACD_W = 72
const MACD_H = 28
const HOVER_ZOOM = 4

/** Hover shows a 4× popover of the same sparkline. */
function SparkHoverZoom({
  label,
  children,
  zoom,
}: {
  label: string
  children: ReactNode
  zoom: ReactNode
}) {
  return (
    <span className="spark-hover" tabIndex={0} aria-label={label}>
      {children}
      <span className="spark-zoom" role="presentation">
        {zoom}
      </span>
    </span>
  )
}

function fmtSparkPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) {
    return n.toLocaleString('fr-FR', { maximumFractionDigits: 0 })
  }
  if (abs >= 10) {
    return n.toLocaleString('fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    })
  }
  return n.toLocaleString('fr-FR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

/** Fractional index (equal-spaced samples) closest to a calendar day. */
function fracIndexAtDate(
  points: Array<{ date: string; close: number }>,
  isoDay: string,
): number | null {
  const t = Date.parse(isoDay)
  if (!Number.isFinite(t) || points.length < 2) return null
  const t0 = Date.parse(points[0].date)
  const t1 = Date.parse(points[points.length - 1].date)
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t < t0 || t > t1) {
    return null
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = Date.parse(points[i].date)
    const b = Date.parse(points[i + 1].date)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (t >= a && t <= b) {
      if (b === a) return i
      return i + (t - a) / (b - a)
    }
  }
  return points.length - 1
}

const MS_YEAR = 365.25 * 24 * 60 * 60 * 1000

/** Abscissa ticks: if <1Y history → first quote MM-YYYY; else N−1 & current at 1 Jan. */
function yearMarks(
  points: Array<{ date: string; close: number }>,
): Array<{ i: number; label: string }> {
  if (points.length < 2) return []
  const t0 = Date.parse(points[0].date)
  const t1 = Date.parse(points[points.length - 1].date)
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return []

  // Short history: show first quote month instead of a misleading Jan-1 year.
  if (t1 - t0 < MS_YEAR) {
    const d = points[0].date
    if (!/^\d{4}-\d{2}/.test(d)) return []
    return [{ i: 0, label: `${d.slice(5, 7)}-${d.slice(0, 4)}` }]
  }

  const nowY = new Date().getFullYear()
  const out: Array<{ i: number; label: string }> = []
  for (const y of [nowY - 1, nowY]) {
    const i = fracIndexAtDate(points, `${y}-01-01`)
    if (i == null) continue
    out.push({ i, label: String(y) })
  }
  return out
}

/** Tiny 2Y price path — pure SVG, no chart lib. */
export const PriceSparkline = memo(function PriceSparkline({
  points,
  values,
  width = PRICE_W,
  height = PRICE_H,
}: {
  /** Preferred: dated closes for year ticks. */
  points?: Array<{ date: string; close: number }>
  /** Fallback closes only. */
  values?: number[]
  width?: number
  height?: number
}) {
  const pts =
    points && points.length >= 2
      ? points
      : (values ?? []).map((close, i) => ({
          date: String(i),
          close,
        }))
  if (pts.length < 2) {
    return <span className="muted">—</span>
  }
  return (
    <SparkHoverZoom
      label="Cours ~2 ans — survol pour agrandir"
      zoom={
        <PriceSparkSvg
          points={pts}
          width={width * HOVER_ZOOM}
          height={height * HOVER_ZOOM}
        />
      }
    >
      <PriceSparkSvg points={pts} width={width} height={height} />
    </SparkHoverZoom>
  )
})

function PriceSparkSvg({
  points,
  width,
  height,
}: {
  points: Array<{ date: string; close: number }>
  width: number
  height: number
}) {
  const values = points.map((p) => p.close)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const s = Math.max(1, width / PRICE_W)
  const padX = 2 * s
  const padTop = 7 + 2.5 * s
  const padBottom = 8 + 2.5 * s
  const stroke = 1.1 + 0.35 * s
  const fontSize = 6 + 1.5 * s
  const plotH = height - padTop - padBottom
  const plotW = width - padX * 2

  const xy = (i: number, v: number) => {
    const x = padX + (i / (values.length - 1)) * plotW
    const y = padTop + plotH - ((v - min) / span) * plotH
    return { x, y }
  }
  const xAt = (i: number) => padX + (i / (values.length - 1)) * plotW

  const linePts = values
    .map((v, i) => {
      const { x, y } = xy(i, v)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const up = values[values.length - 1] >= values[0]
  const years = yearMarks(points)
  const minLabel = fmtSparkPrice(min)
  const maxLabel = fmtSparkPrice(max)

  // Place min/max on the side with more free room vs year labels.
  let leftClear = plotW
  let rightClear = plotW
  for (const { i, label } of years) {
    const x = xAt(i)
    const halfW = fontSize * label.length * 0.32
    leftClear = Math.min(leftClear, Math.max(0, x - halfW - padX))
    rightClear = Math.min(
      rightClear,
      Math.max(0, width - padX - (x + halfW)),
    )
  }
  const ordRight = rightClear >= leftClear
  const ordX = ordRight ? width - padX : padX
  const ordAnchor = ordRight ? 'end' : 'start'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
      aria-hidden
    >
      <polyline
        fill="none"
        stroke={up ? THEME.ok : THEME.danger}
        strokeWidth={stroke}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={linePts}
      />
      {/* Min / max — side with more room vs years */}
      <text
        x={ordX}
        y={padTop - 1}
        textAnchor={ordAnchor}
        fill={THEME.muted}
        fontSize={fontSize}
        opacity={0.7}
      >
        {maxLabel}
      </text>
      <text
        x={ordX}
        y={height - padBottom + fontSize + 1}
        textAnchor={ordAnchor}
        fill={THEME.muted}
        fontSize={fontSize}
        opacity={0.7}
      >
        {minLabel}
      </text>
      {/* Years / first-quote month on abscissa */}
      {years.map(({ i, label }) => {
        const x = xAt(i)
        const edge = 10
        const anchor =
          x < padX + edge ? 'start' : x > width - padX - edge ? 'end' : 'middle'
        return (
          <text
            key={label}
            x={x}
            y={height - 1}
            textAnchor={anchor}
            fill={THEME.muted}
            fontSize={fontSize}
            opacity={0.55}
          >
            {label}
          </text>
        )
      })}
    </svg>
  )
}

/** MACD histogram ~3M — green when rising, red when falling. */
export const MacdHistSparkline = memo(function MacdHistSparkline({
  bars,
  width = MACD_W,
  height = MACD_H,
}: {
  bars: Array<{ v: number; rising: boolean }>
  width?: number
  height?: number
}) {
  if (bars.length < 2) {
    return <span className="muted">—</span>
  }
  return (
    <SparkHoverZoom
      label="MACD ~3 mois — survol pour agrandir"
      zoom={
        <MacdHistSvg
          bars={bars}
          width={width * HOVER_ZOOM}
          height={height * HOVER_ZOOM}
        />
      }
    >
      <MacdHistSvg bars={bars} width={width} height={height} />
    </SparkHoverZoom>
  )
})

function MacdHistSvg({
  bars,
  width,
  height,
}: {
  bars: Array<{ v: number; rising: boolean }>
  width: number
  height: number
}) {
  const maxAbs = Math.max(...bars.map((b) => Math.abs(b.v)), 1e-9)
  const mid = height / 2
  const gap = width > MACD_W ? 0.8 : 0.4
  const bw = Math.max(0.8, (width - gap * bars.length) / bars.length)
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
      aria-hidden
    >
      <line
        x1={0}
        x2={width}
        y1={mid}
        y2={mid}
        stroke={`rgba(${THEME.lineRgb}, 0.35)`}
        strokeWidth={width > MACD_W ? 1.5 : 1}
      />
      {bars.map((b, i) => {
        const h = (Math.abs(b.v) / maxAbs) * (mid - 1)
        const x = i * (bw + gap)
        const y = b.v >= 0 ? mid - h : mid
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={bw}
            height={Math.max(0.5, h)}
            fill={b.rising ? THEME.ok : THEME.danger}
            opacity={0.85}
          />
        )
      })}
    </svg>
  )
}
