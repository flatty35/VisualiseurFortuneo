import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ALL_ENVELOPES, envelopeLabel } from '@/domain/envelopes'
import { clearAllData } from '@/persist/db'
import { loadProjected } from '@/persist/portfolioStore'
import { buildHoldingsSeries } from '@/engine/positions'
import { computePortfolioTri } from '@/engine/tri'
import { valueHoldingsSeries } from '@/engine/valuation'
import { getAllQuoteMaps } from '@/quotes/localQuoteCache'
import { isProxyConfigured } from '@/quotes/gasClient'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'

const ENVELOPES = ALL_ENVELOPES

function fmtEur(n: number): string {
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

function fmtTriPct(irr: number): string {
  return `${(irr * 100).toLocaleString('fr-FR', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  })} %`
}

export default function DashboardPage() {
  const [resetting, setResetting] = useState(false)
  const [resetMsg, setResetMsg] = useState<string | null>(null)
  const { data, loading, reload } = useAsyncData(async () => {
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
      const valued = valueHoldingsSeries({
        holdings,
        supports,
        quotes,
        operations: ops,
      })
      const last = valued[valued.length - 1]
      const first = valued[0]
      const tri =
        first && last
          ? computePortfolioTri({
              envelope: type,
              operations: ops,
              supports,
              quotes,
              t0: first.date,
              t1: last.date,
              virtualOpening: vo,
            })
          : null
      return {
        type,
        empty: false as const,
        label: meta?.label ?? type,
        total: last?.total ?? 0,
        cash: last?.cash ?? 0,
        securities: last?.securities ?? 0,
        opsCount: ops.filter((o) => !o.synthetic).length,
        irr: tri?.irr ?? null,
        from: first?.date ?? vo?.date,
      }
    })

    return {
      cards,
      supportCount: supports.length,
      mapped: supports.filter((s) => s.yahooTicker).length,
    }
  }, [])

  const onResetAll = async () => {
    const ok = confirm(
      'Réinitialiser tout le visualiseur ?\n\n' +
        'Cela efface définitivement dans ce navigateur :\n' +
        '• opérations et positions (PEA / PEA-PME / CTO Fortuneo / CTO Saxo)\n' +
        '• correspondances ISIN / tickers\n' +
        '• cache de cours\n\n' +
        'Cette action est irréversible (exportez avant si besoin).',
    )
    if (!ok) return
    const again = confirm('Confirmer l’effacement complet ?')
    if (!again) return
    setResetting(true)
    setResetMsg(null)
    try {
      await clearAllData()
      setResetMsg('Visualiseur réinitialisé — vous pouvez réimporter.')
      reload()
    } catch (e) {
      setResetMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setResetting(false)
    }
  }

  return (
    <div>
      <section className="panel" style={{ marginBottom: '1rem' }}>
        <h1 className="display" style={{ margin: '0 0 0.35rem' }}>
          Portefeuille local
        </h1>
        <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
          Vos opérations et quantités restent dans ce navigateur. Seuls des tickers publics
          transitent éventuellement vers le proxy de cours.
        </p>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link className="btn btn-primary" to="/import">
            Importer
          </Link>
          <Link className="btn" to="/charts">
            Voir les graphiques
          </Link>
          <button
            type="button"
            className="btn btn-danger"
            disabled={resetting}
            onClick={onResetAll}
          >
            {resetting ? 'Réinitialisation…' : 'Tout réinitialiser'}
          </button>
          {!isProxyConfigured() && (
            <span className="badge warn">Proxy cours non configuré</span>
          )}
        </div>
        {resetMsg && (
          <p className="muted" style={{ margin: '0.75rem 0 0', fontSize: '0.9rem' }}>
            {resetMsg}
          </p>
        )}
      </section>

      {loading && <p className="muted">Chargement…</p>}

      <div className="kpi">
        {data?.cards.map((c) =>
          c.empty ? (
            <div key={c.type} className="kpi-card">
              <div className="label">{envelopeLabel(c.type)}</div>
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
                {c.irr !== null && (
                  <>
                    {' '}
                    · TRI{' '}
                    <span
                      style={{
                        color: c.irr >= 0 ? 'var(--ok)' : 'var(--danger)',
                      }}
                    >
                      {fmtTriPct(c.irr)}
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
