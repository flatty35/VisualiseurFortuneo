import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvelopeType, Support } from '@/domain/types'
import { loadProjected } from '@/persist/portfolioStore'
import {
  isValidIsin,
  normalizeSupportKey,
  rekeySupport,
} from '@/persist/rekeySupport'
import { buildHoldingsSeries } from '@/engine/positions'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import { isLocalSupportId } from '@/import/resolveIsin'
import { isProxyConfigured } from '@/quotes/gasClient'
import {
  autoResolveLocalIsins,
  searchIsinCandidates,
  type IsinCandidate,
  type IsinSearchDebugStep,
} from '@/quotes/isinSearch'
import {
  autoMatchSupports,
  googleTickerFromYahoo,
  resetSupportTickers,
  searchTickerCandidates,
  type TickerCandidate,
} from '@/quotes/tickerMatch'
import { useAsyncData } from '@/ui/hooks/useLiveQuery'

type SearchBoxState<T> = {
  loading: boolean
  status: string | null
  error: string | null
  queries: string[]
  candidates: T[]
  debug?: IsinSearchDebugStep[]
  suggested?: IsinCandidate
}

const emptySearch = <T,>(): SearchBoxState<T> => ({
  loading: false,
  status: null,
  error: null,
  queries: [],
  candidates: [],
  debug: [],
  suggested: undefined,
})

type SupportRow = Support & {
  held: boolean
  envelopes: EnvelopeType[]
}

