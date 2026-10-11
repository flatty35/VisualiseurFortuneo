import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { quantityDelta } from '@/domain/classify'
import { parseTitresText } from './fortuneoTitres'
import { parsePositionsXlsBuffer } from './positionsXls'
import { reconstructVirtualOpening } from './reconstructBackward'
import { assignSupportKeys, buildNameToIsin } from './resolveIsin'

async function loadPeaPme() {
  const zipBuf = readFileSync(
    'testData/PEA-PME/HistoriqueOperationsBourse_016466511276.zip',
  )
  const zip = await JSZip.loadAsync(zipBuf)
  const name = Object.keys(zip.files).find((n) => n.endsWith('.csv'))!
  const text = await zip.files[name].async('string')
  const ops = parseTitresText(text, 'PEA_PME')
  const posBuf = readFileSync(
    'testData/PEA-PME/Export_portefeuille_detaille_016466511276.xls',
  )
  const ab = posBuf.buffer.slice(
    posBuf.byteOffset,
    posBuf.byteOffset + posBuf.byteLength,
  )
  const positions = parsePositionsXlsBuffer(ab as ArrayBuffer)
  return { ops, positions }
}

describe('PEA-PME VusionGroup reconstruction', () => {
  it('does not produce negative opening qty for VusionGroup', async () => {
    const { ops, positions } = await loadPeaPme()
    const vOps = ops.filter(
      (o) =>
        /vusion/i.test(o.name || '') || /vusion/i.test(o.label || ''),
    )
    let netFwd = 0
    for (const o of vOps) {
      netFwd += quantityDelta(o.type, o.quantity ?? 0)
    }

    const cur = positions.find((p) => /vusion/i.test(p.name))
    expect(cur?.quantity).toBeGreaterThan(0)

    const vo = reconstructVirtualOpening({
      envelope: 'PEA_PME',
      positions,
      operations: ops,
      currentCash: 0,
    })
    const opening = vo.positions.find(
      (p) => p.isin === cur?.isin || /vusion/i.test(p.name),
    )
    const openQty = opening?.quantity ?? 0
    expect(openQty).toBeGreaterThanOrEqual(0)
    expect(openQty + netFwd).toBeCloseTo(cur!.quantity, 5)
    expect(vo.positions.every((p) => p.quantity >= -1e-8)).toBe(true)
  })

  it('clamps opening when duplicate buys would invent a short', async () => {
    const { ops, positions } = await loadPeaPme()
    const cur = positions.find((p) => /vusion/i.test(p.name))!
    const vBuys = ops.filter(
      (o) =>
        /vusion/i.test(o.name || '') &&
        (o.type === 'ACHAT' || o.type === 'SCRIPT'),
    )
    const duped = [
      ...ops,
      ...vBuys.map((o, i) => ({
        ...o,
        id: `${o.id}-dup${i}`,
        fingerprint: `${o.fingerprint}-dup${i}`,
      })),
    ]
    const vo = reconstructVirtualOpening({
      envelope: 'PEA_PME',
      positions,
      operations: duped,
      currentCash: 0,
    })
    const openQty =
      vo.positions.find((p) => p.isin === cur.isin)?.quantity ?? 0
    expect(openQty).toBeGreaterThanOrEqual(0)
    expect(vo.positions.every((p) => p.quantity >= 0)).toBe(true)
  })

  it('maps LOCAL sells onto position ISIN (no leftover short on FR)', async () => {
    const { ops, positions } = await loadPeaPme()
    const cur = positions.find((p) => /vusion/i.test(p.name))!
    const split = ops.map((o) =>
      /vusion/i.test(o.name || '') && o.type === 'VENTE'
        ? { ...o, isin: 'LOCAL:vusiongroup' }
        : o,
    )
    const vo = reconstructVirtualOpening({
      envelope: 'PEA_PME',
      positions,
      operations: split,
      currentCash: 0,
    })
    expect(vo.positions.find((p) => p.isin === cur.isin)?.quantity ?? 0).toBeGreaterThanOrEqual(
      0,
    )
    expect(
      vo.positions.find((p) => p.isin === 'LOCAL:vusiongroup')?.quantity ?? 0,
    ).toBeGreaterThanOrEqual(0)
  })

  it('assignSupportKeys then reconstruct keeps non-negative Vusion open', async () => {
    const { ops, positions } = await loadPeaPme()
    const cur = positions.find((p) => /vusion/i.test(p.name))!
    const localised = ops.map((o) =>
      /vusion/i.test(o.name || '')
        ? { ...o, isin: 'LOCAL:vusiongroup' }
        : o,
    )
    const map = buildNameToIsin(positions, [])
    const keyed = assignSupportKeys(localised, map)
    const vo = reconstructVirtualOpening({
      envelope: 'PEA_PME',
      positions,
      operations: keyed,
      currentCash: 0,
    })
    expect(vo.positions.find((p) => p.isin === cur.isin)?.quantity ?? 0).toBeGreaterThanOrEqual(
      0,
    )
  })

  it('keeps duplicate Vusion ventes so opening reconciles with current qty', async () => {
    const { ops, positions } = await loadPeaPme()
    const cur = positions.find((p) => /vusion/i.test(p.name))!
    const vSells = ops.filter(
      (o) => /vusion/i.test(o.name || '') && o.type === 'VENTE',
    )
    const fps = vSells.map((o) => o.fingerprint)
    expect(new Set(fps).size).toBe(fps.length)

    // Simulate legacy merge that collapsed identical fingerprints → short open
    const seen = new Set<string>()
    const collapsed = ops.filter((o) => {
      const bare = o.fingerprint.replace(/#\d+$/, '')
      if (seen.has(bare) && o.fingerprint.includes('#')) return false
      if (seen.has(o.fingerprint)) return false
      seen.add(bare)
      seen.add(o.fingerprint)
      return true
    })
    const voCollapsed = reconstructVirtualOpening({
      envelope: 'PEA_PME',
      positions,
      operations: collapsed.map((o) => ({
        ...o,
        fingerprint: o.fingerprint.replace(/#\d+$/, ''),
      })),
      currentCash: 0,
    })
    // With clamp, never negative — but without the duplicate sell, qty is wrong
    expect(
      voCollapsed.positions.find((p) => p.isin === cur.isin)?.quantity ?? 0,
    ).toBeGreaterThanOrEqual(0)

    const vo = reconstructVirtualOpening({
      envelope: 'PEA_PME',
      positions,
      operations: ops,
      currentCash: 0,
    })
    let netFwd = 0
    for (const o of ops.filter((x) => /vusion/i.test(x.name || ''))) {
      netFwd += quantityDelta(o.type, o.quantity ?? 0)
    }
    const openQty = vo.positions.find((p) => p.isin === cur.isin)?.quantity ?? 0
    expect(openQty).toBeGreaterThanOrEqual(0)
    expect(openQty + netFwd).toBeCloseTo(cur.quantity, 5)
  })
})
