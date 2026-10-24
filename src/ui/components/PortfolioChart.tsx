import { useEffect, useMemo, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts'
import type { EChartsType } from 'echarts'
import type { ChartPeriod } from '@/domain/types'
import {
  formatMarkerTooltip,
  type OperationMarker,
} from '@/engine/markers'
import { SERIES_PALETTE, THEME } from '@/ui/theme'

const LINE = (alpha: number) => `rgba(${THEME.lineRgb}, ${alpha})`
const ACCENT = (alpha: number) => `rgba(${THEME.accentRgb}, ${alpha})`

/** ECharts native dataZoom sync between Cours / Valorisation charts. */
const ZOOM_SYNC_GROUP = 'vf-charts-zoom-sync'

export interface ChartSeries {
  id: string
  name: string
  dates: string[]
  values: Array<number | null>
  dashed?: boolean
  isPosition?: boolean
  step?: boolean | 'start' | 'middle' | 'end'
  color?: string
  /** Only first segment of a multi-segment line should appear in legend */
  showInLegend?: boolean
  connectGroup?: string
  /** Parallel unit prices (€) — tooltip when chart is base 100 */
  realPrices?: number[]
  /** Parallel position valuations qty×price (€) */
  valuations?: number[]
  /** Secondary Y axis (e.g. TRI %) */
  yAxisIndex?: 0 | 1
  /** How to format tooltip / axis values */
  valueUnit?: 'eur' | 'pct' | 'index'
  /** ISO currency for money tooltips (USD positions stay in USD). */
  currency?: string
  /** Join across null gaps (monthly TRI on a daily axis). */
  connectNulls?: boolean
  /** Show markers on each sample (useful for sparse series). */
  showSymbol?: boolean
  /** When set with showSymbol, only these calendar days get a visible marker. */
  symbolDates?: string[]
  /**
   * Horizontal S/R overlays (`value` in same unit as series: € or %).
   * `price` = cours absolu pour le tooltip ; `strength` 0..1 → line width.
   */
  levels?: Array<{
    value: number
    kind: 'support' | 'resistance'
    strength: number
    label?: string
    /** Absolute quote for hover (e.g. 42,50 €) */
    price?: number
    currency?: string
  }>
}

/** Calendar-day zoom window shared across charts (YYYY-MM-DD). */
export interface ZoomRange {
  start: string
  end: string
}

interface Props {
  series: ChartSeries[]
  markers?: OperationMarker[]
  /** Absolute EUR vs index (base 100 already applied in values) */
  mode: 'euro' | 'index'
  period: ChartPeriod
  onPeriod: (p: ChartPeriod) => void
  height?: number
  showPeriodBar?: boolean
  /** Shared category axis (period window) — keeps valorisation & cours aligned */
  axisDates?: string[]
  /** Calendar bounds of the period — zoom null = this full window */
  periodRange?: ZoomRange | null
  /** Shared zoom (null = full period). */
  zoomRange?: ZoomRange | null
  onZoomRangeChange?: (range: ZoomRange | null) => void
  /** Calendar day under the axis pointer (hover), or null on leave. */
  onPointerDate?: (date: string | null) => void
}

const PERIODS: ChartPeriod[] = ['1M', '3M', '1Y', '2Y']
const EMPTY_MARKERS: OperationMarker[] = []
const CHART_STYLE = { height: 400, width: '100%' as const }
const CHART_OPTS = { renderer: 'canvas' as const }

export default function PortfolioChart({
  series,
  markers,
  mode,
  period,
  onPeriod,
  height = 400,
  showPeriodBar = true,
  axisDates,
  periodRange = null,
  zoomRange = null,
  onZoomRangeChange,
  onPointerDate,
}: Props) {
  const chartRef = useRef<ReactECharts>(null)
  const axisDatesRef = useRef<string[]>([])
  const periodRangeRef = useRef(periodRange)
  periodRangeRef.current = periodRange
  const onZoomRef = useRef(onZoomRangeChange)
  onZoomRef.current = onZoomRangeChange
  const zoomRangeRef = useRef(zoomRange)
  zoomRangeRef.current = zoomRange
  const onPointerDateRef = useRef(onPointerDate)
  onPointerDateRef.current = onPointerDate
  const lastPointerDayRef = useRef<string | null>(null)
  /** Ignore dataZoom events caused by our own dispatchAction / option apply */
  const suppressEmit = useRef(0)

  const emitPointerDay = (raw: unknown) => {
    const dates = axisDatesRef.current
    let day = calendarDay(raw)
    // Category axisPointer sometimes yields a numeric index
    if (/^\d+$/.test(day) && dates.length) {
      const idx = Number(day)
      if (idx >= 0 && idx < dates.length) day = calendarDay(dates[idx])
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(day)) return
    if (day === lastPointerDayRef.current) return
    lastPointerDayRef.current = day
    onPointerDateRef.current?.(day)
  }
  const emitPointerDayRef = useRef(emitPointerDay)
  emitPointerDayRef.current = emitPointerDay

  // Parent often passes markers={[]} — a new [] each render would rebuild the
  // ECharts option (notMerge) and snap dataZoom back to the full window.
  const stableMarkers =
    !markers || markers.length === 0 ? EMPTY_MARKERS : markers

  const option = useMemo(() => {
    const built = buildOption(
      series,
      stableMarkers,
      mode,
      () => chartRef.current?.getEchartsInstance() ?? null,
      axisDates,
      (date) => emitPointerDayRef.current(date),
    )
    axisDatesRef.current = built.axisDates
    // Bake shared zoom so series/axis rebuilds keep the window (connect handles
    // live peer sync — do not re-apply zoom via React effects).
    const z = resolveZoomOnAxis(built.axisDates, zoomRangeRef.current)
    // Only bake shared *time* zoom onto X dataZooms — never overwrite Y scale.
    const dataZoom = (
      built.option as { dataZoom: Array<Record<string, unknown>> }
    ).dataZoom.map((dz) =>
      isXAxisDataZoom(dz)
        ? {
            ...dz,
            start: z.start,
            end: z.end,
            startValue: z.startValue,
            endValue: z.endValue,
          }
        : dz,
    )
    return { ...built.option, dataZoom }
  }, [series, stableMarkers, mode, axisDates])

  // Remount when the period window changes — ECharts otherwise keeps the first
  // category abscissa (e.g. 1Y) on the cours chart until a manual zoom.
  const axisKey =
    axisDates && axisDates.length > 0
      ? `${calendarDay(axisDates[0])}_${calendarDay(axisDates[axisDates.length - 1])}_${axisDates.length}`
      : 'no-axis'

  const syncZoom = Boolean(onZoomRangeChange)

  // Join ECharts connect group so dataZoom/axisPointer stay in lockstep.
  useEffect(() => {
    if (!syncZoom) return
    const chart = chartRef.current?.getEchartsInstance()
    if (!chart) return
    chart.group = ZOOM_SYNC_GROUP
    echarts.connect(ZOOM_SYNC_GROUP)
  }, [syncZoom, axisKey, option])

  // Parent jumps the window (period pill / envelope / double-click reset).
  // Live wheel zoom is mirrored by echarts.connect; skip when already in sync.
  useEffect(() => {
    const chart = chartRef.current?.getEchartsInstance()
    if (!chart || !axisDatesRef.current.length || !syncZoom) return
    const dates = axisDatesRef.current
    const current = readZoomRange(chart, dates, periodRangeRef.current)
    if (sameZoom(current, zoomRange ?? null)) return
    suppressEmit.current += 1
    try {
      applyZoomToChart(chart, dates, zoomRange)
    } catch {
      // disposing
    }
    const t = window.setTimeout(() => {
      suppressEmit.current = Math.max(0, suppressEmit.current - 1)
    }, 150)
    return () => {
      window.clearTimeout(t)
    }
  }, [zoomRange, syncZoom])

  useEffect(() => {
    lastPointerDayRef.current = null
  }, [axisKey])

  const chartStyle = useMemo(
    () => (height === 400 ? CHART_STYLE : { height, width: '100%' as const }),
    [height],
  )

  // Stable handlers — echarts-for-react rebinds when onEvents identity/contents change.
  const onEvents = useMemo(
    () => ({
      datazoom: (ev?: {
        dataZoomId?: string
        dataZoomIndex?: number
        batch?: Array<{ dataZoomId?: string; dataZoomIndex?: number }>
      }) => {
        if (suppressEmit.current > 0) return
        // Ignore pure Y-scale zooms — they must not rewrite the shared time window.
        type DzEv = { dataZoomId?: string; dataZoomIndex?: number }
        const batch: DzEv[] = ev?.batch?.length
          ? ev.batch
          : [{ dataZoomId: ev?.dataZoomId, dataZoomIndex: ev?.dataZoomIndex }]
        const onlyY =
          batch.length > 0 &&
          batch.every(
            (b) =>
              b.dataZoomId === 'yInside' ||
              b.dataZoomId === 'ySlider' ||
              b.dataZoomIndex === 2 ||
              b.dataZoomIndex === 3,
          )
        if (onlyY) return
        const chart = chartRef.current?.getEchartsInstance()
        if (!chart) return
        const dates = axisDatesRef.current
        if (!dates.length) return
        const next = readZoomRange(chart, dates, periodRangeRef.current)
        const prev = zoomRangeRef.current
        if (sameZoom(next, prev)) return
        onZoomRef.current?.(next)
      },
      dblclick: () => {
        const chart = chartRef.current?.getEchartsInstance()
        const dates = axisDatesRef.current
        if (chart && dates.length) {
          suppressEmit.current += 1
          try {
            applyZoomToChart(chart, dates, null)
            resetYZoom(chart)
          } catch {
            // disposing
          }
          window.setTimeout(() => {
            suppressEmit.current = Math.max(0, suppressEmit.current - 1)
          }, 150)
        }
        onZoomRef.current?.(null)
      },
      updateAxisPointer: (ev: {
        axesInfo?: Array<{ value?: string | number }>
      }) => {
        const raw = ev?.axesInfo?.[0]?.value
        if (raw == null || raw === '') return
        emitPointerDayRef.current(raw)
      },
      // Tooltip show is the most reliable hover signal with trigger:'axis'
      showTip: (ev: {
        dataIndex?: number
        name?: string
        dataByCoordSys?: Array<{
          dataByAxis?: Array<{ value?: string | number }>
        }>
      }) => {
        const fromAxis = ev?.dataByCoordSys?.[0]?.dataByAxis?.[0]?.value
        if (fromAxis != null && fromAxis !== '') {
          emitPointerDayRef.current(fromAxis)
          return
        }
        if (ev?.name) {
          emitPointerDayRef.current(ev.name)
          return
        }
        if (typeof ev?.dataIndex === 'number') {
          emitPointerDayRef.current(ev.dataIndex)
        }
      },
    }),
    [],
  )

  const onChartReady = (chart: EChartsType) => {
    // Join only when the parent opted into shared zoom (callback present).
    if (!onZoomRef.current) return
    chart.group = ZOOM_SYNC_GROUP
    echarts.connect(ZOOM_SYNC_GROUP)
  }

  return (
    <div>
      {showPeriodBar && (
        <div className="pill-row" style={{ marginBottom: '0.75rem' }}>
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              className={`pill ${period === p ? 'active' : ''}`}
              onClick={() => onPeriod(p)}
            >
              {p === '1Y' ? '1A' : p === '2Y' ? '2A' : p}
            </button>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
        Molette = zoom · glisser = déplacer · double-clic = tout l’historique
        (les pastilles 1M / 3M / 1A / 2A cadrent la vue ; on peut dézoomer
        jusqu’au maximum disponible)
        {onZoomRangeChange ? ' · zoom synchronisé entre les deux graphiques' : ''}
      </p>
      <ReactECharts
        key={`${mode}-${axisKey}`}
        ref={chartRef}
        option={option}
        style={chartStyle}
        notMerge
        lazyUpdate={false}
        opts={CHART_OPTS}
        onEvents={onEvents}
        onChartReady={onChartReady}
      />
    </div>
  )
}

type AxisParam = {
  axisValue?: string
  seriesName?: string
  value?: unknown
  color?: string
  marker?: string
}

/** ECharts getOption() often wraps scalars in one-element arrays. */
function unwrap<T>(v: T | T[] | undefined | null): T | undefined {
  if (v == null) return undefined
  return Array.isArray(v) ? v[0] : v
}

function calendarDay(v: unknown): string {
  return String(v ?? '').replace(/·abo$/, '')
}

function sameZoom(a: ZoomRange | null, b: ZoomRange | null): boolean {
  if (a === null && b === null) return true
  if (!a || !b) return false
  return a.start === b.start && a.end === b.end
}

function resolveZoomOnAxis(
  dates: string[],
  range: ZoomRange | null,
): {
  start: number
  end: number
  startValue: string
  endValue: string
} {
  if (!dates.length) {
    return { start: 0, end: 100, startValue: '', endValue: '' }
  }
  const days = dates.map(calendarDay)
  let i0 = 0
  let i1 = dates.length - 1
  if (range) {
    const found = days.findIndex((d) => d >= range.start)
    i0 = found < 0 ? 0 : found
    i1 = dates.length - 1
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i] <= range.end) {
        i1 = i
        break
      }
    }
    if (i1 < i0) i1 = i0
  }
  const last = dates.length - 1
  const start = last === 0 ? 0 : (i0 / last) * 100
  const end = last === 0 ? 100 : (i1 / last) * 100
  return {
    start,
    end,
    startValue: dates[i0],
    endValue: dates[i1],
  }
}

