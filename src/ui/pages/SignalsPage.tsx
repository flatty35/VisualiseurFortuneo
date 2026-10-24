import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EnvelopeType } from '@/domain/types'
import { ALL_ENVELOPES, envelopeLabel } from '@/domain/envelopes'
import {
  loadEnvelopeProjected,
  loadProjected,
} from '@/persist/portfolioStore'
import { buildHoldingsSeries } from '@/engine/positions'
import { scoreOpenPositions } from '@/engine/scoreOpenPositions'
import type { SignalLabel } from '@/engine/signalScore'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import { getAllQuoteMaps } from '@/quotes/localQuoteCache'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'
import {
  MacdHistSparkline,
  PriceSparkline,
} from '@/ui/components/Sparklines'

type Scope = EnvelopeType | 'ALL'
type SortKey = 'score' | 'name' | 'rsi'

function fmtPx(n: number, currency = 'EUR'): string {
  const c = (currency || 'EUR').toUpperCase()
  try {
    return n.toLocaleString('fr-FR', {
      style: 'currency',
      currency: c,
      maximumFractionDigits: 2,
    })
  } catch {
    return `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${c}`
  }
}

function scoreClass(score: number): string {
  if (score >= 50) return 'score-pill score-strong-buy'
  if (score >= 20) return 'score-pill score-buy'
  if (score <= -50) return 'score-pill score-strong-sell'
  if (score <= -20) return 'score-pill score-sell'
  return 'score-pill score-neutral'
}

function regimeLabel(r: string): string {
  if (r === 'bull') return 'Haussier'
  if (r === 'bear') return 'Baissier'
  return 'Neutre'
}

function volLabel(v: boolean | undefined): string {
  if (v === true) return 'OK'
  if (v === false) return 'Faible'
  return 'n/a'
}

function labelTone(label: SignalLabel): string {
  if (label === 'Achat fort' || label === 'Renfort') return 'ok'
  if (label === 'Vente' || label === 'Alléger') return 'warn'
  return 'muted'
}

