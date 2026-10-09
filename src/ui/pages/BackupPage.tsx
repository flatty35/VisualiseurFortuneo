import { useState } from 'react'
import {
  buildExportBundle,
  downloadExport,
  importBundle,
  parseExportFile,
  type ImportMode,
} from '@/persist/exportImport'
import { clearAllData } from '@/persist/db'

export default function BackupPage() {
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge')

  const onExport = async () => {
    setErr(null)
    try {
      const bundle = await buildExportBundle(true)
      downloadExport(bundle)
      const nOps =
        bundle.portfolio?.envelopes?.reduce(
          (n, e) => n + (e.operations?.length ?? 0),
          0,
        ) ??
        bundle.operations?.length ??
        0
      setMsg(`Export généré — ${nOps} opérations (schema v${bundle.meta.schemaVersion})`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const onImport = async (file: File | null) => {
    if (!file) return
    setErr(null)
    try {
      const bundle = await parseExportFile(file)
      await importBundle(bundle, mode)
      const nOps =
        bundle.portfolio?.envelopes?.reduce(
          (n, e) => n + (e.operations?.length ?? 0),
          0,
        ) ??
        bundle.operations?.length ??
        0
      setMsg(`Import ${mode} OK — ${nOps} opérations dans le fichier`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const onWipe = async () => {
    if (!confirm('Effacer toutes les données locales de cette application ?')) return
    await clearAllData()
    setMsg('Données locales effacées')
  }

  return (
    <div>
      <section className="panel">
        <h1 style={{ marginTop: 0 }}>Sauvegarde</h1>
        <p className="muted">
          Exportez ou réimportez l’état complet du portefeuille (fichier JSON local). Rien n’est
          envoyé sur un serveur.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: '1rem' }}>
          <button type="button" className="btn btn-primary" onClick={onExport}>
            Exporter JSON
          </button>
          <label className="btn" style={{ cursor: 'pointer' }}>
            Importer JSON
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => onImport(e.target.files?.[0] ?? null)}
            />
          </label>
          <button type="button" className="btn btn-danger" onClick={onWipe}>
            Effacer le navigateur
          </button>
        </div>

        <label style={{ display: 'block', marginTop: '1rem' }} className="muted">
          Mode d’import :{' '}
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ImportMode)}
            style={{ marginLeft: 8 }}
          >
            <option value="merge">Fusionner (garder l’existant + ajouter)</option>
            <option value="replace">Remplacer tout</option>
          </select>
        </label>

        {msg && <p style={{ color: 'var(--ok)' }}>{msg}</p>}
        {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
      </section>
    </div>
  )
}
