// Live check of the Morningstar history path on testData positions:
//   node scripts/benchMorningstarHistory.mjs
// Same calls as the browser: one screener `ISIN:IN:` filter for all ISINs,
// then one EUR time series per title (concurrency 6).
import { readdirSync, readFileSync } from 'node:fs'
import XLSX from 'xlsx'

const SCREENER =
  'https://lt.morningstar.com/api/rest.svc/klr5zyak8x/security/screener'
const SERIES =
  'https://lt.morningstar.com/api/rest.svc/timeseries_price/klr5zyak8x'
const HOME = { FR: 'XPAR', NL: 'XAMS', BE: 'XBRU', DE: 'XETR', IT: 'XMIL', ES: 'XMAD', GB: 'XLON', US: 'XNAS' }
const REGULATED = new Set(['XPAR', 'XAMS', 'XBRU', 'XLIS', 'XETR', 'XFRA', 'XMIL', 'XMAD', 'XLON', 'XSWX', 'XWBO', 'XNAS', 'XNYS'])

function positions(file) {
  const wb = XLSX.read(readFileSync(file))
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
  return rows
    .map((r) => ({ name: String(r[0]), price: Number(r[1]), isin: String(r[r.length - 1]) }))
    .filter((p) => /^[A-Z]{2}[A-Z0-9]{10}$/.test(p.isin) && !/^solde position/i.test(p.name))
}

const byIsin = new Map()
for (const env of readdirSync('testData')) {
  const xls = readdirSync(`testData/${env}`).find((f) => f.endsWith('.xls'))
  if (xls) for (const p of positions(`testData/${env}/${xls}`)) byIsin.set(p.isin, p)
}
const all = [...byIsin.values()]

const t0 = Date.now()
const q = new URLSearchParams({
  page: '1', pageSize: '500', outputType: 'json', version: '1', languageId: 'fr-FR',
  securityDataPoints: 'SecId|ISIN|Ticker|ExchangeId|Name',
  filters: `ISIN:IN:${all.map((p) => p.isin).join(':')}`,
})
const rows = (await (await fetch(`${SCREENER}?${q}`)).json()).rows ?? []
const tScreener = Date.now() - t0
const mic = (r) => String(r.ExchangeId || '').replace(/^EX\$+/, '')
const score = (r, isin) => {
  const m = mic(r)
  if (!m) return 60
  if (HOME[isin.slice(0, 2)] === m) return 50
  if (m === 'XPAR') return 40
  return REGULATED.has(m) ? 20 : 0
}
const start = new Date(Date.now() - 730 * 86400e3).toISOString().slice(0, 10)

let next = 0
const out = []
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < all.length) {
      const p = all[next++]
      const pick = rows
        .filter((r) => r.ISIN === p.isin && r.SecId)
        .sort((a, b) => score(b, p.isin) - score(a, p.isin))[0]
      if (!pick) {
        out.push({ p })
        continue
      }
      const s = new URLSearchParams({
        id: pick.SecId, idtype: 'Morningstar', currencyId: 'EUR', frequency: 'daily',
        startDate: start, outputType: 'COMPACTJSON',
      })
      const data = await (await fetch(`${SERIES}?${s}`)).json()
      const bars = (Array.isArray(data) ? data : []).filter((r) => Array.isArray(r) && r.length === 2)
      out.push({ p, pick, bars })
    }
  }),
)
const ms = Date.now() - t0

let ok = 0
for (const { p, pick, bars } of out.sort((a, b) => a.p.name.localeCompare(b.p.name))) {
  if (!bars?.length) {
    console.log(`MISS ${p.isin} ${p.name}`)
    continue
  }
  ok++
  const last = bars[bars.length - 1]
  const gap = p.price > 0 ? ((last[1] / p.price - 1) * 100).toFixed(2) : '?'
  console.log(
    `ok   ${p.isin} ${pick.SecId} ${mic(pick).padEnd(4)} ${String(bars.length).padStart(3)} bars, last ${new Date(last[0]).toISOString().slice(0, 10)} ${last[1]} vs xls ${p.price} (${gap}%)  ${p.name}`,
  )
}
console.log(`\n${ok}/${all.length} ISINs with history in ${ms} ms (screener ${tScreener} ms)`)
