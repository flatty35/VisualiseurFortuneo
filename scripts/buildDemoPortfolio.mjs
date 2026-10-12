/**
 * Builds a fictional PEA demo portfolio (XLS positions + CSV history)
 * for showcasing the app without personal data.
 *
 *   node scripts/buildDemoPortfolio.mjs
 *
 * Output: demoData/PEA/
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import XLSX from 'xlsx'

const ACCOUNT = '099887766554'
const HOLDER = 'PEA DEMO VISUALISEUR'
const AS_OF = '11/10/2026'
const OUT = 'demoData/PEA'

/** @typedef {{ name: string, isin: string, place: string, mnemo?: string }} Asset */

const A = {
  AI: { name: 'AIR LIQUIDE', isin: 'FR0000120073', place: 'Euronext Paris', mnemo: 'AI' },
  SAN: { name: 'SANOFI', isin: 'FR0000120578', place: 'Euronext Paris', mnemo: 'SAN' },
  DG: { name: 'VINCI', isin: 'FR0000125486', place: 'Euronext Paris', mnemo: 'DG' },
  ABCA: { name: 'ABC ARBITRAGE', isin: 'FR0004040608', place: 'Euronext Paris', mnemo: 'ABCA' },
  SAF: { name: 'SAFRAN', isin: 'FR0000073272', place: 'Euronext Paris', mnemo: 'SAF' },
  FGR: { name: 'EIFFAGE', isin: 'FR0000130452', place: 'Euronext Paris', mnemo: 'FGR' },
  WAVE: { name: 'WAVESTONE', isin: 'FR0013357621', place: 'Euronext Paris', mnemo: 'WAVE' },
  DCAM: {
    name: 'AMUNDI PEA MONDE (MSCI World) UCITS ETF - Acc EUR ACC',
    isin: 'FR001400U5Q4',
    place: 'Euronext Paris',
    mnemo: 'DCAM',
  },
  // Closed #1 — held at opening of the 2y window
  RNO: { name: 'RENAULT', isin: 'FR0000131906', place: 'Euronext Paris', mnemo: 'RNO' },
  // Closed #2 — opened in year 1
  CA: { name: 'CARREFOUR', isin: 'FR0000120172', place: 'Euronext Paris', mnemo: 'CA' },
  // Closed #3 — opened in year 2
  EDEN: { name: 'EDENRED', isin: 'FR0010908533', place: 'Euronext Paris', mnemo: 'EDEN' },
}

const fmt = (n, d = 2) =>
  Number(n).toLocaleString('en-US', {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: d,
  })

function buy(a, date, qty, price, fee = 0) {
  const gross = -(qty * price)
  const net = gross - Math.abs(fee)
  return {
    name: a.name,
    op: 'Achat Comptant',
    place: a.place,
    date,
    qty,
    price,
    gross,
    fee: -Math.abs(fee),
    net,
    currency: 'EUR',
    isin: a.isin,
    kind: 'buy',
  }
}

function sell(a, date, qty, price, fee = 0) {
  const gross = qty * price
  const net = gross - Math.abs(fee)
  return {
    name: a.name,
    op: 'Vente comptant',
    place: a.place,
    date,
    qty,
    price,
    gross,
    fee: -Math.abs(fee),
    net,
    currency: 'EUR',
    isin: a.isin,
    kind: 'sell',
  }
}

function ttf(a, date, qty, amount) {
  return {
    name: a.name,
    op: 'TAXE TRANSAC FINAN',
    place: a.place,
    date,
    qty,
    price: 0,
    gross: -Math.abs(amount),
    fee: 0,
    net: -Math.abs(amount),
    currency: 'EUR',
    isin: a.isin,
    kind: 'tax',
  }
}

function dividend(a, date, qty, amount) {
  return {
    name: a.name,
    op: 'Encaissement coupons intérêt/dividende',
    place: a.place,
    date,
    qty,
    price: 0,
    gross: amount,
    fee: 0,
    net: amount,
    currency: 'EUR',
    isin: a.isin,
    kind: 'div',
  }
}

function detach(a, date, qty, amount) {
  return {
    name: a.name,
    op: 'OST de création de coupons - Détachement coupon optionnel',
    place: a.place,
    date,
    qty,
    price: 0,
    gross: amount,
    fee: 0,
    net: amount,
    currency: 'EUR',
    isin: a.isin,
    kind: 'detach',
  }
}

/**
 * Narrative (newest → oldest in the file, like Fortuneo):
 *
 * Opening (≈ 11/10/2024): AI 8, SAN 12, DG 6, ABCA 150, RNO 25
 * Year 1: buy CA (closed later), buy SAF, buy FGR; sell RNO (closed #1)
 * Year 2: buy EDEN (closed later), buy WAVE, buy DCAM; sell CA, sell EDEN
 * Still open at as-of: AI, SAN, DG, ABCA, SAF, FGR, WAVE, DCAM
 */
