import type { EnvelopeType, OperationType } from './types'

function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function round6(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return ''
  return (Math.round(n * 1e6) / 1e6).toString()
}

/** Stable fingerprint for incremental merge (idempotent re-import). */
export function operationFingerprint(input: {
  envelope: EnvelopeType
  date: string
  type: OperationType
  isin?: string
  name?: string
  quantity?: number
  price?: number
  netAmount?: number
  label: string
}): string {
  const assetKey =
    input.isin ??
    (input.name ? `NAME:${normalizeLabel(input.name)}` : 'CASH')
  const parts = [
    input.envelope,
    input.date,
    input.type,
    assetKey,
    round6(input.quantity),
    round6(input.price),
    round6(input.netAmount),
    normalizeLabel(input.label),
  ]
  return simpleHash(parts.join('|'))
}

function simpleHash(str: string): string {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function makeOperationId(fingerprint: string, index: number): string {
  return `${fingerprint}-${index}`
}
