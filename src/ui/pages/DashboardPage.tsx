import { Link } from 'react-router-dom'
import type { EnvelopeType } from '@/domain/types'
import { loadProjected } from '@/persist/portfolioStore'
import { buildHoldingsSeries } from '@/engine/positions'
import { valueHoldingsSeries } from '@/engine/valuation'
import { getAllQuoteMaps } from '@/quotes/localQuoteCache'
import { isProxyConfigured } from '@/quotes/gasClient'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'

const ENVELOPES: EnvelopeType[] = ['PEA', 'PEA_PME', 'CTO']

function fmtEur(n: number): string {
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

export default function DashboardPage() {
  const { data, loading } = useAsyncData(async () => {
    const [{ envelopes, operations, supports, virtualOpenings }, quotes] =
      await Promise.all([loadProjected(), getAllQuoteMaps()])

    const cards = ENVELOPES.map((type) => {
      const meta = envelopes.find((e) => e.type === type)
      const ops = operations.filter((o) => o.envelope === type)
      const vo = virtualOpenings.find((o) => o.envelope === type) ?? null
      if (!ops.length && !vo) {
        return { type, empty: true as const }
      }
      const holdings = buildHoldingsSeries({ envelope: type, operations: ops, virtualOpening: vo })
      const valued = valueHoldingsSeries({ holdings, supports, quotes })
      const last = valued[valued.length - 1]
      const first = valued[0]
      const perf =
        first && last && first.total !== 0
          ? ((last.total - first.total) / Math.abs(first.total)) * 100
          : null
      return {
        type,
        empty: false as const,
        label: meta?.label ?? type,
        total: last?.total ?? 0,
        cash: last?.cash ?? 0,
        securities: last?.securities ?? 0,
        opsCount: ops.filter((o) => !o.synthetic).length,
        perf,
        from: vo?.date,
      }
    })

    return {
      cards,
      supportCount: supports.length,
      mapped: supports.filter((s) => s.yahooTicker).length,
    }
  }, [])

  return (
    <div>
      <section className="panel" style={{ marginBottom: '1rem' }}>
        <h1 className="display" style={{ margin: '0 0 0.35rem', fontSize: '2.2rem' }}>
          Portefeuille local
        </h1>
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
          Vos opérations et quantités restent dans ce navigateur. Seuls des tickers publics
          transitent éventuelllement vers le proxy de cours.
        </p>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link className="btn btn-primary" to="/import">
            Importer Fortuneo
          </Link>
          <Link className="btn" to="/charts">
            Voir les graphiques
          </Link>
          {!isProxyConfigured() && (
            <span className="badge warn">Proxy cours non configuré</span>
          )}
        </div>
      </section>

      {loading && <p className="muted">Chargement…</p>}

      <div className="kpi">
        {data?.cards.map((c) =>
          c.empty ? (
            <div key={c.type} className="kpi-card">
              <div className="label">{c.type.replace('_', '-')}</div>
              <div className="value" style={{ fontSize: '1.2rem', color: 'var(--ink-muted)' }}>
                Non importé
              </div>
            </div>
          ) : (
            <div key={c.type} className="kpi-card">
              <div className="label">{c.label}</div>
              <div className="value">{fmtEur(c.total)}</div>
              <div className="muted" style={{ fontSize: '0.85rem', marginTop: 4 }}>
                Titres {fmtEur(c.securities)} · Espèces {fmtEur(c.cash)}
              </div>
              <div className="muted" style={{ fontSize: '0.8rem', marginTop: 6 }}>
                {c.opsCount} ops
                {c.perf !== null && (
                  <>
                    {' '}
                    · perf hist.{' '}
                    <span style={{ color: c.perf >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                      {c.perf.toFixed(1)}%
                    </span>
                  </>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      <section className="panel" style={{ marginTop: '1rem' }}>
        <div className="muted">
          Supports suivis : {data?.supportCount ?? 0} · dont ticker Yahoo : {data?.mapped ?? 0}
        </div>
      </section>
    </div>
  )
}
