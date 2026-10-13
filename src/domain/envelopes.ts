import type { EnvelopeType } from './types'

/** All envelopes known to the viewer (Fortuneo + Saxo). */
export const ALL_ENVELOPES: EnvelopeType[] = [
  'PEA',
  'PEA_PME',
  'CTO',
  'PEA_SAXO',
  'PEA_PME_SAXO',
  'CTO_SAXO',
]

export type BrokerId = 'fortuneo' | 'saxo'

export function envelopeLabel(type: EnvelopeType): string {
  switch (type) {
    case 'PEA':
      return 'PEA Fortuneo'
    case 'PEA_PME':
      return 'PEA-PME Fortuneo'
    case 'CTO':
      return 'CTO Fortuneo'
    case 'PEA_SAXO':
      return 'PEA Saxo'
    case 'PEA_PME_SAXO':
      return 'PEA-PME Saxo'
    case 'CTO_SAXO':
      return 'CTO Saxo'
  }
}

/** Envelopes offered for a given broker on the Import page. */
export function envelopesForBroker(broker: BrokerId): EnvelopeType[] {
  if (broker === 'saxo') return ['PEA_SAXO', 'PEA_PME_SAXO', 'CTO_SAXO']
  return ['PEA', 'PEA_PME', 'CTO']
}

export function brokerForEnvelope(type: EnvelopeType): BrokerId {
  return type === 'CTO_SAXO' ||
    type === 'PEA_SAXO' ||
    type === 'PEA_PME_SAXO'
    ? 'saxo'
    : 'fortuneo'
}

/** Saxo accounts ship a full cash journal → ledger cash mode. */
export function isSaxoEnvelope(type: EnvelopeType | string | undefined): boolean {
  return (
    type === 'CTO_SAXO' || type === 'PEA_SAXO' || type === 'PEA_PME_SAXO'
  )
}
