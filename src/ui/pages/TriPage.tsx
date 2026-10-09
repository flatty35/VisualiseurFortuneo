import { useMemo, useState } from 'react'
import type { EnvelopeType } from '@/domain/types'
import { loadEnvelopeProjected } from '@/persist/portfolioStore'
import { computePortfolioTri } from '@/engine/tri'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import { getAllQuoteMaps } from '@/quotes/localQuoteCache'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'

export default function TriPage() {
  const [envelope, setEnvelope] = useState<EnvelopeType>('PEA')
  const [isin, setIsin] = useState('')
  const [t0, setT0] = useState('')
  const [t1, setT1] = useState('')

  const { data, loading } = useAsyncData(async () => {
    await ensureHistoricalSupports()
    const [projected, quotes] = await Promise.all([
      loadEnvelopeProjected(envelope),
      getAllQuoteMaps(),
    ])
    const { operations, supports, virtualOpening: vo } = projected
    const dates = operations.map((o) => o.date).sort()
    const isinSet = new Set(
      operations.map((o) => o.isin).filter((x): x is string => Boolean(x)),
    )
    const isins = [...isinSet].sort((a, b) => {
      const na = supports.find((s) => s.isin === a)?.name ?? a
      const nb = supports.find((s) => s.isin === b)?.name ?? b
      return na.localeCompare(nb, 'fr')
    })
    return {
      operations,
      supports,
      vo,
      quotes,
      minDate: vo?.date ?? dates[0] ?? '',
      maxDate: dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10),
      isins,
    }
  }, [envelope])

  // Default dates when data loads
  const effectiveT0 = t0 || data?.minDate || ''
  const effectiveT1 = t1 || data?.maxDate || ''

  const result = useMemo(() => {
    if (!data || !effectiveT0 || !effectiveT1) return null
    return computePortfolioTri({
      envelope,
      operations: data.operations,
      supports: data.supports,
      quotes: data.quotes,
      t0: effectiveT0,
      t1: effectiveT1,
      isin: isin || undefined,
      virtualOpening: data.vo,
    })
  }, [data, envelope, effectiveT0, effectiveT1, isin])

  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>TRI (IRR)</h1>
        <p className="muted">
          Achat synthétique des positions en début de période, flux réels, revente synthétique
          en fin de période — sans frais d’ordre.
        </p>

        <div className="grid-2" style={{ marginTop: '1rem' }}>
          <label>
            <span className="muted">Enveloppe</span>
            <br />
            <select
              value={envelope}
              onChange={(e) => setEnvelope(e.target.value as EnvelopeType)}
              style={{ width: '100%', marginTop: 6 }}
            >
              <option value="PEA">PEA</option>
              <option value="PEA_PME">PEA-PME</option>
              <option value="CTO">CTO</option>
            </select>
          </label>
          <label>
            <span className="muted">Position (optionnel)</span>
            <br />
            <select
              value={isin}
              onChange={(e) => setIsin(e.target.value)}
              style={{ width: '100%', marginTop: 6 }}
            >
              <option value="">Portefeuille entier</option>
              {data?.isins.map((i) => {
                const name = data.supports.find((s) => s.isin === i)?.name ?? i
                return (
                  <option key={i} value={i}>
                    {name}
                  </option>
                )
              })}
            </select>
          </label>
          <label>
            <span className="muted">Début</span>
            <br />
            <input
              type="date"
              value={effectiveT0}
              onChange={(e) => setT0(e.target.value)}
              style={{ width: '100%', marginTop: 6 }}
            />
          </label>
          <label>
            <span className="muted">Fin</span>
            <br />
            <input
              type="date"
              value={effectiveT1}
              onChange={(e) => setT1(e.target.value)}
              style={{ width: '100%', marginTop: 6 }}
            />
          </label>
        </div>

        {loading && <p className="muted">Chargement…</p>}

        {result && (
          <div className="kpi" style={{ marginTop: '1.25rem' }}>
            <div className="kpi-card">
              <div className="label">TRI annualisé</div>
              <div className="value">
                {result.irr === null
                  ? '—'
                  : `${(result.irr * 100).toFixed(2)} %`}
              </div>
            </div>
            <div className="kpi-card">
              <div className="label">Valeur début</div>
              <div className="value" style={{ fontSize: '1.4rem' }}>
                {result.startValue.toLocaleString('fr-FR', {
                  style: 'currency',
                  currency: 'EUR',
                })}
              </div>
            </div>
            <div className="kpi-card">
              <div className="label">Valeur fin</div>
              <div className="value" style={{ fontSize: '1.4rem' }}>
                {result.endValue.toLocaleString('fr-FR', {
                  style: 'currency',
                  currency: 'EUR',
                })}
              </div>
            </div>
          </div>
        )}

        {result && result.flows.length > 0 && (
          <div style={{ marginTop: '1.25rem', overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Flux</th>
                  <th>Libellé</th>
                </tr>
              </thead>
              <tbody>
                {result.flows.map((f, i) => (
                  <tr key={`${f.date}-${i}`}>
                    <td>{f.date}</td>
                    <td
                      style={{
                        color: f.amount >= 0 ? 'var(--ok)' : 'var(--danger)',
                      }}
                    >
                      {f.amount.toLocaleString('fr-FR', {
                        style: 'currency',
                        currency: 'EUR',
                      })}
                    </td>
                    <td>{f.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