function isXAxisDataZoom(dz: Record<string, unknown>): boolean {
  const id = dz.id
  if (id === 'yInside' || id === 'ySlider') return false
  // Y-only zoom: has yAxisIndex and no x category zoom
  if (dz.yAxisIndex != null && dz.xAxisIndex == null) return false
  return true
}

/** Apply zoom to inside + slider so the category abscissa refreshes on both charts. */
function applyZoomToChart(
  chart: EChartsType,
  dates: string[],
  range: ZoomRange | null,
) {
  const z = resolveZoomOnAxis(dates, range)
  chart.dispatchAction({
    type: 'dataZoom',
    dataZoomIndex: 0,
    start: z.start,
    end: z.end,
    startValue: z.startValue,
    endValue: z.endValue,
  })
  chart.dispatchAction({
    type: 'dataZoom',
    dataZoomIndex: 1,
    start: z.start,
    end: z.end,
    startValue: z.startValue,
    endValue: z.endValue,
  })
  requestAnimationFrame(() => {
    try {
      chart.resize()
    } catch {
      // ignore
    }
  })
}

function resetYZoom(chart: EChartsType) {
  for (const id of ['yInside', 'ySlider'] as const) {
    chart.dispatchAction({
      type: 'dataZoom',
      dataZoomId: id,
      start: 0,
      end: 100,
    })
  }
}

