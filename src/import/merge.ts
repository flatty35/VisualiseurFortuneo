import type {
  EnvelopeType,
  ImportReport,
  Operation,
  ParsedPosition,
  Support,
} from '@/domain/types'
import { db, ensureEnvelope } from '@/persist/db'
import {
  reconstructVirtualOpening,
  seedsFromVirtualOpening,
} from './reconstructBackward'
import { extractCashFromPositions } from './positionsXls'
import { assignSupportKeys, buildNameToIsin } from './resolveIsin'
import { applySeedMatches } from '@/quotes/tickerMatch'
import { ensureHistoricalSupports } from './ensureHistoricalSupports'

export async function mergeImport(input: {
  envelope: EnvelopeType
  titresOps: Operation[]
  especesOps: Operation[]
  positions: ParsedPosition[]
  currentCash?: number
}): Promise<ImportReport> {
  const { envelope, positions } = input
  const warnings: string[] = []

  await ensureEnvelope(envelope)

  const nameToIsin = buildNameToIsin(positions, input.titresOps)
  // Real ISIN from positions when possible, else LOCAL:{libellé} so sold /
  // historical titles stay visible (FortuneoPEAViewer keyed by name).
  const titresOps = assignSupportKeys(input.titresOps, nameToIsin)
  const localKeyed = titresOps.filter(
    (o) =>
      o.isin?.startsWith('LOCAL:') &&
      (o.type === 'ACHAT' ||
        o.type === 'VENTE' ||
        o.type === 'SCRIPT' ||
        o.type === 'RACHAT'),
  ).length
  if (localKeyed) {
    warnings.push(
      `${localKeyed} opération(s) sans ISIN Fortuneo — clé locale par libellé (titres sortis inclus). Associez un ticker dans Correspondances.`,
    )
  }

  // Espèces parser already keeps only VERSEMENT/RETRAIT
  const especesOps = input.especesOps.filter(
    (o) => o.type === 'VERSEMENT' || o.type === 'RETRAIT',
  )

  const incoming = [...titresOps, ...especesOps]
  const existing = await db.operations.where('envelope').equals(envelope).toArray()
  const existingFp = new Set(existing.map((o) => o.fingerprint))

  // Drop previous synthetic seeds for this envelope before recompute
  const syntheticIds = existing.filter((o) => o.synthetic).map((o) => o.id)
  if (syntheticIds.length) {
    await db.operations.bulkDelete(syntheticIds)
  }

  // Purge legacy espèces mirrors (achat/vente/…) that double-counted cash
  const legacyMirrors = existing.filter(
    (o) =>
      !o.synthetic &&
      !o.isin &&
      o.type !== 'VERSEMENT' &&
      o.type !== 'RETRAIT' &&
      o.type !== 'POSITION_SEED',
  )
  if (legacyMirrors.length) {
    await db.operations.bulkDelete(legacyMirrors.map((o) => o.id))
    warnings.push(
      `${legacyMirrors.length} ligne(s) espèces miroir ignorées (anti double-comptage).`,
    )
  }

  const fresh = incoming.filter((o) => !existingFp.has(o.fingerprint))
  const skippedDuplicates = incoming.length - fresh.length

  if (fresh.length) {
    await db.operations.bulkPut(fresh)
  }

  const allOps = await db.operations
    .where('envelope')
    .equals(envelope)
    .filter((o) => !o.synthetic)
    .toArray()

  // Upsert supports from positions + ops
  let supportsCreated = 0
  const supportMap = new Map<string, Support>()
  for (const s of await db.supports.toArray()) {
    supportMap.set(s.isin, s)
  }

  const upsertSupport = async (isin: string, name: string, price?: number) => {
    const cur = supportMap.get(isin)
    if (!cur) {
      const created: Support = {
        isin,
        name,
        manualPrices: [],
        staticPrice: price,
      }
      supportMap.set(isin, created)
      await db.supports.put(created)
      supportsCreated++
    } else if (name && cur.name !== name) {
      const updated = { ...cur, name }
      supportMap.set(isin, updated)
      await db.supports.put(updated)
    } else if (price !== undefined && cur.staticPrice === undefined) {
      const updated = { ...cur, staticPrice: price }
      supportMap.set(isin, updated)
      await db.supports.put(updated)
    }
  }

  for (const p of positions) {
    if (!p.isin || p.isin === 'CASH' || p.isin === 'EUR') continue
    const n = p.name.toLowerCase()
    if (n.includes('espec') || n.includes('liquidit')) continue
    await upsertSupport(p.isin, p.name, p.price ?? p.pru)
  }
  for (const o of allOps) {
    if (o.isin) await upsertSupport(o.isin, o.name ?? o.isin, o.price)
  }

  // Fast local seed only during import (Yahoo/OpenFIGI run separately with UI progress)
  const seeded = await applySeedMatches([...supportMap.values()])
  if (seeded) {
    warnings.push(`${seeded} ticker(s) associés via table locale.`)
  }

  if (positions.length === 0) {
    warnings.push('Aucune position ouverte fournie — reconstruction virtuelle impossible.')
    const hist = await ensureHistoricalSupports()
    supportsCreated += hist.supportsCreated
    return {
      envelope,
      added: fresh.length,
      skippedDuplicates,
      supportsCreated,
      virtualOpening: null,
      warnings,
    }
  }

  const cashFromPos = extractCashFromPositions(positions)
  const currentCash = input.currentCash ?? cashFromPos ?? 0

  if (cashFromPos === undefined && input.currentCash === undefined) {
    warnings.push(
      'Espèces actuelles absentes des positions — hypothèse 0 € (la poche ne sera pas négative en fin de période).',
    )
  }

  const virtualOpening = reconstructVirtualOpening({
    envelope,
    positions,
    operations: allOps,
    currentCash,
  })

  if (virtualOpening.cash < 0) {
    warnings.push(
      `Ouverture virtuelle espèces = ${virtualOpening.cash.toFixed(2)} € (compte déjà investi avant l’historique Fortuneo) — normal si le PEA existait avant la fenêtre.`,
    )
  }

  const seeds = seedsFromVirtualOpening(virtualOpening)
  await db.operations.bulkPut(seeds)
  await db.virtualOpenings.put(virtualOpening)
  await ensureEnvelope(envelope)

  // Backfill any pre-existing ops still missing keys (re-import / upgrades)
  const hist = await ensureHistoricalSupports()
  supportsCreated += hist.supportsCreated
  if (hist.opsUpdated) {
    warnings.push(
      `${hist.opsUpdated} opération(s) historiques rattachées à un support (ISIN ou clé locale).`,
    )
  }

  const unmapped = (await db.supports.toArray()).filter(
    (s) => !s.yahooTicker && s.staticPrice === undefined,
  )
  if (unmapped.length) {
    warnings.push(
      `${unmapped.length} support(s) sans ticker Yahoo ni prix fixe — utilisez Correspondances.`,
    )
  }

  return {
    envelope,
    added: fresh.length,
    skippedDuplicates,
    supportsCreated,
    virtualOpening,
    warnings,
  }
}
