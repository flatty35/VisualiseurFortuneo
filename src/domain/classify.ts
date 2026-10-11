import type { OperationType } from './types'

/** Classify Fortuneo titres "Opération" / libellé into typed ops. */
export function classifyTitresOperation(operation: string, label: string): OperationType {
  const op = normalize(operation)
  const lib = normalize(label)

  // Fortuneo cancellations: « ANNUL. SCRIPT-PARTS SICAV EXTERNE » undoes a buy.
  // Must run before the plain SCRIPT / ACHAT matches.
  if (op.includes('annul')) {
    if (
      op.includes('script') ||
      op.includes('achat') ||
      lib.includes('script')
    ) {
      return 'RACHAT'
    }
    if (op.includes('rachat') || op.includes('vente') || lib.includes('rachat')) {
      return 'SCRIPT'
    }
  }

  // « RACHAT » contains the substring « achat » — test rachat BEFORE achat.
  if (op.includes('rachat') || lib.includes('rachat')) return 'RACHAT'
  if (op.includes('script') || lib.includes('script')) return 'SCRIPT'
  if (op.includes('achat') || lib.startsWith('achat ')) return 'ACHAT'
  if (op.includes('vente') || lib.startsWith('vente ')) return 'VENTE'

  // BPI / FCPR: « Détachement coupon amortissement » = détachement + encaissement
  // combinés (remboursement de capital). Ordinary « optionnel » stays DETACHEMENT
  // (followed by a separate Encaissement line).
  if (
    (op.includes('detachement') || lib.includes('detachement')) &&
    (op.includes('amortissement') || lib.includes('amortissement'))
  ) {
    return 'DIVIDENDE'
  }
  if (op.includes('detachement') || lib.includes('detachement')) return 'DETACHEMENT'
  if (
    op.includes('encaissement') ||
    lib.includes('dividende') ||
    lib.includes('coupon') ||
    (lib.includes('encaissement') && lib.includes('dividende'))
  ) {
    return 'DIVIDENDE'
  }

  // Fortuneo: « OST de création … Attribution automatique » (ex. Air Liquide).
  // Must run before the generic OST_* catch-all (operation starts with « OST »).
  if (
    lib.includes('action gratuite') ||
    lib.includes('actions gratuites') ||
    lib.includes('attribution') ||
    op.includes('action gratuite') ||
    op.includes('actions gratuites') ||
    op.includes('attribution') ||
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
  if (
    lib.includes('versement') ||
    lib.includes('apport') ||
    lib.includes('alimentation') ||
    (lib.includes('virement') &&
      !lib.includes('achat') &&
      !lib.includes('vente'))
  ) {
    return 'VERSEMENT'
  }
  if (
    lib.includes('retrait') ||
    lib.includes('arbitrage') ||
    lib.includes('sortie de fonds')
  ) {
    return 'RETRAIT'
  }
  if (lib.includes('dividende') || lib.includes('coupon') || lib.includes('encaissement')) {
    return 'DIVIDENDE'
  }
  if (lib.includes('taxe')) return 'TAXE'
  if (lib.includes('frais') || lib.includes('commission')) return 'FRAIS'
  if (lib.startsWith('achat') || lib.includes(' achat')) return 'ACHAT'
  if (lib.startsWith('vente') || lib.includes(' vente')) return 'VENTE'
  if (lib.includes('sousc') || lib.includes('script')) return 'SCRIPT'
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