export default function MappingsPage() {
  const { data, loading, reload } = useAsyncData(async () => {
    // Label-only Fortuneo rows → LOCAL supports (incl. titres sortis)
    await ensureHistoricalSupports()

    const { supports, operations, virtualOpenings: openings } =
      await loadProjected()
    supports.sort((a, b) => a.name.localeCompare(b.name, 'fr'))

    const held = new Set<string>()
    const envelopesByIsin = new Map<string, Set<EnvelopeType>>()

    for (const env of ['PEA', 'PEA_PME', 'CTO'] as EnvelopeType[]) {
      const ops = operations.filter((o) => o.envelope === env)
      if (!ops.length) continue
      const vo = openings.find((o) => o.envelope === env) ?? null
      const series = buildHoldingsSeries({
        envelope: env,
        operations: ops,
        virtualOpening: vo,
      })
      const last = series[series.length - 1]
      if (last) {
        for (const [isin, qty] of last.quantities) {
          if (Math.abs(qty) > 1e-8) held.add(isin)
        }
      }
      // Any isin seen in history for this envelope
      for (const snap of series) {
        for (const [isin, qty] of snap.quantities) {
          if (Math.abs(qty) <= 1e-8) continue
          const set = envelopesByIsin.get(isin) ?? new Set()
          set.add(env)
          envelopesByIsin.set(isin, set)
        }
      }
      for (const o of ops) {
        if (!o.isin) continue
        const set = envelopesByIsin.get(o.isin) ?? new Set()
        set.add(env)
        envelopesByIsin.set(o.isin, set)
      }
    }

    const rows: SupportRow[] = supports
      .map((s) => ({
        ...s,
        held: held.has(s.isin),
        envelopes: [...(envelopesByIsin.get(s.isin) ?? [])],
      }))
      .sort((a, b) => {
        if (a.held !== b.held) return a.held ? -1 : 1
        return a.name.localeCompare(b.name, 'fr')
      })

    return rows
  }, [])
  const [edit, setEdit] = useState<Support | null>(null)
  /** Key in DB when the editor was opened (for rekey on save). */
  const [editOriginalIsin, setEditOriginalIsin] = useState<string | null>(null)

  const toSupport = (s: SupportRow | Support): Support => ({
    isin: s.isin,
    name: s.name,
    yahooTicker: s.yahooTicker,
    googleTicker: s.googleTicker,
    boursoramaTicker: s.boursoramaTicker,
    manualPrices: s.manualPrices,
    staticPrice: s.staticPrice,
  })

  const openEdit = (s: SupportRow | Support) => {
    const support = toSupport(s)
    setEditOriginalIsin(support.isin)
    setEdit(support)
  }

  const editPanelRef = useRef<HTMLElement>(null)
  const yahooInputRef = useRef<HTMLInputElement>(null)
  const [manualDate, setManualDate] = useState('')
  const [manualPrice, setManualPrice] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [matching, setMatching] = useState(false)
  const [matchProgress, setMatchProgress] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tickerSearch, setTickerSearch] =
    useState<SearchBoxState<TickerCandidate>>(emptySearch)
  const [isinSearch, setIsinSearch] =
    useState<SearchBoxState<IsinCandidate>>(emptySearch)
  const [saving, setSaving] = useState(false)

  const rows = data ?? []
  const allIsins = useMemo(() => rows.map((s) => s.isin), [rows])

  // Drop selections that no longer exist after reload
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((isin) => allIsins.includes(isin)))
      return next.size === prev.size ? prev : next
    })
  }, [allIsins])

  // When opening editor: scroll into view + focus; reset searches
  useEffect(() => {
    if (!editOriginalIsin) return
    setTickerSearch(emptySearch())
    setIsinSearch(emptySearch())
    editPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const t = window.setTimeout(() => {
      yahooInputRef.current?.focus()
      yahooInputRef.current?.select()
    }, 50)
    return () => window.clearTimeout(t)
  }, [editOriginalIsin])

  const runTickerSearch = async () => {
    if (!edit) return
    setTickerSearch((s) => ({
      ...s,
      loading: true,
      status: 'Recherche…',
      error: null,
      candidates: [],
    }))
    try {
      const report = await searchTickerCandidates({
        name: edit.name,
        isin: isLocalSupportId(edit.isin) ? undefined : edit.isin,
        onStatus: (status) =>
          setTickerSearch((s) => ({ ...s, status })),
      })
      setTickerSearch({
        loading: false,
        status: null,
        error: report.error ?? null,
        queries: report.queries,
        candidates: report.candidates,
      })
    } catch (e) {
      setTickerSearch({
        loading: false,
        status: null,
        error: e instanceof Error ? e.message : String(e),
        queries: [],
        candidates: [],
      })
    }
  }

  const runIsinSearch = async () => {
    if (!edit) return
    setIsinSearch((s) => ({
      ...s,
      loading: true,
      status: 'Recherche…',
      error: null,
      candidates: [],
      debug: [],
      suggested: undefined,
    }))
    try {
      const report = await searchIsinCandidates({
        name: edit.name,
        yahooTicker: edit.yahooTicker,
        onStatus: (status) => setIsinSearch((s) => ({ ...s, status })),
      })
      setIsinSearch({
        loading: false,
        status: report.suggested
          ? `Suggestion EUR : ${report.suggested.isin}`
          : null,
        error: report.error ?? null,
        queries: report.queries,
        candidates: report.candidates,
        debug: report.debug,
        suggested: report.suggested,
      })
      // Auto-remplir si clé locale + suggestion EUR fiable
      if (
        report.suggested &&
        isLocalSupportId(edit.isin) &&
        report.suggested.eurListed
      ) {
        pickIsinCandidate(report.suggested)
      }
    } catch (e) {
      setIsinSearch({
        loading: false,
        status: null,
        error: e instanceof Error ? e.message : String(e),
        queries: [],
        candidates: [],
        debug: [],
      })
    }
  }

  const pickTickerCandidate = (c: TickerCandidate) => {
    if (!edit) return
    const g = googleTickerFromYahoo(c.symbol)
    setEdit({
      ...edit,
      yahooTicker: c.symbol,
      googleTicker: g ?? edit.googleTicker,
    })
  }

  const pickIsinCandidate = (c: IsinCandidate) => {
    if (!edit) return
    const g = c.ticker
      ? googleTickerFromYahoo(c.ticker)
      : undefined
    setEdit({
      ...edit,
      isin: c.isin,
      yahooTicker: c.ticker || edit.yahooTicker,
      googleTicker: g ?? edit.googleTicker,
      name: edit.name || c.name || edit.name,
    })
  }

  const allSelected = rows.length > 0 && selected.size === rows.length
  const someSelected = selected.size > 0 && !allSelected

  const toggleOne = (isin: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(isin)) next.delete(isin)
      else next.add(isin)
      return next
    })
  }

  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(allIsins))
  }

  const selectedSupports = () => rows.filter((s) => selected.has(s.isin))

  const runAutoMatchMissing = async () => {
    setMatching(true)
    setMsg(null)
    setMatchProgress(null)
    try {
      const isinR = await autoResolveLocalIsins(undefined, {
        onProgress: (info) =>
          setMatchProgress(`ISIN ${info.current}/${info.total} — ${info.name}`),
      })
      const r = await autoMatchSupports(undefined, {
        onProgress: (info) => setMatchProgress(`${info.status} — ${info.name}`),
      })
      setMsg(
        `ISIN locaux : ${isinR.updated} résolus, ${isinR.skipped} à valider, ${isinR.failed} échecs · ` +
          `Tickers : ${r.updated} associés, ${r.failed} non trouvés`,
      )
      reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setMatching(false)
      setMatchProgress(null)
    }
  }

  const runAutoIsinLocal = async () => {
    setMatching(true)
    setMsg(null)
    setMatchProgress(null)
    try {
      const r = await autoResolveLocalIsins(undefined, {
        onProgress: (info) =>
          setMatchProgress(`ISIN ${info.current}/${info.total} — ${info.name}`),
      })
      setMsg(
        `ISIN (LOCAL→réel, préférence EUR) : ${r.updated} appliqués · ${r.skipped} à choisir à l’édition · ${r.failed} non trouvés`,
      )
      reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setMatching(false)
      setMatchProgress(null)
    }
  }

  const runReassociateSelected = async () => {
    const list = selectedSupports()
    if (!list.length) {
      setMsg('Sélectionnez au moins une ligne.')
      return
    }
    setMatching(true)
    setMsg(null)
    setMatchProgress(null)
    try {
      const r = await autoMatchSupports(list, {
        force: true,
        onProgress: (info) => setMatchProgress(`${info.status} — ${info.name}`),
      })
      setMsg(
        `Réassociation : ${r.updated} mis à jour · ${r.failed} non trouvés (${list.length} sélectionné(s))`,
      )
      reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setMatching(false)
      setMatchProgress(null)
    }
  }

  const runResetSelected = async () => {
    const list = selectedSupports()
    if (!list.length) {
      setMsg('Sélectionnez au moins une ligne.')
      return
    }
    if (
      !confirm(
        `Réinitialiser les tickers Yahoo/Google de ${list.length} ligne(s) sélectionnée(s) ?`,
      )
    ) {
      return
    }
    setMatching(true)
    setMsg(null)
    try {
      const n = await resetSupportTickers(list)
      setMsg(`${n} ticker(s) réinitialisé(s)`)
      reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setMatching(false)
    }
  }

  const save = async () => {
    if (!edit || !editOriginalIsin) return
    const nextKey = normalizeSupportKey(edit.isin)
    if (!isLocalSupportId(nextKey) && !isValidIsin(nextKey)) {
      setMsg(
        'ISIN invalide — 12 caractères (ex. FR0000120073) ou conservez LOCAL:…',
      )
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const patch = {
        name: edit.name,
        yahooTicker: edit.yahooTicker,
        googleTicker: edit.googleTicker,
        boursoramaTicker: edit.boursoramaTicker,
        manualPrices: edit.manualPrices,
        staticPrice: edit.staticPrice,
      }
      const r = await rekeySupport(editOriginalIsin, nextKey, patch)
      const bits = [`Enregistré : ${r.to}`]
      if (r.from !== r.to) {
        bits.push(`clé ${r.from} → ${r.to}`)
        if (r.opsUpdated) bits.push(`${r.opsUpdated} op(s)`)
        if (r.mergedIntoExisting) bits.push('fusionné avec un support existant')
      }
      setMsg(bits.join(' · '))
      setEdit(null)
      setEditOriginalIsin(null)
      reload()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const closeEdit = () => {
    setEdit(null)
    setEditOriginalIsin(null)
  }

  const addManual = () => {
    if (!edit || !manualDate || !manualPrice) return
    const price = Number(manualPrice.replace(',', '.'))
    if (!Number.isFinite(price)) return
    const manualPrices = [
      ...edit.manualPrices.filter((p) => p.date !== manualDate),
      { date: manualDate, price },
    ].sort((a, b) => a.date.localeCompare(b.date))
    setEdit({ ...edit, manualPrices })
    setManualDate('')
    setManualPrice('')
  }

  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Correspondances actifs</h1>
        <p className="muted">
          Associez chaque titre (ouverts et sortis) à un ISIN réel et un ticker Yahoo. Les exports
          Fortuneo sans ISIN utilisent une clé <code>LOCAL:…</code> — éditable : recherchez un
          ISIN ou saisissez-le ; à l’enregistrement, les opérations sont migrées.
        </p>

        <div
          style={{
            marginTop: 8,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            className="btn btn-primary"
            disabled={matching}
            onClick={runAutoMatchMissing}
          >
            {matching ? 'Association…' : 'Auto-associer (ISIN + tickers)'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={matching}
            onClick={runAutoIsinLocal}
            title="Résout les clés LOCAL:… vers un ISIN réel (EUR privilégié)"
          >
            Auto-ISIN (titres sortis / LOCAL)
          </button>
          <button
            type="button"
            className="btn"
            disabled={matching || selected.size === 0}
            onClick={runReassociateSelected}
          >
            Réassocier tickers (sélection)
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={matching || selected.size === 0}
            onClick={runResetSelected}
          >
            Reset sélection
          </button>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {selected.size} sélectionné(s)
          </span>
        </div>

        {matchProgress && (
          <p className="muted" style={{ marginTop: 8 }}>
            {matchProgress}
          </p>
        )}
        {msg && (
          <div className="badge" style={{ display: 'block', marginTop: 8 }}>
            {msg}
          </div>
        )}
        {loading && <p className="muted">Chargement…</p>}

        <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected
                    }}
                    onChange={toggleAll}
                    title={allSelected ? 'Tout désélectionner' : 'Tout sélectionner'}
                    aria-label="Tout sélectionner / aucun"
                  />
                </th>
                <th>Nom</th>
                <th>Statut</th>
                <th>ISIN / clé</th>
                <th>Yahoo</th>
                <th>Google</th>
                <th>Boursorama</th>
                <th>Prix fixe</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.isin} style={s.held ? undefined : { opacity: 0.9 }}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(s.isin)}
                      onChange={() => toggleOne(s.isin)}
                      aria-label={`Sélectionner ${s.name}`}
                    />
                  </td>
                  <td>{s.name}</td>
                  <td>
                    {s.held ? (
                      <span className="badge">En portefeuille</span>
                    ) : (
                      <span className="badge warn">Sorti</span>
                    )}
                    {s.envelopes.length > 0 && (
                      <span className="muted" style={{ marginLeft: 6, fontSize: '0.75rem' }}>
                        {s.envelopes.join(', ')}
                      </span>
                    )}
                  </td>
                  <td>
                    <code title={s.isin}>
                      {isLocalSupportId(s.isin) ? s.isin.replace(/^LOCAL:/, 'loc:') : s.isin}
                    </code>
                  </td>
                  <td>{s.yahooTicker || <span className="badge warn">—</span>}</td>
                  <td>{s.googleTicker || '—'}</td>
                  <td>{s.boursoramaTicker || '—'}</td>
                  <td>{s.staticPrice ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => openEdit(s)}
                    >
                      Éditer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>          </table>
        </div>
      </section>

      {edit && (
        <section className="panel" ref={editPanelRef} id="support-edit-panel">
          <h2 style={{ marginTop: 0 }}>
            Édition — {edit.name}{' '}
            <span className="muted">
              (
              {editOriginalIsin && editOriginalIsin !== edit.isin
                ? `${editOriginalIsin} → ${edit.isin}`
                : edit.isin}
              )
            </span>
          </h2>

          <div style={{ marginBottom: '1rem' }}>
            <label>
              <span className="muted">
                ISIN (clé du support — éditable ; les opérations sont migrées à
                l’enregistrement)
              </span>
              <br />
              <input
                value={edit.isin}
                onChange={(e) =>
                  setEdit({ ...edit, isin: e.target.value.trim() })
                }
                placeholder="FR0000120073 ou LOCAL:…"
                spellCheck={false}
                style={{
                  width: '100%',
                  maxWidth: 420,
                  marginTop: 6,
                  fontFamily: 'ui-monospace, monospace',
                }}
              />
            </label>
            {isLocalSupportId(editOriginalIsin ?? edit.isin) && (
              <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.85rem' }}>
                Clé locale (export Fortuneo sans ISIN). Recherchez un vrai ISIN
                ou saisissez-le, puis enregistrez.
              </p>
            )}
            <div
              style={{
                marginTop: 8,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                className="btn"
                disabled={isinSearch.loading || matching || saving}
                onClick={runIsinSearch}
                title="Morningstar (dev via Vite) + GAS OpenFIGI/Boursorama — défaut EUR"
              >
                {isinSearch.loading ? 'Recherche ISIN…' : 'Rechercher un ISIN'}
              </button>
              {isinSearch.suggested && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={() => pickIsinCandidate(isinSearch.suggested!)}
                >
                  Appliquer suggestion
                  {isinSearch.suggested.eurListed ? ' EUR' : ''}
                </button>
              )}
              {isinSearch.status && (
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  {isinSearch.status}
                </span>
              )}
            </div>
            {isinSearch.error && (
              <p
                className="muted"
                style={{ margin: '6px 0 0', color: 'var(--danger)' }}
              >
                {isinSearch.error}
              </p>
            )}
            {(isinSearch.debug?.length ?? 0) > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>
                  Debug recherche ISIN ({isinSearch.debug!.length} étapes)
                  {import.meta.env.DEV ? ' · Morningstar via /api/morningstar' : ''}
                </summary>
                <pre
                  className="muted"
                  style={{
                    marginTop: 6,
                    padding: 10,
                    borderRadius: 8,
                    background: 'rgba(0,0,0,0.35)',
                    fontSize: '0.75rem',
                    whiteSpace: 'pre-wrap',
                    maxHeight: 180,
                    overflow: 'auto',
                  }}
                >
                  {`Requêtes: ${isinSearch.queries.join(' · ') || '—'}\n` +
                    isinSearch
                      .debug!.map(
                        (d) =>
                          `${d.ok ? '✓' : '✗'} [${d.phase}]${d.query ? ` «${d.query}»` : ''} — ${d.detail}${d.count != null ? ` (n=${d.count})` : ''}`,
                      )
                      .join('\n')}
                </pre>
              </details>
            )}
            {isinSearch.candidates.length > 0 && (
              <div
                style={{
                  marginTop: 10,
                  maxHeight: 220,
                  overflowY: 'auto',
                  border: '1px solid rgba(232,240,235,0.12)',
                  borderRadius: 10,
                  background: 'rgba(0,0,0,0.2)',
                }}
              >
                <table className="data" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>ISIN</th>
                      <th>Nom</th>
                      <th>Ticker</th>
                      <th>Place</th>
                      <th>Source</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {isinSearch.candidates.map((c) => {
                      const selectedIsin =
                        normalizeSupportKey(edit.isin) === c.isin
                      const isSuggested =
                        isinSearch.suggested?.isin === c.isin
                      const label = c.name || '—'
                      return (
                        <tr
                          key={c.isin}
                          style={
                            selectedIsin || isSuggested
                              ? { background: 'rgba(196, 163, 90, 0.12)' }
                              : undefined
                          }
                        >
                          <td>
                            <code>{c.isin}</code>
                            {c.eurListed && (
                              <span className="badge" style={{ marginLeft: 6 }}>
                                EUR
                              </span>
                            )}
                            {isSuggested && (
                              <span className="badge" style={{ marginLeft: 6 }}>
                                défaut
                              </span>
                            )}
                          </td>
                          <td title={label}>
                            {label.length > 40
                              ? label.slice(0, 40) + '…'
                              : label}
                          </td>
                          <td>
                            <code>{c.ticker || '—'}</code>
                          </td>
                          <td className="muted" style={{ fontSize: '0.75rem' }}>
                            {c.exch || (c.eurListed ? 'EUR' : '—')}
                          </td>
                          <td
                            className="muted"
                            style={{ fontSize: '0.75rem' }}
                          >
                            {c.sources.join('+')}
                          </td>
                          <td>
                            <button
                              type="button"
                              className={`btn ${selectedIsin ? 'btn-primary' : ''}`}
                              onClick={() => pickIsinCandidate(c)}
                            >
                              {selectedIsin ? 'Sélectionné' : 'Choisir'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid-2">
            <div>
              <label>
                <span className="muted">Ticker Yahoo</span>
                <br />
                <input
                  ref={yahooInputRef}
                  value={edit.yahooTicker ?? ''}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      yahooTicker: e.target.value.trim() || undefined,
                    })
                  }
                  placeholder="MC.PA — ou choisissez ci-dessous"
                  style={{ width: '100%', marginTop: 6 }}
                />
              </label>
              <div
                style={{
                  marginTop: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  className="btn"
                  disabled={tickerSearch.loading || matching}
                  onClick={runTickerSearch}
                  title={
                    isProxyConfigured()
                      ? 'Recherche Yahoo (ISIN + nom) et OpenFIGI'
                      : 'Proxy non configuré — seed locale uniquement'
                  }
                >
                  {tickerSearch.loading
                    ? 'Recherche…'
                    : 'Rechercher des tickers'}
                </button>
                {tickerSearch.status && (
                  <span className="muted" style={{ fontSize: '0.85rem' }}>
                    {tickerSearch.status}
                  </span>
                )}
              </div>
              {tickerSearch.error && (
                <p className="muted" style={{ margin: '6px 0 0', color: 'var(--danger)' }}>
                  {tickerSearch.error}
                </p>
              )}
              {tickerSearch.queries.length > 0 && !tickerSearch.loading && (
                <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.8rem' }}>
                  Requêtes : {tickerSearch.queries.join(' · ')}
                </p>
              )}
              {tickerSearch.candidates.length > 0 && (
                <div
                  style={{
                    marginTop: 10,
                    maxHeight: 220,
                    overflowY: 'auto',
                    border: '1px solid rgba(232,240,235,0.12)',
                    borderRadius: 10,
                    background: 'rgba(0,0,0,0.2)',
                  }}
                >
                  <table className="data" style={{ margin: 0 }}>
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        <th>Nom</th>
                        <th>Type</th>
                        <th>Source</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {tickerSearch.candidates.map((c) => {
                        const selectedYahoo =
                          (edit.yahooTicker || '').toUpperCase() ===
                          c.symbol.toUpperCase()
                        const label =
                          c.longname || c.shortname || '—'
                        return (
                          <tr
                            key={c.symbol}
                            style={
                              selectedYahoo
                                ? { background: 'rgba(196, 163, 90, 0.12)' }
                                : undefined
                            }
                          >
                            <td>
                              <code>{c.symbol}</code>
                              {c.symbol.endsWith('.PA') && (
                                <span
                                  className="badge"
                                  style={{ marginLeft: 6 }}
                                >
                                  .PA
                                </span>
                              )}
                            </td>
                            <td title={label}>
                              {label.length > 42
                                ? label.slice(0, 42) + '…'
                                : label}
                            </td>
                            <td className="muted">
                              {c.quoteType || c.exch || '—'}
                            </td>
                            <td className="muted" style={{ fontSize: '0.75rem' }}>
                              {c.sources.join('+')}
                            </td>
                            <td>
                              <button
                                type="button"
                                className={`btn ${selectedYahoo ? 'btn-primary' : ''}`}
                                onClick={() => pickTickerCandidate(c)}
                              >
                                {selectedYahoo ? 'Sélectionné' : 'Choisir'}
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {!tickerSearch.loading &&
                tickerSearch.queries.length > 0 &&
                tickerSearch.candidates.length === 0 &&
                !tickerSearch.error && (
                  <p className="muted" style={{ marginTop: 8 }}>
                    Aucun ticker trouvé — saisissez-en un manuellement ci-dessus.
                  </p>
                )}
            </div>
            <label>
              <span className="muted">Ticker Google</span>
              <br />
              <input
                value={edit.googleTicker ?? ''}
                onChange={(e) =>
                  setEdit({ ...edit, googleTicker: e.target.value || undefined })
                }
                placeholder="EPA:MC"
                style={{ width: '100%', marginTop: 6 }}
              />
            </label>
            <label>
              <span className="muted">Ticker / URL Boursorama (v2)</span>
              <br />
              <input
                value={edit.boursoramaTicker ?? ''}
                onChange={(e) =>
                  setEdit({
                    ...edit,
                    boursoramaTicker: e.target.value || undefined,
                  })
                }
                style={{ width: '100%', marginTop: 6 }}
              />
            </label>
            <label>
              <span className="muted">Prix fixe (si pas de Yahoo)</span>
              <br />
              <input
                value={edit.staticPrice ?? ''}
                onChange={(e) => {
                  const v = e.target.value.replace(',', '.')
                  setEdit({
                    ...edit,
                    staticPrice: v === '' ? undefined : Number(v),
                  })
                }}
                style={{ width: '100%', marginTop: 6 }}
              />
            </label>
            <label>
              <span className="muted">Nom</span>
              <br />
              <input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                style={{ width: '100%', marginTop: 6 }}
              />
            </label>
          </div>

          <h3>Cours manuels</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label>
              <span className="muted">Date</span>
              <br />
              <input
                type="date"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
              />
            </label>
            <label>
              <span className="muted">Cours</span>
              <br />
              <input
                value={manualPrice}
                onChange={(e) => setManualPrice(e.target.value)}
                placeholder="12,34"
              />
            </label>
            <button type="button" className="btn" onClick={addManual}>
              Ajouter
            </button>
          </div>
          {edit.manualPrices.length > 0 && (
            <ul className="muted">
              {edit.manualPrices.map((p) => (
                <li key={p.date}>
                  {p.date} → {p.price}
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: '1rem', display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={save}
            >
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={closeEdit}
            >
              Annuler
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
