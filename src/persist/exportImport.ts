import { APP_NAME, SCHEMA_VERSION, type ExportBundle, type UiPrefs } from '@/domain/types'
import { Operation, Portfolio } from '@/domain/portfolioModel'
import { clearAllData, db, getUiPrefs } from './db'
import { loadPortfolio, savePortfolio } from './portfolioStore'
import { portfolioFromV1 } from './migrateV1'

export async function buildExportBundle(includeQuotes = true): Promise<ExportBundle> {
  const [portfolio, quoteCache, uiPrefs] = await Promise.all([
    loadPortfolio(),
    includeQuotes ? db.quoteCache.toArray() : Promise.resolve([]),
    getUiPrefs(),
  ])

  return {
    meta: {
      app: APP_NAME,
      schemaVersion: SCHEMA_VERSION,
      date: new Date().toISOString(),
    },
    portfolio: portfolio.toJSON(),
    quoteCache: includeQuotes ? quoteCache : undefined,
    uiPrefs,
  }
}

export function downloadExport(bundle: ExportBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const day = bundle.meta.date.slice(0, 10)
  a.href = url
  a.download = `visualiseur-fortuneo-${day}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export type ImportMode = 'replace' | 'merge'

function portfolioFromBundle(bundle: ExportBundle): Portfolio {
  if (bundle.portfolio) {
    return Portfolio.fromJSON(bundle.portfolio)
  }
  // v1 export
  return portfolioFromV1({
    envelopes: bundle.envelopes ?? [],
    operations: bundle.operations ?? [],
    supports: bundle.supports ?? [],
    virtualOpenings: bundle.virtualOpenings ?? [],
  })
}

export async function importBundle(
  bundle: ExportBundle,
  mode: ImportMode,
): Promise<void> {
  if (bundle.meta?.app !== APP_NAME) {
    throw new Error('Fichier non reconnu (app incorrecte)')
  }
  if (typeof bundle.meta.schemaVersion !== 'number') {
    throw new Error('schemaVersion manquant')
  }

  const incoming = portfolioFromBundle(bundle)

  if (mode === 'replace') {
    await clearAllData()
    await savePortfolio(incoming)
  } else {
    const current = await loadPortfolio()
    // Merge supports by ISIN/localKey; append ops by fingerprint
    for (const s of Object.values(incoming.supports)) {
      current.upsertSupport({
        niceUniqueName: s.niceUniqueName,
        ISIN: s.ISIN,
        localKey: s.localKey,
        assetType: s.assetType,
        getterType: s.getterType,
        yahooFinanceTicker: s.yahooFinanceTicker,
        googleFinanceTicker: s.googleFinanceTicker,
        boursoramaTicker: s.boursoramaTicker,
        staticDatedValues: s.staticDatedValues,
        lastKnownValue: s.lastKnownValue,
      })
    }
    for (const envIn of incoming.envelopes) {
      const env = current.getOrCreateEnvelope(envIn.kindName())
      const fps = new Set(env.operations.map((o) => o.fingerprint))
      for (const op of envIn.operations) {
        if (op.fingerprint && fps.has(op.fingerprint)) continue
        // Remap supportUniqueID via ISIN/localKey
        let supportId = 0
        if (op.supportUniqueID > 0) {
          const src = incoming.getSupport(op.supportUniqueID)
          if (src) {
            const dst = current.upsertSupport({
              niceUniqueName: src.niceUniqueName,
              ISIN: src.ISIN,
              localKey: src.localKey,
              assetType: src.assetType,
              getterType: src.getterType,
              yahooFinanceTicker: src.yahooFinanceTicker,
              googleFinanceTicker: src.googleFinanceTicker,
              boursoramaTicker: src.boursoramaTicker,
              staticDatedValues: src.staticDatedValues,
            })
            supportId = dst.uniqueID
          }
        }
        env.operations.push(
          new Operation({
            ...op.toJSON(),
            supportUniqueID: supportId || op.supportUniqueID,
          }),
        )
        if (op.fingerprint) fps.add(op.fingerprint)
      }
      env.updatedAt = new Date().toISOString()
    }
    await savePortfolio(current)
  }

  await db.transaction('rw', [db.quoteCache, db.meta], async () => {
    if (bundle.quoteCache?.length) {
      await db.quoteCache.bulkPut(bundle.quoteCache)
    }
    if (bundle.uiPrefs) {
      await db.meta.put({ key: 'uiPrefs', value: bundle.uiPrefs as UiPrefs })
    }
  })
}

export async function parseExportFile(file: File): Promise<ExportBundle> {
  const text = await file.text()
  const data = JSON.parse(text) as ExportBundle
  if (
    !data.meta ||
    (!data.portfolio && !Array.isArray(data.operations))
  ) {
    throw new Error('Structure JSON invalide')
  }
  return data
}