const ops = [
  // --- late 2026 activity ---
  buy(A.WAVE, '09/10/2026', 8, 29.85, 0.84),
  ttf(A.WAVE, '09/10/2026', 8, 0.72),
  buy(A.AI, '02/10/2026', 2, 168.4, 1.18),
  ttf(A.AI, '02/10/2026', 2, 1.01),
  sell(A.EDEN, '18/09/2026', 28, 33.6, 3.3), // closed #3 fully
  buy(A.DCAM, '15/09/2026', 40, 6.12, 0.86),
  buy(A.FGR, '28/08/2026', 4, 97.8, 1.37),
  ttf(A.FGR, '28/08/2026', 4, 1.17),
  dividend(A.ABCA, '09/07/2026', 150, 6),
  detach(A.ABCA, '07/07/2026', 150, 6),
  dividend(A.SAF, '28/05/2026', 5, 14.5),
  detach(A.SAF, '26/05/2026', 5, 14.5),
  dividend(A.AI, '20/05/2026', 10, 32),
  detach(A.AI, '18/05/2026', 10, 32),
  buy(A.EDEN, '12/03/2026', 28, 28.4, 2.79), // closed #3 open (year 2)
  ttf(A.EDEN, '12/03/2026', 28, 2.39),
  buy(A.WAVE, '18/02/2026', 22, 27.1, 2.09),
  ttf(A.WAVE, '18/02/2026', 22, 1.79),
  buy(A.SAF, '22/01/2026', 2, 248.5, 1.74),
  ttf(A.SAF, '22/01/2026', 2, 1.49),

  // --- year 1 / late 2025 ---
  sell(A.CA, '14/11/2025', 45, 14.35, 2.26), // closed #2 fully
  dividend(A.DG, '24/10/2025', 6, 19.8),
  detach(A.DG, '22/10/2025', 6, 19.8),
  buy(A.DCAM, '03/10/2025', 55, 5.68, 1.09),
  sell(A.RNO, '24/09/2025', 25, 34.1, 2.98), // closed #1 (existed at opening)
  buy(A.FGR, '18/06/2025', 8, 92.4, 2.59),
  ttf(A.FGR, '18/06/2025', 8, 2.22),
  dividend(A.SAN, '14/05/2025', 12, 46.8),
  detach(A.SAN, '12/05/2025', 12, 46.8),
  buy(A.CA, '12/03/2025', 45, 12.85, 2.02), // closed #2 open (year 1)
  ttf(A.CA, '12/03/2025', 45, 1.74),
  buy(A.SAF, '20/01/2025', 3, 215.2, 2.26),
  ttf(A.SAF, '20/01/2025', 3, 1.94),
  buy(A.AI, '05/12/2024', 2, 158.9, 1.11),
  ttf(A.AI, '05/12/2024', 2, 0.95),
  dividend(A.ABCA, '16/04/2025', 150, 15),
  detach(A.ABCA, '14/04/2025', 150, 15),
  dividend(A.DG, '17/10/2024', 6, 6.3),
  detach(A.DG, '15/10/2024', 6, 6.3),
]

// Chronological forward replay to get final qty + PRU
function replay(list) {
  const chrono = [...list].sort((a, b) => {
    const da = a.date.split('/').reverse().join('-')
    const db = b.date.split('/').reverse().join('-')
    return da.localeCompare(db) || a.kind.localeCompare(b.kind)
  })
  /** @type {Map<string, { qty: number, cost: number, name: string, isin: string }>} */
  const book = new Map()
  const ensure = (isin, name) => {
    if (!book.has(isin)) book.set(isin, { qty: 0, cost: 0, name, isin })
    return book.get(isin)
  }

  // Opening held before first history day (11/10/2024)
  const opening = [
    { a: A.AI, qty: 8, pru: 152 },
    { a: A.SAN, qty: 12, pru: 88 },
    { a: A.DG, qty: 6, pru: 105 },
    { a: A.ABCA, qty: 150, pru: 5.1 },
    { a: A.RNO, qty: 25, pru: 38.5 }, // closed #1 — exists at start
  ]
  for (const o of opening) {
    const b = ensure(o.a.isin, o.a.name)
    b.qty = o.qty
    b.cost = o.qty * o.pru
  }

  for (const op of chrono) {
    const b = ensure(op.isin, op.name)
    if (op.kind === 'buy') {
      b.qty += op.qty
      b.cost += Math.abs(op.net) // courtage in cost
    } else if (op.kind === 'tax') {
      b.cost += Math.abs(op.net)
    } else if (op.kind === 'sell') {
      if (b.qty > 1e-9) {
        const frac = Math.min(1, op.qty / b.qty)
        b.cost *= 1 - frac
        b.qty -= op.qty
        if (b.qty < 1e-9) {
          b.qty = 0
          b.cost = 0
        }
      }
    }
  }
  return { book, opening }
}

const { book, opening } = replay(ops)

