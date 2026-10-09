/** YYYY-MM-DD → next weekday (Mon–Fri), unchanged if already a weekday. */
export function toBusinessDay(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return date
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return d.toISOString().slice(0, 10)
}

export function eachBusinessDay(from: string, to: string): string[] {
  const out: string[] = []
  const d = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  while (d <= end) {
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}
