#!/usr/bin/env node
/**
 * Fortuneo Accès Marchés — recherche ISIN / mnémo (ticker Fortuneo)
 *
 * Endpoint public (pas de login) :
 *   GET https://bourse.fortuneo.fr/api/search?term=<libellé|mnemo|ISIN>
 *
 * Usage :
 *   node scripts/fortuneoIsinScraper.mjs SAFRAN
 *   node scripts/fortuneoIsinScraper.mjs "AIR LIQUIDE" VINCI
 *   node scripts/fortuneoIsinScraper.mjs --json SAFRAN
 *   node scripts/fortuneoIsinScraper.mjs --csv labels.txt
 *   echo SAFRAN | node scripts/fortuneoIsinScraper.mjs --stdin
 *
 * --csv FILE : une requête par ligne (libellé). Sortie CSV :
 *   query;isin;mnemo;yahooGuess;libelle;place;type;cours;devise
 */

const API = 'https://bourse.fortuneo.fr/api/search'
const UA =
  'Mozilla/5.0 (compatible; VisualiseurFortuneo/0.1; +local-script)'

/** Euronext Paris → suffixe Yahoo Finance courant */
const PLACE_TO_YAHOO = new Map([
  ['Euronext Paris', '.PA'],
  ['Euronext Amsterdam', '.AS'],
  ['Euronext Brussels', '.BR'],
  ['Euronext Lisbon', '.LS'],
  ['Xetra', '.DE'],
  ['London Stock Exchange', '.L'],
  ['NYSE', ''],
  ['NASDAQ', ''],
])

/**
 * @typedef {{
 *   codeIsin?: string
 *   mnemo?: string
 *   libelle?: string
 *   type?: string
 *   place?: string
 *   codePlace?: number
 *   cours?: number | null
 *   devise?: string | null
 *   variation?: number | null
 *   codeRef?: string
 * }} FortuneoHit
 */

/**
 * @param {string} term
 * @returns {Promise<FortuneoHit[]>}
 */
export async function searchFortuneo(term) {
  const q = term.trim()
  if (!q) return []
  const url = `${API}?term=${encodeURIComponent(q)}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': UA,
      Referer: 'https://bourse.fortuneo.fr/',
    },
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
  const data = await res.json()
  const items = data?.market?.fortuneo?.items
  if (!Array.isArray(items)) return []
  return dedupeHits(items)
}

/** @param {FortuneoHit[]} items */
function dedupeHits(items) {
  const seen = new Set()
  const out = []
  for (const it of items) {
    const key = `${it.codeIsin || ''}|${it.mnemo || ''}|${it.place || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

/**
 * Guess Yahoo Finance ticker from Fortuneo mnemo + place.
 * @param {FortuneoHit} hit
 */
export function guessYahooTicker(hit) {
  const mnemo = (hit.mnemo || '').trim()
  if (!mnemo) return ''
  const place = hit.place || ''
  if (PLACE_TO_YAHOO.has(place)) {
    return `${mnemo}${PLACE_TO_YAHOO.get(place)}`
  }
  // codePlace 23 = Euronext Paris (empirique)
  if (hit.codePlace === 23) return `${mnemo}.PA`
  return mnemo
}

/**
 * @param {string} query
 * @param {FortuneoHit[]} hits
 */
function formatTable(query, hits) {
  if (!hits.length) {
    return [`[${query}] aucun résultat`]
  }
  const lines = [`[${query}] ${hits.length} résultat(s)`]
  for (const h of hits) {
    const yahoo = guessYahooTicker(h)
    const px =
      h.cours != null && Number.isFinite(h.cours)
        ? ` | ${h.cours} ${h.devise || ''}`.trimEnd()
        : ''
    lines.push(
      `  ${h.codeIsin || '—'}  ${h.mnemo || '—'}  → Yahoo? ${yahoo || '—'}  | ${h.libelle || ''} | ${h.place || ''} | ${h.type || ''}${px}`,
    )
  }
  return lines
}

function csvEscape(s) {
  const t = String(s ?? '')
  if (/[;"\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`
  return t
}

/**
 * @param {string} query
 * @param {FortuneoHit[]} hits
 */
function formatCsvRows(query, hits) {
  if (!hits.length) {
    return [ [query, '', '', '', '', '', '', '', ''].map(csvEscape).join(';') ]
  }
  return hits.map((h) =>
    [
      query,
      h.codeIsin || '',
      h.mnemo || '',
      guessYahooTicker(h),
      h.libelle || '',
      h.place || '',
      h.type || '',
      h.cours ?? '',
      h.devise || '',
    ]
      .map(csvEscape)
      .join(';'),
  )
}

async function readStdinLines() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks)
    .toString('utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

async function main() {
  const args = process.argv.slice(2)
  let json = false
  let csvMode = false
  let stdin = false
  /** @type {string | null} */
  let file = null
  const terms = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') json = true
    else if (a === '--stdin') stdin = true
    else if (a === '--csv') {
      csvMode = true
      file = args[++i] || null
      if (!file) {
        console.error('--csv requires a file path')
        process.exit(1)
      }
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/fortuneoIsinScraper.mjs [options] <term>...
  --json          sortie JSON
  --csv FILE      une requête / ligne → CSV (avec en-tête)
  --stdin         lire les libellés depuis stdin
`)
      process.exit(0)
    } else {
      terms.push(a)
    }
  }

  if (file) {
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
    terms.push(...lines)
  }
  if (stdin) {
    terms.push(...(await readStdinLines()))
  }
  if (!terms.length) {
    console.error('Indiquez au moins un libellé / ISIN / mnémo.')
    process.exit(1)
  }

  /** @type {Array<{ query: string, hits: FortuneoHit[] }>} */
  const results = []
  for (const term of terms) {
    const hits = await searchFortuneo(term)
    results.push({ query: term, hits })
    // Petit délai poli entre requêtes
    if (terms.length > 1) await new Promise((r) => setTimeout(r, 200))
  }

  if (json) {
    console.log(
      JSON.stringify(
        results.map(({ query, hits }) => ({
          query,
          hits: hits.map((h) => ({
            isin: h.codeIsin,
            mnemo: h.mnemo,
            yahooGuess: guessYahooTicker(h),
            libelle: h.libelle,
            place: h.place,
            type: h.type,
            cours: h.cours,
            devise: h.devise,
            codeRef: h.codeRef,
          })),
        })),
        null,
        2,
      ),
    )
    return
  }

  if (csvMode || file) {
    console.log(
      'query;isin;mnemo;yahooGuess;libelle;place;type;cours;devise',
    )
    for (const { query, hits } of results) {
      for (const row of formatCsvRows(query, hits)) console.log(row)
    }
    return
  }

  for (const { query, hits } of results) {
    for (const line of formatTable(query, hits)) console.log(line)
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file:').href

if (isMain || process.argv[1]?.endsWith('fortuneoIsinScraper.mjs')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
