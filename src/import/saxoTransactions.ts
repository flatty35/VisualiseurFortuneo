/**
 * Saxo Bank « Transactions_….xlsx » importer (sheet Transactions + Opérations).
 * Full history from account opening → current positions are derived by forward
 * replay (no separate positions file required).
 */
import * as XLSX from 'xlsx'
import { classifyTitresOperation } from '@/domain/classify'
import { makeOperationId, operationFingerprint } from '@/domain/fingerprint'
import type {
  EnvelopeType,
  Operation,
  OperationType,
  ParsedPosition,
} from '@/domain/types'
import { quantityDelta } from '@/domain/classify'
import { readFileAsArrayBuffer } from './parseUtils'

const MIC_TO_YAHOO: Record<string, string> = {
  xpar: '.PA',
  xams: '.AS',
  xbru: '.BR',
  xlis: '.LS',
  xetr: '.DE',
  xfra: '.F',
  xmil: '.MI',
  xmad: '.MC',
  xlon: '.L',
  xswx: '.SW',
  xnys: '',
  xnas: '',
}

/** Excel serial day → YYYY-MM-DD (SheetJS / Excel 1900 system). */
export function excelSerialToIso(serial: number): string {
  const whole = Math.floor(serial)
  // Excel's day 0 is 1899-12-30 in the 1900 date system used by SheetJS
  const ms = Date.UTC(1899, 11, 30) + whole * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

function cellDate(v: unknown): string | undefined {
  if (v == null || v === '' || v === '-') return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return excelSerialToIso(v)
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return undefined
}

function num(v: unknown): number | undefined {
  if (v == null || v === '' || v === '-') return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string {
  return v == null || v === '-' ? '' : String(v).trim()
}

function pick(row: Record<string, unknown>, ...needles: string[]): unknown {
  const entries = Object.entries(row)
  for (const needle of needles) {
    const n = needle
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
    for (const [k, v] of entries) {
      const nk = k
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/\u00a0/g, ' ')
      if (nk === n || nk.includes(n)) return v
    }
  }
  return undefined
}

/** « FOLOW:xpar » → Yahoo « FOLOW.PA » ; US listings stay bare. */
export function yahooFromSaxoSymbol(symbol: string): string | undefined {
  const raw = symbol.trim()
  if (!raw) return undefined
  const [ticker, micRaw] = raw.split(':')
  if (!ticker || !/^[A-Za-z0-9._^-]{1,12}$/.test(ticker)) return undefined
  const mic = (micRaw || '').toLowerCase()
  if (!mic || mic === 'cats') return undefined
  if (mic in MIC_TO_YAHOO) {
    const suffix = MIC_TO_YAHOO[mic]
    return suffix ? `${ticker.toUpperCase()}${suffix}` : ticker.toUpperCase()
  }
  return undefined
}

/**
 * Parse « Acheter 45 @ 11.22 EUR » / « Vendre -7 @ 76.96 USD » /
 * « Expiry 1 @ 0.00 USD » (worthless close).
 */
export function parseSaxoTradeEvent(
  event: string,
): { side: 'buy' | 'sell'; qty: number; price: number } | null {
  const m = event
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .match(
      /^(Acheter|Vendre|Expiry)\s+(-?\d+(?:[.,]\d+)?)\s*@\s*(\d+(?:[.,]\d+)?)/i,
    )
  if (!m) return null
  const qty = Math.abs(Number(m[2].replace(',', '.')))
  const price = Number(m[3].replace(',', '.'))
  if (!(qty > 0) || !Number.isFinite(price) || !(price >= 0)) return null
  const verb = m[1]
  // Expiry closes either a long (sell) or a short (buy): the direction comes
  // from the Opérations sheet. Default to sell when that sheet is missing.
  const side: 'buy' | 'sell' =
    /^vendre/i.test(verb) || /^expiry/i.test(verb) ? 'sell' : 'buy'
  return { side, qty, price }
}

function isExpiryEvent(event: string): boolean {
  return /^expiry\b/i.test(event.trim())
}

/** Saxo instrument types quoted per underlying unit (contract = N units). */
function hasContractMultiplier(instrumentType: string): boolean {
  return /option|future/i.test(instrumentType)
}

interface OpsRow {
  tradeId: string
  qty: number
  price: number
  side: 'buy' | 'sell'
  event: string
  isin?: string
  date?: string
}

function loadOpsSheet(wb: XLSX.WorkBook): {
  byTradeId: Map<string, OpsRow>
  byIsinDate: Map<string, OpsRow>
} {
  const name =
    wb.SheetNames.find((n) => /^op[eé]rations$/i.test(n)) ??
    wb.SheetNames.find((n) => /op[eé]ration/i.test(n))
  const byTradeId = new Map<string, OpsRow>()
  const byIsinDate = new Map<string, OpsRow>()
  if (!name) return { byTradeId, byIsinDate }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets[name],
    { defval: '' },
  )
  for (const row of rows) {
    const tradeId = str(pick(row, "id d'operation", 'id operation', 'trade id'))
    const event = str(pick(row, 'evenement', 'événement'))
    const qtyRaw = num(pick(row, 'traded quantity', 'quantite', 'quantité'))
    const price = num(pick(row, 'cours', 'price')) ?? 0
    const eventType = str(pick(row, 'trade event type'))
    const isin = str(pick(row, 'code isin', 'isin'))
      .toUpperCase()
      .replace(/\s/g, '')
    const date =
      cellDate(pick(row, "date d'operation ajustee", "date d'operation ajustée")) ??
      cellDate(pick(row, "date d'execution", "date d’exécution de l’opération"))
    if (!tradeId && !event) continue
    const parsed = parseSaxoTradeEvent(event)
    const qty =
      qtyRaw !== undefined ? Math.abs(qtyRaw) : parsed?.qty
    if (qty === undefined || !(qty > 0)) continue
    const sheetSide: 'buy' | 'sell' =
      /vend/i.test(eventType) || (qtyRaw !== undefined && qtyRaw < 0)
        ? 'sell'
        : 'buy'
    const side: 'buy' | 'sell' =
      parsed && !isExpiryEvent(event) ? parsed.side : sheetSide
    const rowOut: OpsRow = {
      tradeId,
      qty,
      price: parsed?.price ?? price,
      side,
      event,
      isin: /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin) ? isin : undefined,
      date,
    }
    if (tradeId) byTradeId.set(tradeId, rowOut)
    if (rowOut.isin && rowOut.date) {
      byIsinDate.set(`${rowOut.isin}|${rowOut.date}|${rowOut.side}`, rowOut)
      // Worthless exits / corporate actions: also key without side
      if (/sortie sans valeur/i.test(event)) {
        byIsinDate.set(`${rowOut.isin}|${rowOut.date}|exit`, rowOut)
      }
    }
  }
  return { byTradeId, byIsinDate }
}

