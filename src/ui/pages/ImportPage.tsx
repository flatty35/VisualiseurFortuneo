import { useState } from 'react'
import type { EnvelopeType, ImportReport } from '@/domain/types'
import { parseTitresCsv } from '@/import/fortuneoTitres'
import { parsePositionsFile } from '@/import/positionsXls'
import { mergeImport } from '@/import/merge'
import { isLocalSupportId } from '@/import/resolveIsin'
import { autoResolveSupports } from '@/quotes/identityResolver'
import { autoMatchSupports } from '@/quotes/tickerMatch'
import { isProxyConfigured } from '@/quotes/gasClient'
import {
  clearEnvelopeOperations,
  listFlatSupports,
  loadEnvelopeProjected,
} from '@/persist/portfolioStore'

const ENVELOPES: { value: EnvelopeType; label: string }[] = [
  { value: 'PEA', label: 'PEA' },
  { value: 'PEA_PME', label: 'PEA-PME' },
  { value: 'CTO', label: 'CTO' },
]

export default function ImportPage() {
  const [envelope, setEnvelope] = useState<EnvelopeType>('PEA')
  const [titres, setTitres] = useState<File | null>(null)
  const [positions, setPositions] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cashOverride, setCashOverride] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [progressPct, setProgressPct] = useState(0)
  const [resetMsg, setResetMsg] = useState<string | null>(null)

  const onResetEnvelope = async () => {
    setError(null)
    setResetMsg(null)
    const label =
      ENVELOPES.find((e) => e.value === envelope)?.label ?? envelope
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
    if (!titres || !positions) {
      setError('Historique titres et positions ouvertes sont requis.')
      return
    }
    setBusy(true)
    try {
      setProgress('Lecture des fichiers…')
      setProgressPct(8)
      const [titresOps, pos] = await Promise.all([
        parseTitresCsv(titres, envelope),
        parsePositionsFile(positions),
      ])

      setProgress(
        `Fichiers lus — ${titresOps.length} ops titres, ${pos.length} positions`,
      )
      setProgressPct(25)

      const cashRaw = cashOverride.replace(',', '.').trim()
      const currentCash = cashRaw === '' ? undefined : Number(cashRaw)
      if (cashRaw !== '' && !Number.isFinite(currentCash)) {
        throw new Error('Espèces actuelles invalides')
      }

      setProgress('Fusion & reconstruction du portefeuille virtuel…')
      setProgressPct(40)
      const r = await mergeImport({
        envelope,
        titresOps,
        positions: pos,
        currentCash,
      })

      // Scope to this envelope only — avoid re-resolving PEA when importing PEA-PME
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

      // Slow GAS cascade only for real ISINs still lacking a ticker
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
        <h1 style={{ marginTop: 0 }}>Import Fortuneo</h1>
        <p className="muted">
          Historique titres + positions ouvertes (CSV, XLS ou ZIP). Pas de fichier
          espèces : chaque achat est un apport (argent investi ce jour-là), sans
          poche cash cumulative. Le solde espèces saisi n’apparaît qu’en fin de
          période. Un réimport n’ajoute que les opérations encore inconnues.
        </p>

        <label style={{ display: 'block', marginBottom: '1rem' }}>
          <span className="muted">Enveloppe</span>
          <br />
          <select
            value={envelope}
            onChange={(e) => setEnvelope(e.target.value as EnvelopeType)}
            style={{ marginTop: 6, minWidth: 200 }}
          >
            {ENVELOPES.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </label>

        <div className="grid-2">
          <FileField label="Historique titres (CSV / ZIP)" file={titres} onChange={setTitres} />
          <FileField
            label="Positions ouvertes (XLS / CSV / ZIP)"
            file={positions}
            onChange={setPositions}
            accept=".xls,.xlsx,.csv,.zip"
          />
          <label>
            <span className="muted">
              Espèces actuelles (€) — solde cash du compte (positions ou saisie)
            </span>
            <br />
            <input
              value={cashOverride}
              onChange={(e) => setCashOverride(e.target.value)}
              placeholder="ex. 1523,45 (défaut 0)"
              style={{ width: '100%', marginTop: 6 }}
            />
          </label>
        </div>

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
                  background: 'linear-gradient(90deg, #2f6b4f, #c4a35a)',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
            {!isProxyConfigured() && (
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: 8 }}>
                Proxy non configuré : l’import local reste rapide, mais le matching Yahoo sera
                limité à la table locale. Voir <code>gas/README.md</code>.
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
            <strong>{ENVELOPES.find((e) => e.value === envelope)?.label}</strong>{' '}
            uniquement. Les correspondances (page Correspondances) restent.
          </p>
          <button type="button" className="btn" onClick={onResetEnvelope} disabled={busy}>
            Vider les opérations ({ENVELOPES.find((e) => e.value === envelope)?.label})
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
