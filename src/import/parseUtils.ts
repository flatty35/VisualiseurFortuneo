export function parseFrenchNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  let s = String(raw)
    .replace(/\u00a0/g, ' ')
    .replace(/€/g, '')
    .replace(/\s/g, '')
    .trim()
  if (!s) return undefined
  // French: 1 234,56 or 1234,56
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** Parse dd/mm/yyyy → YYYY-MM-DD */
export function parseFrenchDate(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined
  if (typeof raw === 'number') {
    // Excel serial date
    const utc = excelSerialToDate(raw)
    return formatISODate(utc)
  }
  const s = String(raw).trim()
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (m) {
    const dd = m[1].padStart(2, '0')
    const mm = m[2].padStart(2, '0')
    const yyyy = m[3]
    return `${yyyy}-${mm}-${dd}`
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return undefined
}

function excelSerialToDate(serial: number): Date {
  const utc_days = Math.floor(serial - 25569)
  return new Date(utc_days * 86400 * 1000)
}

export function formatISODate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function readFileAsLatin1(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Erreur lecture fichier'))
    reader.readAsText(file, 'latin1')
  })
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(new Error('Erreur lecture fichier'))
    reader.readAsArrayBuffer(file)
  })
}

/** Extract ISIN from label like "TOTALENERGIES SE - FR0000120271" */
export function extractIsin(text: string): string | undefined {
  const m = text.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/)
  return m?.[1]
}

export function stripIsinFromName(text: string): string {
  return text
    .replace(/\s*[-–]\s*[A-Z]{2}[A-Z0-9]{10}\b/, '')
    .replace(/\b[A-Z]{2}[A-Z0-9]{10}\b/, '')
    .trim()
}
