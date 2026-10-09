import { useEffect, useMemo, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsType } from 'echarts'
import type { ChartPeriod } from '@/domain/types'
import {
  formatMarkerTooltip,
  type OperationMarker,
} from '@/engine/markers'

export interface ChartSeries {
  id: string
  name: string
  dates: string[]
  values: number[]
  dashed?: boolean
  isPosition?: boolean
  step?: boolean | 'start' | 'middle' | 'end'
  color?: string
  /** Only first segment of a multi-segment line should appear in legend */
  showInLegend?: boolean
  connectGroup?: string
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
  /** Shared zoom (null = full period). */
  zoomRange?: ZoomRange | null
  onZoomRangeChange?: (range: ZoomRange | null) => void
}

const PERIODS: ChartPeriod[] = ['1M', '3M', '1Y', '3Y', '10Y', 'MAX']

export default function PortfolioChart({
  series,
  markers = [],
  mode,
  period,
  onPeriod,
  height = 400,
  showPeriodBar = true,
  zoomRange = null,
  onZoomRangeChange,
}: Props) {
  const chartRef = useRef<ReactECharts>(null)
  const axisDatesRef = useRef<string[]>([])
  const onZoomRef = useRef(onZoomRangeChange)
  onZoomRef.current = onZoomRangeChange
  const zoomRangeRef = useRef(zoomRange)
  zoomRangeRef.current = zoomRange
  /** Ignore dataZoom events caused by our own dispatchAction / option apply */
  const suppressEmit = useRef(0)

  const option = useMemo(() => {
    const built = buildOption(series, markers, mode, () =>
      chartRef.current?.getEchartsInstance() ?? null,
    )
    axisDatesRef.current = built.axisDates
    return built.option
  }, [series, markers, mode])

  // Apply shared zoom from the peer chart only (never on every series rebuild + emit)
  useEffect(() => {
    const chart = chartRef.current?.getEchartsInstance()
    if (!chart || !axisDatesRef.current.length) return

    const dates = axisDatesRef.current
    const current = readZoomRange(chart, dates)
    if (sameZoom(current, zoomRange ?? null)) return

    suppressEmit.current += 1
    try {
      chart.dispatchAction({
        type: 'dataZoom',
        ...resolveZoomOnAxis(dates, zoomRange ?? null),
      })
    } catch {
      // chart may be disposing
    }
    // ECharts may emit datazoom async — keep suppress for a tick
    const t = window.setTimeout(() => {
      suppressEmit.current = Math.max(0, suppressEmit.current - 1)
    }, 50)
    return () => {
      window.clearTimeout(t)
      suppressEmit.current = Math.max(0, suppressEmit.current - 1)
    }
  }, [zoomRange])

  // After series/option replace (notMerge), re-apply current shared zoom silently
  useEffect(() => {
    const chart = chartRef.current?.getEchartsInstance()
    if (!chart || !zoomRangeRef.current) return
    const dates = axisDatesRef.current
    if (!dates.length) return
    suppressEmit.current += 1
    try {
      chart.dispatchAction({
        type: 'dataZoom',
        ...resolveZoomOnAxis(dates, zoomRangeRef.current),
      })
    } catch {
      // ignore
    }
    const t = window.setTimeout(() => {
      suppressEmit.current = Math.max(0, suppressEmit.current - 1)
    }, 50)
    return () => {
      window.clearTimeout(t)
      suppressEmit.current = Math.max(0, suppressEmit.current - 1)
    }
  }, [series, markers, mode])

  const emitZoomFromChart = () => {
    if (suppressEmit.current > 0) return
    const chart = chartRef.current?.getEchartsInstance()
    if (!chart) return
    const dates = axisDatesRef.current
    if (!dates.length) return
    const next = readZoomRange(chart, dates)
    const prev = zoomRangeRef.current
    if (sameZoom(next, prev)) return
    onZoomRef.current?.(next)
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
              {p === '1Y' ? '1A' : p === '3Y' ? '3A' : p === '10Y' ? '10A' : p}
            </button>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
        Molette = zoom · glisser = déplacer · double-clic = réinitialiser
        {onZoomRangeChange ? ' · zoom synchronisé entre les deux graphiques' : ''}
      </p>
      <ReactECharts
        ref={chartRef}
        option={option}
        style={{ height, width: '100%' }}
        notMerge
        opts={{ renderer: 'canvas' }}
        onEvents={{
          datazoom: () => emitZoomFromChart(),
          dblclick: () => {
            suppressEmit.current += 1
            const chart = chartRef.current?.getEchartsInstance()
            try {
              chart?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
            } catch {
              // ignore
            }
            onZoomRef.current?.(null)
            window.setTimeout(() => {
              suppressEmit.current = Math.max(0, suppressEmit.current - 1)
            }, 50)
          },
        }}
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
): { start: number; end: number } | { startValue: string; endValue: string } {
  if (!range || !dates.length) return { start: 0, end: 100 }
  const days = dates.map(calendarDay)
  let i0 = days.findIndex((d) => d >= range.start)
  if (i0 < 0) i0 = 0
  let i1 = dates.length - 1
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i] <= range.end) {
      i1 = i
      break
    }
  }
  if (i1 < i0) i1 = i0
  return { startValue: dates[i0], endValue: dates[i1] }
}

