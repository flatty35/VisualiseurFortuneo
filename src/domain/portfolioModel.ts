/**
 * Domain model: Portfolio aggregate (Envelope / Operation / Support / Position).
 */

export const AssetType = {
  ESPECES: 0,
  FOND_EURO: 1,
  OBLIGATIONS_IG: 2,
  OBLIGATIONS_HY: 3,
  ACTIONS: 4,
  IMMO: 5,
  PRECIOUS_METAL: 6,
  PRIVATE_EQUITY_DETTE: 7,
  PRIVATE_EQUITY_CAPITAL: 8,
  CRYPTO: 9,
  END: 10,
} as const
export type AssetTypeId = (typeof AssetType)[keyof typeof AssetType]

export const GetterType = {
  YAHOO_FINANCE: 0,
  BOURSORAMA: 1,
  SCRAPING: 2,
  STATIC: 3,
  END: 4,
} as const
export type GetterTypeId = (typeof GetterType)[keyof typeof GetterType]

export const OperationType = {
  UNKNOWN: 0,
  PEA_VERSEMENT: 1,
  PEA_RETRAIT: 2,
  PEA_ACHAT: 3,
  PEA_VENTE: 4,
  PEA_DIVIDENDE: 5,
  PEA_DETACHEMENT: 6,
  PEA_ACTIONS_GRATUITES: 7,
  PEA_OST_FUSION: 8,
  PEA_OST_SPLIT: 9,
  PEA_OST_GROUP: 10,
  PEA_OST_UNGROUP: 11,
  AV_VERSEMENT: 12,
  AV_ARBITRAGE: 13,
  AV_RETRAIT: 14,
  AV_FRAIS_UC: 15,
  AV_PARTICIPATION_FONDS_EURO: 16,
  AV_DIVIDENDES_UC: 17,
  SCPI_ACHAT: 18,
  SCPI_DIVIDENDE: 19,
  SCPI_VENTE: 20,
  DEFAULT_VERSEMENT: 21,
  DEFAULT_RETRAIT: 22,
  DEFAULT_ACHAT: 23,
  DEFAULT_VENTE: 24,
  CRYPTO_ACHAT: 25,
  CRYPTO_VENTE: 26,
  CRYPTO_SWAP: 27,
  CRYPTO_TRANSFERT: 28,
  CRYPTO_FRAIS: 29,
  POSITION_SET: 30,
  /** Script / souscription parts (PEA UCITS etc.) */
  PEA_SCRIPT: 32,
  PEA_TAXE: 33,
  PEA_FRAIS: 34,
  PEA_OST_OTHER: 35,
  PEA_AUGMENTATION_CAPITAL: 36,
  END: 37,
} as const
export type OperationTypeId = (typeof OperationType)[keyof typeof OperationType]

/** Envelope category used by the Fortuneo viewer */
export const EnvelopeKind = {
  PEA: 0,
  PEA_PME: 1,
  CTO: 2,
  END: 3,
} as const
export type EnvelopeKindId = (typeof EnvelopeKind)[keyof typeof EnvelopeKind]

export type EnvelopeKindName = 'PEA' | 'PEA_PME' | 'CTO'

export function envelopeKindFromName(name: EnvelopeKindName): EnvelopeKindId {
  return EnvelopeKind[name]
}

export function envelopeKindToName(kind: number): EnvelopeKindName {
  if (kind === EnvelopeKind.PEA_PME) return 'PEA_PME'
  if (kind === EnvelopeKind.CTO) return 'CTO'
  return 'PEA'
}

export interface PositionData {
  supportUniqueID?: number
  quantity?: number
  PRU?: number
  customDetails?: string
}

export class Position {
  supportUniqueID: number
  quantity: number
  PRU: number
  customDetails: string

  constructor(data: PositionData = {}) {
    this.supportUniqueID = data.supportUniqueID || 0
    this.quantity = data.quantity || 0
    this.PRU = Math.abs(data.PRU || 0)
    this.customDetails = data.customDetails || ''
  }

  toJSON(): PositionData {
    return {
      supportUniqueID: this.supportUniqueID,
      quantity: this.quantity,
      PRU: this.PRU,
      customDetails: this.customDetails,
    }
  }
}

