import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSaxoWorkbook } from '@/import/saxoTransactions'
import { buildHoldingsSeries } from './positions'
import { cashImpact } from './cashImpact'

describe('Saxo cash ledger', () => {
  it('end cash ≈ inferredCash (~0), not −securities', () => {
    const buf = readFileSync(
      'testData/saxo/Transactions_21044853_2026-01-01_2026-10-13.xlsx',
    )
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const { operations, inferredCash } = parseSaxoWorkbook(
      ab as ArrayBuffer,
      'CTO_SAXO',
    )

    const versements = operations.filter((o) => o.type === 'VERSEMENT')
    expect(versements.length).toBeGreaterThan(0)
    expect(
      versements.reduce((s, o) => s + (o.netAmount ?? 0), 0),
    ).toBeGreaterThan(1000)

    let all = 0
    for (const o of operations) all += cashImpact(o, 'ledger')
    expect(all).toBeCloseTo(inferredCash, 2)

    const series = buildHoldingsSeries({
      envelope: 'CTO_SAXO',
      operations,
    })
    const last = series[series.length - 1]!
    expect(last.cash).toBeCloseTo(inferredCash, 2)
    expect(Math.abs(last.cash)).toBeLessThan(50)

    // Without cash-only ops, cash ≈ −invested (the bug the user sees)
    const titresOnly = operations.filter((o) => o.isin)
    const broken = buildHoldingsSeries({
      envelope: 'CTO_SAXO',
      operations: titresOnly,
    })
    expect(broken[broken.length - 1]!.cash).toBeLessThan(-1000)
  })
})