export default function SignalsPage() {
  const [scope, setScope] = useState<Scope>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortAsc, setSortAsc] = useState(false)
  const [openScoreIsin, setOpenScoreIsin] = useState<string | null>(null)

  const { data, loading, error } = useAsyncData(async () => {
    await ensureHistoricalSupports()
    const quotes = await getAllQuoteMaps()
    if (scope === 'ALL') {
      const projected = await loadProjected()
      const positions: Array<{
        isin: string
        quantity: number
        envelope: EnvelopeType
      }> = []
      for (const env of ALL_ENVELOPES) {
        const ops = projected.operations.filter((o) => o.envelope === env)
        const vo =
          projected.virtualOpenings.find((v) => v.envelope === env) ?? null
        if (!ops.length && !vo) continue
        const series = buildHoldingsSeries({
          envelope: env,
          operations: ops,
          virtualOpening: vo,
        })
        const last = series[series.length - 1]
        if (!last) continue
        for (const [isin, qty] of last.quantities) {
          if (Math.abs(qty) < 1e-10) continue
          positions.push({ isin, quantity: qty, envelope: env })
        }
      }
      return {
        rows: scoreOpenPositions({
          positions,
          supports: projected.supports,
          quotes,
        }),
        skippedNoHistory: 0,
      }
    }

    const projected = await loadEnvelopeProjected(scope)
    const series = buildHoldingsSeries({
      envelope: scope,
      operations: projected.operations,
      virtualOpening: projected.virtualOpening,
    })
    const last = series[series.length - 1]
    const positions = last
      ? [...last.quantities.entries()]
          .filter(([, q]) => Math.abs(q) >= 1e-10)
          .map(([isin, quantity]) => ({
            isin,
            quantity,
            envelope: scope,
          }))
      : []
    return {
      rows: scoreOpenPositions({
        positions,
        supports: projected.supports,
        quotes,
      }),
      skippedNoHistory: 0,
    }
  }, [scope])

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])]
    list.sort((a, b) => {
      let cmp = 0
      if (sortKey === 'score') cmp = a.signal.score - b.signal.score
      else if (sortKey === 'rsi')
        cmp = (a.indicators.rsi ?? -1) - (b.indicators.rsi ?? -1)
      else cmp = a.name.localeCompare(b.name, 'fr')
      if (cmp !== 0) return sortAsc ? cmp : -cmp
      // Tie-break: always alphabetical by name (A→Z), independent of primary direction
      return a.name.localeCompare(b.name, 'fr')
    })
    return list
  }, [data, sortKey, sortAsc])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      // Name → A→Z first; RSI / score → high→low first
      setSortAsc(key === 'name')
    }
  }

  const sortMark = (key: SortKey) => {
    if (sortKey !== key) return ''
    return sortAsc ? ' ↑' : ' ↓'
  }

  const sortHeader = (key: SortKey, label: string) => (
    <th
      aria-sort={
        sortKey !== key
          ? 'none'
          : sortAsc
            ? 'ascending'
            : 'descending'
      }
    >
      <button
        type="button"
        className={`signals-sort-btn${sortKey === key ? ' active' : ''}`}
        onClick={() => toggleSort(key)}
        title={
          sortKey === key
            ? sortAsc
              ? 'Tri croissant — cliquer pour inverser'
              : 'Tri décroissant — cliquer pour inverser'
            : `Trier par ${label}`
        }
      >
        {label}
        <span className="signals-sort-mark" aria-hidden>
          {sortMark(key)}
        </span>
      </button>
    </th>
  )

  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Signaux</h1>
        <p className="muted">
          Score technique sur les positions ouvertes (MM19/49/190, RSI, MACD,
          pivots S/R, volume, ATR). Cliquez Titre / RSI / Score pour trier.
          Survolez le score pour les raisons pour / contre.
        </p>

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: '1rem',
            fontSize: '0.9rem',
          }}
        >
          <span className="muted">Enveloppe</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
            aria-label="Filtrer par enveloppe"
          >
            <option value="ALL">Tout le portefeuille</option>
            {ALL_ENVELOPES.map((e) => (
              <option key={e} value={e}>
                {envelopeLabel(e)}
              </option>
            ))}
          </select>
        </label>

        {loading && <p className="muted">Calcul des indicateurs…</p>}
        {error && <p className="muted">{String(error)}</p>}

        {!loading && rows.length === 0 && (
          <p className="muted">
            Aucune position scorable (historique insuffisant, dérivés exclus,
            ou portefeuille vide). Rafraîchissez les cours depuis Graphiques si
            besoin.
          </p>
        )}

        {rows.length > 0 && (
          <table className="data signals-table">
            <thead>
              <tr>
                {sortHeader('name', 'Titre')}
                <th title="Cours ~2 ans (cache local)">2A</th>
                {scope === 'ALL' && <th>Enveloppe</th>}
                <th>Cours</th>
                <th>Régime</th>
                {sortHeader('rsi', 'RSI')}
                {sortHeader('score', 'Score')}
                <th title="Histogramme MACD ~3 mois (vert = hausse, rouge = baisse)">
                  MACD
                </th>
                <th
                  title="Niveaux indicatifs basés sur la volatilité (ATR) : stop de protection ≈ cours − 2×ATR, objectif ≈ cours + 3×ATR. Ce n’est pas un ordre automatique."
                >
                  Stop / Objectif
                </th>
                <th>Vol.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cur = r.quoteCurrency || 'EUR'
                const open = openScoreIsin === r.isin
                return (
                  <tr key={r.isin}>
                    <td>
                      <Link
                        className="signal-title"
                        to={`/charts?${new URLSearchParams({
                          isin: r.isin,
                          envelope:
                            scope !== 'ALL'
                              ? scope
                              : (r.envelopes[0] ?? 'ALL'),
                        }).toString()}`}
                        title="Voir le graphique de ce titre"
                      >
                        {r.name}
                      </Link>
                      <code className="muted" style={{ fontSize: '0.75rem' }}>
                        {r.isin.length > 18 ? `${r.isin.slice(0, 16)}…` : r.isin}
                      </code>
                    </td>
                    <td className="spark-cell">
                      <PriceSparkline points={r.sparkPoints} />
                    </td>
                    {scope === 'ALL' && (
                      <td>
                        <span className="badge muted">
                          {r.envelopes.map(envelopeLabel).join(' · ')}
                        </span>
                      </td>
                    )}
                    <td>{fmtPx(r.indicators.lastClose, cur)}</td>
                    <td>{regimeLabel(r.indicators.regime)}</td>
                    <td>
                      {r.indicators.rsi !== undefined
                        ? r.indicators.rsi.toLocaleString('fr-FR', {
                            maximumFractionDigits: 1,
                          })
                        : '—'}
                    </td>
                    <td
                      className="score-cell"
                      onMouseEnter={() => setOpenScoreIsin(r.isin)}
                      onMouseLeave={() => setOpenScoreIsin(null)}
                    >
                      <button
                        type="button"
                        className={scoreClass(r.signal.score)}
                        aria-expanded={open}
                        aria-label={`Score ${r.signal.score}, ${r.signal.label}. Afficher les raisons.`}
                        onFocus={() => setOpenScoreIsin(r.isin)}
                        onBlur={() => setOpenScoreIsin(null)}
                        onClick={() =>
                          setOpenScoreIsin((curIsin) =>
                            curIsin === r.isin ? null : r.isin,
                          )
                        }
                      >
                        {r.signal.score > 0 ? '+' : ''}
                        {r.signal.score}
                        <span className={`badge ${labelTone(r.signal.label)}`}>
                          {r.signal.label}
                        </span>
                      </button>
                      {open && (
                        <div className="score-popover" role="tooltip">
                          <div className="score-popover-cols">
                            <div>
                              <strong>Pour</strong>
                              {r.signal.reasonsFor.length === 0 ? (
                                <p className="muted">—</p>
                              ) : (
                                <ul>
                                  {r.signal.reasonsFor.map((x) => (
                                    <li key={x.label}>
                                      {x.label}
                                      {x.points !== 0
                                        ? ` (${x.points > 0 ? '+' : ''}${x.points})`
                                        : ''}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <div>
                              <strong>Contre</strong>
                              {r.signal.reasonsAgainst.length === 0 ? (
                                <p className="muted">—</p>
                              ) : (
                                <ul>
                                  {r.signal.reasonsAgainst.map((x) => (
                                    <li key={x.label}>
                                      {x.label}
                                      {x.points !== 0
                                        ? ` (${x.points})`
                                        : ''}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>
                          {r.signal.reasonsInfo.length > 0 && (
                            <ul className="score-popover-info">
                              {r.signal.reasonsInfo.map((x) => (
                                <li key={x.label} className="muted">
                                  {x.label}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="score-popover-foot muted">
                            Total {r.signal.score > 0 ? '+' : ''}
                            {r.signal.score} — indicateurs informatifs, pas un
                            conseil.
                          </p>
                        </div>
                      )}
                    </td>
                    <td className="spark-cell">
                      <MacdHistSparkline bars={r.macdHist} />
                    </td>
                    <td
                      title={
                        r.indicators.stopLoss !== undefined &&
                        r.indicators.takeProfit !== undefined
                          ? `Stop (protection) ${fmtPx(r.indicators.stopLoss, cur)} · Objectif ${fmtPx(r.indicators.takeProfit, cur)} — calcul ATR, indicatif`
                          : undefined
                      }
                    >
                      {r.indicators.stopLoss !== undefined &&
                      r.indicators.takeProfit !== undefined
                        ? `${fmtPx(r.indicators.stopLoss, cur)} → ${fmtPx(r.indicators.takeProfit, cur)}`
                        : '—'}
                    </td>
                    <td>{volLabel(r.indicators.volumeConfirm)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <p className="muted" style={{ marginTop: '1.25rem', fontSize: '0.85rem' }}>
          Indicateurs techniques à titre informatif uniquement — ce n’est pas un
          conseil en investissement. Les OPCVM sans volume Yahoo affichent Vol.
          n/a. Redéployez le proxy GAS puis rafraîchissez les cours pour activer
          high/low/volume.
        </p>
      </section>
    </div>
  )
}
