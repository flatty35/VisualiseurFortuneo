import { APP_NAME, SCHEMA_VERSION, type ExportBundle, type UiPrefs } from '@/domain/types'
import { clearAllData, db, getUiPrefs } from './db'

export async function buildExportBundle(includeQuotes = true): Promise<ExportBundle> {
  const [envelopes, operations, supports, virtualOpenings, quoteCache, uiPrefs] =
    await Promise.all([
      db.envelopes.toArray(),
      db.operations.toArray(),
      db.supports.toArray(),
      db.virtualOpenings.toArray(),
      includeQuotes ? db.quoteCache.toArray() : Promise.resolve([]),
      getUiPrefs(),
    ])

  return {
    meta: {
      app: APP_NAME,
      schemaVersion: SCHEMA_VERSION,
      date: new Date().toISOString(),
    },
    envelopes,
    operations,
    supports,
    virtualOpenings,
    quoteCache: includeQuotes ? quoteCache : undefined,
    uiPrefs,
  }
}

export function downloadExport(bundle: ExportBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const day = bundle.meta.date.slice(0, 10)
  a.href = url
  a.download = `visualiseur-fortuneo-${day}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export type ImportMode = 'replace' | 'merge'

export async function importBundle(bundle: ExportBundle, mode: ImportMode): Promise<void> {
  if (bundle.meta?.app !== APP_NAME) {
    throw new Error('Fichier non reconnu (app incorrecte)')
  }
  if (typeof bundle.meta.schemaVersion !== 'number') {
    throw new Error('schemaVersion manquant')
  }

  if (mode === 'replace') {
    await clearAllData()
  }

  await db.transaction(
    'rw',
    [db.envelopes, db.operations, db.supports, db.virtualOpenings, db.quoteCache, db.meta],
    async () => {
      if (bundle.envelopes?.length) await db.envelopes.bulkPut(bundle.envelopes)
      if (bundle.supports?.length) {
        if (mode === 'merge') {
          for (const s of bundle.supports) {
            const existing = await db.supports.get(s.isin)
            await db.supports.put(
              existing
                ? {
                    ...existing,
                    ...s,
                    manualPrices: s.manualPrices ?? existing.manualPrices,
                  }
                : s,
            )
          }
        } else {
          await db.supports.bulkPut(bundle.supports)
        }
      }
      if (bundle.operations?.length) {
        if (mode === 'merge') {
          const existingFp = new Set(
            (await db.operations.toArray()).map((o) => o.fingerprint),
          )
          const fresh = bundle.operations.filter((o) => !existingFp.has(o.fingerprint))
          if (fresh.length) await db.operations.bulkPut(fresh)
        } else {
          await db.operations.bulkPut(bundle.operations)
        }
      }
      if (bundle.virtualOpenings?.length) {
        await db.virtualOpenings.bulkPut(bundle.virtualOpenings)
      }
      if (bundle.quoteCache?.length) {
        await db.quoteCache.bulkPut(bundle.quoteCache)
      }
      if (bundle.uiPrefs) {
        await db.meta.put({ key: 'uiPrefs', value: bundle.uiPrefs as UiPrefs })
      }
    },
  )
}

export async function parseExportFile(file: File): Promise<ExportBundle> {
  const text = await file.text()
  const data = JSON.parse(text) as ExportBundle
  if (!data.meta || !Array.isArray(data.operations)) {
    throw new Error('Structure JSON invalide')
  }
  return data
}
