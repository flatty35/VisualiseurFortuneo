import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvelopeType, Operation, Support } from '@/domain/types'
import { ALL_ENVELOPES, envelopeLabel } from '@/domain/envelopes'
import { loadProjected } from '@/persist/portfolioStore'
import {
  isValidIsin,
  normalizeSupportKey,
  rekeySupport,
} from '@/persist/rekeySupport'
import { buildHoldingsSeries } from '@/engine/positions'
import { ensureHistoricalSupports } from '@/import/ensureHistoricalSupports'
import { isLocalSupportId } from '@/import/resolveIsin'
import {
  fetchBulkPrices,
  isProxyConfigured,
} from '@/quotes/gasClient'
import { autoResolveSupports } from '@/quotes/identityResolver'
import {
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

function fmtPrice(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

function fmtQty(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 6 })
}

function lookupLivePrice(
  prices: Record<string, number>,
  ticker: string | undefined,
): number | undefined {
  if (!ticker) return undefined
  if (prices[ticker] !== undefined) return prices[ticker]
  const key = Object.keys(prices).find(
    (k) => k.toUpperCase() === ticker.toUpperCase(),
  )
  return key !== undefined ? prices[key] : undefined
}

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
  /** Held in at least one envelope today. */
  held: boolean
  /** Envelopes where the position is currently open. */
  heldEnvelopes: EnvelopeType[]
  /** Envelopes that ever touched this support (history). */
  envelopes: EnvelopeType[]
}

type EnvelopeFilter = EnvelopeType | 'ALL'

