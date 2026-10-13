import type { EnvelopeType } from './types'

/** All envelopes known to the viewer (Fortuneo + Saxo). */
export const ALL_ENVELOPES: EnvelopeType[] = [
  'PEA',
  'PEA_PME',
  'CTO',
  'CTO_SAXO',
]

export type BrokerId = 'fortuneo' | 'saxo'

export function envelopeLabel(type: EnvelopeType): string {
  switch (type) {
    case 'PEA':
      return 'PEA'
    case 'PEA_PME':
      return 'PEA-PME'
    case 'CTO':
      return 'CTO Fortuneo'
    case 'CTO_SAXO':
      return 'CTO Saxo'
  }
}

/** Envelopes offered for a given broker on the Import page. */
export function envelopesForBroker(broker: BrokerId): EnvelopeType[] {
  if (broker === 'saxo') return ['CTO_SAXO']
  return ['PEA', 'PEA_PME', 'CTO']
}

export function brokerForEnvelope(type: EnvelopeType): BrokerId {
  return type === 'CTO_SAXO' ? 'saxo' : 'fortuneo'
}
