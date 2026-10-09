import JSZip from 'jszip'

export function isZipFile(file: File): boolean {
  return (
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip')
  )
}

/** If ZIP, extract the first CSV (or preferred name); otherwise return the file as-is. */
export async function unwrapCsvFile(file: File, preferredName?: string): Promise<File> {
  if (!isZipFile(file)) return file

  const zip = await JSZip.loadAsync(file)
  const entries = Object.entries(zip.files).filter(
    ([name, f]) => !f.dir && name.toLowerCase().endsWith('.csv'),
  )

  if (!entries.length) {
    throw new Error(`Aucun CSV dans l'archive ZIP « ${file.name} »`)
  }

  let chosen = entries[0]
  if (preferredName) {
    const match = entries.find(([name]) =>
      name.toLowerCase().includes(preferredName.toLowerCase()),
    )
    if (match) chosen = match
  }

  const [name, entry] = chosen
  const data = await entry.async('uint8array')
  const blob = new Blob([data as BlobPart], { type: 'text/csv' })
  // Keep only basename for display
  const base = name.split('/').pop() ?? name
  return new File([blob], base, { type: 'text/csv' })
}
