import { useMemo, useState } from 'react'
import type { EnvelopeType } from '@/domain/types'
import {
  loadEnvelopeProjected,
  loadProjected,
} from '@/persist/portfolioStore'
import {
  computePositionContributions,
  type PositionContribution,
} from '@/engine/contribution'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import { getAllQuoteMaps } from '@/quotes/localQuoteCache'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'

type Scope = EnvelopeType | 'ALL'

type SortKey =
  | 'name'
  | 'status'
  | 'invested'
  | 'proceeds'
  | 'dividends'
  | 'marketValue'
  | 'absolute'
  | 'roi'
  | 'irr'
  | 'from'

const fmtEur = (n: number) =>
  n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })

const fmtPct = (n: number | null) =>
  n === null
    ? '—'
    : `${(n * 100).toLocaleString('fr-FR', {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })} %`

const envelopeLabel = (e: EnvelopeType) =>
  e === 'PEA_PME' ? 'PEA-PME' : e

export default function ContributionPage() {
  const [envelope, setEnvelope] = useState<Scope>('PEA')
  const [sortKey, setSortKey] = useState<SortKey>('absolute')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>(
    'all',
  )

  const { data, loading } = useAsyncData(async () => {
    await ensureHistoricalSupports()
    const quotes = await getAllQuoteMaps()
    if (envelope === 'ALL') {
      const projected = await loadProjected()
      const dates = projected.operations.map((o) => o.date).sort()
      return {
        operations: projected.operations,
        supports: projected.supports,
        virtualOpenings: projected.virtualOpenings,
        quotes,
        asOf:
          dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10),
        envelopes: ['PEA', 'PEA_PME', 'CTO'] as EnvelopeType[],
      }
    }
    const projected = await loadEnvelopeProjected(envelope)
    const dates = projected.operations.map((o) => o.date).sort()
    return {
      operations: projected.operations,
      supports: projected.supports,
      virtualOpenings: projected.virtualOpening
        ? [projected.virtualOpening]
        : [],
      quotes,
      asOf:
        dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10),
      envelopes: [envelope] as EnvelopeType[],
    }
  }, [envelope])

  const rows = useMemo(() => {
    if (!data) return [] as PositionContribution[]
    return computePositionContributions({
      operations: data.operations,
      supports: data.supports,
      quotes: data.quotes,
      virtualOpenings: data.virtualOpenings,
      asOf: data.asOf,
      envelopes: data.envelopes,
    })
  }, [data])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return rows
    return rows.filter((r) => r.status === statusFilter)
  }, [rows, statusFilter])

  const sorted = useMemo(() => {
    const copy = [...filtered]
    const dir = sortDir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return dir * av.localeCompare(bv, 'fr')
      }
      const an = av === null || av === undefined ? Number.NEGATIVE_INFINITY : Number(av)
      const bn = bv === null || bv === undefined ? Number.NEGATIVE_INFINITY : Number(bv)
      return dir * (an - bn)
    })
    return copy
  }, [filtered, sortKey, sortDir])

  const kpis = useMemo(() => {
    const absolute = filtered.reduce((s, r) => s + r.absolute, 0)
    const invested = filtered.reduce((s, r) => s + r.invested, 0)
    const open = filtered.filter((r) => r.status === 'open').length
    const closed = filtered.filter((r) => r.status === 'closed').length
    return { absolute, invested, open, closed, count: filtered.length }
  }, [filtered])

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(
        key === 'name' || key === 'status' || key === 'from' ? 'asc' : 'desc',
      )
    }
  }

  const sortMark = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Contribution par position</h1>
        <p className="muted">
          Richesse créée to date par ISIN (ouverts et fermés) : ventes +
          dividendes + valeur actuelle − achats. ROI = contribution / capital
          investi ; TRI = XIRR annualisé sur les flux (sensible à la durée
          d’immobilisation).
        </p>

        <div className="grid-2" style={{ marginTop: '1rem' }}>
          <label>
            <span className="muted">Enveloppe</span>
            <br />
            <select
              value={envelope}
              onChange={(e) => setEnvelope(e.target.value as Scope)}
              style={{ width: '100%', marginTop: 6 }}
            >
              <option value="ALL">Toutes</option>
              <option value="PEA">PEA</option>
              <option value="PEA_PME">PEA-PME</option>
              <option value="CTO">CTO</option>
            </select>
          </label>
          <label>
            <span className="muted">Statut</span>
            <br />
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'all' | 'open' | 'closed')
              }
              style={{ width: '100%', marginTop: 6 }}
            >
              <option value="all">Tous</option>
              <option value="open">Ouverts</option>
              <option value="closed">Fermés</option>
            </select>
          </label>
        </div>

        {loading && <p className="muted">Chargement…</p>}

        {!loading && data && (
          <>
            <div className="kpi" style={{ marginTop: '1.25rem' }}>
              <div className="kpi-card">
                <div className="label">Contribution totale</div>
                <div
                  className="value"
                  style={{
                    color:
                      kpis.absolute >= 0 ? 'var(--ok)' : 'var(--danger)',
                  }}
                >
                  {fmtEur(kpis.absolute)}
                </div>
              </div>
              <div className="kpi-card">
                <div className="label">Capital investi</div>
                <div className="value" style={{ fontSize: '1.4rem' }}>
                  {fmtEur(kpis.invested)}
                </div>
              </div>
              <div className="kpi-card">
                <div className="label">Positions</div>
                <div className="value" style={{ fontSize: '1.4rem' }}>
                  {kpis.count}
                </div>
                <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
                  {kpis.open} ouvertes · {kpis.closed} fermées
                </div>
              </div>
              <div className="kpi-card">
                <div className="label">Au</div>
                <div className="value" style={{ fontSize: '1.4rem' }}>
                  {data.asOf}
                </div>
              </div>
            </div>

            <div style={{ marginTop: '1.25rem', overflowX: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    {envelope === 'ALL' && <th>Enveloppe</th>}
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('name')}>
                        Nom{sortMark('name')}
                      </button>
                    </th>
                    <th>ISIN</th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('status')}>
                        Statut{sortMark('status')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('invested')}>
                        Investi{sortMark('invested')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('proceeds')}>
                        Ventes{sortMark('proceeds')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('dividends')}>
                        Dividendes{sortMark('dividends')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('marketValue')}>
                        Valo{sortMark('marketValue')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('absolute')}>
                        Contribution €{sortMark('absolute')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('roi')}>
                        ROI %{sortMark('roi')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('irr')}>
                        TRI %{sortMark('irr')}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="linkish" onClick={() => onSort('from')}>
                        Période{sortMark('from')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={envelope === 'ALL' ? 12 : 11} className="muted">
                        Aucune position pour cette enveloppe.
                      </td>
                    </tr>
                  )}
                  {sorted.map((r) => (
                    <tr key={`${r.envelope}-${r.isin}`}>
                      {envelope === 'ALL' && (
                        <td>{envelopeLabel(r.envelope)}</td>
                      )}
                      <td>{r.name}</td>
                      <td className="muted" style={{ fontSize: '0.8rem' }}>
                        {r.isin}
                      </td>
                      <td>
                        <span
                          className={
                            r.status === 'open' ? 'badge ok' : 'badge muted'
                          }
                        >
                          {r.status === 'open' ? 'Ouvert' : 'Fermé'}
                        </span>
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtEur(r.invested)}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtEur(r.proceeds)}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtEur(r.dividends)}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtEur(r.marketValue)}
                      </td>
                      <td
                        style={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 600,
                          color:
                            r.absolute >= 0 ? 'var(--ok)' : 'var(--danger)',
                        }}
                      >
                        {fmtEur(r.absolute)}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtPct(r.roi)}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtPct(r.irr)}
                      </td>
                      <td className="muted" style={{ fontSize: '0.8rem' }}>
                        {r.from} → {r.to}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
