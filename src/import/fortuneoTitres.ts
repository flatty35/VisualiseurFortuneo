import Papa from 'papaparse'
import { classifyTitresOperation } from '@/domain/classify'
import { makeOperationId, operationFingerprint } from '@/domain/fingerprint'
import type { EnvelopeType, Operation } from '@/domain/types'
import {
  extractIsin,
  parseFrenchDate,
  parseFrenchNumber,
  readFileAsLatin1,
  stripIsinFromName,
} from './parseUtils'
import { unwrapCsvFile } from './zipExtract'

function findHeaderIndex(lines: string[]): number {
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const low = lines[i].toLowerCase()
    if (low.includes('op') && (low.includes('libell') || low.includes('date'))) {
      return i
    }
  }
  return 0
}

function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['']/g, '')
    .trim()
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  const map = new Map(Object.entries(row).map(([k, v]) => [normalizeHeader(k), v]))
  for (const key of keys) {
    const v = map.get(normalizeHeader(key))
    if (v !== undefined && v !== '') return v
  }
  // fuzzy
  for (const [k, v] of map) {
    for (const key of keys) {
      if (k.includes(normalizeHeader(key)) && v) return v
    }
  }
  return ''
}

export async function parseTitresCsv(
  file: File,
  envelope: EnvelopeType,
): Promise<Operation[]> {
  const csv = await unwrapCsvFile(file, 'titre')
  const text = await readFileAsLatin1(csv)
  return parseTitresText(text, envelope)
}

export function parseTitresText(text: string, envelope: EnvelopeType): Operation[] {
  const lines = text.split(/\r?\n/)
  const headerIdx = findHeaderIndex(lines)
  const csvBody = lines.slice(headerIdx).join('\n')

  const parsed = Papa.parse<Record<string, string>>(csvBody, {
    header: true,
    skipEmptyLines: true,
    delimiter: ';',
  })

  const ops: Operation[] = []
  let i = 0
  // Fortuneo sometimes repeats an identical trade row (same date/qty/price).
  // A bare content hash would collapse them on merge and invent short openings
  // (e.g. VusionGroup −5). Suffix #n keeps duplicates distinct while staying
  // stable across re-parse of the same file; the first row keeps the bare hash
  // so existing stored ops still match on re-import.
  const fpOccurrence = new Map<string, number>()

  for (const row of parsed.data) {
    const label = pick(row, 'libellé', 'libelle', 'Libellé')
    const operation = pick(row, 'Opération', 'Operation', 'opération')
    const dateRaw = pick(row, 'Date', 'date')
    const date = parseFrenchDate(dateRaw)
    if (!date || (!label && !operation)) continue

    const type = classifyTitresOperation(operation || label, label)
    const qty = parseFrenchNumber(pick(row, 'Qté', 'Qte', 'Quantité', 'Quantite'))
    const price = parseFrenchNumber(
      pick(row, "Prix d'éxé", "Prix d'exe", 'Prix', 'Cours'),
    )
    const gross = parseFrenchNumber(pick(row, 'Montant brut', 'Montant Brut'))
    const fees = parseFrenchNumber(
      pick(row, 'Courtage/Prélèvement', 'Courtage/Prelevement', 'Courtage'),
    )
    const net = parseFrenchNumber(pick(row, 'Montant net', 'Montant Net'))
    const currency = pick(row, 'Devise') || 'EUR'
    const placeRaw = pick(row, 'Place').trim()
    const place = placeRaw && placeRaw.toLowerCase() !== 'null' ? placeRaw : undefined

    const isin = extractIsin(label) ?? extractIsin(operation)
    const name = stripIsinFromName(label || operation)

    const assetName = name || undefined
    // Fingerprint keeps the historical key (name-first). Stored label prefers the
    // Opération text so amortissement / OST wording remains available later.
    const baseFp = operationFingerprint({
      envelope,
      date,
      type,
      isin,
      name: assetName,
      quantity: qty,
      price,
      netAmount: net,
      label: label || operation,
    })
    const occ = fpOccurrence.get(baseFp) ?? 0
    fpOccurrence.set(baseFp, occ + 1)
    const fingerprint = occ === 0 ? baseFp : `${baseFp}#${occ}`
    const storedLabel = operation?.trim()
      ? label?.trim()
        ? `${operation.trim()} · ${label.trim()}`
        : operation.trim()
      : label || operation

    ops.push({
      id: makeOperationId(fingerprint, i++),
      fingerprint,
      envelope,
      date,
      type,
      isin,
      name: assetName,
      quantity: qty !== undefined ? Math.abs(qty) : undefined,
      price,
      grossAmount: gross,
      fees,
      netAmount: net,
      currency,
      place,
      label: storedLabel,
    })
  }

  return ops
}
