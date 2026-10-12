import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChartPeriod, EnvelopeType, VirtualOpening } from '@/domain/types'
import {
  loadEnvelopeProjected,
  loadProjected,
} from '@/persist/portfolioStore'
import { buildHoldingsSeries, type HoldingsSnapshot } from '@/engine/positions'
import { buildOperationMarkers } from '@/engine/markers'
import {
  buildPriceCompareSeries,
  buildPruStepSeries,
} from '@/engine/priceCompare'
import {
  computeCalendarYearTris,
  computeConsolidatedPortfolioTri,
  computeMonthlyTriSeries,
  computePortfolioTri,
  densifyTriSeries,
  listEnvelopeExternalFlows,
  listPositionTradeFlows,
  spansMoreThanOneMonth,
  sumEnvelopeExternalFlows,
} from '@/engine/tri'
import {
  clipInactivePositionValues,
  mergeValuedSeries,
  quoteKeyForSupport,
  sliceByPeriod,
  valueHoldingsSeries,
} from '@/engine/valuation'
import {
  getAllQuoteMaps,
  refreshQuotesForSupports,
} from '@/quotes/localQuoteCache'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import PortfolioChart, {
  type ChartSeries,
  type ZoomRange,
} from '@/ui/components/PortfolioChart'

type ChartsTab = 'historique' | 'valorisation'
type ChartScope = EnvelopeType | 'ALL'
const ALL_ENVELOPES: EnvelopeType[] = ['PEA', 'PEA_PME', 'CTO']

