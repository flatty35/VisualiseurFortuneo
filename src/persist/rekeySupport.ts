import type { Support } from '@/domain/types'
import { isLocalSupportId } from '@/import/resolveIsin'
import { db } from './db'

export function isValidIsin(isin: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin.trim().toUpperCase())
}

export function normalizeSupportKey(raw: string): string {
  const t = raw.trim()
  if (isLocalSupportId(t)) {
    // Keep LOCAL: slug as-is (lowercase slug already)
    const slug = t.slice('LOCAL:'.length).trim().toLowerCase()
    return `LOCAL:${slug}`
  }
  return t.toUpperCase()
}

export interface RekeyResult {
  from: string
  to: string
  opsUpdated: number
  voUpdated: number
  mergedIntoExisting: boolean
}

/**
 * Change a support's primary key (ISIN / LOCAL:…).
 * Updates operations + virtual openings. Merges into an existing support
 * if `to` already exists.
 */
export async function rekeySupport(
  fromIsin: string,
  toIsin: string,
  patch?: Partial<Omit<Support, 'isin'>>,
): Promise<RekeyResult> {
  const from = fromIsin.trim()
  const to = normalizeSupportKey(toIsin)
  if (!from) throw new Error('Clé source vide')
  if (!to) throw new Error('Nouvelle clé vide')
  if (!isLocalSupportId(to) && !isValidIsin(to)) {
    throw new Error('ISIN invalide (12 caractères, ex. FR0000120073) ou LOCAL:…')
  }

  if (from === to) {
    const cur = await db.supports.get(from)
    if (!cur) throw new Error(`Support introuvable: ${from}`)
    if (patch) {
      await db.supports.put({
        ...cur,
        ...patch,
        isin: from,
        manualPrices: patch.manualPrices ?? cur.manualPrices,
      })
    }
    return { from, to, opsUpdated: 0, voUpdated: 0, mergedIntoExisting: false }
  }

  const source = await db.supports.get(from)
  if (!source) throw new Error(`Support introuvable: ${from}`)

  const existingTarget = await db.supports.get(to)
  const merged: Support = {
    isin: to,
    name: patch?.name ?? existingTarget?.name ?? source.name,
    yahooTicker:
      patch?.yahooTicker ?? existingTarget?.yahooTicker ?? source.yahooTicker,
    googleTicker:
      patch?.googleTicker ?? existingTarget?.googleTicker ?? source.googleTicker,
    boursoramaTicker:
      patch?.boursoramaTicker ??
      existingTarget?.boursoramaTicker ??
      source.boursoramaTicker,
    staticPrice:
      patch?.staticPrice ?? existingTarget?.staticPrice ?? source.staticPrice,
    manualPrices:
      patch?.manualPrices ??
      (existingTarget?.manualPrices?.length
        ? existingTarget.manualPrices
        : source.manualPrices),
  }

  const ops = await db.operations.where('isin').equals(from).toArray()
  const opsUpdated = ops.length
  if (ops.length) {
    await db.operations.bulkPut(ops.map((o) => ({ ...o, isin: to })))
  }

  let voUpdated = 0
  const openings = await db.virtualOpenings.toArray()
  for (const vo of openings) {
    let changed = false
    const positions = vo.positions.map((p) => {
      if (p.isin !== from) return p
      changed = true
      return { ...p, isin: to, name: merged.name }
    })
    // Collapse duplicate isins after remap
    if (changed) {
      const byIsin = new Map<string, (typeof positions)[0]>()
      for (const p of positions) {
        const prev = byIsin.get(p.isin)
        if (!prev) byIsin.set(p.isin, p)
        else {
          byIsin.set(p.isin, {
            ...prev,
            quantity: prev.quantity + p.quantity,
            name: prev.name || p.name,
          })
        }
      }
      await db.virtualOpenings.put({
        ...vo,
        positions: [...byIsin.values()],
      })
      voUpdated++
    }
  }

  await db.supports.put(merged)
  if (from !== to) await db.supports.delete(from)

  return {
    from,
    to,
    opsUpdated,
    voUpdated,
    mergedIntoExisting: Boolean(existingTarget),
  }
}
