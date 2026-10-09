import Dexie, { type Table } from 'dexie'
import type {
  EnvelopeMeta,
  EnvelopeType,
  Operation,
  QuoteSeries,
  Support,
  UiPrefs,
  VirtualOpening,
} from '@/domain/types'
import { SCHEMA_VERSION } from '@/domain/types'

export class VisualiseurDB extends Dexie {
  envelopes!: Table<EnvelopeMeta, EnvelopeType>
  operations!: Table<Operation, string>
  supports!: Table<Support, string>
  virtualOpenings!: Table<VirtualOpening, EnvelopeType>
  quoteCache!: Table<QuoteSeries, string>
  meta!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super('visualiseur-fortuneo')
    this.version(SCHEMA_VERSION).stores({
      envelopes: 'type',
      operations: 'id, fingerprint, envelope, date, isin, type',
      supports: 'isin, name, yahooTicker',
      virtualOpenings: 'envelope',
      quoteCache: 'ticker',
      meta: 'key',
    })
  }
}

export const db = new VisualiseurDB()

const UI_PREFS_KEY = 'uiPrefs'

export async function getUiPrefs(): Promise<UiPrefs> {
  const row = await db.meta.get(UI_PREFS_KEY)
  return (row?.value as UiPrefs) ?? { chartBase100: true, defaultPeriod: '1Y' }
}

export async function setUiPrefs(prefs: UiPrefs): Promise<void> {
  await db.meta.put({ key: UI_PREFS_KEY, value: prefs })
}

export async function ensureEnvelope(type: EnvelopeType): Promise<void> {
  const existing = await db.envelopes.get(type)
  const now = new Date().toISOString()
  if (existing) {
    await db.envelopes.update(type, { updatedAt: now })
    return
  }
  const labels: Record<EnvelopeType, string> = {
    PEA: 'PEA',
    PEA_PME: 'PEA-PME',
    CTO: 'CTO',
  }
  await db.envelopes.put({
    type,
    label: labels[type],
    createdAt: now,
    updatedAt: now,
  })
}

export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.envelopes.clear(),
    db.operations.clear(),
    db.supports.clear(),
    db.virtualOpenings.clear(),
    db.quoteCache.clear(),
    db.meta.clear(),
  ])
}
