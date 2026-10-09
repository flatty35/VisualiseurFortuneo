import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import type { ParsedPosition } from '@/domain/types'
import {
  parseFrenchNumber,
  readFileAsArrayBuffer,
  readFileAsLatin1,
} from './parseUtils'
import { isZipFile, unwrapCsvFile } from './zipExtract'

function normalizeCell(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  return String(cell)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

function mapPositions(records: Record<string, unknown>[]): ParsedPosition[] {
  const positions: ParsedPosition[] = []

  for (const row of records) {
    const entries = Object.entries(row)
    const get = (...needles: string[]): unknown => {
      for (const [k, v] of entries) {
        const nk = normalizeCell(k)
        for (const n of needles) {
          if (nk === n || nk.includes(n)) return v
        }
      }
      return undefined
    }

    const isinRaw = get('isin')
    const isin = isinRaw ? String(isinRaw).trim().toUpperCase() : ''
    if (!isin || isin.length < 8) continue

    const name = String(get('libelle', 'libellé', 'nom', 'designation') ?? isin).trim()
    const quantity = parseFrenchNumber(get('qte', 'quantite', 'quantité', 'quantity'))
    if (quantity === undefined || quantity === 0) continue

    positions.push({
      isin,
      name,
      quantity: Math.abs(quantity),
      price: parseFrenchNumber(get('cours', 'prix', 'last')),
      pru: parseFrenchNumber(get('pru', 'prix revient', 'prix de revient', 'prm')),
      valuation: parseFrenchNumber(get('valorisation', 'valo', 'montant')),
      currency: String(get('devise') ?? 'EUR'),
    })
  }

  return positions
}

export async function parsePositionsFile(file: File): Promise<ParsedPosition[]> {
  if (isZipFile(file)) {
    const csv = await unwrapCsvFile(file)
    const text = await readFileAsLatin1(csv)
    return parsePositionsCsvText(text)
  }
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = await readFileAsLatin1(file)
    return parsePositionsCsvText(text)
  }
  return parsePositionsXlsBuffer(await readFileAsArrayBuffer(file))
}

export function parsePositionsCsvText(text: string): ParsedPosition[] {
  const lines = text.split(/\r?\n/)
  let headerIdx = 0
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const low = lines[i].toLowerCase()
    if (low.includes('isin') && (low.includes('libell') || low.includes('qte') || low.includes('quant'))) {
      headerIdx = i
      break
    }
  }
  const delimiter = lines[headerIdx]?.includes(';') ? ';' : ','
  const parsed = Papa.parse<Record<string, string>>(lines.slice(headerIdx).join('\n'), {
    header: true,
    skipEmptyLines: true,
    delimiter,
  })
  return mapPositions(parsed.data)
}

export function parsePositionsXlsBuffer(buffer: ArrayBuffer): ParsedPosition[] {
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: null,
    raw: false,
  })

  const headerRowIndex = rows.findIndex((row) => {
    if (!Array.isArray(row)) return false
    const normalized = row.map((cell) => normalizeCell(cell))
    return normalized.includes('isin') && normalized.some((c) => c.includes('libell') || c === 'nom')
  })

  const idx = headerRowIndex >= 0 ? headerRowIndex : 0
  const headerRow = (rows[idx] as unknown[]) ?? []
  const headers = headerRow.map((cell) => (cell == null ? '' : String(cell).trim()))

  const records = rows.slice(idx + 1).map((row) => {
    const record: Record<string, unknown> = {}
    if (!Array.isArray(row)) return record
    headers.forEach((header, index) => {
      if (header) record[header] = row[index]
    })
    return record
  })

  return mapPositions(records)
}

/** Extract cash pocket from positions export if a cash-like row exists. */
export function extractCashFromPositions(positions: ParsedPosition[]): number | undefined {
  const cash = positions.find((p) => {
    const n = p.name
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
    return (
      n.includes('espece') ||
      n.includes('liquidit') ||
      n.includes('especes') ||
      n.includes('cash') ||
      n.includes('solde') ||
      p.isin === 'CASH' ||
      p.isin === 'EUR' ||
      p.isin.startsWith('XX')
    )
  })
  if (!cash) return undefined
  const v = cash.valuation ?? cash.quantity * (cash.price ?? 1)
  return Number.isFinite(v) ? Math.max(0, v) : undefined
}
