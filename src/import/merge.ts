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
import {
  reconstructVirtualOpening,
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

  const especesOps = input.especesOps
  const incoming = [...titresOps, ...especesOps]

  const portfolio = await loadPortfolio()
  const env = portfolio.getOrCreateEnvelope(envelopeTypeToKind(envelope))

  // Drop previous synthetic seeds before recompute
  env.operations = env.operations.filter((o) => !o.synthetic)

  const existingFp = new Set(env.operations.map((o) => o.fingerprint))
  const fresh = incoming.filter((o) => !existingFp.has(o.fingerprint))
  const skippedDuplicates = incoming.length - fresh.length

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

  // Reload after seed matches (applySeedMatches writes via portfolio store)
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
      'Espèces actuelles absentes des positions — hypothèse 0 € (la poche ne sera pas négative en fin de période).',
    )
  }

  const opsForReconstruct = projectPortfolio(portfolio2).operations.filter(
    (o) => o.envelope === envelope && !o.synthetic,
  )

  const virtualOpening = reconstructVirtualOpening({
    envelope,
    positions,
    operations: opsForReconstruct,
    currentCash,
  })

  if (virtualOpening.cash < 0) {
    warnings.push(
      `Ouverture virtuelle espèces = ${virtualOpening.cash.toFixed(2)} € (compte déjà investi avant l’historique Fortuneo) — normal si le PEA existait avant la fenêtre.`,
    )
  }

  applyVirtualOpeningSeeds(portfolio2, virtualOpening)
  await savePortfolio(portfolio2)
  await ensureEnvelope(envelope)

  const hist = await ensureHistoricalSupports()
  supportsCreated += hist.supportsCreated
  if (hist.opsUpdated) {
    warnings.push(
      `${hist.opsUpdated} opération(s) historiques rattachées à un support (ISIN ou clé locale).`,
    )
  }

  portfolio2 = await loadPortfolio()
  const unmapped = projectPortfolio(portfolio2).supports.filter(
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
