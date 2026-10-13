import Dexie, { type Table } from 'dexie'
import type { QuoteSeries, UiPrefs } from '@/domain/types'
import type {
  CustomFilterData,
  EnvelopeData,
  SupportData,
} from '@/domain/portfolioModel'

/** Envelope row: ops embedded (Portfolio Envelope.toJSON). */
export type EnvelopeRow = EnvelopeData & { niceUniqueName: string }

/**
 * Fresh IndexedDB name — Dexie cannot change primary keys on upgrade
 * (v1 used envelopes.type / supports.isin). No migration of old local data.
 */
const DB_NAME = 'visualiseur-fortuneo-v2'
const LEGACY_DB_NAME = 'visualiseur-fortuneo'

export class VisualiseurDB extends Dexie {
  envelopes!: Table<EnvelopeRow, string>
  supports!: Table<SupportData, number>
  customFilters!: Table<CustomFilterData, number>
  quoteCache!: Table<QuoteSeries, string>
  meta!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super(DB_NAME)
    this.version(1).stores({
      envelopes: 'niceUniqueName, envelopeType',
      supports: 'uniqueID, ISIN, localKey, niceUniqueName',
      customFilters: 'uniqueID',
      quoteCache: 'ticker',
      meta: 'key',
    })
  }
}

export const db = new VisualiseurDB()

/** Drop the old v1 DB if present (ignore errors). */
void Dexie.delete(LEGACY_DB_NAME).catch(() => undefined)

const UI_PREFS_KEY = 'uiPrefs'

export async function getUiPrefs(): Promise<UiPrefs> {
  const row = await db.meta.get(UI_PREFS_KEY)
  return (row?.value as UiPrefs) ?? { chartBase100: true, defaultPeriod: '2Y' }
}

export async function setUiPrefs(prefs: UiPrefs): Promise<void> {
  await db.meta.put({ key: UI_PREFS_KEY, value: prefs })
}

export async function ensureEnvelope(
  type: 'PEA' | 'PEA_PME' | 'CTO' | 'CTO_SAXO',
): Promise<void> {
  const { updatePortfolio } = await import('./portfolioStore')
  const { envelopeTypeToKind } = await import('@/domain/flatAdapters')
  await updatePortfolio((p) => {
    p.getOrCreateEnvelope(envelopeTypeToKind(type))
  })
}

export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.envelopes.clear(),
    db.supports.clear(),
    db.customFilters.clear(),
    db.quoteCache.clear(),
    db.meta.clear(),
  ])
}
