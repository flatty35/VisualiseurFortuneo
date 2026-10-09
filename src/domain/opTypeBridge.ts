import { OperationType, type OperationTypeId } from './portfolioModel'
/** Legacy flat string op types (pre-migration UI / parsers). */
export type LegacyOpType =
  | 'ACHAT'
  | 'VENTE'
  | 'SCRIPT'
  | 'RACHAT'
  | 'DIVIDENDE'
  | 'DETACHEMENT'
  | 'ACTIONS_GRATUITES'
  | 'AUGMENTATION_CAPITAL'
  | 'VERSEMENT'
  | 'RETRAIT'
  | 'FRAIS'
  | 'TAXE'
  | 'OST_OTHER'
  | 'OST_SPLIT'
  | 'OST_FUSION'
  | 'POSITION_SEED'
  | 'UNKNOWN'

const LEGACY_TO_PEA: Record<LegacyOpType, OperationTypeId> = {
  VERSEMENT: OperationType.PEA_VERSEMENT,
  RETRAIT: OperationType.PEA_RETRAIT,
  ACHAT: OperationType.PEA_ACHAT,
  VENTE: OperationType.PEA_VENTE,
  DIVIDENDE: OperationType.PEA_DIVIDENDE,
  DETACHEMENT: OperationType.PEA_DETACHEMENT,
  ACTIONS_GRATUITES: OperationType.PEA_ACTIONS_GRATUITES,
  OST_FUSION: OperationType.PEA_OST_FUSION,
  OST_SPLIT: OperationType.PEA_OST_SPLIT,
  SCRIPT: OperationType.PEA_SCRIPT,
  RACHAT: OperationType.PEA_VENTE,
  AUGMENTATION_CAPITAL: OperationType.PEA_AUGMENTATION_CAPITAL,
  TAXE: OperationType.PEA_TAXE,
  FRAIS: OperationType.PEA_FRAIS,
  OST_OTHER: OperationType.PEA_OST_OTHER,
  POSITION_SEED: OperationType.POSITION_SET,
  UNKNOWN: OperationType.UNKNOWN,
}

const PEA_TO_LEGACY: Partial<Record<number, LegacyOpType>> = {
  [OperationType.PEA_VERSEMENT]: 'VERSEMENT',
  [OperationType.PEA_RETRAIT]: 'RETRAIT',
  [OperationType.PEA_ACHAT]: 'ACHAT',
  [OperationType.PEA_VENTE]: 'VENTE',
  [OperationType.PEA_DIVIDENDE]: 'DIVIDENDE',
  [OperationType.PEA_DETACHEMENT]: 'DETACHEMENT',
  [OperationType.PEA_ACTIONS_GRATUITES]: 'ACTIONS_GRATUITES',
  [OperationType.PEA_OST_FUSION]: 'OST_FUSION',
  [OperationType.PEA_OST_SPLIT]: 'OST_SPLIT',
  [OperationType.PEA_OST_GROUP]: 'OST_OTHER',
  [OperationType.PEA_OST_UNGROUP]: 'OST_OTHER',
  [OperationType.PEA_SCRIPT]: 'SCRIPT',
  [OperationType.PEA_TAXE]: 'TAXE',
  [OperationType.PEA_FRAIS]: 'FRAIS',
  [OperationType.PEA_OST_OTHER]: 'OST_OTHER',
  [OperationType.PEA_AUGMENTATION_CAPITAL]: 'AUGMENTATION_CAPITAL',
  [OperationType.POSITION_SET]: 'POSITION_SEED',
  [OperationType.UNKNOWN]: 'UNKNOWN',
  [OperationType.DEFAULT_VERSEMENT]: 'VERSEMENT',
  [OperationType.DEFAULT_RETRAIT]: 'RETRAIT',
  [OperationType.DEFAULT_ACHAT]: 'ACHAT',
  [OperationType.DEFAULT_VENTE]: 'VENTE',
}

export function legacyToOperationType(t: LegacyOpType): OperationTypeId {
  return LEGACY_TO_PEA[t] ?? OperationType.UNKNOWN
}

export function operationTypeToLegacy(t: number): LegacyOpType {
  return PEA_TO_LEGACY[t] ?? 'UNKNOWN'
}

/** Qty delta for forward replay (positive = long more shares). */
export function quantityDeltaOp(type: number, qty: number): number {
  const q = Math.abs(qty)
  switch (type) {
    case OperationType.PEA_ACHAT:
    case OperationType.PEA_SCRIPT:
    case OperationType.PEA_ACTIONS_GRATUITES:
    case OperationType.PEA_AUGMENTATION_CAPITAL:
    case OperationType.DEFAULT_ACHAT:
    case OperationType.SCPI_ACHAT:
    case OperationType.CRYPTO_ACHAT:
    case OperationType.POSITION_SET:
      return q
    case OperationType.PEA_VENTE:
    case OperationType.DEFAULT_VENTE:
    case OperationType.SCPI_VENTE:
    case OperationType.CRYPTO_VENTE:
      return -q
    default:
      return 0
  }
}

export function reverseQuantityDeltaOp(type: number, qty: number): number {
  return -quantityDeltaOp(type, qty)
}

export function isBuyOp(type: number): boolean {
  return quantityDeltaOp(type, 1) > 0 && type !== OperationType.POSITION_SET
}

export function isSellOp(type: number): boolean {
  return quantityDeltaOp(type, 1) < 0
}

export function isCashLedgerOp(type: number): boolean {
  return (
    type === OperationType.PEA_VERSEMENT ||
    type === OperationType.PEA_RETRAIT ||
    type === OperationType.PEA_ACHAT ||
    type === OperationType.PEA_VENTE ||
    type === OperationType.PEA_DIVIDENDE ||
    type === OperationType.PEA_TAXE ||
    type === OperationType.PEA_FRAIS ||
    type === OperationType.PEA_SCRIPT ||
    type === OperationType.PEA_AUGMENTATION_CAPITAL ||
    type === OperationType.DEFAULT_VERSEMENT ||
    type === OperationType.DEFAULT_RETRAIT ||
    type === OperationType.DEFAULT_ACHAT ||
    type === OperationType.DEFAULT_VENTE ||
    type === OperationType.UNKNOWN
  )
}
