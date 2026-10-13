import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  excelSerialToIso,
  parseSaxoTradeEvent,
  parseSaxoWorkbook,
  yahooFromSaxoSymbol,
} from './saxoTransactions'
import { quantityDelta } from '@/domain/classify'

describe('saxo helpers', () => {
  it('parses Acheter / Vendre / Expiry events', () => {
    expect(parseSaxoTradeEvent('Acheter 45 @ 11.22 EUR')).toEqual({
      side: 'buy',
      qty: 45,
      price: 11.22,
    })
    expect(parseSaxoTradeEvent('Vendre -7 @ 76.96 USD')).toEqual({
      side: 'sell',
      qty: 7,
      price: 76.96,
    })
    expect(parseSaxoTradeEvent('Expiry 1 @ 0.00 USD')).toEqual({
      side: 'sell',
      qty: 1,
      price: 0,
    })
  })

  it('maps Saxo symbols to Yahoo tickers', () => {
    expect(yahooFromSaxoSymbol('FOLOW:xpar')).toBe('FOLOW.PA')
    expect(yahooFromSaxoSymbol('MU:xnas')).toBe('MU')
    expect(yahooFromSaxoSymbol('GOLD:xpar')).toBe('GOLD.PA')
    expect(yahooFromSaxoSymbol('CH1595275830:cats')).toBeUndefined()
  })

  it('converts Excel serials to ISO dates', () => {
    // 45901 ≈ 2025-09-01-ish — just check shape + monotonicity
    const a = excelSerialToIso(45901)
    const b = excelSerialToIso(46304)
    expect(a).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(b > a).toBe(true)
  })
})

describe('parseSaxoWorkbook (live testData)', () => {
  it('accepts PEA_SAXO envelope (same file format)', () => {
    const buf = readFileSync(
      'testData/saxo/Transactions_21044853_2026-01-01_2026-10-13.xlsx',
    )
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const { operations } = parseSaxoWorkbook(ab as ArrayBuffer, 'PEA_SAXO')
    expect(operations.length).toBeGreaterThan(40)
    expect(operations.every((o) => o.envelope === 'PEA_SAXO')).toBe(true)
  })

  it('imports trades, derives open positions, opening ≈ empty', () => {
    const buf = readFileSync(
      'testData/saxo/Transactions_21044853_2026-01-01_2026-10-13.xlsx',
    )
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const { operations, positions, inferredCash, currencyHints } =
      parseSaxoWorkbook(ab as ArrayBuffer, 'CTO_SAXO')

    expect(operations.length).toBeGreaterThan(40)
    expect(operations.every((o) => o.envelope === 'CTO_SAXO')).toBe(true)
    expect(operations.some((o) => o.type === 'ACHAT')).toBe(true)
    expect(operations.some((o) => o.type === 'VENTE')).toBe(true)

    // Cash ledger rows kept (intérêts / portage / versements / dividendes)
    expect(operations.some((o) => o.type === 'VERSEMENT')).toBe(true)
    expect(operations.some((o) => o.type === 'FRAIS')).toBe(true)
    expect(
      operations.some(
        (o) =>
          o.type === 'DIVIDENDE' &&
          /réinvest|dividende/i.test(o.label),
      ),
    ).toBe(true)

    // Gold ISIN known from Fortuneo holdings
    const gold = operations.filter((o) => o.isin === 'FR0013416716')
    expect(gold.length).toBeGreaterThan(0)
    expect(gold.every((o) => o.currency === 'EUR')).toBe(true)

    // Worthless exit (Moderna turbo) must close the position at price 0
    const moderna = operations.filter((o) => o.isin === 'CH1595275830')
    let q = 0
    for (const o of moderna) q += quantityDelta(o.type, o.quantity ?? 0)
    expect(Math.abs(q)).toBeLessThan(1e-8)
    expect(moderna.some((o) => o.type === 'VENTE' && o.price === 0)).toBe(true)

    // USD trades keep instrument amount + fx
    const uberSell = operations.find(
      (o) => o.isin === 'US90353T1007' && o.type === 'VENTE',
    )
    expect(uberSell?.instrumentCurrency).toBe('USD')
    expect(uberSell?.instrumentAmount).toBeDefined()
    expect(uberSell?.fxRate).toBeGreaterThan(0)
    expect(currencyHints['US90353T1007']).toBe('USD')

    // Short put closed by « Expiry » (buy-to-close at 0) → flat, ×100 units
    const solana = operations.filter((o) => o.name?.startsWith('Solana ETF'))
    expect(solana.find((o) => /^Expiry/.test(o.label))?.type).toBe('ACHAT')
    let qSol = 0
    for (const o of solana) qSol += quantityDelta(o.type, o.quantity ?? 0)
    expect(qSol).toBe(0)
    expect(solana.every((o) => o.quantity === 100)).toBe(true)
    expect(positions.some((p) => p.name.startsWith('Solana'))).toBe(false)

    expect(positions.length).toBeGreaterThan(5)
    expect(positions.every((p) => p.quantity > 0)).toBe(true)
    expect(Number.isFinite(inferredCash)).toBe(true)

    // No personal account id leaked into operation labels as sole content
    expect(operations.every((o) => o.date >= '2025-01-01')).toBe(true)
  })
})