/** Last known demos prices (as-of) — fictional but in the ballpark */
const LAST = {
  [A.AI.isin]: 171.2,
  [A.SAN.isin]: 84.6,
  [A.DG.isin]: 118.5,
  [A.ABCA.isin]: 5.72,
  [A.SAF.isin]: 268.4,
  [A.FGR.isin]: 99.4,
  [A.WAVE.isin]: 29.85,
  [A.DCAM.isin]: 6.18,
}

function csvEscape(s) {
  return String(s)
}

function toCsvRow(op) {
  return [
    csvEscape(op.name),
    csvEscape(op.op.padEnd(op.op === 'Vente comptant' ? 66 : 0)),
    op.place,
    op.date,
    fmt(op.qty, 1),
    fmt(op.price, 4),
    fmt(op.gross, 2),
    fmt(op.fee, 2),
    fmt(op.net, 2),
    op.currency,
    '',
  ].join(';')
}

// Fortuneo history is newest-first
const byNewest = [...ops].sort((a, b) => {
  const da = a.date.split('/').reverse().join('-')
  const db = b.date.split('/').reverse().join('-')
  return db.localeCompare(da)
})

const csvHeader =
  "libellé;Opération;Place;Date;Qté;Prix d'éxé;Montant brut;Courtage/Prélèvement;Montant net;Devise;"
const csvBody = [csvHeader, ...byNewest.map(toCsvRow)].join('\r\n') + '\r\n'

mkdirSync(OUT, { recursive: true })
const csvName = `HistoriqueOperationsBourse_${ACCOUNT}_du_11_10_2024_au_11_10_2026.csv`
writeFileSync(join(OUT, csvName), Buffer.from(csvBody, 'latin1'))

// Open positions for XLS (qty > 0), sorted by name
const openRows = [...book.values()]
  .filter((b) => b.qty > 1e-8)
  .sort((a, b) => a.name.localeCompare(b.name, 'fr'))

const xlsRows = [
  [`Portefeuille ${ACCOUNT}`, '', '', '', '', '', '', '', '', '', '', ''],
  [`(${HOLDER})`, '', '', '', '', '', '', '', '', '', '', ''],
  [AS_OF, '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', ''],
  [
    'Libellé',
    'Cours',
    '',
    'Dev',
    'Var/Veille',
    'Qté',
    'PRU',
    'Valorisation',
    '+/- values',
    '+/- values (%)',
    'Poids',
    'ISIN',
  ],
]

let totalValo = 0
const valued = openRows.map((b) => {
  const cours = LAST[b.isin] ?? b.cost / b.qty
  const pru = b.cost / b.qty
  const valo = b.qty * cours
  const pmv = valo - b.cost
  const pmvPct = b.cost > 0 ? pmv / b.cost : 0
  totalValo += valo
  const asset = Object.values(A).find((x) => x.isin === b.isin)
  const label = asset?.mnemo ? `${b.name} (${asset.mnemo})` : b.name
  return { b, cours, pru, valo, pmv, pmvPct, label }
})

for (const v of valued) {
  const weight = totalValo > 0 ? v.valo / totalValo : 0
  xlsRows.push([
    v.label,
    v.cours,
    'V',
    'EUR',
    0.001,
    v.b.qty,
    Math.round(v.pru * 10000) / 10000,
    Math.round(v.valo * 100) / 100,
    Math.round(v.pmv * 100) / 100,
    Math.round(v.pmvPct * 10000) / 10000,
    Math.round(weight * 1000000) / 1000000,
    v.b.isin,
  ])
  xlsRows.push([
    'Solde position CPT',
    '-',
    '-',
    '',
    '',
    v.b.qty,
    Math.round(v.pru * 10000) / 10000,
    Math.round(v.valo * 100) / 100,
    Math.round(v.pmv * 100) / 100,
    Math.round(v.pmvPct * 1000000) / 1000000,
    Math.round(weight * 1000000) / 1000000,
    v.b.isin,
  ])
}

const wb = XLSX.utils.book_new()
const ws = XLSX.utils.aoa_to_sheet(xlsRows)
XLSX.utils.book_append_sheet(wb, ws, 'Sheet0')
const xlsName = `Export_portefeuille_detaille_${ACCOUNT}.xls`
XLSX.writeFile(wb, join(OUT, xlsName), { bookType: 'xls' })

// Sanity report
const closed = [...book.values()].filter((b) => b.qty < 1e-8)
console.log('Wrote', join(OUT, csvName))
console.log('Wrote', join(OUT, xlsName))
console.log('\nOpen positions:')
for (const v of valued) {
  console.log(
    `  ${v.b.qty.toFixed(0).padStart(4)} × ${v.label.padEnd(40)} PRU ${v.pru.toFixed(2)} → ${v.valo.toFixed(0)} €`,
  )
}
console.log('\nClosed (qty 0):', closed.map((b) => b.name).join(', ') || '(none)')
console.log('Opening seeds:', opening.map((o) => `${o.a.name}×${o.qty}`).join(', '))
console.log('Total valo:', totalValo.toFixed(2), '€')
console.log('Ops:', ops.length)
