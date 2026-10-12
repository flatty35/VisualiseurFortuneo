import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTitresText } from './fortuneoTitres'
import { parsePositionsXlsBuffer } from './positionsXls'
import { reconstructVirtualOpening } from './reconstructBackward'
import { assignSupportKeys, buildNameToIsin } from './resolveIsin'

describe('demo portfolio files', () => {
  it('imports, reconstructs a non-negative opening, and keeps the 3 closed titles', () => {
    const csv = new TextDecoder('windows-1252').decode(
      readFileSync(
        'demoData/PEA/HistoriqueOperationsBourse_099887766554_du_11_10_2024_au_11_10_2026.csv',
      ),
    )
    const xls = readFileSync('demoData/PEA/Export_portefeuille_detaille_099887766554.xls')
    const positions = parsePositionsXlsBuffer(
      xls.buffer.slice(xls.byteOffset, xls.byteOffset + xls.byteLength) as ArrayBuffer,
    )
    const raw = parseTitresText(csv, 'PEA')
    const ops = assignSupportKeys(raw, buildNameToIsin(positions, []))
    const vo = reconstructVirtualOpening({
      envelope: 'PEA',
      positions,
      operations: ops,
      currentCash: 0,
    })

    expect(csv).not.toMatch(/016466511|MARAUX|SEBASTIEN/i)
    expect(vo.positions.every((p) => p.quantity >= -1e-8)).toBe(true)

    const openIsins = new Set(positions.map((p) => p.isin))
    expect(openIsins.has('FR0000131906')).toBe(false) // RENAULT closed
    expect(openIsins.has('FR0000120172')).toBe(false) // CARREFOUR closed
    expect(openIsins.has('FR0010908533')).toBe(false) // EDENRED closed

    // Closed #1 existed at opening (sold titles have no ISIN in Fortuneo CSV → LOCAL:)
    const rnoOpen = vo.positions.find((p) => /renault/i.test(p.name) || /renault/i.test(p.isin))
    expect(rnoOpen?.quantity).toBe(25)

    // Closed #2 / #3 were not held at opening
    expect(
      vo.positions.find((p) => /carrefour/i.test(p.name) || /carrefour/i.test(p.isin))
        ?.quantity ?? 0,
    ).toBe(0)
    expect(
      vo.positions.find((p) => /edenred/i.test(p.name) || /edenred/i.test(p.isin))
        ?.quantity ?? 0,
    ).toBe(0)

    const caBuys = ops.filter((o) => /carrefour/i.test(o.name || '') && o.type === 'ACHAT')
    const edenBuys = ops.filter((o) => /edenred/i.test(o.name || '') && o.type === 'ACHAT')
    expect(caBuys[0].date >= '2024-10-11' && caBuys[0].date <= '2025-10-10').toBe(true)
    expect(edenBuys[0].date >= '2025-10-11').toBe(true)
  })
})
