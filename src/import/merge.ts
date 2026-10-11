import type {
  EnvelopeType,
  ImportReport,
  Operation,
  ParsedPosition,
} from '@/domain/types'
import { AssetType } from '@/domain/portfolioModel'
import {
  applyVirtualOpeningSeeds,
  envelopeTypeToKind,
  mergeFlatOpsIntoPortfolio,
  projectPortfolio,
} from '@/domain/flatAdapters'
import { ensureEnvelope } from '@/persist/db'
import { loadPortfolio, savePortfolio } from '@/persist/portfolioStore'
import { reconstructVirtualOpening } from './reconstructBackward'
import { extractCashFromPositions } from './positionsXls'
import { assignSupportKeys, buildNameToIsin } from './resolveIsin'
import { applySeedMatches } from '@/quotes/tickerMatch'
import { ensureHistoricalSupports } from './ensureHistoricalSupports'

export async function mergeImport(input: {
  envelope: EnvelopeType
  titresOps: Operation[]
  positions: ParsedPosition[]
  currentCash?: number
}): Promise<ImportReport> {
  const { envelope, positions } = input
  const warnings: string[] = []

  await ensureEnvelope(envelope)

  const nameToIsin = buildNameToIsin(positions, input.titresOps)
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

  warnings.push(
    'Cash : pas de poche cumulative — chaque achat compte comme un apport (argent investi ce jour-là). Le solde espèces saisi n’apparaît qu’en fin de période. Les ventes comptent comme retraits pour le TRI.',
  )

  const portfolio = await loadPortfolio()
  const env = portfolio.getOrCreateEnvelope(envelopeTypeToKind(envelope))

  // Drop synthetic seeds + legacy espèces ledger (supportUniqueID === 0)
  env.operations = env.operations.filter(
    (o) => !o.synthetic && o.supportUniqueID > 0,
  )

  const existingFp = new Set(env.operations.map((o) => o.fingerprint))
  const fresh = titresOps.filter((o) => !existingFp.has(o.fingerprint))
  const skippedDuplicates = titresOps.length - fresh.length

  mergeFlatOpsIntoPortfolio(portfolio, envelope, fresh)

  const projected = projectPortfolio(portfolio)
  const allOps = projected.operations.filter(
    (o) => o.envelope === envelope && !o.synthetic,
  )

  let supportsCreated = 0
  const beforeSupports = Object.keys(portfolio.supports).length

  for (const p of positions) {
    if (!p.isin || p.isin === 'CASH' || p.isin === 'EUR') continue
    const n = p.name.toLowerCase()
    if (n.includes('espec') || n.includes('liquidit')) continue
    portfolio.upsertSupport({
      niceUniqueName: p.name,
      ISIN: p.isin.startsWith('LOCAL:') ? '' : p.isin,
      localKey: p.isin.startsWith('LOCAL:') ? p.isin : '',
      assetType: AssetType.ACTIONS,
      lastKnownValue:
        p.price !== undefined || p.pru !== undefined
          ? ([0, p.price ?? p.pru ?? 0] as [number, number])
          : undefined,
      staticDatedValues:
        p.price !== undefined || p.pru !== undefined
          ? [[0, p.price ?? p.pru ?? 0]]
          : undefined,
    })
  }
  for (const o of allOps) {
    if (!o.isin) continue
    portfolio.upsertSupport({
      niceUniqueName: o.name ?? o.isin,
      ISIN: o.isin.startsWith('LOCAL:') ? '' : o.isin,
      localKey: o.isin.startsWith('LOCAL:') ? o.isin : '',
      assetType: AssetType.ACTIONS,
    })
  }
  supportsCreated = Math.max(
    0,
    Object.keys(portfolio.supports).length - beforeSupports,
  )

  await savePortfolio(portfolio)

  const flatSupports = projectPortfolio(portfolio).supports
  const seeded = await applySeedMatches(flatSupports)
  if (seeded) {
    warnings.push(`${seeded} ticker(s) associés via table locale.`)
  }

  let portfolio2 = await loadPortfolio()

  if (positions.length === 0) {
    warnings.push(
      'Aucune position ouverte fournie — reconstruction virtuelle impossible.',
    )
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
      'Espèces actuelles absentes des positions — hypothèse 0 € (saisir le solde cash pour caler la fin de période).',
    )
  }

  // Align LOCAL→ISIN **before** virtual opening — otherwise open positions
  // stay at "current" qty while history replays on another key (~2× valo).
  const hist = await ensureHistoricalSupports()
  supportsCreated += hist.supportsCreated
  if (hist.opsUpdated) {
    warnings.push(
      `${hist.opsUpdated} opération(s) historiques rattachées à un support (ISIN ou clé locale).`,
    )
  }
  if (hist.supportsCreated) {
    warnings.push(
      `${hist.supportsCreated} support(s) créés pour l’historique (titres sortis inclus).`,
    )
  }
  if (hist.migratedToRealIsin) {
    warnings.push(
      `${hist.migratedToRealIsin} support(s) locaux migrés vers un vrai ISIN.`,
    )
  }

  portfolio2 = await loadPortfolio()
  const opsForReconstruct = projectPortfolio(portfolio2).operations.filter(
    (o) => o.envelope === envelope && !o.synthetic && !!o.isin,
  )

  const virtualOpening = reconstructVirtualOpening({
    envelope,
    positions,
    operations: opsForReconstruct,
    currentCash,
  })

  applyVirtualOpeningSeeds(portfolio2, virtualOpening)
  await savePortfolio(portfolio2)
  await ensureEnvelope(envelope)

  return {
    envelope,
    added: fresh.length,
    skippedDuplicates,
    supportsCreated,
    virtualOpening,
    warnings,
  }
}