export interface OperationData {
  id?: string
  fingerprint?: string
  dateTime?: number
  date?: string
  amount?: number
  fees?: number
  taxes?: number
  buyPositions?: PositionData[]
  sellPositions?: PositionData[]
  type?: number
  supportUniqueID?: number
  quantity?: number
  executionPrice?: number
  PRU?: number
  compartimentPER?: number
  customDetails?: Record<string, unknown>
  label?: string
  currency?: string
  synthetic?: boolean
}

export class Operation {
  id: string
  fingerprint: string
  dateTime: number
  date: string
  amount: number
  fees: number
  taxes: number
  buyPositions: Position[]
  sellPositions: Position[]
  type: number
  supportUniqueID: number
  quantity: number
  executionPrice: number
  PRU: number
  compartimentPER: number
  customDetails: Record<string, unknown>
  label: string
  currency: string
  synthetic: boolean

  constructor(data: OperationData = {}) {
    this.id = data.id || ''
    this.fingerprint = data.fingerprint || ''
    this.dateTime = data.dateTime || 0
    this.date = data.date || ''
    this.amount = data.amount || 0
    this.fees = data.fees || 0
    this.taxes = data.taxes || 0
    this.buyPositions = (data.buyPositions || []).map((p) => new Position(p))
    this.sellPositions = (data.sellPositions || []).map((p) => new Position(p))
    this.type = data.type !== undefined ? data.type : OperationType.END
    this.supportUniqueID = data.supportUniqueID || 0
    this.quantity = data.quantity || 0
    this.executionPrice = data.executionPrice || 0
    this.PRU = Math.abs(data.PRU || 0)
    this.compartimentPER = data.compartimentPER || 0
    this.customDetails = data.customDetails || {}
    this.label = data.label || ''
    this.currency = data.currency || 'EUR'
    this.synthetic = Boolean(data.synthetic)
  }

  calculatePRU(): number {
    if (this.quantity <= 0) return 0
    return (
      (this.quantity * this.executionPrice + this.fees + this.taxes) /
      this.quantity
    )
  }

  toJSON(): OperationData {
    return {
      id: this.id,
      fingerprint: this.fingerprint,
      dateTime: this.dateTime,
      date: this.date,
      amount: this.amount,
      fees: this.fees,
      taxes: this.taxes,
      buyPositions: this.buyPositions.map((p) => p.toJSON()),
      sellPositions: this.sellPositions.map((p) => p.toJSON()),
      type: this.type,
      supportUniqueID: this.supportUniqueID,
      quantity: this.quantity,
      executionPrice: this.executionPrice,
      PRU: this.PRU,
      compartimentPER: this.compartimentPER,
      customDetails: this.customDetails,
      label: this.label,
      currency: this.currency,
      synthetic: this.synthetic,
    }
  }
}