function classifySaxoRow(
  txType: string,
  event: string,
  trade: ReturnType<typeof parseSaxoTradeEvent>,
): OperationType | null {
  const t = txType
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
  const e = event
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

  if (t.includes('transfert') && e.includes('depot')) return 'VERSEMENT'
  if (t.includes('transfert') && e.includes('retrait')) return 'RETRAIT'
  if (e.includes('interet') || e.includes('portage')) return 'FRAIS'
  if (e.includes('frais') && t.includes('liquidit')) return 'FRAIS'
  if (e.includes('sortie sans valeur')) return 'VENTE'
  if (e.includes('expiry')) return trade?.side === 'buy' ? 'ACHAT' : 'VENTE'
  // Scrip / réinvest: cash residual (rompu) in this export — treat as dividend.
  // Share credits, when present later, would be SCRIPT with qty.
  if (e.includes('reinvestissement')) return 'DIVIDENDE'
  if (e.includes('dividende')) return 'DIVIDENDE'
  if (trade?.side === 'buy') return 'ACHAT'
  if (trade?.side === 'sell') return 'VENTE'
  if (t.startsWith('operation')) {
    return classifyTitresOperation(event, event)
  }
  return null
}

export interface SaxoParseResult {
  operations: Operation[]
  /** End-of-history holdings (for VO reconstruction + support seeds). */
  positions: ParsedPosition[]
  /** Idle cash ≈ sum of deposits − withdrawals − trade nets (informational). */
  inferredCash: number
  /** ISIN → Yahoo ticker guessed from Saxo « Symbole » (FOLOW:xpar → FOLOW.PA). */
  tickerHints: Record<string, string>
  /** ISIN → instrument quote currency (USD, EUR, …). */
  currencyHints: Record<string, string>
}

/**
 * Parse a Saxo Transactions workbook into flat operations + derived positions.
 */
