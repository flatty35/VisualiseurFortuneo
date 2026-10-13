import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSaxoWorkbook } from '@/import/saxoTransactions'
import { buildHoldingsSeries } from './positions'
import {
  looksLikeDerivativeName,
  quoteKeyForSupport,
  valueHoldingsSeries,
} from './valuation'
import { seedTradePricesFromOperations } from '@/import/seedTradePrices'
import { Portfolio } from '@/domain/portfolioModel'
import { projectPortfolio } from '@/domain/flatAdapters'
import type { QuoteBar } from '@/domain/types'

describe('Saxo derivative valuation (Solana put + Moderna turbo)', () => {
  const buf = readFileSync(
    'testData/saxo/Transactions_21044853_2026-01-01_2026-10-13.xlsx',
  )
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

  it('detects Saxo option / turbo names (incl. short “P” put notation)', () => {
    expect(looksLikeDerivativeName('Solana ETF Mar2026 8 P')).toBe(true)
    expect(looksLikeDerivativeName('Moderna TurboXL Short 171.95 Saxo')).toBe(
      true,
    )
    expect(looksLikeDerivativeName('Amundi PEA Monde')).toBe(false)
  })

  it('never uses Yahoo/ISIN feed for those lines; valo stays near trade premiums', () => {
    const { operations, tradeQuotesOnlyKeys } = parseSaxoWorkbook(
      ab as ArrayBuffer,
      'CTO_SAXO',
    )

    const solana = operations.filter((o) =>
      /solana/i.test(o.name ?? o.label ?? ''),
    )
    const moderna = operations.filter((o) =>
      /moderna|CH1595275830/i.test(`${o.name} ${o.isin} ${o.label}`),
    )
    expect(solana.length).toBeGreaterThan(0)
    expect(moderna.length).toBeGreaterThan(0)

    const portfolio = new Portfolio()
    for (const o of operations) {
      if (!o.isin && !o.name) continue
      const key =
        o.isin ??
        `LOCAL:${(o.name || '').toLowerCase().replace(/\s+/g, '')}`
      if (!o.isin) (o as { isin?: string }).isin = key
      portfolio.upsertSupport({
        niceUniqueName: o.name ?? key,
        ISIN: key.startsWith('LOCAL:') ? '' : key,
        localKey: key.startsWith('LOCAL:') ? key : '',
        quoteCurrency: o.instrumentCurrency,
        tradeQuotesOnly: tradeQuotesOnlyKeys.includes(key),
      })
    }
    const flatOps = operations.map((o) => ({
      ...o,
      isin:
        o.isin ??
        `LOCAL:${(o.name || '').toLowerCase().replace(/\s+/g, '')}`,
    }))
    seedTradePricesFromOperations(portfolio, flatOps)

    // Mark any remaining by name (same as merge)
    for (const s of Object.values(portfolio.supports)) {
      if (looksLikeDerivativeName(s.niceUniqueName)) {
        s.tradeQuotesOnly = true
        s.yahooFinanceTicker = ''
      }
    }

    const { supports } = projectPortfolio(portfolio)
    const solKey = supports.find((s) => /solana/i.test(s.name))!.isin
    const modKey = 'CH1595275830'
    const solSup = supports.find((s) => s.isin === solKey)!
    const modSup = supports.find((s) => s.isin === modKey)!

    expect(solSup.tradeQuotesOnly || looksLikeDerivativeName(solSup.name)).toBe(
      true,
    )
    expect(modSup.tradeQuotesOnly || looksLikeDerivativeName(modSup.name)).toBe(
      true,
    )
    expect(quoteKeyForSupport(solSup)).toBeUndefined()
    expect(quoteKeyForSupport(modSup)).toBeUndefined()

    // Poisonous underlying quotes that used to explode qty × ETF$/MRNA$
    const quotes = new Map<string, QuoteBar[]>([
      [solKey, [{ date: '2026-03-10', close: 40 }]],
      ['CH1595275830', [{ date: '2026-09-14', close: 150 }]],
      ['MRNA', [{ date: '2026-09-14', close: 150 }]],
    ])

    const series = buildHoldingsSeries({
      envelope: 'CTO_SAXO',
      operations: flatOps,
    })
    const valued = valueHoldingsSeries({
      holdings: series,
      supports,
      quotes,
      operations: flatOps,
    })

    const solVals = valued.map((v) => v.byIsin[solKey] ?? 0)
    const modVals = valued.map((v) => v.byIsin[modKey] ?? 0)
    // Short 100 × 0.20 USD ≈ −17 € (FX) — never ±4000 from underlying ×100
    expect(Math.max(...solVals.map(Math.abs))).toBeLessThan(50)
    // Long turbo ~76 × ~1.2–2.7 € ≈ 90–100 € then 0 at worthless exit — not 76×150
    expect(Math.max(...modVals)).toBeLessThan(200)
    expect(Math.max(...modVals)).toBeGreaterThan(50)
    const afterExpiry = valued.find((v) => v.date >= '2026-09-24')
    expect(afterExpiry?.byIsin[modKey] ?? 0).toBe(0)
  })
})