function rangeFromDataZoom(
  dz: {
    startValue?: unknown
    endValue?: unknown
    start?: unknown
    end?: unknown
  },
  dates: string[],
  periodRange?: ZoomRange | null,
): ZoomRange | null {
  if (!dates.length) return null

  const startPct = Number(unwrap(dz.start as number))
  const endPct = Number(unwrap(dz.end as number))
  if (Number.isFinite(startPct) && Number.isFinite(endPct)) {
    // Full window → no shared crop
    if (startPct <= 0.5 && endPct >= 99.5) return null
  }

  const startVal = unwrap(dz.startValue as string | number)
  const endVal = unwrap(dz.endValue as string | number)
  let start: string | undefined
  let end: string | undefined

  if (startVal != null && endVal != null) {
    start = calendarDay(startVal)
    end = calendarDay(endVal)
  } else if (
    Number.isFinite(startPct) &&
    Number.isFinite(endPct) &&
    dates.length > 1
  ) {
    const last = dates.length - 1
    const i0 = Math.min(last, Math.max(0, Math.round((startPct / 100) * last)))
    const i1 = Math.min(last, Math.max(0, Math.round((endPct / 100) * last)))
    start = calendarDay(dates[Math.min(i0, i1)])
    end = calendarDay(dates[Math.max(i0, i1)])
  }

  if (!start || !end) return null

  // Full period (shared) or full local axis → treat as reset
  const fullStart = calendarDay(periodRange?.start ?? dates[0])
  const fullEnd = calendarDay(
    periodRange?.end ?? dates[dates.length - 1],
  )
  if (start <= fullStart && end >= fullEnd) return null

  const first = calendarDay(dates[0])
  const last = calendarDay(dates[dates.length - 1])
  if (start <= first && end >= last) return null

  return { start, end }
}