export default function MappingsPage() {
  const { data, loading, reload } = useAsyncData(async () => {
    // Label-only Fortuneo rows → LOCAL supports (incl. titres sortis)
    await ensureHistoricalSupports()

    const { supports, operations, virtualOpenings: openings } =
      await loadProjected()
    supports.sort((a, b) => a.name.localeCompare(b.name, 'fr'))

    const heldByIsin = new Map<string, Set<EnvelopeType>>()
    const envelopesByIsin = new Map<string, Set<EnvelopeType>>()

    for (const env of ALL_ENVELOPES) {
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
          if (Math.abs(qty) <= 1e-8) continue
          const set = heldByIsin.get(isin) ?? new Set()
          set.add(env)
          heldByIsin.set(isin, set)
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
      .map((s) => {
        const heldEnvelopes = [...(heldByIsin.get(s.isin) ?? [])]
        return {
          ...s,
          held: heldEnvelopes.length > 0,
          heldEnvelopes,
          envelopes: [...(envelopesByIsin.get(s.isin) ?? [])],
        }
      })
      .sort((a, b) => {
        if (a.held !== b.held) return a.held ? -1 : 1
        return a.name.localeCompare(b.name, 'fr')
      })

    return { rows, operations }
  }, [])
  const [envelopeFilter, setEnvelopeFilter] = useState<EnvelopeFilter>('ALL')
  const [edit, setEdit] = useState<Support | null>(null)
  /** Key in DB when the editor was opened (for rekey on save). */
  const [editOriginalIsin, setEditOriginalIsin] = useState<string | null>(null)
  const [livePrices, setLivePrices] = useState<Record<string, number>>({})
  const [livePricesLoading, setLivePricesLoading] = useState(false)

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

  const rows = data?.rows ?? []
  const allOperations = data?.operations ?? []

  /** Envelopes that actually have supports (for a compact filter list). */
  const envelopesWithSupports = useMemo(() => {
    const present = new Set<EnvelopeType>()
    for (const r of rows) for (const e of r.envelopes) present.add(e)
    return ALL_ENVELOPES.filter((e) => present.has(e))
  }, [rows])

  const visibleRows = useMemo(() => {
    if (envelopeFilter === 'ALL') return rows
    return rows.filter((r) => r.envelopes.includes(envelopeFilter))
  }, [rows, envelopeFilter])

  const visibleIsins = useMemo(
    () => visibleRows.map((s) => s.isin),
    [visibleRows],
  )

  const rowIsHeld = (s: SupportRow): boolean =>
    envelopeFilter === 'ALL'
      ? s.held
      : s.heldEnvelopes.includes(envelopeFilter)

  /** Ops for the support being edited (original key + current key). */
  const editOps = useMemo(() => {
    if (!edit || !editOriginalIsin) return [] as Operation[]
    const keys = new Set(
      [editOriginalIsin, edit.isin]
        .filter(Boolean)
        .map((k) => normalizeSupportKey(k)),
    )
    return allOperations
      .filter(
        (o) =>
          o.isin &&
          keys.has(normalizeSupportKey(o.isin)) &&
          !o.synthetic,
      )
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
      )
  }, [edit, editOriginalIsin, allOperations])

  const editPriceHints = useMemo(() => {
    const priced = editOps.filter(
      (o) => o.price !== undefined && Number.isFinite(o.price) && o.price > 0,
    )
    const buys = priced.filter((o) => o.type === 'ACHAT' || o.type === 'SCRIPT')
    const sells = priced.filter((o) => o.type === 'VENTE' || o.type === 'RACHAT')
    const last = priced[0]
    const lastBuy = buys[0]
    const lastSell = sells[0]
    return { last, lastBuy, lastSell, count: priced.length }
  }, [editOps])

  // Drop selections that are outside the visible filter / no longer exist
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(
        [...prev].filter((isin) => visibleIsins.includes(isin)),
      )
      return next.size === prev.size ? prev : next
    })
  }, [visibleIsins])

  // When opening editor: scroll into view + focus; reset searches
  useEffect(() => {
    if (!editOriginalIsin) return
    setTickerSearch(emptySearch())
    setIsinSearch(emptySearch())
    setLivePrices({})
    editPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const t = window.setTimeout(() => {
      yahooInputRef.current?.focus()
      yahooInputRef.current?.select()
    }, 50)
    return () => window.clearTimeout(t)
  }, [editOriginalIsin])

  // Live prices for ticker candidates + current Yahoo ticker + ISIN candidate tickers
  const tickersForPrices = useMemo(() => {
    const set = new Set<string>()
    if (edit?.yahooTicker) set.add(edit.yahooTicker.trim())
    for (const c of tickerSearch.candidates) {
      if (c.symbol) set.add(c.symbol)
    }
    for (const c of isinSearch.candidates) {
      if (c.ticker) set.add(c.ticker)
    }
    return [...set]
  }, [edit?.yahooTicker, tickerSearch.candidates, isinSearch.candidates])

  useEffect(() => {
    if (!tickersForPrices.length || !isProxyConfigured()) {
      setLivePrices({})
      setLivePricesLoading(false)
      return
    }
    let cancelled = false
    setLivePricesLoading(true)
    fetchBulkPrices(tickersForPrices)
      .then((prices) => {
        if (!cancelled) setLivePrices(prices)
      })
      .catch(() => {
        if (!cancelled) setLivePrices({})
      })
      .finally(() => {
        if (!cancelled) setLivePricesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tickersForPrices.join('|')])

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

  const allSelected =
    visibleRows.length > 0 && selected.size === visibleRows.length
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
    else setSelected(new Set(visibleIsins))
  }

  const selectedSupports = () =>
    visibleRows.filter((s) => selected.has(s.isin))

  const runAutoMatchMissing = async () => {
    setMatching(true)
    setMsg(null)
    setMatchProgress(null)
    try {
      const fast = await autoResolveSupports(undefined, {
        onProgress: (info) =>
          setMatchProgress(`ISIN / ticker ${info.done}/${info.total} — ${info.name}`),
      })
      const bits = [
        `Rapide : ${fast.isinResolved} ISIN, ${fast.tickersSet} tickers (${fast.total} titres)`,
      ]
      if (isProxyConfigured()) {
        const r = await autoMatchSupports(undefined, {
          onProgress: (info) => setMatchProgress(`Proxy · ${info.status} — ${info.name}`),
        })
        if (r.updated + r.failed) {
          bits.push(`Proxy : ${r.updated} tickers, ${r.failed} non trouvés`)
        }
      }
      const locals = (await loadProjected()).supports.filter((s) =>
        isLocalSupportId(s.isin),
      ).length
      if (locals) bits.push(`${locals} LOCAL à valider à l’édition`)
      setMsg(bits.join(' · '))
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
      const fast = await autoResolveSupports(list, {
        force: true,
        onProgress: (info) =>
          setMatchProgress(`ISIN / ticker ${info.done}/${info.total} — ${info.name}`),
      })
      const missed = new Set(fast.unresolved.map((r) => r.key))
      const rest = isProxyConfigured()
        ? (await loadProjected()).supports.filter(
            (s) => missed.has(s.isin) && !isLocalSupportId(s.isin),
          )
        : []
      const r = rest.length
        ? await autoMatchSupports(rest, {
            force: true,
            onProgress: (info) => setMatchProgress(`Proxy · ${info.status} — ${info.name}`),
          })
        : { updated: 0, failed: 0 }
      setMsg(
        `Réassociation (${list.length} sélectionné(s)) : ${fast.isinResolved} ISIN, ${fast.tickersSet} tickers` +
          (rest.length ? ` · proxy ${r.updated} mis à jour, ${r.failed} non trouvés` : ''),
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
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '0.9rem',
            }}
          >
            <span className="muted">Enveloppe</span>
            <select
              value={envelopeFilter}
              onChange={(e) =>
                setEnvelopeFilter(e.target.value as EnvelopeFilter)
              }
              aria-label="Filtrer par enveloppe"
            >
              <option value="ALL">Tout le portefeuille</option>
              {envelopesWithSupports.map((e) => (
                <option key={e} value={e}>
                  {envelopeLabel(e)}
                </option>
              ))}
            </select>
          </label>
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
            {visibleRows.length} support(s)
            {envelopeFilter !== 'ALL' ? ` · ${envelopeLabel(envelopeFilter)}` : ''}
            {' · '}
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
              {visibleRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={9} className="muted" style={{ padding: '1rem 0.6rem' }}>
                    {envelopeFilter === 'ALL'
                      ? 'Aucun support — importez un historique.'
                      : `Aucun support pour ${envelopeLabel(envelopeFilter)}.`}
                  </td>
                </tr>
              )}
              {visibleRows.map((s) => {
                const heldHere = rowIsHeld(s)
                return (
                  <tr
                    key={s.isin}
                    style={heldHere ? undefined : { opacity: 0.9 }}
                  >
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
                      {heldHere ? (
                        <span className="badge">En portefeuille</span>
                      ) : (
                        <span className="badge warn">Sorti</span>
                      )}
                      {s.envelopes.length > 0 && (
                        <span
                          className="muted"
                          style={{ marginLeft: 6, fontSize: '0.75rem' }}
                        >
                          {s.envelopes.map(envelopeLabel).join(' · ')}
                        </span>
                      )}
                    </td>
                    <td>
                      <code title={s.isin}>
                        {isLocalSupportId(s.isin)
                          ? s.isin.replace(/^LOCAL:/, 'loc:')
                          : s.isin}
                      </code>
                    </td>
                    <td>
                      {s.yahooTicker || <span className="badge warn">—</span>}
                    </td>
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
                )
              })}
            </tbody>
          </table>
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

          <div style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>
              Opérations connues
              {editOps.length > 0 && (
                <span className="muted" style={{ fontWeight: 400 }}>
                  {' '}
                  ({editOps.length})
                </span>
              )}
            </h3>
            <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.85rem' }}>
              Prix Fortuneo pour caler ISIN / ticker
              {editPriceHints.lastBuy && (
                <>
                  {' '}
                  · dernier achat{' '}
                  <strong style={{ color: 'var(--text)' }}>
                    {fmtPrice(editPriceHints.lastBuy.price)} €
                  </strong>{' '}
                  ({editPriceHints.lastBuy.date})
                </>
              )}
              {editPriceHints.lastSell && (
                <>
                  {' '}
                  · dernière vente{' '}
                  <strong style={{ color: 'var(--text)' }}>
                    {fmtPrice(editPriceHints.lastSell.price)} €
                  </strong>{' '}
                  ({editPriceHints.lastSell.date})
                </>
              )}
              {!editPriceHints.count && editOps.length > 0 && (
                <> · aucun prix unitaire dans l’historique</>
              )}
            </p>
            {editOps.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                Aucune opération rattachée à cette clé.
              </p>
            ) : (
              <div
                style={{
                  maxHeight: 200,
                  overflowY: 'auto',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'rgba(0,0,0,0.2)',
                }}
              >
                <table className="data" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Qté</th>
                      <th>Prix</th>
                      <th>Montant</th>
                      <th>Env.</th>
                      <th>Libellé</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editOps.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <code style={{ fontSize: '0.8rem' }}>{o.date}</code>
                        </td>
                        <td>{o.type}</td>
                        <td style={{ textAlign: 'right' }}>{fmtQty(o.quantity)}</td>
                        <td
                          style={{
                            textAlign: 'right',
                            fontWeight:
                              o.price !== undefined && o.price > 0 ? 600 : 400,
                          }}
                        >
                          {o.price !== undefined && o.price > 0
                            ? `${fmtPrice(o.price)} €`
                            : '—'}
                        </td>
                        <td
                          className="muted"
                          style={{ textAlign: 'right', fontSize: '0.8rem' }}
                        >
                          {o.netAmount !== undefined
                            ? `${fmtPrice(o.netAmount)} €`
                            : o.grossAmount !== undefined
                              ? `${fmtPrice(o.grossAmount)} €`
                              : '—'}
                        </td>
                        <td className="muted" style={{ fontSize: '0.75rem' }}>
                          {o.envelope}
                        </td>
                        <td
                          className="muted"
                          style={{ fontSize: '0.75rem' }}
                          title={o.label}
                        >
                          {o.label.length > 36
                            ? o.label.slice(0, 36) + '…'
                            : o.label}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

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
                  border: '1px solid var(--line)',
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
                      <th>Cours</th>
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
                      const live = lookupLivePrice(livePrices, c.ticker)
                      return (
                        <tr
                          key={c.isin}
                          style={
                            selectedIsin || isSuggested
                              ? { background: 'rgba(79, 140, 255, 0.12)' }
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
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {c.ticker
                              ? live !== undefined
                                ? `${fmtPrice(live)} €`
                                : livePricesLoading
                                  ? '…'
                                  : '—'
                              : '—'}
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
                <span className="muted">
                  Ticker Yahoo
                  {edit.yahooTicker && (
                    <>
                      {' '}
                      · cours{' '}
                      {(() => {
                        const p = lookupLivePrice(livePrices, edit.yahooTicker)
                        if (p !== undefined) return `${fmtPrice(p)} €`
                        if (livePricesLoading) return '…'
                        return isProxyConfigured() ? 'n/d' : 'proxy off'
                      })()}
                    </>
                  )}
                </span>
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
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    background: 'rgba(0,0,0,0.2)',
                  }}
                >
                  <table className="data" style={{ margin: 0 }}>
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        <th>Cours</th>
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
                        const live = lookupLivePrice(livePrices, c.symbol)
                        const nearOp =
                          live !== undefined &&
                          editPriceHints.last &&
                          editPriceHints.last.price &&
                          Math.abs(
                            live / editPriceHints.last.price! - 1,
                          ) < 0.35
                        return (
                          <tr
                            key={c.symbol}
                            style={
                              selectedYahoo
                                ? { background: 'rgba(79, 140, 255, 0.12)' }
                                : nearOp
                                  ? { background: 'rgba(34, 195, 142, 0.12)' }
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
                            <td
                              style={{
                                textAlign: 'right',
                                whiteSpace: 'nowrap',
                                fontWeight: nearOp ? 600 : 400,
                              }}
                              title={
                                nearOp && editPriceHints.last?.price
                                  ? `Proche du dernier prix op (${fmtPrice(editPriceHints.last.price)} €)`
                                  : undefined
                              }
                            >
                              {live !== undefined
                                ? `${fmtPrice(live)} €`
                                : livePricesLoading
                                  ? '…'
                                  : '—'}
                            </td>
                            <td title={label}>
                              {label.length > 36
                                ? label.slice(0, 36) + '…'
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
              {tickerSearch.candidates.length > 0 &&
                editPriceHints.last?.price && (
                  <p className="muted" style={{ marginTop: 6, fontSize: '0.8rem' }}>
                    Surbrillance verte ≈ cours Yahoo proche du dernier prix op (
                    {fmtPrice(editPriceHints.last.price)} €)
                    {livePricesLoading ? ' · chargement des cours…' : ''}
                  </p>
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