function fmtEur(n: number): string {
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

function mergeHoldingsSnapshots(
  seriesList: HoldingsSnapshot[][],
): HoldingsSnapshot[] {
  const lists = seriesList.filter((s) => s.length > 0)
  if (!lists.length) return []
  if (lists.length === 1) return lists[0]

  const dateSet = new Set<string>()
  for (const series of lists) for (const h of series) dateSet.add(h.date)
  const dates = [...dateSet].sort()
  const cursors = lists.map(() => 0)
  const last: Array<HoldingsSnapshot | null> = lists.map(() => null)
  const out: HoldingsSnapshot[] = []

  for (const date of dates) {
    const quantities = new Map<string, number>()
    let cash = 0
    for (let i = 0; i < lists.length; i++) {
      const series = lists[i]
      while (
        cursors[i] < series.length &&
        series[cursors[i]].date <= date
      ) {
        last[i] = series[cursors[i]]
        cursors[i] += 1
      }
      const h = last[i]
      if (!h) continue
      cash += h.cash
      for (const [isin, qty] of h.quantities) {
        quantities.set(isin, (quantities.get(isin) ?? 0) + qty)
      }
    }
    out.push({ date, quantities, cash })
  }
  return out
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toLocaleString('fr-FR', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })} %`
}

/** Earliest VO / operation date — NEVER use operations[0] (Fortuneo exports are often newest-first). */
function historyStartForScope(
  vos: VirtualOpening[],
  operations: { date: string }[],
): string {
  let start = ''
  for (const vo of vos) {
    if (vo.date && (!start || vo.date < start)) start = vo.date
  }
  for (const o of operations) {
    if (o.date && (!start || o.date < start)) start = o.date
  }
  return start || '2020-01-01'
}

export default function ChartsPage() {
  const [tab, setTab] = useState<ChartsTab>('historique')
  const [envelope, setEnvelope] = useState<ChartScope>('PEA')
  const [period, setPeriod] = useState<ChartPeriod>('2Y')
  const [selectedIsins, setSelectedIsins] = useState<string[]>([])
  const [pickerFilter, setPickerFilter] = useState('')
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null)
  /** Date sous le curseur (onglet Valorisation) — défaut = fin de période. */
  const [pointerDate, setPointerDate] = useState<string | null>(null)
  const autoRefreshDone = useRef(false)

  const setPeriodAndResetZoom = (p: ChartPeriod) => {
    setZoomRange(null)
    setPeriod(p)
  }

  useEffect(() => {
    setZoomRange(null)
    setPointerDate(null)
    // Allow auto-refresh again when switching PEA ↔ PEA-PME ↔ CTO
    autoRefreshDone.current = false
  }, [envelope, period])

  const onZoomRangeChange = (range: ZoomRange | null) => {
    setZoomRange((prev) => {
      if (range === null && prev === null) return prev
      if (
        range &&
        prev &&
        range.start === prev.start &&
        range.end === prev.end
      ) {
        return prev
      }
      return range
    })
  }

  const { data, loading, error, reload } = useAsyncData(async () => {
    try {
      await ensureHistoricalSupports()
    } catch (e) {
      console.warn('ensureHistoricalSupports', e)
    }
    const quotes = await getAllQuoteMaps()
    if (envelope === 'ALL') {
      const projected = await loadProjected()
      return {
        operations: projected.operations,
        supports: projected.supports,
        vos: projected.virtualOpenings as VirtualOpening[],
        quotes,
        scope: 'ALL' as const,
      }
    }
    const projected = await loadEnvelopeProjected(envelope)
    return {
      operations: projected.operations,
      supports: projected.supports,
      vos: (projected.virtualOpening
        ? [projected.virtualOpening]
        : []) as VirtualOpening[],
      quotes,
      scope: envelope,
    }
  }, [envelope])

  const model = useMemo(() => {
    if (!data) return null
    try {
      const scopes: EnvelopeType[] =
        data.scope === 'ALL' ? ALL_ENVELOPES : [data.scope]
      const quotes = data.quotes

      const perEnvHoldings = scopes.map((env) => {
        const vo = data.vos.find((v) => v.envelope === env) ?? null
        const series = buildHoldingsSeries({
          envelope: env,
          operations: data.operations,
          virtualOpening: vo,
        })
        // Idle cash today only on the last snapshot (not projected backward)
        const reported = vo?.reportedCash ?? 0
        if (series.length && Math.abs(reported) > 1e-9) {
          const last = series[series.length - 1]
          series[series.length - 1] = { ...last, cash: reported }
        }
        return series
      })
      const holdings = mergeHoldingsSnapshots(perEnvHoldings)
      if (!holdings.length) return null

      const allDates = holdings.map((h) => h.date)
      const { from, to } = sliceByPeriod(allDates, period)
      const sliced = holdings.filter((h) => h.date >= from && h.date <= to)
      const axisDates = sliced.map((h) => h.date)
      const periodRange = { start: from, end: to }

      const valuedParts = perEnvHoldings.map((hSeries, idx) => {
        const env = scopes[idx]
        const partSliced = hSeries.filter((h) => h.date >= from && h.date <= to)
        return valueHoldingsSeries({
          holdings: partSliced,
          supports: data.supports,
          quotes,
          operations: data.operations.filter((o) => o.envelope === env),
        })
      })
      const valued = mergeValuedSeries(valuedParts)

      /** Portefeuille seul (onglet Valorisation) + TRI mensuel sur 2ᵉ axe */
      const startDay = valued[0]?.date
      const endDay = valued[valued.length - 1]?.date
      const valuedTotals = valued.map((v) => ({
        date: v.date,
        total: v.total,
      }))
      const midTriFlows =
        startDay && endDay
          ? scopes.flatMap((env) =>
              listEnvelopeExternalFlows({
                operations: data.operations,
                envelope: env,
                from: startDay,
                to: endDay,
                includeStartDay: false,
              }),
            )
          : []
      const triCurve = computeMonthlyTriSeries({
        valued: valuedTotals,
        midFlows: midTriFlows,
      })
      const triAxisDates = valued.map((v) => v.date)
      const triDense = densifyTriSeries(triCurve, triAxisDates)
      const calendarTris =
        startDay && endDay && spansMoreThanOneMonth(startDay, endDay)
          ? computeCalendarYearTris({
              valued: valuedTotals,
              midFlows: midTriFlows,
              asOf: endDay,
            })
          : []

      const portfolioSeries: ChartSeries[] = [
        {
          id: 'total',
          name:
            data.scope === 'ALL' ? 'Portefeuille (toutes enveloppes)' : 'Portefeuille',
          dates: valued.map((v) => v.date),
          values: valued.map((v) => v.total),
          showInLegend: true,
        },
        {
          id: 'tri',
          name: 'TRI annualisé',
          dates: triDense.map((p) => p.date),
          values: triDense.map((p) =>
            p.rate == null ? null : p.rate * 100,
          ),
          yAxisIndex: 1,
          valueUnit: 'pct',
          color: '#6eb5ff',
          dashed: true,
          showInLegend: true,
          // Densified polyline for tooltip; symbols only on month-end knots
          connectNulls: true,
          showSymbol: true,
          symbolDates: triCurve
            .filter((p) => p.rate != null)
            .map((p) => p.date),
        },
      ]

      /** Valorisation des titres sélectionnés — sans total */
      const positionValo: ChartSeries[] = []
      const holdingsByDate = new Map(
        sliced.map((h) => [h.date, h] as const),
      )
      for (const isin of selectedIsins) {
        const s = data.supports.find((x) => x.isin === isin)
        const opName = data.operations.find((o) => o.isin === isin && o.name)
          ?.name
        const rawValues = valued.map((v) => v.byIsin[isin] ?? 0)
        const held = valued.map((v) => {
          const qty = holdingsByDate.get(v.date)?.quantities.get(isin) ?? 0
          return Math.abs(qty) > 1e-8
        })
        positionValo.push({
          id: isin,
          name: s?.name ?? opName ?? isin,
          dates: valued.map((v) => v.date),
          values: clipInactivePositionValues(rawValues, held),
          isPosition: true,
          connectGroup: isin,
          showInLegend: true,
        })
      }

      const selectedSet = new Set(selectedIsins)
      const markers = buildOperationMarkers(data.operations).filter(
        (m) => m.date >= from && m.date <= to && selectedSet.has(m.seriesId),
      )

      const names: Record<string, string> = {}
      for (const s of data.supports) names[s.isin] = s.name
      for (const o of data.operations) {
        if (o.isin && o.name && !names[o.isin]) names[o.isin] = o.name
      }
      const priceCompare: ChartSeries[] = buildPriceCompareSeries({
        isins: selectedIsins,
        names,
        supports: data.supports,
        quotes,
        operations: data.operations,
        holdings,
        from,
        to,
      }).map((s) => ({
        ...s,
        isPosition: true,
      }))

      // Single selection: PRU step (same % scale) + monthly TRI on 2nd axis.
      if (selectedIsins.length === 1) {
        const isin = selectedIsins[0]
        const pru = buildPruStepSeries({
          isin,
          operations: data.operations,
          supports: data.supports,
          quotes,
          days: axisDates,
          from,
          to,
        })
        if (pru) priceCompare.push(pru)

        const valuedPos = valued
          .map((v) => ({ date: v.date, total: v.byIsin[isin] ?? 0 }))
          .filter((v) => v.date >= from && v.date <= to)
        const firstHeld = valuedPos.findIndex((v) => v.total > 1e-6)
        const triValued =
          firstHeld >= 0 ? valuedPos.slice(firstHeld) : []
        if (triValued.length >= 2) {
          const posStart = triValued[0].date
          const posEnd = triValued[triValued.length - 1].date
          const midFlows = listPositionTradeFlows({
            operations: data.operations,
            isin,
            supports: data.supports,
            quotes,
            from: posStart,
            to: posEnd,
          })
          const posTriCurve = computeMonthlyTriSeries({
            valued: triValued,
            midFlows,
          })
          const posTriDense = densifyTriSeries(
            posTriCurve,
            triValued.map((v) => v.date),
          )
          priceCompare.push({
            id: `${isin}-tri`,
            name: 'TRI annualisé',
            dates: posTriDense.map((p) => p.date),
            values: posTriDense.map((p) =>
              p.rate == null ? null : p.rate * 100,
            ),
            yAxisIndex: 1,
            valueUnit: 'pct',
            color: '#6eb5ff',
            dashed: true,
            showInLegend: true,
            connectNulls: true,
            showSymbol: true,
            symbolDates: posTriCurve
              .filter((p) => p.rate != null)
              .map((p) => p.date),
          })
        }
      }

      const heldNow = new Set<string>()
      const everHeld = new Set<string>()
      for (const h of holdings) {
        for (const [isin, qty] of h.quantities) {
          if (Math.abs(qty) > 1e-8) everHeld.add(isin)
        }
      }
      const last = holdings[holdings.length - 1]
      if (last) {
        for (const [isin, qty] of last.quantities) {
          if (Math.abs(qty) > 1e-8) heldNow.add(isin)
        }
      }
      // Only ISINs that appeared in this scope (ops / holdings) — not the global
      // support catalog (other envelopes).
      const allIsins = new Map<string, { name: string }>()
      for (const o of data.operations) {
        if (!o.isin || o.synthetic) continue
        if (!allIsins.has(o.isin)) {
          allIsins.set(o.isin, {
            name:
              o.name ??
              data.supports.find((s) => s.isin === o.isin)?.name ??
              o.isin,
          })
        }
      }
      for (const isin of everHeld) {
        if (allIsins.has(isin)) continue
        allIsins.set(isin, {
          name: data.supports.find((s) => s.isin === isin)?.name ?? isin,
        })
      }
      const isinList = [...allIsins.entries()]
        .map(([isin, meta]) => ({
          isin,
          name: meta.name,
          closed: !heldNow.has(isin),
        }))
        .sort((a, b) => {
          if (a.closed !== b.closed) return a.closed ? 1 : -1
          return a.name.localeCompare(b.name, 'fr')
        })
      const scopeSupports = data.supports.filter((s) => allIsins.has(s.isin))
      const tickersMapped = scopeSupports.filter((s) => quoteKeyForSupport(s)).length
      const tickersCached = scopeSupports.filter((s) => {
        const key = quoteKeyForSupport(s)
        return key && (quotes.get(key)?.length ?? 0) > 0
      }).length

      const tri =
        data.scope === 'ALL'
          ? computeConsolidatedPortfolioTri({
              operations: data.operations,
              supports: data.supports,
              quotes,
              t0: from,
              t1: to,
              virtualOpenings: data.vos,
            })
          : computePortfolioTri({
              envelope: data.scope,
              operations: data.operations,
              supports: data.supports,
              quotes,
              t0: from,
              t1: to,
              virtualOpening: data.vos[0] ?? null,
            })

      // Apports/retraits: non suivis (pas de ledger espèces) — TRI = path valo.
      const externalNet =
        data.scope === 'ALL'
          ? ALL_ENVELOPES.map((env) =>
              sumEnvelopeExternalFlows({
                operations: data.operations,
                envelope: env,
                from,
                to,
              }),
            ).reduce(
              (acc, x) => ({
                net: acc.net + x.net,
                apports: acc.apports + x.apports,
                retraits: acc.retraits + x.retraits,
                count: acc.count + x.count,
              }),
              { net: 0, apports: 0, retraits: 0, count: 0 },
            )
          : sumEnvelopeExternalFlows({
              operations: data.operations,
              envelope: data.scope,
              from,
              to,
            })

      return {
        portfolioSeries,
        positionValo,
        priceCompare,
        markers,
        isinList,
        scopeSupports,
        axisDates,
        periodRange,
        tickersMapped,
        tickersCached,
        lastTotal: valued[valued.length - 1]?.total ?? 0,
        periodFrom: from,
        periodTo: to,
        tri,
        calendarTris,
        externalNet,
        valued,
        holdingsSliced: sliced,
        names,
      }
    } catch (e) {
      console.error('Charts model', e)
      return null
    }
  }, [data, period, selectedIsins])

  // Drop selections that are not in the current envelope's ISIN list
  useEffect(() => {
    const allowed = new Set((model?.isinList ?? []).map((x) => x.isin))
    if (!allowed.size) return
    setSelectedIsins((prev) => {
      const next = prev.filter((id) => allowed.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [model?.isinList])

  const filteredIsins = useMemo(() => {
    const list = model?.isinList ?? []
    const q = pickerFilter.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (x) =>
        x.name.toLowerCase().includes(q) || x.isin.toLowerCase().includes(q),
    )
  }, [model?.isinList, pickerFilter])

  /** Positions ouvertes + espèces à la date pointée (ou fin de période). */
  const dayBreakdown = useMemo(() => {
    if (!model?.valued.length) return null
    const target =
      pointerDate &&
      model.valued.some((v) => v.date === pointerDate)
        ? pointerDate
        : pointerDate
          ? [...model.valued].reverse().find((v) => v.date <= pointerDate)
              ?.date ?? model.valued[model.valued.length - 1].date
          : model.valued[model.valued.length - 1].date
    const v = model.valued.find((x) => x.date === target)
    if (!v) return null
    const h =
      model.holdingsSliced.find((x) => x.date === target) ??
      [...model.holdingsSliced].reverse().find((x) => x.date <= target)

    const qtyByIsin = h?.quantities ?? new Map<string, number>()
    const isins = new Set([
      ...qtyByIsin.keys(),
      ...Object.keys(v.byIsin),
    ])
    const rows = [...isins]
      .map((isin) => {
        const qty = qtyByIsin.get(isin) ?? 0
        const value = v.byIsin[isin] ?? 0
        if (Math.abs(qty) <= 1e-8 && Math.abs(value) <= 1e-8) return null
        const price =
          Math.abs(qty) > 1e-12 ? value / qty : undefined
        return {
          isin,
          name: model.names[isin] ?? isin,
          qty,
          price,
          value,
          weight: v.total > 0 ? value / v.total : 0,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r != null)
      .sort((a, b) => b.value - a.value)

    return {
      date: target,
      cash: v.cash,
      securities: v.securities,
      total: v.total,
      rows,
      pointed: Boolean(pointerDate),
    }
  }, [model, pointerDate])

  const onRefreshQuotes = async () => {
    if (!data) return
    setRefreshing(true)
    setRefreshMsg('Mise à jour des cours…')
    try {
      const start = historyStartForScope(data.vos, data.operations)
      // Only tickers of supports present in the current envelope / scope
      const supportsToRefresh =
        model?.scopeSupports?.length
          ? model.scopeSupports
          : data.supports.filter((s) =>
              data.operations.some((o) => o.isin === s.isin && !o.synthetic),
            )
      const r = await refreshQuotesForSupports(
        supportsToRefresh,
        start,
        (info) => {
          setRefreshMsg(`Cours ${info.current}/${info.total} — ${info.ticker}`)
        },
      )
      const errPreview =
        r.errors.length > 0
          ? ` · ${r.errors.length} erreur(s)` +
            (r.errors[0] ? ` (${r.errors[0]})` : '')
          : ''
      setRefreshMsg(
        `Terminé : ${r.updated.length} maj, ${r.skipped} déjà à jour` +
          ` · depuis ${start}${errPreview}`,
      )
      reload()
    } catch (e) {
      setRefreshMsg(
        `Échec maj cours : ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!data || !model || autoRefreshDone.current || refreshing) return
    // Morningstar history needs no proxy; only a quote key (ticker or ISIN)
    const keys = model.scopeSupports
      .map((s) => quoteKeyForSupport(s))
      .filter((k): k is string => Boolean(k))
    if (!keys.length) return
    // Refresh if any scoped title lacks a usable series (not "some PEA already cached")
    const needsFetch = keys.some((k) => (data.quotes.get(k)?.length ?? 0) < 40)
    if (!needsFetch) return
    autoRefreshDone.current = true
    void onRefreshQuotes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, model?.scopeSupports, envelope])

  const toggleIsin = (isin: string) => {
    setSelectedIsins((prev) =>
      prev.includes(isin) ? prev.filter((x) => x !== isin) : [...prev, isin],
    )
  }

  return (
    <div className="charts-page">
      <section className="panel charts-toolbar">
        <div className="charts-toolbar-row">
          <h1 style={{ margin: 0 }}>Graphiques</h1>
          <div className="charts-tabs" role="tablist" aria-label="Section graphiques">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'historique'}
              className={`pill ${tab === 'historique' ? 'active' : ''}`}
              onClick={() => setTab('historique')}
            >
              Historique
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'valorisation'}
              className={`pill ${tab === 'valorisation' ? 'active' : ''}`}
              onClick={() => setTab('valorisation')}
            >
              Valorisation
            </button>
          </div>
          <div className="charts-toolbar-controls">
            <select
              value={envelope}
              onChange={(e) => setEnvelope(e.target.value as ChartScope)}
              aria-label="Enveloppe"
            >
              <option value="ALL">Toutes</option>
              <option value="PEA">PEA</option>
              <option value="PEA_PME">PEA-PME</option>
              <option value="CTO">CTO</option>
            </select>
            <div className="pill-row">
              {(['1M', '3M', '1Y', '2Y'] as ChartPeriod[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pill ${period === p ? 'active' : ''}`}
                  onClick={() => setPeriodAndResetZoom(p)}
                >
                  {p === '1Y' ? '1A' : p === '2Y' ? '2A' : p}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn"
              disabled={refreshing || !data}
              onClick={onRefreshQuotes}
            >
              {refreshing ? 'Maj…' : 'Rafraîchir cours'}
            </button>
          </div>
        </div>
        {refreshMsg && (
          <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
            {refreshMsg}
          </p>
        )}
        {error && (
          <div className="badge warn" style={{ display: 'block', marginTop: 8 }}>
            Erreur chargement : {error}
          </div>
        )}
      </section>

      {loading && (
        <section className="panel" style={{ marginTop: '1rem' }}>
          <p className="muted">Chargement…</p>
        </section>
      )}
      {!loading && !model && (
        <section className="panel" style={{ marginTop: '1rem' }}>
          <p className="muted">
            Aucune donnée pour cette enveloppe — lancez un import.
          </p>
        </section>
      )}

      {model && tab === 'valorisation' && (
        <div className="charts-stack" style={{ marginTop: '1rem' }}>
          <section className="panel charts-panel">
            <div className="charts-panel-head">
              <h2>Valorisation</h2>
              <span className="muted">
                Portefeuille · {model.periodFrom} → {model.periodTo}
              </span>
            </div>
            <div className="charts-tri-strip">
              <div>
                <span className="muted">TRI période</span>
                <div className="charts-tri-value">
                  {model.tri.irr !== null ? fmtPct(model.tri.irr) : '—'}
                </div>
              </div>
              {model.calendarTris.map((cy) => (
                <div key={cy.year}>
                  <span className="muted">TRI {cy.year}</span>
                  <div className="charts-tri-value" style={{ fontSize: '1.1rem' }}>
                    {cy.irr !== null ? fmtPct(cy.irr) : '—'}
                  </div>
                </div>
              ))}
              <div>
                <span className="muted">Début</span>
                <div>{fmtEur(model.tri.startValue)}</div>
              </div>
              <div>
                <span className="muted">Fin</span>
                <div>{fmtEur(model.tri.endValue)}</div>
              </div>
              <div>
                <span className="muted">Apports / retraits (titres)</span>
                <div>
                  {fmtEur(model.externalNet.net)}
                  <span className="muted" style={{ marginLeft: 6 }}>
                    ({model.externalNet.count} flux
                    {model.externalNet.retraits > 0
                      ? ` · ventes et dividendes −${fmtEur(model.externalNet.retraits)}`
                      : ''}
                    )
                  </span>
                </div>
              </div>
            </div>
            <p className="muted" style={{ margin: '0 0 0.75rem', fontSize: '0.8rem' }}>
              Courbe TRI : XIRR depuis le début de fenêtre, un point par fin de
              mois (achat synthétique en t₀, chaque achat = apport, chaque vente
              = retrait, valo du mois en sortie). TRI N / N−1 / N−2 = années
              calendaires autonomes (si fenêtre &gt; 1 mois).
            </p>
            {model.tickersMapped > 0 && model.tickersCached === 0 && (
              <div
                className="badge warn"
                style={{ display: 'block', marginBottom: 8 }}
              >
                Aucun historique de cours en cache — « Rafraîchir cours ».
              </div>
            )}
            <div className="charts-valo-split">
              <div className="charts-valo-chart">
                <PortfolioChart
                  series={model.portfolioSeries}
                  mode="euro"
                  period={period}
                  onPeriod={setPeriod}
                  showPeriodBar={false}
                  axisDates={model.axisDates}
                  periodRange={model.periodRange}
                  zoomRange={zoomRange}
                  onZoomRangeChange={onZoomRangeChange}
                  onPointerDate={setPointerDate}
                  height={420}
                />
              </div>

              <aside className="charts-day-breakdown">
                <div className="charts-day-breakdown-head">
                  <h3>
                    Positions
                    {dayBreakdown ? (
                      <>
                        {' '}
                        au {dayBreakdown.date}
                        {!dayBreakdown.pointed && (
                          <span className="muted"> (fin de période)</span>
                        )}
                      </>
                    ) : null}
                  </h3>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>
                    Survolez le graphique pour une autre date
                  </span>
                </div>
                {!dayBreakdown ? (
                  <p className="muted" style={{ margin: 0 }}>
                    Aucune valorisation disponible pour cette période.
                  </p>
                ) : (
                  <>
                    <div className="charts-day-breakdown-totals">
                      <div>
                        <span className="muted">Titres</span>
                        <div>{fmtEur(dayBreakdown.securities)}</div>
                      </div>
                      <div>
                        <span className="muted">Espèces</span>
                        <div>{fmtEur(dayBreakdown.cash)}</div>
                      </div>
                      <div>
                        <span className="muted">Total</span>
                        <div
                          className="charts-tri-value"
                          style={{ fontSize: '1.1rem' }}
                        >
                          {fmtEur(dayBreakdown.total)}
                        </div>
                      </div>
                    </div>
                    {dayBreakdown.rows.length === 0 ? (
                      <p className="muted" style={{ margin: '0.5rem 0 0' }}>
                        Aucune position titre ouverte à cette date
                        {dayBreakdown.cash !== 0
                          ? ` — solde espèces ${fmtEur(dayBreakdown.cash)}`
                          : ''}
                        .
                      </p>
                    ) : (
                      <div className="charts-day-breakdown-table-wrap">
                        <table className="data charts-day-breakdown-table">
                          <thead>
                            <tr>
                              <th>Titre</th>
                              <th className="num">Qté</th>
                              <th className="num">Cours</th>
                              <th className="num">Valo</th>
                              <th className="num">%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dayBreakdown.rows.map((r) => (
                              <tr key={r.isin}>
                                <td title={`${r.name} · ${r.isin}`}>
                                  <div className="charts-day-breakdown-name">
                                    {r.name}
                                  </div>
                                  <code className="charts-day-breakdown-isin">
                                    {r.isin}
                                  </code>
                                </td>
                                <td className="num">
                                  {r.qty.toLocaleString('fr-FR', {
                                    maximumFractionDigits: 4,
                                  })}
                                </td>
                                <td className="num">
                                  {r.price !== undefined ? fmtEur(r.price) : '—'}
                                </td>
                                <td className="num">{fmtEur(r.value)}</td>
                                <td className="num">
                                  {(r.weight * 100).toLocaleString('fr-FR', {
                                    maximumFractionDigits: 1,
                                  })}
                                </td>
                              </tr>
                            ))}
                            <tr className="charts-day-breakdown-cash-row">
                              <td>
                                <strong>Espèces</strong>
                              </td>
                              <td className="num">—</td>
                              <td className="num">—</td>
                              <td className="num">
                                {fmtEur(dayBreakdown.cash)}
                              </td>
                              <td className="num">
                                {dayBreakdown.total > 0
                                  ? (
                                      (dayBreakdown.cash / dayBreakdown.total) *
                                      100
                                    ).toLocaleString('fr-FR', {
                                      maximumFractionDigits: 1,
                                    })
                                  : '—'}
                              </td>
                            </tr>
                          </tbody>
                          <tfoot>
                            <tr>
                              <td>
                                <strong>Total</strong>
                              </td>
                              <td />
                              <td />
                              <td className="num">
                                <strong>{fmtEur(dayBreakdown.total)}</strong>
                              </td>
                              <td className="num">100</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </aside>
            </div>

            <p className="muted" style={{ margin: '0.75rem 0 0', fontSize: '0.85rem' }}>
              TRI mensuel depuis le début de fenêtre (un point par fin de mois).
              Détail des flux : onglet TRI.
            </p>
          </section>
        </div>
      )}

      {model && tab === 'historique' && (
        <div className="charts-layout">
          <aside className="panel charts-picker" aria-label="Sélection des titres">
            <div className="charts-picker-head">
              <strong>Titres</strong>
              <span className="muted charts-picker-count">
                {selectedIsins.length}/{model.isinList.length}
              </span>
            </div>
            <input
              type="search"
              className="charts-picker-filter"
              placeholder="Filtrer…"
              value={pickerFilter}
              onChange={(e) => setPickerFilter(e.target.value)}
              aria-label="Filtrer les titres"
            />
            <div className="charts-picker-actions">
              <button
                type="button"
                className="pill"
                disabled={selectedIsins.length === 0}
                onClick={() => setSelectedIsins([])}
              >
                Tout ôter
              </button>
              <span className="muted" style={{ fontSize: '0.75rem' }}>
                cache {model.tickersCached}/{model.tickersMapped}
              </span>
            </div>
            <ul className="charts-picker-list">
              {filteredIsins.map(({ isin, name, closed }) => {
                const on = selectedIsins.includes(isin)
                return (
                  <li key={isin}>
                    <button
                      type="button"
                      className={`charts-picker-item${on ? ' active' : ''}${closed ? ' closed' : ''}`}
                      onClick={() => toggleIsin(isin)}
                      title={closed ? `${isin} (sorti)` : isin}
                      aria-pressed={on}
                    >
                      <span className="charts-picker-check" aria-hidden>
                        {on ? '✓' : ''}
                      </span>
                      <span className="charts-picker-name">{name || isin}</span>
                      {closed && (
                        <span className="charts-picker-tag">sorti</span>
                      )}
                    </button>
                  </li>
                )
              })}
              {filteredIsins.length === 0 && (
                <li className="muted" style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                  Aucun titre
                </li>
              )}
            </ul>
          </aside>

          <div className="charts-stack">
            <section className="panel charts-panel">
              <div className="charts-panel-head">
                <h2>Historique — Cours</h2>
                <span className="muted">
                  0 % au 1ᵉʳ achat · zoom sync
                  {selectedIsins.length === 1
                    ? ' · PRU (escalier) + TRI position'
                    : ''}
                </span>
              </div>
              {selectedIsins.length === 0 ? (
                <p className="muted" style={{ margin: '0.5rem 0' }}>
                  Cochez un titre à gauche.
                </p>
              ) : model.priceCompare.length === 0 ? (
                <p className="muted" style={{ margin: '0.5rem 0' }}>
                  Pas assez de cours (ticker / historique manquant).
                </p>
              ) : (
                <PortfolioChart
                  series={model.priceCompare}
                  markers={model.markers}
                  mode="index"
                  period={period}
                  onPeriod={setPeriod}
                  showPeriodBar={false}
                  axisDates={model.axisDates}
                  periodRange={model.periodRange}
                  zoomRange={zoomRange}
                  onZoomRangeChange={onZoomRangeChange}
                  height={380}
                />
              )}
            </section>

            <section className="panel charts-panel">
              <div className="charts-panel-head">
                <h2>Historique — Valorisation titres</h2>
                <span className="muted">€ · zoom sync</span>
              </div>
              {model.tickersMapped > 0 && model.tickersCached === 0 && (
                <div
                  className="badge warn"
                  style={{ display: 'block', marginBottom: 8 }}
                >
                  Aucun historique de cours en cache — « Rafraîchir cours ».
                </div>
              )}
              {selectedIsins.length === 0 ? (
                <p className="muted" style={{ margin: '0.5rem 0' }}>
                  Cochez un ou plusieurs titres.
                </p>
              ) : (
                <PortfolioChart
                  series={model.positionValo}
                  markers={model.markers}
                  mode="euro"
                  period={period}
                  onPeriod={setPeriod}
                  showPeriodBar={false}
                  axisDates={model.axisDates}
                  periodRange={model.periodRange}
                  zoomRange={zoomRange}
                  onZoomRangeChange={onZoomRangeChange}
                  height={380}
                />
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
