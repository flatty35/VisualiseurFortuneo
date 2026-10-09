import type { OperationType } from './types'

/** Classify Fortuneo titres "Opération" / libellé into typed ops. */
export function classifyTitresOperation(operation: string, label: string): OperationType {
  const op = normalize(operation)
  const lib = normalize(label)

  if (op.includes('achat') || lib.startsWith('achat ')) return 'ACHAT'
  if (op.includes('vente') || lib.startsWith('vente ')) return 'VENTE'
  if (op.includes('script') || lib.includes('script')) return 'SCRIPT'
  if (op.includes('rachat') || lib.includes('rachat')) return 'RACHAT'

  if (op.includes('detachement') || lib.includes('detachement')) return 'DETACHEMENT'
  if (
    op.includes('encaissement') ||
    lib.includes('dividende') ||
    lib.includes('coupon') ||
    (lib.includes('encaissement') && lib.includes('dividende'))
  ) {
    return 'DIVIDENDE'
  }

  if (
    lib.includes('action gratuite') ||
    lib.includes('actions gratuites') ||
    lib.includes('attribution') ||
    op.includes('gratuite')
  ) {
    return 'ACTIONS_GRATUITES'
  }

  if (
    lib.includes('augmentation de capital') ||
    lib.includes('augm. de capital') ||
    lib.includes('souscription')
  ) {
    return 'AUGMENTATION_CAPITAL'
  }

  if (lib.includes('split') || lib.includes('division')) return 'OST_SPLIT'
  if (lib.includes('fusion')) return 'OST_FUSION'
  if (op.startsWith('ost') || lib.startsWith('ost')) return 'OST_OTHER'
  if (op.includes('taxe') || lib.includes('taxe')) return 'TAXE'

  return 'UNKNOWN'
}

export function classifyCashLabel(label: string): OperationType {
  const lib = normalize(label)
  if (lib.includes('versement')) return 'VERSEMENT'
  if (lib.includes('retrait') || lib.includes('arbitrage')) return 'RETRAIT'
  if (lib.includes('dividende') || lib.includes('coupon') || lib.includes('encaissement')) {
    return 'DIVIDENDE'
  }
  if (lib.includes('taxe') || lib.includes('frais') || lib.includes('commission')) return 'FRAIS'
  return 'UNKNOWN'
}

/** Qty delta for forward replay (positive = long more shares). */
export function quantityDelta(type: OperationType, qty: number): number {
  const q = Math.abs(qty)
  switch (type) {
    case 'ACHAT':
    case 'SCRIPT':
    case 'ACTIONS_GRATUITES':
    case 'AUGMENTATION_CAPITAL':
    case 'POSITION_SEED':
      return q
    case 'VENTE':
    case 'RACHAT':
      return -q
    default:
      return 0
  }
}

/** Inverse qty delta for backward reconstruction from current snapshot. */
export function reverseQuantityDelta(type: OperationType, qty: number): number {
  return -quantityDelta(type, qty)
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}