function rangeFromDataZoom(
  dz: {
    startValue?: unknown
    endValue?: unknown
    start?: unknown
    end?: unknown
  },
  dates: string[],
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

  // Spans whole axis → treat as reset (avoids null ↔ full-range ping-pong)
  const first = calendarDay(dates[0])
  const last = calendarDay(dates[dates.length - 1])
  if (start <= first && end >= last) return null

  return { start, end }
}

function readZoomRange(
  chart: EChartsType,
  dates: string[],
): ZoomRange | null {
  try {
    const opt = chart.getOption() as {
      dataZoom?: Array<{
        startValue?: unknown
        endValue?: unknown
        start?: unknown
        end?: unknown
      }>
    }
    const raw = opt.dataZoom?.[0]
    if (!raw) return null
    // getOption may nest dataZoom entries
    const dz = Array.isArray(raw) ? raw[0] : raw
    return rangeFromDataZoom(dz ?? {}, dates)
  } catch {
    return null
  }
}

function buildOption(
  series: ChartSeries[],
  markers: OperationMarker[],
  mode: 'euro' | 'index',
  getChart: () => EChartsType | null,
) {
  const dateSet = new Set<string>()
  for (const s of series) for (const d of s.dates) dateSet.add(d)
  const dates = [...dateSet].sort()

  const markersByDate = new Map<string, OperationMarker[]>()
  for (const m of markers) {
    const list = markersByDate.get(m.date) ?? []
    list.push(m)
    markersByDate.set(m.date, list)
  }

  const visibleIsins = new Set(
    series
      .filter((s) => s.isPosition)
      .map((s) => s.connectGroup || s.id),
  )

  const echartsSeries = series.map((s) => {
    const markData = s.isPosition
      ? markers
          .filter((m) => m.seriesId === s.id || m.seriesId === s.connectGroup)
          .map((m) => {
            const idx = s.dates.indexOf(m.date)
            if (idx < 0) return null
            if (s.showInLegend === false && idx === 0) return null
            return {
              name: `${m.type} ${m.date}`,
              coord: [s.dates[idx], s.values[idx]] as [string, number],
              value: m.quantity ?? 0,
              symbol: 'triangle',
              symbolSize: 11,
              symbolRotate: m.kind === 'entry' ? 0 : 180,
              itemStyle: {
                color: m.kind === 'entry' ? '#5fad7a' : '#e07a5f',
              },
            }
          })
          .filter(Boolean)
      : []

    return {
      id: s.id,
      name: s.name,
      type: 'line' as const,
      showSymbol: Boolean(s.step),
      symbolSize: s.step ? 5 : 0,
      smooth: false,
      step: s.step ? (s.step === true ? 'end' : s.step) : undefined,
      showLegendSymbol: s.showInLegend !== false,
      lineStyle: {
        width: 2,
        type: s.dashed ? ('dashed' as const) : ('solid' as const),
        color: s.color,
      },
      itemStyle: s.color ? { color: s.color } : undefined,
      data: s.dates.map((d, i) => [d, s.values[i]]),
      markPoint: markData.length
        ? {
            animation: false,
            tooltip: { show: false },
            label: { show: false },
            emphasis: { scale: 1.35, label: { show: false } },
            data: markData as object[],
          }
        : undefined,
    }
  })

  const legendNames = [
    ...new Set(
      series.filter((s) => s.showInLegend !== false).map((s) => s.name),
    ),
  ]

  const formatValue = (v: unknown) => {
    const n = Array.isArray(v) ? Number(v[1]) : Number(v)
    if (!Number.isFinite(n)) return '—'
    return mode === 'index'
      ? n.toFixed(2)
      : n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
  }

  const option = {
    backgroundColor: 'transparent',
    animationDurationUpdate: 200,
    textStyle: { color: '#9bb5a8', fontFamily: 'DM Sans' },
    toolbox: {
      right: 8,
      top: 28,
      iconStyle: { borderColor: '#9bb5a8' },
      feature: {
        dataZoom: {
          yAxisIndex: 'none',
          title: { zoom: 'Zoom zone', back: 'Annuler zoom' },
        },
        restore: { title: 'Réinitialiser' },
      },
    },
    tooltip: {
      trigger: 'axis',
      className: 'vf-echarts-tooltip',
      appendToBody: true,
      confine: false,
      enterable: true,
      hideDelay: 80,
      backgroundColor: 'rgba(12, 24, 18, 0.96)',
      borderColor: 'rgba(196, 163, 90, 0.35)',
      textStyle: { color: '#e8f0eb', fontSize: 12 },
      extraCssText:
        'z-index:2147483646;max-width:min(380px,92vw);pointer-events:auto;box-shadow:0 8px 28px rgba(0,0,0,.45);white-space:normal;line-height:1.35',
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

        let pageX = bounds.left + pos[0] + gap
        let pageY = bounds.top + pos[1] - gap

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
      formatter: (params: AxisParam[] | AxisParam) => {
        const list = Array.isArray(params) ? params : [params]
        if (!list.length) return ''
        const date = String(list[0].axisValue ?? '').replace('·abo', '')
        const lines: string[] = [
          `<div style="font-weight:600;margin-bottom:6px;color:#c4a35a">${date}</div>`,
        ]

        const seen = new Set<string>()
        for (const p of list) {
          const name = p.seriesName || ''
          if (!name || seen.has(name)) continue
          seen.add(name)
          lines.push(
            `<div style="display:flex;gap:8px;align-items:baseline;margin:2px 0">` +
              `<span>${p.marker || ''}</span>` +
              `<span style="flex:1">${escapeHtml(name)}</span>` +
              `<span style="font-variant-numeric:tabular-nums">${formatValue(p.value)}</span>` +
              `</div>`,
          )
        }

        const dayMarkers = (markersByDate.get(date) ?? []).filter((m) =>
          visibleIsins.has(m.seriesId),
        )
        if (dayMarkers.length) {
          lines.push(
            `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(232,240,235,.15);color:#9bb5a8;font-size:11px">Opérations</div>`,
          )
          for (const m of dayMarkers) {
            lines.push(
              `<div style="margin-top:6px;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.25)">${formatMarkerTooltip(m)}</div>`,
            )
          }
        }
        return lines.join('')
      },
    },
    legend: {
      top: 0,
      data: legendNames,
      textStyle: { color: '#9bb5a8' },
    },
    grid: { left: 55, right: 24, top: 52, bottom: 72 },
    dataZoom: [
      {
        type: 'inside',
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
        xAxisIndex: 0,
        filterMode: 'none',
        start: 0,
        end: 100,
        height: 22,
        bottom: 12,
        borderColor: 'rgba(232,240,235,0.15)',
        backgroundColor: 'rgba(0,0,0,0.25)',
        fillerColor: 'rgba(125, 206, 160, 0.18)',
        handleStyle: { color: '#c4a35a' },
        textStyle: { color: '#9bb5a8', fontSize: 10 },
        dataBackground: {
          lineStyle: { color: 'rgba(125,206,160,0.35)' },
          areaStyle: { color: 'rgba(125,206,160,0.08)' },
        },
      },
    ],
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(232,240,235,0.2)' } },
      axisLabel: {
        color: '#9bb5a8',
        formatter: (v: string) => v.replace('·abo', '').slice(2),
      },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: 'rgba(232,240,235,0.08)' } },
      axisLabel: {
        color: '#9bb5a8',
        formatter: (v: number) =>
          mode === 'index' ? String(Math.round(v)) : compactEur(v),
      },
    },
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
