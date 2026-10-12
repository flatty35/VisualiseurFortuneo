import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { parseTitresText } from './fortuneoTitres'
import { parsePositionsXlsBuffer } from './positionsXls'
import {
  assignSupportKeys,
  buildNameToIsin,
  isLocalSupportId,
} from './resolveIsin'

describe('PEA-PME LOCAL→ISIN merge', () => {
  it('attaches Chargeurs / Median / Vusion CSV ops to XLS ISINs', async () => {
    const zip = await JSZip.loadAsync(
      readFileSync(
        'testData/PEA-PME/HistoriqueOperationsBourse_016466511276.zip',
      ),
    )
    const csvName = Object.keys(zip.files).find(
      (n) => n.endsWith('.csv') && !zip.files[n].dir,
    )!
    // Fortuneo zips are Windows-1252 — UTF-8 `async('string')` breaks headers.
    const bytes = await zip.files[csvName].async('uint8array')
    const text = new TextDecoder('windows-1252').decode(bytes)
    expect(text.length).toBeGreaterThan(100)
    const ops = parseTitresText(text, 'PEA_PME')
    expect(ops.length).toBeGreaterThan(10)
    const posBuf = readFileSync(
      'testData/PEA-PME/Export_portefeuille_detaille_016466511276.xls',
    )
    const positions = parsePositionsXlsBuffer(
      posBuf.buffer.slice(
        posBuf.byteOffset,
        posBuf.byteOffset + posBuf.byteLength,
      ) as ArrayBuffer,
    )
    expect(positions.map((p) => p.isin)).toEqual(
      expect.arrayContaining([
        'FR0000130692',
        'FR0011049824',
        'FR0010282822',
      ]),
    )

    const map = buildNameToIsin(positions, [])
    const keyed = assignSupportKeys(ops, map)
    const byLabel = (re: RegExp) =>
      keyed.filter(
        (o) => re.test(o.name || '') || re.test(o.label || ''),
      )

    for (const needle of [
      { re: /chargeurs/i, isin: 'FR0000130692' },
      { re: /median/i, isin: 'FR0011049824' },
      { re: /vusion/i, isin: 'FR0010282822' },
    ]) {
      const rows = byLabel(needle.re)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((o) => o.isin === needle.isin)).toBe(true)
      expect(rows.some((o) => o.isin && isLocalSupportId(o.isin))).toBe(false)
    }
  })
})