function readZoomRange(
  chart: EChartsType,
  dates: string[],
  periodRange?: ZoomRange | null,
): ZoomRange | null {
  try {
    const opt = chart.getOption() as {
      dataZoom?: Array<{
        id?: string
        startValue?: unknown
        endValue?: unknown
        start?: unknown
        end?: unknown
      }>
    }
    const list = (opt.dataZoom ?? []).map((raw) =>
      Array.isArray(raw) ? raw[0] : raw,
    )
    const dz =
      list.find((d) => d?.id === 'xInside' || d?.id === 'xSlider') ?? list[0]
    if (!dz) return null
    return rangeFromDataZoom(dz, dates, periodRange)
  } catch {
    return null
  }
}

function buildOption(
  series: ChartSeries[],
  markers: OperationMarker[],
  mode: 'euro' | 'index',
  getChart: () => EChartsType | null,
  axisDates?: string[],
  onPointerDate?: (date: string) => void,
) {
  const dateSet = new Set<string>()
  if (axisDates?.length) {
    for (const d of axisDates) dateSet.add(calendarDay(d))
  } else {
    for (const s of series) for (const d of s.dates) dateSet.add(calendarDay(d))
  }
  const dates = [...dateSet].sort()

  const markersByDate = new Map<string, OperationMarker[]>()
  for (const m of markers) {
    const day = calendarDay(m.date)
    const list = markersByDate.get(day) ?? []
    list.push(m)
    markersByDate.set(day, list)
  }

  const visibleIsins = new Set(
    series
      .filter((s) => s.isPosition)
      .map((s) => s.connectGroup || s.id),
  )

  const formatMoney = (n: number, currency = 'EUR') => {
    const c = (currency || 'EUR').toUpperCase()
    try {
      return n.toLocaleString('fr-FR', { style: 'currency', currency: c })
    } catch {
      return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${c}`
    }
  }

  const formatTooltipSeries = (seriesName: string, date: string, raw: unknown) => {
    const rawY = Array.isArray(raw) ? raw[1] : raw
    const chartVal = rawY == null || rawY === '' ? NaN : Number(rawY)
    const day = calendarDay(date)
    const match = series.find(
      (s) =>
        s.name === seriesName &&
        s.dates.some((d) => calendarDay(d) === day),
    )
    const cur = match?.currency || 'EUR'
    const idx =
      match?.dates.findIndex((d) => calendarDay(d) === day) ?? -1
    const price =
      idx >= 0 && match?.realPrices?.[idx] !== undefined
        ? match.realPrices[idx]
        : undefined
    const valo =
      idx >= 0 && match?.valuations?.[idx] !== undefined
        ? match.valuations[idx]
        : undefined

    const formatSignedPct = (v: number) => {
      const abs = Math.abs(v).toLocaleString('fr-FR', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
      return `${v > 0 ? '+' : v < 0 ? '−' : ''}${abs} %`
    }

    if (mode === 'index' && (price !== undefined || valo !== undefined)) {
      const primary =
        valo !== undefined && valo > 0
          ? formatMoney(valo, cur)
          : price !== undefined
            ? formatMoney(price, cur)
            : '—'
      const secondary = Number.isFinite(chartVal)
        ? ` · ${formatSignedPct(chartVal)}`
        : ''
      const priceHint =
        valo !== undefined && valo > 0 && price !== undefined
          ? ` <span style="color:${THEME.muted};font-size:11px">(${formatMoney(price, cur)})</span>`
          : ''
      return `${primary}${priceHint}<span style="color:${THEME.muted};font-size:11px">${secondary}</span>`
    }

    if (!Number.isFinite(chartVal)) return '—'
    if (match?.valueUnit === 'pct' || mode === 'index') {
      return formatSignedPct(chartVal)
    }
    return formatMoney(chartVal, cur)
  }

  /** Same HTML box for axis day hover and markPoint (triangle/square) hover. */
  const buildDayTooltipHtml = (
    dateRaw: string,
    axisParams?: AxisParam[],
  ): string => {
    const date = calendarDay(String(dateRaw || '').replace('·abo', ''))
    if (!date) return ''
    const lines: string[] = [
      `<div style="font-weight:600;margin-bottom:6px;color:${THEME.ink};font-variant-numeric:tabular-nums">${date}</div>`,
    ]

    const seen = new Set<string>()
    if (axisParams?.length) {
      for (const p of axisParams) {
        const name = p.seriesName || ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        lines.push(
          `<div style="display:flex;gap:8px;align-items:baseline;margin:2px 0">` +
            `<span>${p.marker || ''}</span>` +
            `<span style="flex:1">${escapeHtml(name)}</span>` +
            `<span style="font-variant-numeric:tabular-nums;text-align:right">${formatTooltipSeries(name, date, p.value)}</span>` +
            `</div>`,
        )
      }
    } else {
      // MarkPoint hover: rebuild series rows from data for that day
      for (const s of series) {
        if (s.showInLegend === false) continue
        if (seen.has(s.name)) continue
        const idx = s.dates.findIndex((d) => calendarDay(d) === date)
        if (idx < 0 || s.values[idx] == null) continue
        seen.add(s.name)
        lines.push(
          `<div style="display:flex;gap:8px;align-items:baseline;margin:2px 0">` +
            `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color || THEME.accent}"></span>` +
            `<span style="flex:1">${escapeHtml(s.name)}</span>` +
            `<span style="font-variant-numeric:tabular-nums;text-align:right">${formatTooltipSeries(s.name, date, s.values[idx])}</span>` +
            `</div>`,
        )
      }
    }

    const dayMarkers = (markersByDate.get(date) ?? [])
      .filter((m) => visibleIsins.has(m.seriesId))
      .slice()
      .sort((a, b) => {
        const rank = (k: typeof a.kind) =>
          k === 'entry' || k === 'exit' ? 0 : 1
        return rank(a.kind) - rank(b.kind)
      })
    if (dayMarkers.length) {
      lines.push(
        `<div style="margin-top:8px;padding-top:8px;border-top:1px solid ${LINE(0.18)};color:${THEME.muted};font-size:11px;text-transform:uppercase;letter-spacing:.06em">Opérations</div>`,
      )
      for (const m of dayMarkers) {
        lines.push(
          `<div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:${LINE(0.08)}">${formatMarkerTooltip(m)}</div>`,
        )
      }
    }
    return lines.join('')
  }

  const echartsSeries = series.map((s) => {
    const markData = s.isPosition
      ? markers
          .filter((m) => m.seriesId === s.id || m.seriesId === s.connectGroup)
          // Draw events first, trades last → triangles on top
          .slice()
          .sort((a, b) => {
            const rank = (k: typeof a.kind) =>
              k === 'event' ? 0 : k === 'entry' || k === 'exit' ? 1 : 2
            return rank(a.kind) - rank(b.kind) || a.date.localeCompare(b.date)
          })
          .map((m) => {
            const day = calendarDay(m.date)
            if (!dates.includes(day)) return null
            const idx = s.dates.findIndex((d) => calendarDay(d) === day)
            const y =
              idx >= 0 && s.values[idx] != null
                ? s.values[idx]!
                : undefined
            if (y === undefined) return null
            if (s.showInLegend === false && idx === 0) return null
            const isTrade = m.kind === 'entry' || m.kind === 'exit'
            return {
              name: `${m.type} ${m.date}`,
              coord: [day, y] as [string, number],
              value: m.quantity ?? m.netAmount ?? 0,
              vfDate: day,
              symbol: isTrade ? 'triangle' : 'rect',
              symbolSize: isTrade ? 16 : 12,
              symbolRotate: m.kind === 'exit' ? 180 : 0,
              z: isTrade ? 10 : 1,
              itemStyle: {
                color:
                  m.kind === 'entry'
                    ? THEME.ok
                    : m.kind === 'exit'
                      ? THEME.danger
                      : THEME.neutral,
              },
            }
          })
          .filter(Boolean)
      : []

    const showSymbol = s.showSymbol ?? Boolean(s.step)
    const defaultSymbolSize = showSymbol ? (s.step ? 5 : 6) : 0
    const symbolDays = s.symbolDates?.length
      ? new Set(s.symbolDates.map((d) => calendarDay(d)))
      : null
    return {
      id: s.id,
      name: s.name,
      type: 'line' as const,
      yAxisIndex: s.yAxisIndex ?? 0,
      showSymbol: showSymbol || Boolean(symbolDays),
      symbolSize: symbolDays ? 0 : defaultSymbolSize,
      smooth: false,
      connectNulls: s.connectNulls ?? false,
      step: s.step ? (s.step === true ? 'end' : s.step) : undefined,
      showLegendSymbol: s.showInLegend !== false,
      lineStyle: {
        width: s.yAxisIndex === 1 ? 1.75 : 2,
        type: s.dashed ? ('dashed' as const) : ('solid' as const),
        color: s.color,
      },
      itemStyle: s.color ? { color: s.color } : undefined,
      data: dates.map((day) => {
        const idx = s.dates.findIndex((d) => calendarDay(d) === day)
        const v = idx >= 0 ? s.values[idx] : null
        if (!symbolDays) return [day, v] as [string, number | null]
        return {
          value: [day, v] as [string, number | null],
          symbolSize:
            v != null && symbolDays.has(day) ? defaultSymbolSize || 6 : 0,
        }
      }),
      markPoint: markData.length
        ? {
            animation: false,
            // Hover on triangle/square → same day tooltip box as axis hover
            tooltip: {
              show: true,
              trigger: 'item',
              formatter: (params: {
                data?: { vfDate?: string; coord?: [string, number] }
              }) => {
                const day =
                  params.data?.vfDate ||
                  params.data?.coord?.[0] ||
                  ''
                return buildDayTooltipHtml(day)
              },
            },
            label: { show: false },
            emphasis: { scale: 1.45, label: { show: false } },
            data: markData as object[],
          }
        : undefined,
      markLine:
        s.levels && s.levels.length
          ? {
              symbol: 'none',
              animation: false,
              emphasis: { label: { show: true } },
              tooltip: {
                show: true,
                trigger: 'item',
                formatter: (params: {
                  name?: string
                  data?: {
                    vfKind?: string
                    vfPrice?: number
                    vfPct?: number
                    vfCurrency?: string
                    value?: number
                  }
                }) => {
                  const d = params.data
                  const isSup = d?.vfKind === 'support'
                  const kind = isSup ? 'Support' : 'Résistance'
                  const cur = (d?.vfCurrency || s.currency || 'EUR').toUpperCase()
                  const price =
                    d?.vfPrice != null && Number.isFinite(d.vfPrice)
                      ? formatMoney(d.vfPrice, cur)
                      : null
                  const pct =
                    d?.vfPct != null && Number.isFinite(d.vfPct)
                      ? `${d.vfPct > 0 ? '+' : ''}${d.vfPct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`
                      : null
                  const lines = [
                    `<div style="font-weight:600;margin-bottom:4px">${kind}</div>`,
                  ]
                  if (price) {
                    lines.push(
                      `<div>Cours du niveau : <b>${price}</b></div>`,
                    )
                  }
                  if (pct) {
                    lines.push(
                      `<div class="muted">vs 1ᵉʳ achat : ${pct}</div>`,
                    )
                  }
                  return `<div style="min-width:140px">${lines.join('')}</div>`
                },
              },
              label: {
                show: true,
                position: 'insideEndTop',
                fontSize: 10,
                color: THEME.muted,
                formatter: (p: { name?: string }) => p.name || '',
              },
              data: s.levels.map((lv) => {
                const isSup = lv.kind === 'support'
                const w = 1 + lv.strength * 3
                return {
                  name: lv.label ?? (isSup ? 'S' : 'R'),
                  yAxis: lv.value,
                  vfKind: lv.kind,
                  vfPrice: lv.price,
                  vfPct: lv.value,
                  vfCurrency: lv.currency ?? s.currency,
                  lineStyle: {
                    type: 'solid' as const,
                    width: w,
                    color: isSup ? THEME.ok : THEME.danger,
                    opacity: 0.55 + lv.strength * 0.35,
                  },
                }
              }),
            }
          : undefined,
    }
  })

  const legendNames = [
    ...new Set(
      series.filter((s) => s.showInLegend !== false).map((s) => s.name),
    ),
  ]

  const option = {
    backgroundColor: 'transparent',
    color: SERIES_PALETTE,
    animationDurationUpdate: 200,
    textStyle: { color: THEME.muted, fontFamily: THEME.font },
    toolbox: {
      right: 8,
      top: 28,
      iconStyle: { borderColor: THEME.muted },
      feature: {
        dataZoom: {
          // Include primary Y so a drag-rectangle can tighten % / € scale
          xAxisIndex: 0,
          yAxisIndex: 0,
          title: {
            zoom: 'Zoom zone (temps + échelle)',
            back: 'Annuler zoom',
          },
        },
        restore: { title: 'Réinitialiser' },
      },
    },
    tooltip: {
      trigger: 'axis',
      className: 'vf-echarts-tooltip',
      appendToBody: true,
      confine: false,
      // Must not capture the pointer — otherwise pan/drag stops when the
      // tooltip flips under the cursor (common when dragging right).
      enterable: false,
      hideDelay: 0,
      backgroundColor: THEME.tooltipBg,
      borderColor: LINE(0.25),
      textStyle: { color: THEME.ink, fontSize: 12, fontFamily: THEME.font },
      extraCssText:
        'z-index:2147483646;max-width:min(380px,92vw);pointer-events:none;box-shadow:0 8px 28px rgba(0,0,0,.45);white-space:normal;line-height:1.35',
      position: (
        pos: number[],
        _params: unknown,
        _dom: HTMLElement,
        _rect: unknown,
        size: { contentSize: number[]; viewSize: number[] },
      ) => {
        const [boxW, boxH] = size.contentSize
        const gap = 16
        const chart = getChart()
        const el = chart?.getDom()
        const bounds = el?.getBoundingClientRect()
        if (!bounds) {
          return [pos[0] + gap, pos[1] - gap]
        }

        // Prefer below-right of the cursor so the box stays out of the drag path
        let pageX = bounds.left + pos[0] + gap
        let pageY = bounds.top + pos[1] + gap

        if (pageX + boxW > window.innerWidth - 8) {
          pageX = bounds.left + pos[0] - boxW - gap
        }
        if (pageX < 8) pageX = 8
        if (pageY + boxH > window.innerHeight - 8) {
          pageY = bounds.top + pos[1] - boxH - gap
        }
        if (pageY < 8) pageY = 8

        return [pageX - bounds.left, pageY - bounds.top]
      },
      axisPointer: {
        type: 'line',
        snap: true,
        label: { show: false },
        lineStyle: { color: LINE(0.45), width: 1, type: 'dashed' },
      },
      formatter: (params: AxisParam[] | AxisParam) => {
        const list = Array.isArray(params) ? params : [params]
        if (!list.length) return ''
        // markPoint item hover also hits this formatter in some ECharts versions
        const first = list[0] as AxisParam & {
          componentType?: string
          data?: { vfDate?: string; coord?: [string, number] }
        }
        if (first.componentType === 'markPoint') {
          const day =
            first.data?.vfDate || first.data?.coord?.[0] || ''
          if (day) onPointerDate?.(calendarDay(day))
          return buildDayTooltipHtml(day)
        }
        if (first.componentType === 'markLine') {
          const d = first.data as {
            vfKind?: string
            vfPrice?: number
            vfPct?: number
            vfCurrency?: string
          }
          const isSup = d?.vfKind === 'support'
          const kind = isSup ? 'Support' : 'Résistance'
          const cur = (d?.vfCurrency || 'EUR').toUpperCase()
          const price =
            d?.vfPrice != null && Number.isFinite(d.vfPrice)
              ? formatMoney(d.vfPrice, cur)
              : null
          const pct =
            d?.vfPct != null && Number.isFinite(d.vfPct)
              ? `${d.vfPct > 0 ? '+' : ''}${d.vfPct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`
              : null
          const bits = [`<div style="font-weight:600;margin-bottom:4px">${kind}</div>`]
          if (price) bits.push(`<div>Cours du niveau : <b>${price}</b></div>`)
          if (pct) bits.push(`<div style="opacity:.75">vs 1ᵉʳ achat : ${pct}</div>`)
          return `<div style="min-width:140px">${bits.join('')}</div>`
        }
        const date = String(first.axisValue ?? '').replace('·abo', '')
        if (date) onPointerDate?.(calendarDay(date))
        return buildDayTooltipHtml(date, list)
      },
    },
    legend: {
      top: 0,
      data: legendNames,
      textStyle: { color: THEME.muted },
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 3,
    },
    grid: {
      left: 72,
      right: series.some((s) => s.yAxisIndex === 1) ? 52 : 24,
      top: 52,
      bottom: 72,
    },
    dataZoom: [
      {
        type: 'inside',
        id: 'xInside',
        xAxisIndex: 0,
        filterMode: 'none',
        start: 0,
        end: 100,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        preventDefaultMouseMove: true,
        throttle: 50,
      },
      {
        type: 'slider',
        id: 'xSlider',
        xAxisIndex: 0,
        filterMode: 'none',
        start: 0,
        end: 100,
        height: 22,
        bottom: 12,
        borderColor: LINE(0.18),
        backgroundColor: LINE(0.04),
        fillerColor: ACCENT(0.16),
        handleStyle: { color: THEME.accent },
        moveHandleStyle: { color: ACCENT(0.5) },
        textStyle: { color: THEME.muted, fontSize: 10 },
        dataBackground: {
          lineStyle: { color: ACCENT(0.4) },
          areaStyle: { color: ACCENT(0.08) },
        },
      },
      // Primary Y scale (%, €) — drag the left slider or Shift+wheel on the chart
      {
        type: 'inside',
        id: 'yInside',
        yAxisIndex: 0,
        filterMode: 'none',
        start: 0,
        end: 100,
        zoomOnMouseWheel: 'shift',
        moveOnMouseMove: true,
        moveOnMouseWheel: 'shift',
        throttle: 50,
      },
      {
        type: 'slider',
        id: 'ySlider',
        yAxisIndex: 0,
        filterMode: 'none',
        start: 0,
        end: 100,
        width: 16,
        left: 8,
        top: 52,
        bottom: 72,
        borderColor: LINE(0.18),
        backgroundColor: LINE(0.04),
        fillerColor: ACCENT(0.16),
        handleStyle: { color: THEME.accent },
        moveHandleStyle: { color: ACCENT(0.5) },
        textStyle: { color: THEME.muted, fontSize: 9 },
        showDetail: false,
        brushSelect: false,
      },
    ],
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: LINE(0.25) } },
      axisLabel: {
        color: THEME.muted,
        hideOverlap: true,
        showMinLabel: true,
        showMaxLabel: true,
        formatter: (v: string) => {
          const d = v.replace('·abo', '')
          // YY-MM-DD keeps year visible on multi-year axes
          return d.length >= 10 ? d.slice(2) : d
        },
      },
    },
    yAxis: (() => {
      const primary = {
        type: 'value' as const,
        scale: true,
        splitLine: { lineStyle: { color: LINE(0.1) } },
        axisLabel: {
          color: THEME.muted,
          formatter: (v: number) => {
            if (mode !== 'index') return compactEur(v)
            const rounded = Math.round(v)
            if (rounded > 0) return `+${rounded} %`
            if (rounded < 0) return `${rounded} %`
            return '0 %'
          },
        },
      }
      if (!series.some((s) => s.yAxisIndex === 1)) return primary
      return [
        primary,
        {
          type: 'value' as const,
          scale: true,
          position: 'right' as const,
          splitLine: { show: false },
          axisLine: { show: true, lineStyle: { color: `rgba(${THEME.triRgb}, 0.45)` } },
          axisLabel: {
            color: THEME.tri,
            formatter: (v: number) =>
              `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} %`,
          },
        },
      ]
    })(),
    series: echartsSeries,
  }

  return { option, axisDates: dates }
}

function compactEur(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}k`
  return String(Math.round(v))
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
