import Dexie, { type Table } from 'dexie'
import type {
  QuoteSeries,
  UiPrefs,
} from '@/domain/types'
import { SCHEMA_VERSION } from '@/domain/types'
import type {
  CustomFilterData,
  EnvelopeData,
  SupportData,
} from '@/domain/portfolioModel'
import { portfolioFromV1 } from './migrateV1'

/** Envelope row: ops embedded (Portfolio Envelope.toJSON). */
export type EnvelopeRow = EnvelopeData & { niceUniqueName: string }

export class VisualiseurDB extends Dexie {
  envelopes!: Table<EnvelopeRow, string>
  supports!: Table<SupportData, number>
  customFilters!: Table<CustomFilterData, number>
  quoteCache!: Table<QuoteSeries, string>
  meta!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super('visualiseur-fortuneo')

    // Historical v1 schema (ISIN-keyed supports, flat operations)
    this.version(1).stores({
      envelopes: 'type',
      operations: 'id, fingerprint, envelope, date, isin, type',
      supports: 'isin, name, yahooTicker',
      virtualOpenings: 'envelope',
      quoteCache: 'ticker',
      meta: 'key',
    })

    // v2: Portfolio graph (supports by uniqueID, ops inside envelopes)
    this.version(SCHEMA_VERSION)
      .stores({
        envelopes: 'niceUniqueName, envelopeType',
        supports: 'uniqueID, ISIN, localKey, niceUniqueName',
        customFilters: 'uniqueID',
        quoteCache: 'ticker',
        meta: 'key',
        operations: null,
        virtualOpenings: null,
      })
      .upgrade(async (tx) => {
        const oldEnvelopes = await tx.table('envelopes').toArray()
        const oldOps = await tx.table('operations').toArray()
        const oldSupports = await tx.table('supports').toArray()
        const oldVos = await tx.table('virtualOpenings').toArray()

        // Detect v1 shape: envelope.type string, support.isin
        const looksV1 =
          oldSupports.some(
            (s: Record<string, unknown>) =>
              typeof s.isin === 'string' && s.uniqueID === undefined,
          ) ||
          oldOps.length > 0 ||
          oldVos.length > 0

        if (!looksV1 && oldEnvelopes.some((e: Record<string, unknown>) => e.operations)) {
          // Already v2-ish after partial upgrade — keep quoteCache/meta
          return
        }

        const portfolio = portfolioFromV1({
          envelopes: oldEnvelopes.map((e: Record<string, unknown>) => ({
            type: e.type as 'PEA' | 'PEA_PME' | 'CTO',
            label: String(e.label ?? e.type ?? 'PEA'),
            createdAt: String(e.createdAt ?? new Date().toISOString()),
            updatedAt: String(e.updatedAt ?? new Date().toISOString()),
          })),
          operations: oldOps as Parameters<typeof portfolioFromV1>[0]['operations'],
          supports: oldSupports as Parameters<typeof portfolioFromV1>[0]['supports'],
          virtualOpenings: oldVos as Parameters<
            typeof portfolioFromV1
          >[0]['virtualOpenings'],
        })

        const json = portfolio.toJSON()
        await tx.table('envelopes').clear()
        await tx.table('supports').clear()

        for (const env of json.envelopes ?? []) {
          const niceUniqueName =
            env.niceUniqueName || `env-${env.envelopeType ?? 0}`
          await tx.table('envelopes').put({ ...env, niceUniqueName })
        }
        for (const s of json.supports ?? []) {
          if (s.uniqueID != null) await tx.table('supports').put(s)
        }
        for (const f of json.customFilters ?? []) {
          if (f.uniqueID != null) await tx.table('customFilters').put(f)
        }
        await tx.table('meta').put({
          key: 'currentSupportID',
          value: json.currentSupportID ?? 1,
        })
        await tx.table('meta').put({
          key: 'currentCustomFiltersID',
          value: json.currentCustomFiltersID ?? 1,
        })
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

export async function ensureEnvelope(
  type: 'PEA' | 'PEA_PME' | 'CTO',
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
