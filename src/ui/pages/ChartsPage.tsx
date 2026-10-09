import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChartPeriod, EnvelopeType } from '@/domain/types'
import { db } from '@/persist/db'
import { buildHoldingsSeries } from '@/engine/positions'
import { buildCashSpikeSeries } from '@/engine/cashSeries'
import { buildOperationMarkers } from '@/engine/markers'
import { buildPriceCompareSeries } from '@/engine/priceCompare'
import { sliceByPeriod, valueHoldingsSeries } from '@/engine/valuation'
import {
  getAllQuoteMaps,
  refreshQuotesForSupports,
} from '@/quotes/localQuoteCache'
import { isProxyConfigured } from '@/quotes/gasClient'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import PortfolioChart, {
  type ChartSeries,
  type ZoomRange,
} from '@/ui/components/PortfolioChart'

export default function ChartsPage() {
  const [envelope, setEnvelope] = useState<EnvelopeType>('PEA')
  const [period, setPeriod] = useState<ChartPeriod>('1Y')
  const [selectedIsins, setSelectedIsins] = useState<string[]>([])
  const [pickerFilter, setPickerFilter] = useState('')
  const [showCash, setShowCash] = useState(true)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null)
  const autoRefreshDone = useRef(false)

  const setPeriodAndResetZoom = (p: ChartPeriod) => {
    setZoomRange(null)
    setPeriod(p)
  }

  useEffect(() => {
    setZoomRange(null)
  }, [envelope])

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
    const [operations, supports, vo, quotes] = await Promise.all([
      db.operations.where('envelope').equals(envelope).toArray(),
      db.supports.toArray(),
      db.virtualOpenings.get(envelope),
      getAllQuoteMaps(),
    ])
    return { operations, supports, vo: vo ?? null, quotes }
  }, [envelope])

  const model = useMemo(() => {
    if (!data) return null
    try {
      const holdings = buildHoldingsSeries({
        envelope,
        operations: data.operations,
        virtualOpening: data.vo,
      })
      if (!holdings.length) return null

      const allDates = holdings.map((h) => h.date)
      const { from, to } = sliceByPeriod(allDates, period)
      const sliced = holdings.filter((h) => h.date >= from && h.date <= to)
      /** Shared X axis for valorisation + cours (period window). */
      const axisDates = sliced.map((h) => h.date)
      const periodRange = { start: from, end: to }
      const valued = valueHoldingsSeries({
        holdings: sliced,
        supports: data.supports,
        quotes: data.quotes,
      })

      const tickersMapped = data.supports.filter((s) => s.yahooTicker).length
      const tickersCached = [...data.quotes.values()].filter((b) => b.length > 0)
        .length

      const valorisation: ChartSeries[] = [
        {
          id: 'total',
          name: 'Portefeuille',
          dates: valued.map((v) => v.date),
          values: valued.map((v) => v.total),
          showInLegend: true,
        },
      ]
      if (showCash) {
        const cashFull = buildCashSpikeSeries({
          operations: data.operations.filter((o) => o.envelope === envelope),
          openingCash: data.vo?.cash ?? 0,
          from: holdings[0]?.date ?? from,
          to: holdings[holdings.length - 1]?.date ?? to,
        })
        // EOD only (no ·abo categories) so axis stays aligned with cours
        const cashPts = cashFull.filter(
          (p) => !p.isSpike && p.day >= from && p.day <= to,
        )
        valorisation.push({
          id: 'cash',
          name: 'Espèces',
          dates: cashPts.map((p) => p.day),
          values: cashPts.map((p) => p.cash),
          dashed: true,
          step: 'end',
          showInLegend: true,
        })
      }
      for (const isin of selectedIsins) {
        const s = data.supports.find((x) => x.isin === isin)
        const opName = data.operations.find((o) => o.isin === isin && o.name)?.name
        valorisation.push({
          id: isin,
          name: s?.name ?? opName ?? isin,
          dates: valued.map((v) => v.date),
          values: valued.map((v) => v.byIsin[isin] ?? 0),
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
      const compareIsins = selectedIsins.length > 0 ? selectedIsins : []
      const priceCompare = buildPriceCompareSeries({
        isins: compareIsins,
        names,
        supports: data.supports,
        quotes: data.quotes,
        operations: data.operations,
        holdings,
        from,
        to,
      }).map((s) => ({
        ...s,
        isPosition: true,
      }))

      const heldNow = new Set<string>()
      const last = holdings[holdings.length - 1]
      if (last) {
        for (const [isin, qty] of last.quantities) {
          if (Math.abs(qty) > 1e-8) heldNow.add(isin)
        }
      }
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
      for (const s of data.supports) {
        if (!allIsins.has(s.isin)) allIsins.set(s.isin, { name: s.name })
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

    return {
      valorisation,
      priceCompare,
      markers,
      isinList,
      axisDates,
      periodRange,
      tickersMapped,
      tickersCached,
      lastTotal: valued[valued.length - 1]?.total ?? 0,
    }
    } catch (e) {
      console.error('Charts model', e)
      return null
    }
  }, [data, envelope, period, selectedIsins, showCash])

  const filteredIsins = useMemo(() => {
    const list = model?.isinList ?? []
    const q = pickerFilter.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (x) =>
        x.name.toLowerCase().includes(q) || x.isin.toLowerCase().includes(q),
    )
  }, [model?.isinList, pickerFilter])

  const onRefreshQuotes = async () => {
    if (!data) return
    setRefreshing(true)
    setRefreshMsg('Mise à jour des cours…')
    try {
      const start = data.vo?.date ?? data.operations[0]?.date ?? '2020-01-01'
      const r = await refreshQuotesForSupports(data.supports, start, (info) => {
        setRefreshMsg(`Cours ${info.current}/${info.total} — ${info.ticker}`)
      })
      const errPreview =
        r.errors.length > 0
          ? ` · ${r.errors.length} erreur(s)` +
            (r.errors[0] ? ` (${r.errors[0]})` : '')
          : ''
      setRefreshMsg(
        `Terminé : ${r.updated.length} maj, ${r.skipped} déjà à jour${errPreview}`,
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
    if (!data || autoRefreshDone.current || refreshing) return
    const mapped = data.supports.some((s) => s.yahooTicker)
    const cached = [...data.quotes.values()].some((b) => b.length > 0)
    if (mapped && !cached && isProxyConfigured()) {
      autoRefreshDone.current = true
      void onRefreshQuotes()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

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
          <div className="charts-toolbar-controls">
            <select
              value={envelope}
              onChange={(e) => setEnvelope(e.target.value as EnvelopeType)}
              aria-label="Enveloppe"
            >
              <option value="PEA">PEA</option>
              <option value="PEA_PME">PEA-PME</option>
              <option value="CTO">CTO</option>
            </select>
            <div className="pill-row">
              {(['1M', '3M', '1Y', '3Y', '10Y', 'MAX'] as ChartPeriod[]).map(
                (p) => (
                  <button
                    key={p}
                    type="button"
                    className={`pill ${period === p ? 'active' : ''}`}
                    onClick={() => setPeriodAndResetZoom(p)}
                  >
                    {p === '1Y'
                      ? '1A'
                      : p === '3Y'
                        ? '3A'
                        : p === '10Y'
                          ? '10A'
                          : p}
                  </button>
                ),
              )}
            </div>
            <label className="charts-cash-toggle muted">
              <input
                type="checkbox"
                checked={showCash}
                onChange={(e) => setShowCash(e.target.checked)}
              />{' '}
              Espèces
            </label>
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

      {model && (
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
                <h2>Valorisation</h2>
                <span className="muted">€ · zoom sync</span>
              </div>
              {model.tickersMapped > 0 && model.tickersCached === 0 && (
                <div
                  className="badge warn"
                  style={{ display: 'block', marginBottom: 8 }}
                >
                  Aucun historique Yahoo en cache — « Rafraîchir cours ».
                </div>
              )}
              <PortfolioChart
                series={model.valorisation}
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
            </section>

            <section className="panel charts-panel">
              <div className="charts-panel-head">
                <h2>Cours</h2>
                <span className="muted">base 100 · zoom sync</span>
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
          </div>
        </div>
      )}
    </div>
  )
}
