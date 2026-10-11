import { useMemo, useState } from 'react'
import type { EnvelopeType } from '@/domain/types'
import {
  loadEnvelopeProjected,
  loadProjected,
} from '@/persist/portfolioStore'
import {
  computeCalendarYearTris,
  computeConsolidatedPortfolioTri,
  computePortfolioTri,
  isExternalTriFlow,
  spansMoreThanOneMonth,
  sumEnvelopeExternalFlows,
  type CashFlow,
} from '@/engine/tri'
import { buildHoldingsSeries } from '@/engine/positions'
import { valueHoldingsSeries } from '@/engine/valuation'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import { getAllQuoteMaps } from '@/quotes/localQuoteCache'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'

type TriScope = EnvelopeType | 'ALL'

export default function TriPage() {
  const [envelope, setEnvelope] = useState<TriScope>('PEA')
  const [isin, setIsin] = useState('')
  const [t0, setT0] = useState('')
  const [t1, setT1] = useState('')

  const { data, loading } = useAsyncData(async () => {
    await ensureHistoricalSupports()
    const quotes = await getAllQuoteMaps()
    if (envelope === 'ALL') {
      const projected = await loadProjected()
      const dates = projected.operations.map((o) => o.date).sort()
      const vos = projected.virtualOpenings
      return {
        scope: 'ALL' as const,
        operations: projected.operations,
        supports: projected.supports,
        vos,
        quotes,
        minDate: vos.map((v) => v.date).sort()[0] ?? dates[0] ?? '',
        maxDate:
          dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10),
        isins: [] as string[],
      }
    }
    const projected = await loadEnvelopeProjected(envelope)
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
      scope: envelope,
      operations,
      supports,
      vos: vo ? [vo] : [],
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
    if (data.scope === 'ALL') {
      return computeConsolidatedPortfolioTri({
        operations: data.operations,
        supports: data.supports,
        quotes: data.quotes,
        t0: effectiveT0,
        t1: effectiveT1,
        virtualOpenings: data.vos,
      })
    }
    return computePortfolioTri({
      envelope: data.scope,
      operations: data.operations,
      supports: data.supports,
      quotes: data.quotes,
      t0: effectiveT0,
      t1: effectiveT1,
      isin: isin || undefined,
      virtualOpening: data.vos[0] ?? null,
    })
  }, [data, effectiveT0, effectiveT1, isin])

  const calendarTris = useMemo(() => {
    if (!data || !result || !effectiveT0 || !effectiveT1) return []
    if (!spansMoreThanOneMonth(effectiveT0, effectiveT1)) return []
    // Rebuild valued path for calendar years (same window as result).
    const scopes: EnvelopeType[] =
      data.scope === 'ALL' ? ['PEA', 'PEA_PME', 'CTO'] : [data.scope]
    const valuedParts = scopes.map((env) => {
      const vo = data.vos.find((v) => v.envelope === env) ?? null
      const holdings = buildHoldingsSeries({
        envelope: env,
        operations: data.operations,
        virtualOpening: vo,
        from: effectiveT0,
        to: effectiveT1,
      })
      return valueHoldingsSeries({
        holdings,
        supports: data.supports,
        quotes: data.quotes,
        isinFilter: isin ? [isin] : undefined,
        operations: data.operations.filter((o) => o.envelope === env),
      })
    })
    const byDate = new Map<string, number>()
    for (const part of valuedParts) {
      for (const v of part) {
        const add = isin ? (v.byIsin[isin] ?? 0) : v.total
        byDate.set(v.date, (byDate.get(v.date) ?? 0) + add)
      }
    }
    const valued = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, total]) => ({ date, total }))
    const midFlows: CashFlow[] = result.flows.filter(isExternalTriFlow)
    return computeCalendarYearTris({
      valued,
      midFlows,
      asOf: effectiveT1,
    })
  }, [data, result, effectiveT0, effectiveT1, isin])

  const external = useMemo(() => {
    if (!data || !effectiveT0 || !effectiveT1) return null
    if (data.scope === 'ALL') {
      return (['PEA', 'PEA_PME', 'CTO'] as EnvelopeType[]).reduce(
        (acc, env) => {
          const x = sumEnvelopeExternalFlows({
            operations: data.operations,
            envelope: env,
            from: effectiveT0,
            to: effectiveT1,
          })
          return {
            net: acc.net + x.net,
            apports: acc.apports + x.apports,
            retraits: acc.retraits + x.retraits,
            count: acc.count + x.count,
          }
        },
        { net: 0, apports: 0, retraits: 0, count: 0 },
      )
    }
    return sumEnvelopeExternalFlows({
      operations: data.operations,
      envelope: data.scope,
      from: effectiveT0,
      to: effectiveT1,
    })
  }, [data, effectiveT0, effectiveT1])

  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>TRI (IRR)</h1>
        <p className="muted">
          XIRR : achat synthétique en début de période, chaque achat titres =
          apport (−), chaque vente = retrait (+), revente synthétique en fin —
          sans frais d’ordre. TRI N / N−1 / N−2 = années calendaires autonomes.
        </p>

        <div className="grid-2" style={{ marginTop: '1rem' }}>
          <label>
            <span className="muted">Enveloppe</span>
            <br />
            <select
              value={envelope}
              onChange={(e) => {
                setEnvelope(e.target.value as TriScope)
                setIsin('')
              }}
              style={{ width: '100%', marginTop: 6 }}
            >
              <option value="ALL">Toutes</option>
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
              disabled={envelope === 'ALL'}
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
            {external && (
              <div className="kpi-card">
                <div className="label">Apports / retraits (titres)</div>
                <div className="value" style={{ fontSize: '1.4rem' }}>
                  {external.net.toLocaleString('fr-FR', {
                    style: 'currency',
                    currency: 'EUR',
                  })}
                </div>
              </div>
            )}
            {calendarTris.map((cy) => (
              <div className="kpi-card" key={cy.year}>
                <div className="label">TRI {cy.year}</div>
                <div className="value">
                  {cy.irr === null
                    ? '—'
                    : `${(cy.irr * 100).toFixed(2)} %`}
                </div>
                <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
                  {cy.from} → {cy.to}
                </div>
              </div>
            ))}
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
