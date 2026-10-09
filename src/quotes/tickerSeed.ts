/**
 * Local seed label → Yahoo ticker (Euronext .PA preferred).
 * Used before any network lookup. Names normalized at lookup time.
 */
export const TICKER_SEED: Record<string, string> = {
  safran: 'SAF.PA',
  valneva: 'VLA.PA',
  'veolia environ': 'VIE.PA',
  'veolia environ.': 'VIE.PA',
  'indosuez allocation pea': '0P00005WBC.F',
  carrefour: 'CA.PA',
  'bnp paribas easy stoxx europe 600 ucits etf c acc': 'ETZ.PA',
  'bnp paribas easy stoxx europe 600 ucits etf - c acc': 'ETZ.PA',
  'amundi pea sp 500 ucits etf acc': 'PSP5.PA',
  wavestone: 'WAVE.PA',
  renault: 'RNO.PA',
  'ishares msci world swap pea ucits etf eur acc': 'WPEA.PA',
  'ishares msci world swap pea ucits etf - eur acc': 'WPEA.PA',
  vinci: 'DG.PA',
  'amundi pea monde msci world ucits etf acc eur acc': 'DCAM.PA',
  'amundi pea monde (msci world) ucits etf - acc eur acc': 'DCAM.PA',
  edenred: 'EDEN.PA',
  'ishares divers commodity swap ucits etf': 'CMSE.PA',
  idi: 'IDIP.PA',
  'independance am europe small i c': '0P0001DKPN.F',
  'indépendance am europe small i (c)': '0P0001DKPN.F',
  'perrier gerard': 'PERR.PA',
  'perrier (gerard)': 'PERR.PA',
  'gay lussac microcaps a': '0P0000A94X.F',
  'abionyx pharma': 'ABNX.PA',
  iberdrola: 'IBE.MC',
  'amundi stoxx europe 600 banks ucits etf acc eur acc': 'BNK.PA',
  'amundi pea euro court terme ucits etf acc': 'OBLI.PA',
  'amundi pea japon topix ucits etf eur dis': 'PTPXE.PA',
  'asml holding': 'ASML.AS',
  asml: 'ASML.AS',
  'air liquide': 'AI.PA',
  'amundi pea msci emerging markets esg leaders ucits etf eur dis': 'PAEEM.PA',
  osmosun: 'ALWTR.PA',
  'explosifs prod chi': 'EXPL.PA',
  'explosifs prod.chi': 'EXPL.PA',
  'viel et compagnie': 'VIL.PA',
  'omer decugis cie': 'ALODC.PA',
  'omer-decugis & cie': 'ALODC.PA',
  '2crsi': 'AL2SI.PA',
  totalenergies: 'TTE.PA',
  'totalenergies se': 'TTE.PA',
  'lvmh moet hennessy': 'MC.PA',
  lvmh: 'MC.PA',
  sanofi: 'SAN.PA',
  'bnp paribas': 'BNP.PA',
  schneider: 'SU.PA',
  'schneider electric': 'SU.PA',
  axa: 'CS.PA',
  orange: 'ORA.PA',
  danone: 'BN.PA',
  thales: 'HO.PA',
  capgemini: 'CAP.PA',
  stmicroelectronics: 'STMPA.PA',
  'credit agricole': 'ACA.PA',
  'societe generale': 'GLE.PA',
  engie: 'ENGI.PA',
  bouygues: 'EN.PA',
  publicis: 'PUB.PA',
  hermes: 'RMS.PA',
  'hermes international': 'RMS.PA',
  kerling: 'KER.PA',
  kering: 'KER.PA',
  essilorluxottica: 'EL.PA',
  legrand: 'LR.PA',
  worldline: 'WLN.PA',
  'unibail rodamco': 'URW.PA',
  dassault: 'AM.PA',
  'dassault aviation': 'AM.PA',
  'dassault systemes': 'DSY.PA',
  'dassault systemes se': 'DSY.PA',
  airbus: 'AIR.PA',
  'airbus se': 'AIR.PA',
  michelin: 'ML.PA',
  'cie de saint gobain': 'SGO.PA',
  'saint gobain': 'SGO.PA',
  'pernod ricard': 'RI.PA',
  teleperformance: 'TEP.PA',
  'teleperformance se': 'TEP.PA',
  'accs': 'AC.PA',
  accor: 'AC.PA',
  'bureau veritas': 'BVI.PA',
  'getlink': 'GET.PA',
  'eurofins scientific': 'ERF.PA',
  'arkema': 'AKE.PA',
  'alstom': 'ALO.PA',
  'bio merieux': 'BIM.PA',
  biomerieux: 'BIM.PA',
  'sodexo': 'SW.PA',
  'ubisoft': 'UBI.PA',
  'ubisoft entertainment': 'UBI.PA',
  'vallourec': 'VK.PA',
  'faurecia': 'FRVIA.PA',
  forvia: 'FRVIA.PA',
  'stellantis': 'STLAP.PA',
  'stellantis nv': 'STLAP.PA',
  'ferrari': 'RACE.MI',
  'cnh industrial': '1CNHI.MI',
}

export function normalizeMatchKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function lookupSeedTicker(name: string): string | undefined {
  const key = normalizeMatchKey(name)
  if (TICKER_SEED[key]) return TICKER_SEED[key]
  // fuzzy contains
  for (const [k, t] of Object.entries(TICKER_SEED)) {
    if (key.includes(k) || k.includes(key)) return t
  }
  return undefined
}
