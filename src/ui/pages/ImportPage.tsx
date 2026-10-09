import { useState } from 'react'
import type { EnvelopeType, ImportReport } from '@/domain/types'
import { parseTitresCsv } from '@/import/fortuneoTitres'
import { parseEspecesCsv } from '@/import/fortuneoEspeces'
import { parsePositionsFile } from '@/import/positionsXls'
import { mergeImport } from '@/import/merge'
import { autoResolveLocalIsins } from '@/quotes/isinSearch'
import { autoMatchSupports } from '@/quotes/tickerMatch'
import { isProxyConfigured } from '@/quotes/gasClient'
import { db } from '@/persist/db'

const ENVELOPES: { value: EnvelopeType; label: string }[] = [
  { value: 'PEA', label: 'PEA' },
  { value: 'PEA_PME', label: 'PEA-PME' },
  { value: 'CTO', label: 'CTO' },
]

export default function ImportPage() {
  const [envelope, setEnvelope] = useState<EnvelopeType>('PEA')
  const [titres, setTitres] = useState<File | null>(null)
  const [especes, setEspeces] = useState<File | null>(null)
  const [positions, setPositions] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cashOverride, setCashOverride] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [progressPct, setProgressPct] = useState(0)

  const onImport = async () => {
    setError(null)
    setReport(null)
    setProgress(null)
    setProgressPct(0)
    if (!titres || !especes || !positions) {
      setError('Les 3 fichiers sont requis : titres, espèces, positions ouvertes.')
      return
    }
    setBusy(true)
    try {
      setProgress('Lecture des fichiers…')
      setProgressPct(8)
      const [titresOps, especesOps, pos] = await Promise.all([
        parseTitresCsv(titres, envelope),
        parseEspecesCsv(especes, envelope),
        parsePositionsFile(positions),
      ])

      setProgress(
        `Fichiers lus — ${titresOps.length} ops titres, ${especesOps.length} versements/retraits, ${pos.length} positions`,
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
        especesOps,
        positions: pos,
        currentCash,
      })

      setProgressPct(50)
      setProgress('Résolution des ISIN locaux (titres sortis, préférence EUR)…')
      if (isProxyConfigured() || import.meta.env.DEV) {
        const isinR = await autoResolveLocalIsins(undefined, {
          onProgress: (info) => {
            setProgress(`ISIN ${info.current}/${info.total} — ${info.name}`)
            setProgressPct(
              50 + Math.round((info.current / Math.max(info.total, 1)) * 15),
            )
          },
        })
        r.warnings.push(
          `ISIN : ${isinR.updated} résolus, ${isinR.skipped} à valider, ${isinR.failed} non trouvés.`,
        )
      }

      setProgressPct(65)
      setProgress('Association des tickers Yahoo (peut prendre 1–2 min)…')

      const pending = (await db.supports.toArray()).filter((s) => !s.yahooTicker)
      if (pending.length === 0) {
        r.warnings.push('Tous les supports ont déjà un ticker.')
      } else if (!isProxyConfigured()) {
        r.warnings.push(
          `${pending.length} support(s) sans ticker — configurez VITE_PROXY_URL puis utilisez Correspondances → Auto-associer.`,
        )
      } else {
        const match = await autoMatchSupports(pending, (info) => {
          setProgress(`${info.status} — ${info.name}`)
          setProgressPct(65 + Math.round((info.current / Math.max(info.total, 1)) * 30))
        })
        r.warnings.push(
          `Tickers Yahoo : ${match.updated} associés, ${match.failed} non trouvés.`,
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
          Fournir l’historique titres, l’historique espèces et l’export des positions ouvertes
          (CSV, XLS, ou ZIP contenant un CSV). Un réimport n’ajoute que les opérations encore
          inconnues (merge par empreinte).
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
          <FileField label="Historique espèces (CSV / ZIP)" file={especes} onChange={setEspeces} />
          <FileField
            label="Positions ouvertes (XLS / CSV / ZIP)"
            file={positions}
            onChange={setPositions}
            accept=".xls,.xlsx,.csv,.zip"
          />
          <label>
            <span className="muted">
              Espèces actuelles (€) — optionnel si absentes du fichier positions
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