export interface EnvelopeData {
  envelopeType?: number
  niceUniqueName?: string
  operations?: OperationData[]
  customState?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export class Envelope {
  envelopeType: number
  niceUniqueName: string
  operations: Operation[]
  customState: Record<string, unknown>
  createdAt: string
  updatedAt: string

  constructor(data: EnvelopeData = {}) {
    this.envelopeType = data.envelopeType ?? EnvelopeKind.PEA
    this.niceUniqueName = data.niceUniqueName || ''
    this.operations = (data.operations || []).map((o) => new Operation(o))
    this.customState = data.customState || {}
    this.createdAt = data.createdAt || new Date().toISOString()
    this.updatedAt = data.updatedAt || this.createdAt
  }

  kindName(): EnvelopeKindName {
    return envelopeKindToName(this.envelopeType)
  }

  toJSON(): EnvelopeData {
    return {
      envelopeType: this.envelopeType,
      niceUniqueName: this.niceUniqueName,
      operations: this.operations.map((o) => o.toJSON()),
      customState: this.customState,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
  }
}

export interface SupportData {
  uniqueID?: number
  niceUniqueName?: string
  searchName?: string
  assetType?: number
  customFilterEntries?: Array<[number, string]>
  getterType?: number
  staticDatedValues?: Array<[number, number]>
  ISIN?: string
  yahooFinanceTicker?: string
  googleFinanceTicker?: string
  boursoramaTicker?: string
  scrapeURL?: string
  scrapeFullXPath?: string
  customStaticInformation?: string
  lastKnownValue?: [number, number]
  /** Local synthetic key when Fortuneo had no ISIN */
  localKey?: string
}

export class Support {
  uniqueID: number
  niceUniqueName: string
  searchName: string
  assetType: number
  customFilterEntries: Array<[number, string]>
  getterType: number
  staticDatedValues: Array<[number, number]>
  ISIN: string
  yahooFinanceTicker: string
  googleFinanceTicker: string
  boursoramaTicker: string
  scrapeURL: string
  scrapeFullXPath: string
  customStaticInformation: string
  lastKnownValue: [number, number]
  localKey: string

  constructor(data: SupportData = {}) {
    this.uniqueID = data.uniqueID || 0
    this.niceUniqueName = data.niceUniqueName || ''
    this.searchName = data.searchName || ''
    this.assetType =
      data.assetType !== undefined ? data.assetType : AssetType.ESPECES
    this.customFilterEntries = data.customFilterEntries || []
    this.getterType =
      data.getterType !== undefined ? data.getterType : GetterType.END
    this.staticDatedValues = data.staticDatedValues || []
    this.ISIN = data.ISIN || ''
    this.yahooFinanceTicker = data.yahooFinanceTicker || ''
    this.googleFinanceTicker = data.googleFinanceTicker || ''
    this.boursoramaTicker = data.boursoramaTicker || ''
    this.scrapeURL = data.scrapeURL || ''
    this.scrapeFullXPath = data.scrapeFullXPath || ''
    this.customStaticInformation = data.customStaticInformation || ''
    this.lastKnownValue = data.lastKnownValue || [0, 0]
    this.localKey = data.localKey || ''
  }

  /** Primary display / join key: real ISIN, else LOCAL:…, else id */
  supportKey(): string {
    if (this.ISIN) return this.ISIN.toUpperCase()
    if (this.localKey) return this.localKey
    return `ID:${this.uniqueID}`
  }

  toJSON(): SupportData {
    return {
      uniqueID: this.uniqueID,
      niceUniqueName: this.niceUniqueName,
      searchName: this.searchName,
      assetType: this.assetType,
      customFilterEntries: this.customFilterEntries,
      getterType: this.getterType,
      staticDatedValues: this.staticDatedValues,
      ISIN: this.ISIN,
      yahooFinanceTicker: this.yahooFinanceTicker,
      googleFinanceTicker: this.googleFinanceTicker,
      boursoramaTicker: this.boursoramaTicker,
      scrapeURL: this.scrapeURL,
      scrapeFullXPath: this.scrapeFullXPath,
      customStaticInformation: this.customStaticInformation,
      lastKnownValue: this.lastKnownValue,
      localKey: this.localKey,
    }
  }
}

export interface CustomFilterData {
  uniqueID?: number
  filterName?: string
  possibleValues?: string[]
}

export class CustomFilter {
  uniqueID: number
  filterName: string
  possibleValues: string[]

  constructor(data: CustomFilterData = {}) {
    this.uniqueID = data.uniqueID || 0
    this.filterName = data.filterName || ''
    this.possibleValues = data.possibleValues || []
  }

  toJSON(): CustomFilterData {
    return {
      uniqueID: this.uniqueID,
      filterName: this.filterName,
      possibleValues: this.possibleValues,
    }
  }
}

export interface PortfolioData {
  envelopes?: EnvelopeData[]
  supports?: SupportData[]
  customFilters?: CustomFilterData[]
  currentSupportID?: number
  currentCustomFiltersID?: number
}

export class Portfolio {
  envelopes: Envelope[]
  supports: Record<number, Support>
  customFilters: Record<number, CustomFilter>
  currentSupportID: number
  currentCustomFiltersID: number

  constructor(data: PortfolioData = {}) {
    this.envelopes = (data.envelopes || []).map((e) => new Envelope(e))
    this.supports = {}
    if (Array.isArray(data.supports)) {
      for (const s of data.supports) {
        const sup = new Support(s)
        if (sup.uniqueID) this.supports[sup.uniqueID] = sup
      }
    }
    this.customFilters = {}
    if (Array.isArray(data.customFilters)) {
      for (const f of data.customFilters) {
        const filter = new CustomFilter(f)
        if (filter.uniqueID) this.customFilters[filter.uniqueID] = filter
      }
    }
    this.currentSupportID = data.currentSupportID || 1
    this.currentCustomFiltersID = data.currentCustomFiltersID || 1
  }

  static fromJSON(data: PortfolioData): Portfolio {
    return new Portfolio(data)
  }

  toJSON(): PortfolioData {
    return {
      envelopes: this.envelopes.map((e) => e.toJSON()),
      supports: Object.values(this.supports).map((s) => s.toJSON()),
      customFilters: Object.values(this.customFilters).map((f) => f.toJSON()),
      currentSupportID: this.currentSupportID,
      currentCustomFiltersID: this.currentCustomFiltersID,
    }
  }

  nextSupportId(): number {
    const id = this.currentSupportID
    this.currentSupportID = id + 1
    return id
  }

  nextFilterId(): number {
    const id = this.currentCustomFiltersID
    this.currentCustomFiltersID = id + 1
    return id
  }

  getSupport(id: number): Support | undefined {
    return this.supports[id]
  }

  findSupportByIsin(isin: string): Support | undefined {
    const key = isin.toUpperCase()
    return Object.values(this.supports).find(
      (s) => s.ISIN.toUpperCase() === key,
    )
  }

  findSupportByLocalKey(localKey: string): Support | undefined {
    return Object.values(this.supports).find((s) => s.localKey === localKey)
  }

  findSupportByKey(key: string): Support | undefined {
    if (key.startsWith('LOCAL:')) return this.findSupportByLocalKey(key)
    if (key.startsWith('ID:')) {
      const id = Number(key.slice(3))
      return this.supports[id]
    }
    return this.findSupportByIsin(key)
  }

  findSupportByName(name: string): Support | undefined {
    const n = name.trim().toLowerCase()
    return Object.values(this.supports).find(
      (s) =>
        s.niceUniqueName.toLowerCase() === n ||
        s.searchName.toLowerCase() === n,
    )
  }

  upsertSupport(partial: SupportData & { niceUniqueName: string }): Support {
    if (partial.ISIN) {
      const byIsin = this.findSupportByIsin(partial.ISIN)
      if (byIsin) {
        Object.assign(byIsin, {
          ...partial,
          uniqueID: byIsin.uniqueID,
          ISIN: partial.ISIN.toUpperCase(),
        })
        return byIsin
      }
    }
    if (partial.localKey) {
      const byLocal = this.findSupportByLocalKey(partial.localKey)
      if (byLocal) {
        Object.assign(byLocal, { ...partial, uniqueID: byLocal.uniqueID })
        return byLocal
      }
    }
    const id = this.nextSupportId()
    const s = new Support({
      assetType: AssetType.ACTIONS,
      getterType: GetterType.END,
      ...partial,
      uniqueID: id,
      ISIN: partial.ISIN ? partial.ISIN.toUpperCase() : '',
    })
    this.supports[id] = s
    return s
  }

  getOrCreateEnvelope(kind: EnvelopeKindName): Envelope {
    const type = envelopeKindFromName(kind)
    let env = this.envelopes.find((e) => e.envelopeType === type)
    if (!env) {
      const labels: Record<EnvelopeKindName, string> = {
        PEA: 'PEA',
        PEA_PME: 'PEA-PME',
        CTO: 'CTO',
      }
      env = new Envelope({
        envelopeType: type,
        niceUniqueName: labels[kind],
      })
      this.envelopes.push(env)
    }
    return env
  }

  envelopeByKind(kind: EnvelopeKindName): Envelope | undefined {
    const type = envelopeKindFromName(kind)
    return this.envelopes.find((e) => e.envelopeType === type)
  }
}