export function parseSaxoWorkbook(
  buffer: ArrayBuffer,
  envelope: EnvelopeType,
): SaxoParseResult {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false })
  const txName =
    wb.SheetNames.find((n) => /^transactions$/i.test(n)) ?? wb.SheetNames[0]
  if (!txName) throw new Error('Fichier Saxo : aucune feuille lisible')

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets[txName],
    { defval: '' },
  )
  if (!rows.length) throw new Error('Fichier Saxo : feuille Transactions vide')

  const { byTradeId, byIsinDate } = loadOpsSheet(wb)
  const ops: Operation[] = []
  const fpOccurrence = new Map<string, number>()
  const tickerHints: Record<string, string> = {}
  const currencyHints: Record<string, string> = {}
  const multipliers = new Map<string, number>()
  const pendingMultiplier: Array<{ index: number; key: string; qty: number }> = []
  let i = 0
  let inferredCash = 0

  for (const row of rows) {
    const txType = str(pick(row, 'type de transaction'))
    const event = str(pick(row, 'evenement', 'événement'))
    const date =
      cellDate(pick(row, "date d'operation", 'date operation', 'trade date')) ??
      cellDate(pick(row, 'date de valeur', 'value date'))
    if (!date || (!txType && !event)) continue

    const tradeId = str(pick(row, "id d'operation", 'id operation'))
    const isin = str(pick(row, 'code isin', 'isin'))
      .toUpperCase()
      .replace(/\s/g, '')
    const name = str(pick(row, 'instrument')) || undefined
    const place = str(pick(row, 'description de la place', 'place')) || undefined
    const symbol = str(pick(row, 'symbole', 'symbol'))
    const accountCurrency = str(pick(row, 'devise')) || 'EUR'
    const instrumentCurrencyRaw = str(
      pick(row, "devise de l'instrument", 'instrument currency'),
    )
    const instrumentCurrency = instrumentCurrencyRaw || undefined
    const booked = num(pick(row, 'montant comptabilise', 'montant comptabilisé'))
    const costs = num(pick(row, 'cout total', 'coût total'))
    const fxCost = num(pick(row, 'couts de conversion', 'coûts de conversion'))
    const fxRate = num(pick(row, 'taux de change', 'exchange rate'))
    const instrumentType = str(
      Object.entries(row).find(([k]) => k.trim().toLowerCase() === 'type')?.[1],
    )
    const instCur = instrumentCurrency?.toUpperCase()
    const nonEur =
      !!instCur &&
      instCur !== 'EUR' &&
      instCur !== accountCurrency.toUpperCase()
    const fx =
      nonEur && fxRate !== undefined && Number.isFinite(fxRate) && fxRate > 0
        ? fxRate
        : undefined

    let trade = parseSaxoTradeEvent(event)
    const fromOps =
      (tradeId ? byTradeId.get(tradeId) : undefined) ??
      (isin && date
        ? byIsinDate.get(
            `${isin}|${date}|${trade?.side ?? (/sortie/i.test(event) ? 'exit' : 'buy')}`,
          ) ??
          (/sortie sans valeur/i.test(event)
            ? byIsinDate.get(`${isin}|${date}|exit`)
            : undefined)
        : undefined)
    if (!trade && fromOps) {
      trade = { side: fromOps.side, qty: fromOps.qty, price: fromOps.price }
    } else if (trade && fromOps && !(trade.price > 0) && fromOps.price > 0) {
      trade = { ...trade, price: fromOps.price }
    }
    if (trade && fromOps && isExpiryEvent(event)) {
      trade = { ...trade, side: fromOps.side }
    }
    // Knock-out / worthless exit: Opérations has the qty (Transactions has no trade id)
    if (!trade && /sortie sans valeur/i.test(event) && fromOps) {
      trade = { side: 'sell', qty: fromOps.qty, price: 0 }
    }

    const type = classifySaxoRow(txType, event, trade)
    if (!type || type === 'UNKNOWN') continue

    const qty = trade?.qty
    // Keep explicit 0 (knock-out / expiry) — do not drop as "missing"
    const price =
      trade?.price !== undefined && Number.isFinite(trade.price)
        ? trade.price
        : undefined
    const fees =
      costs !== undefined
        ? Math.abs(costs)
        : fxCost !== undefined
          ? Math.abs(fxCost)
          : undefined
    const netAmount = booked

    if (
      (type === 'VERSEMENT' ||
        type === 'RETRAIT' ||
        type === 'FRAIS' ||
        type === 'DIVIDENDE' ||
        type === 'ACHAT' ||
        type === 'VENTE') &&
      netAmount !== undefined
    ) {
      inferredCash += netAmount
    }

    const isCashOnly =
      type === 'VERSEMENT' ||
      type === 'RETRAIT' ||
      type === 'FRAIS' ||
      (type === 'DIVIDENDE' && (qty === undefined || !(qty > 0)))

    if (isCashOnly) {
      const label = tradeId ? `${event} · #${tradeId}` : event
      const cashIsin = /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin) ? isin : undefined
      const base = {
        envelope,
        date,
        type,
        isin: cashIsin,
        name,
        quantity: undefined,
        price: undefined,
        fees,
        netAmount,
        currency: accountCurrency,
        instrumentCurrency: cashIsin && nonEur ? instCur : undefined,
        fxRate: cashIsin ? fx : undefined,
        place,
        label,
      }
      let fingerprint = operationFingerprint(base)
      const n = (fpOccurrence.get(fingerprint) ?? 0) + 1
      fpOccurrence.set(fingerprint, n)
      if (n > 1) fingerprint = `${fingerprint}#${n}`
      ops.push({
        id: makeOperationId(fingerprint, i++),
        fingerprint,
        ...base,
      })
      continue
    }

    if (!isin && !name) continue
    if (qty === undefined || !(qty > 0)) continue

    const label = tradeId ? `${event} · #${tradeId}` : event
    const validIsin = /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin) ? isin : undefined
    const yahooHint = yahooFromSaxoSymbol(symbol)
    if (validIsin && yahooHint) tickerHints[validIsin] = yahooHint
    if (validIsin && instrumentCurrency) {
      currencyHints[validIsin] = instrumentCurrency.toUpperCase()
    }

    // Options / futures: « Acheter 1 @ 2.30 USD » books 100 × 2.30. Store the
    // underlying unit count so qty × price matches the booked notional.
    const contractKey = validIsin ?? `NAME:${(name ?? '').toLowerCase()}`
    let units = qty
    if (hasContractMultiplier(instrumentType)) {
      if (price !== undefined && price > 0 && netAmount !== undefined) {
        const notionalAccount = qty * price * (fx ?? 1)
        const multiplier = Math.round(Math.abs(netAmount) / notionalAccount)
        if (multiplier >= 10) {
          multipliers.set(contractKey, multiplier)
          units = qty * multiplier
        }
      } else {
        // Expiry / 0-price close: multiplier taken from sibling trades below
        pendingMultiplier.push({ index: ops.length, key: contractKey, qty })
      }
    }

    const instrumentAmount =
      nonEur && price !== undefined
        ? (trade?.side === 'sell' ? 1 : -1) * units * price
        : undefined

    const base = {
      envelope,
      date,
      type,
      isin: validIsin,
      name,
      quantity: units,
      price,
      fees,
      netAmount,
      currency: accountCurrency,
      instrumentCurrency: nonEur ? instCur : undefined,
      instrumentAmount,
      fxRate: fx,
      place,
      label,
    }
    // Fingerprint as before price-0 exits were stored (no duplicate on re-import)
    let fingerprint = operationFingerprint({
      ...base,
      quantity: qty,
      price: price !== undefined && price > 0 ? price : undefined,
    })
    const n = (fpOccurrence.get(fingerprint) ?? 0) + 1
    fpOccurrence.set(fingerprint, n)
    if (n > 1) fingerprint = `${fingerprint}#${n}`

    ops.push({
      id: makeOperationId(fingerprint, i++),
      fingerprint,
      ...base,
    })
  }

  for (const p of pendingMultiplier) {
    const m = multipliers.get(p.key)
    if (m) ops[p.index] = { ...ops[p.index], quantity: p.qty * m }
  }

  ops.sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  )

  // Forward holdings → current positions (titres only)
  const book = new Map<
    string,
    {
      name: string
      qty: number
      lastPrice?: number
      currency: string
    }
  >()
  for (const op of ops) {
    if (!op.isin && !op.name) continue
    if (op.quantity === undefined) continue
    const key = op.isin || `NAME:${(op.name || '').toLowerCase()}`
    const cur = book.get(key) ?? {
      name: op.name || key,
      qty: 0,
      currency: op.instrumentCurrency || op.currency || 'EUR',
    }
    if (op.isin) cur.name = op.name || cur.name
    if (op.instrumentCurrency) cur.currency = op.instrumentCurrency
    cur.qty += quantityDelta(op.type, op.quantity)
    if (op.price !== undefined && Number.isFinite(op.price)) {
      cur.lastPrice = op.price
    }
    book.set(key, cur)
  }

  const positions: ParsedPosition[] = []
  for (const [key, b] of book) {
    // Open shorts (sold options) are not long holdings — leave them to the replay
    if (b.qty < 1e-8) continue
    if (!key.startsWith('NAME:') && !/^[A-Z]{2}[A-Z0-9]{10}$/.test(key)) continue
    positions.push({
      isin: key.startsWith('NAME:')
        ? `LOCAL:${key.slice(5).replace(/\s+/g, '').toLowerCase()}`
        : key,
      name: b.name,
      quantity: b.qty,
      price: b.lastPrice,
      currency: b.currency,
    })
  }
  positions.sort((a, b) => a.name.localeCompare(b.name, 'fr'))

  return {
    operations: ops,
    positions,
    inferredCash,
    tickerHints,
    currencyHints,
  }
}

export async function parseSaxoTransactionsFile(
  file: File,
  envelope: EnvelopeType,
): Promise<SaxoParseResult> {
  const buf = await readFileAsArrayBuffer(file)
  return parseSaxoWorkbook(buf, envelope)
}
