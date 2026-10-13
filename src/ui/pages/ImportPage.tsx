import { useMemo, useState } from 'react'
import type { EnvelopeType, ImportReport } from '@/domain/types'
import {
  type BrokerId,
  envelopeLabel,
  envelopesForBroker,
} from '@/domain/envelopes'
import { parseTitresCsv } from '@/import/fortuneoTitres'
import { parsePositionsFile } from '@/import/positionsXls'
import { parseSaxoTransactionsFile } from '@/import/saxoTransactions'
import { mergeImport } from '@/import/merge'
import { isLocalSupportId } from '@/import/resolveIsin'
import { autoResolveSupports } from '@/quotes/identityResolver'
import { autoMatchSupports } from '@/quotes/tickerMatch'
import { isProxyConfigured } from '@/quotes/gasClient'
import {
  clearEnvelopeOperations,
  listFlatSupports,
  loadEnvelopeProjected,
  putFlatSupports,
} from '@/persist/portfolioStore'
import { googleTickerFromYahoo } from '@/quotes/tickerMatch'

export default function ImportPage() {
  const [broker, setBroker] = useState<BrokerId>('fortuneo')
  const brokerEnvelopes = useMemo(() => envelopesForBroker(broker), [broker])
  const [envelope, setEnvelope] = useState<EnvelopeType>('PEA')
  const [titres, setTitres] = useState<File | null>(null)
  const [positions, setPositions] = useState<File | null>(null)
  const [saxoFile, setSaxoFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cashOverride, setCashOverride] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [progressPct, setProgressPct] = useState(0)
  const [resetMsg, setResetMsg] = useState<string | null>(null)

  const onBrokerChange = (next: BrokerId) => {
    setBroker(next)
    const allowed = envelopesForBroker(next)
    if (!allowed.includes(envelope)) setEnvelope(allowed[0])
    setTitres(null)
    setPositions(null)
    setSaxoFile(null)
    setReport(null)
    setError(null)
  }

  const onResetEnvelope = async () => {
    setError(null)
    setResetMsg(null)
    const label = envelopeLabel(envelope)
    if (
      !confirm(
        `Effacer toutes les opérations de l’enveloppe ${label} ?\n\nLes correspondances (tickers) sont conservées. Vous pourrez réimporter l’historique ensuite.`,
      )
    ) {
      return
    }
    try {
      const { removed } = await clearEnvelopeOperations(envelope)
      setResetMsg(
        `${label} : ${removed} opération(s) effacée(s). Correspondances inchangées.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onImport = async () => {
    setError(null)
    setReport(null)
    setProgress(null)
    setProgressPct(0)

    if (broker === 'fortuneo' && (!titres || !positions)) {
      setError('Historique titres et positions ouvertes sont requis.')
      return
    }
    if (broker === 'saxo' && !saxoFile) {
      setError('Le fichier Transactions Saxo (.xlsx) est requis.')
      return
    }

    setBusy(true)
    try {
      setProgress('Lecture des fichiers…')
      setProgressPct(8)

      let titresOps
      let pos
      let inferredCash: number | undefined
      let tickerHints: Record<string, string> = {}
      let currencyHints: Record<string, string> = {}

      if (broker === 'saxo') {
        const parsed = await parseSaxoTransactionsFile(saxoFile!, envelope)
        titresOps = parsed.operations
        pos = parsed.positions
        inferredCash = parsed.inferredCash
        tickerHints = parsed.tickerHints
        currencyHints = parsed.currencyHints
      } else {
        ;[titresOps, pos] = await Promise.all([
          parseTitresCsv(titres!, envelope),
          parsePositionsFile(positions!),
        ])
      }

      setProgress(
        `Fichiers lus — ${titresOps.length} ops titres, ${pos.length} positions`,
      )
      setProgressPct(25)

      const cashRaw = cashOverride.replace(',', '.').trim()
      let currentCash =
        cashRaw === '' ? inferredCash : Number(cashRaw)
      if (cashRaw !== '' && !Number.isFinite(currentCash)) {
        throw new Error('Espèces actuelles invalides')
      }
      if (currentCash !== undefined && !Number.isFinite(currentCash)) {
        currentCash = undefined
      }

      setProgress('Fusion & reconstruction du portefeuille virtuel…')
      setProgressPct(40)
      const r = await mergeImport({
        envelope,
        titresOps,
        positions: pos,
        currentCash,
        skipVirtualOpening: broker === 'saxo',
        currencyHints:
          broker === 'saxo' && Object.keys(currencyHints).length
            ? currencyHints
            : undefined,
      })

      if (broker === 'saxo') {
        r.warnings.push(
          'Saxo : positions actuelles dérivées de l’historique (compte depuis l’ouverture). Pas de fichier positions séparé.',
        )
        const hints = Object.entries(tickerHints)
        if (hints.length) {
          const supports = await listFlatSupports()
          const updates = supports
            .filter(
              (s) =>
                (!s.yahooTicker && tickerHints[s.isin]) ||
                (!s.quoteCurrency && currencyHints[s.isin]),
            )
            .map((s) => {
              const t = tickerHints[s.isin]
              const cur = currencyHints[s.isin]
              return {
                ...s,
                ...(t && !s.yahooTicker
                  ? {
                      yahooTicker: t,
                      googleTicker: s.googleTicker ?? googleTickerFromYahoo(t),
                    }
                  : {}),
                ...(cur && !s.quoteCurrency
                  ? { quoteCurrency: cur.toUpperCase() }
                  : {}),
              }
            })
          if (updates.length) {
            await putFlatSupports(updates)
            const tickers = updates.filter((s) => s.yahooTicker).length
            if (tickers) {
              r.warnings.push(
                `Saxo : ${tickers} ticker(s) Yahoo préremplis depuis le symbole (ex. FOLOW:xpar → FOLOW.PA).`,
              )
            }
          }
        }
      }

      const envSupports = async () => {
        const envIsins = new Set(
          (await loadEnvelopeProjected(envelope)).operations
            .map((o) => o.isin)
            .filter((x): x is string => Boolean(x)),
        )
        return (await listFlatSupports()).filter((s) => envIsins.has(s.isin))
      }

      setProgressPct(50)
      setProgress('Résolution ISIN + tickers (Fortuneo, Morningstar)…')
      const fast = await autoResolveSupports(await envSupports(), {
        onProgress: (info) => {
          setProgress(`ISIN / ticker ${info.done}/${info.total} — ${info.name}`)
          setProgressPct(50 + Math.round((info.done / Math.max(info.total, 1)) * 30))
        },
      })
      if (fast.total) {
        r.warnings.push(
          `Résolution rapide : ${fast.isinResolved} ISIN trouvés, ${fast.tickersSet} tickers associés sur ${fast.total} titres.`,
        )
      }

      const after = await envSupports()
      const pending = after.filter((s) => !s.yahooTicker && !isLocalSupportId(s.isin))
      const locals = after.filter((s) => isLocalSupportId(s.isin))
      if (pending.length && isProxyConfigured()) {
        setProgressPct(80)
        setProgress('Tickers restants via le proxy…')
        const match = await autoMatchSupports(pending, (info) => {
          setProgress(`${info.status} — ${info.name}`)
          setProgressPct(80 + Math.round((info.current / Math.max(info.total, 1)) * 15))
        })
        r.warnings.push(
          `Proxy : ${match.updated} tickers associés, ${match.failed} non trouvés.`,
        )
      } else if (pending.length) {
        r.warnings.push(
          `${pending.length} support(s) sans ticker — à compléter dans Correspondances.`,
        )
      }
      if (locals.length) {
        r.warnings.push(
          `${locals.length} titre(s) sans ISIN fiable (${locals
            .slice(0, 5)
            .map((s) => s.name)
            .join(', ')}${locals.length > 5 ? '…' : ''}) — à valider dans Correspondances.`,
        )
      }

      setProgress('Terminé')
      setProgressPct(100)
      setReport(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Import</h1>
        <p className="muted">
          Choisissez le courtier puis l’enveloppe. Fortuneo : historique titres +
          positions. Saxo : un seul export Transactions (.xlsx) depuis l’ouverture
          du compte. Un réimport n’ajoute que les opérations encore inconnues.
        </p>

        <div className="grid-2" style={{ marginBottom: '1rem' }}>
          <label>
            <span className="muted">Courtier</span>
            <br />
            <select
              value={broker}
              onChange={(e) => onBrokerChange(e.target.value as BrokerId)}
              style={{ marginTop: 6, width: '100%' }}
            >
              <option value="fortuneo">Fortuneo</option>
              <option value="saxo">Saxo Bank</option>
            </select>
          </label>
          <label>
            <span className="muted">Enveloppe</span>
            <br />
            <select
              value={envelope}
              onChange={(e) => setEnvelope(e.target.value as EnvelopeType)}
              style={{ marginTop: 6, width: '100%' }}
            >
              {brokerEnvelopes.map((e) => (
                <option key={e} value={e}>
                  {envelopeLabel(e)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {broker === 'fortuneo' ? (
          <div className="grid-2">
            <FileField
              label="Historique titres (CSV / ZIP)"
              file={titres}
              onChange={setTitres}
            />
            <FileField
              label="Positions ouvertes (XLS / CSV / ZIP)"
              file={positions}
              onChange={setPositions}
              accept=".xls,.xlsx,.csv,.zip"
            />
          </div>
        ) : (
          <div className="grid-2">
            <FileField
              label="Transactions Saxo (XLSX)"
              file={saxoFile}
              onChange={setSaxoFile}
              accept=".xlsx,.xls"
            />
            <p className="muted" style={{ margin: 0, alignSelf: 'center' }}>
              Export « Transactions » (feuilles Transactions + Opérations) —
              même format pour PEA, PEA-PME et CTO. Les positions ouvertes sont
              recalculées depuis l’historique.
            </p>
          </div>
        )}

        <label style={{ display: 'block', marginTop: '1rem' }}>
          <span className="muted">
            Espèces actuelles (€) — solde cash du compte
            {broker === 'saxo' ? ' (sinon estimé depuis l’historique)' : ''}
          </span>
          <br />
          <input
            value={cashOverride}
            onChange={(e) => setCashOverride(e.target.value)}
            placeholder={
              broker === 'saxo'
                ? 'ex. 1523,45 (laisser vide = estimé)'
                : 'ex. 1523,45 (défaut 0)'
            }
            style={{ width: '100%', marginTop: 6 }}
          />
        </label>

        <div style={{ marginTop: '1.25rem' }}>
          <button className="btn btn-primary" disabled={busy} onClick={onImport}>
            {busy ? 'Import en cours…' : 'Importer & reconstruire'}
          </button>
        </div>

        {(busy || progress) && (
          <div style={{ marginTop: '1rem' }}>
            <div className="muted" style={{ marginBottom: 6 }}>
              {progress}
            </div>
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: 'rgba(0,0,0,0.35)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${progressPct}%`,
                  background: 'var(--accent)',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
            {!isProxyConfigured() && (
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: 8 }}>
                Proxy non configuré : l’import local reste rapide, mais le matching
                Yahoo sera limité à la table locale. Voir <code>gas/README.md</code>.
              </p>
            )}
          </div>
        )}

        {error && <p style={{ color: 'var(--danger)', marginTop: '1rem' }}>{error}</p>}
        {resetMsg && (
          <p className="muted" style={{ marginTop: '1rem' }}>
            {resetMsg}
          </p>
        )}

        <div
          style={{
            marginTop: '2rem',
            paddingTop: '1.25rem',
            borderTop: '1px solid var(--border, rgba(255,255,255,0.12))',
          }}
        >
          <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>
            Réinitialiser l’enveloppe
          </h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Efface les opérations et l’ouverture virtuelle de{' '}
            <strong>{envelopeLabel(envelope)}</strong> uniquement. Les
            correspondances (page Correspondances) restent.
          </p>
          <button type="button" className="btn" onClick={onResetEnvelope} disabled={busy}>
            Vider les opérations ({envelopeLabel(envelope)})
          </button>
        </div>

        {report && (
          <div style={{ marginTop: '1.25rem' }}>
            <h3 style={{ marginBottom: 8 }}>Rapport</h3>
            <ul className="muted">
              <li>Ajoutées : {report.added}</li>
              <li>Doublons ignorés : {report.skippedDuplicates}</li>
              <li>Supports créés : {report.supportsCreated}</li>
              {report.virtualOpening && (
                <li>
                  Ouverture virtuelle au {report.virtualOpening.date} — cash{' '}
                  {report.virtualOpening.cash.toLocaleString('fr-FR', {
                    style: 'currency',
                    currency: 'EUR',
                  })}{' '}
                  · {report.virtualOpening.positions.length} lignes
                </li>
              )}
            </ul>
            {report.warnings.map((w) => (
              <div key={w} className="badge warn" style={{ display: 'block', marginTop: 6 }}>
                {w}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function FileField({
  label,
  file,
  onChange,
  accept = '.csv,.txt,.zip,.xls,.xlsx',
}: {
  label: string
  file: File | null
  onChange: (f: File | null) => void
  accept?: string
}) {
  return (
    <label className="dropzone" style={{ display: 'block', cursor: 'pointer' }}>
      <div style={{ fontWeight: 500 }}>{label}</div>
      <div className="muted" style={{ marginTop: 6, fontSize: '0.85rem' }}>
        {file ? file.name : 'Choisir un fichier…'}
      </div>
      <input
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </label>
  )
}
