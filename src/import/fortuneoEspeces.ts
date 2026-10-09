import Papa from 'papaparse'
import { classifyCashLabel } from '@/domain/classify'
import { makeOperationId, operationFingerprint } from '@/domain/fingerprint'
import type { EnvelopeType, Operation } from '@/domain/types'
import { parseFrenchDate, parseFrenchNumber, readFileAsLatin1 } from './parseUtils'
import { unwrapCsvFile } from './zipExtract'

/**
 * Espèces CSV = sole cash ledger (Débit / Crédit).
 * Keep every movement (versements, achats, ventes, taxes, dividendes…).
 * Titres history drives quantities only — using both for cash double-counts
 * and drifts when Montant net ≠ espèces lines.
 */

function findHeaderIndex(lines: string[]): number {
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const low = lines[i].toLowerCase()
    if (
      low.includes('date') &&
      (low.includes('libell') ||
        low.includes('debit') ||
        low.includes('crédit') ||
        low.includes('credit'))
    ) {
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
    .trim()
}

function pick(row: Record<string, string>, ...keys: string[]): string {
  const map = new Map(Object.entries(row).map(([k, v]) => [normalizeHeader(k), v]))
  for (const key of keys) {
    const v = map.get(normalizeHeader(key))
    if (v !== undefined && v !== '') return v
  }
  for (const [k, v] of map) {
    for (const key of keys) {
      if (k.includes(normalizeHeader(key)) && v) return v
    }
  }
  return ''
}

export async function parseEspecesCsv(
  file: File,
  envelope: EnvelopeType,
): Promise<Operation[]> {
  const csv = await unwrapCsvFile(file, 'espece')
  const text = await readFileAsLatin1(csv)
  return parseEspecesText(text, envelope)
}

export function parseEspecesText(text: string, envelope: EnvelopeType): Operation[] {
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

  for (const row of parsed.data) {
    const label = pick(row, 'libellé', 'libelle', 'Libellé')
    const date =
      parseFrenchDate(pick(row, 'Date opération', 'Date operation', 'Date')) ??
      parseFrenchDate(pick(row, 'Date valeur'))
    if (!date || !label) continue

    const type = classifyCashLabel(label)
    const debit = parseFrenchNumber(pick(row, 'Débit', 'Debit'))
    const credit = parseFrenchNumber(pick(row, 'Crédit', 'Credit'))

    // Fortuneo: Débit already negative, Crédit positive — sum is the cash delta.
    let netAmount = 0
    if (debit !== undefined) netAmount += debit
    if (credit !== undefined) netAmount += credit
    if (Math.abs(netAmount) < 1e-9) continue

    const fingerprint = operationFingerprint({
      envelope,
      date,
      type,
      netAmount,
      label,
    })

    ops.push({
      id: makeOperationId(fingerprint, i++),
      fingerprint,
      envelope,
      date,
      type,
      netAmount,
      currency: 'EUR',
      label,
    })
  }

  return ops
}
