import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseEspecesText } from '@/import/fortuneoEspeces'
import { parseTitresText } from '@/import/fortuneoTitres'
import {
  extractCashFromPositions,
  parsePositionsXlsBuffer,
} from '@/import/positionsXls'
import { assignSupportKeys, buildNameToIsin } from '@/import/resolveIsin'
import { reconstructVirtualOpening } from '@/import/reconstructBackward'
import { cashImpact } from '@/engine/cashImpact'
import { buildHoldingsSeries } from '@/engine/positions'
import { applyVirtualOpeningSeeds, projectPortfolio } from '@/domain/flatAdapters'
import { portfolioFromV1 } from '@/persist/migrateV1'
import { seedsFromVirtualOpening } from '@/import/reconstructBackward'

const PEA = join(process.cwd(), 'testData', 'PEA')

async function csvFromZip(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(path))
  const entry = Object.values(zip.files).find(
    (f) => !f.dir && f.name.toLowerCase().endsWith('.csv'),
  )
  if (!entry) throw new Error(`no csv in ${path}`)
  const u8 = await entry.async('uint8array')
  return new TextDecoder('windows-1252').decode(u8)
}

describe('PEA testData cash (espèces ledger)', () => {
  it('opens near 3400€ before first trades when positions have no cash row', async () => {
    const [titresText, especesText] = await Promise.all([
      csvFromZip(join(PEA, 'HistoriqueOperationsBourse_016466511216_titre.zip')),
      csvFromZip(join(PEA, 'HistoriqueOperationsBourse_016466511216_especes.zip')),
    ])
    const posBuf = readFileSync(
      join(PEA, 'Export_portefeuille_detaille_016466511216.xls'),
    )
    const positions = parsePositionsXlsBuffer(
      posBuf.buffer.slice(posBuf.byteOffset, posBuf.byteOffset + posBuf.byteLength),
    )

    expect(positions.every((p) => !/^solde\s+position/i.test(p.name))).toBe(true)
    expect(extractCashFromPositions(positions)).toBeUndefined()

    const titresRaw = parseTitresText(titresText, 'PEA')
    const especes = parseEspecesText(especesText, 'PEA')
    expect(especes.length).toBeGreaterThan(14)

    const nameToIsin = buildNameToIsin(positions, titresRaw)
    const titres = assignSupportKeys(titresRaw, nameToIsin)
    const all = [...titres, ...especes]

    const vo = reconstructVirtualOpening({
      envelope: 'PEA',
      positions,
      operations: all,
      currentCash: 0,
    })

    const holdings = buildHoldingsSeries({
      envelope: 'PEA',
      operations: all,
      virtualOpening: vo,
    })
    const first = holdings[0]
    const last = holdings[holdings.length - 1]
    const ledgerNet = especes.reduce((s, o) => s + cashImpact(o), 0)

    expect(vo.cash).toBeGreaterThan(3300)
    expect(vo.cash).toBeLessThan(3600)
    expect(first?.cash).toBeGreaterThan(3300)
    expect(first?.cash).toBeLessThan(3600)
    expect(titres.reduce((s, o) => s + cashImpact(o), 0)).toBe(0)
    expect(vo.cash + ledgerNet).toBeCloseTo(0, 0)
    expect(last?.cash).toBeCloseTo(0, 0)

    // Same cash after v1 → Portfolio → flat projection
    const seeds = seedsFromVirtualOpening(vo)
    const portfolio = portfolioFromV1({
      operations: [...all, ...seeds],
      supports: [],
      virtualOpenings: [vo],
    })
    applyVirtualOpeningSeeds(portfolio, vo)
    const projected = projectPortfolio(portfolio)
    const holdings2 = buildHoldingsSeries({
      envelope: 'PEA',
      operations: projected.operations.filter((o) => o.envelope === 'PEA'),
      virtualOpening: projected.virtualOpenings.find((v) => v.envelope === 'PEA'),
    })
    expect(holdings2[0]?.cash).toBeCloseTo(first!.cash, 0)
  })
})
