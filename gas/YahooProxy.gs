/**
 * VisualiseurFortuneo — Yahoo Finance quote proxy (Google Apps Script)
 *
 * PRIVACY CONTRACT:
 * - Accepts ONLY public market identifiers: ticker symbols and date ranges.
 * - Must NEVER receive or store quantities, valuations, operations, ISINs
 *   tied to a portfolio, user ids, or any personal financial data.
 * - Cache keys are ticker + range only (public OHLC, shareable across users).
 * - Do not log request bodies beyond ticker/range; do not persist IPs.
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * Optional script property: ALLOWED_ORIGINS = "https://your.app,http://localhost:5173"
 */

var LIVE_TTL_SEC = 300;      // 5 min
var HISTORY_TTL_SEC = 21600; // 6 h
var MAX_DAYS = 730;
var MAX_TICKERS_BULK = 40;
var TICKER_RE = /^[A-Za-z0-9.^_=/-]{1,32}$/;

function doGet(e) {
  return handle(e);
}

function doPost(e) {
  return handle(e);
}

function handle(e) {
  try {
    var p = (e && e.parameter) ? e.parameter : {};
    var action = (p.action || 'price').toLowerCase();

    // Reject personal/portfolio params. Public name/ISIN may arrive as free-text `q` for search.
    var forbidden = ['quantity', 'qty', 'user', 'email', 'portfolio', 'amount', 'pru'];
    for (var i = 0; i < forbidden.length; i++) {
      if (p[forbidden[i]] !== undefined) {
        return json_({ error: 'Paramètre non autorisé' }, 400);
      }
    }

    if (action === 'price') {
      return json_({ price: getLivePrice_(requireTicker_(p.ticker)) });
    }
    if (action === 'bulk') {
      return json_({ prices: getBulkPrices_(p.tickers || '') });
    }
    if (action === 'history') {
      return json_({ bars: getHistory_(p) });
    }
    if (action === 'search') {
      return json_({ quotes: searchYahoo_(p.q || '') });
    }
    if (action === 'quotemeta') {
      return json_(quoteMeta_(requireTicker_(p.ticker)));
    }
    if (action === 'openfigi') {
      return json_(openFigiIsin_(p.q || ''));
    }
    if (action === 'openfigisearch') {
      return json_({ results: openFigiSearch_(p.q || '') });
    }
    // Name/ticker → ISIN candidates (multi-source; Morningstar often 403 from GAS)
    if (action === 'isinsearch') {
      return json_(isinSearchDetailed_(p.q || ''));
    }
    return json_({ error: 'Action inconnue' }, 400);
  } catch (err) {
    return json_({ error: String(err.message || err) }, 500);
  }
}

function requireTicker_(t) {
  if (!t || !TICKER_RE.test(String(t))) throw new Error('Ticker invalide');
  return String(t);
}

function getLivePrice_(ticker) {
  var cache = CacheService.getScriptCache();
  var key = 'live:' + ticker;
  var hit = cache.get(key);
  if (hit !== null) return Number(hit);

  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(ticker) + '?interval=1d&range=5d';
  var payload = fetchYahoo_(url);
  var meta = payload.chart.result[0].meta;
  var price = meta.regularMarketPrice;
  if (price === undefined || price === null) {
    var closes = payload.chart.result[0].indicators.quote[0].close;
    price = closes[closes.length - 1];
  }
  cache.put(key, String(price), LIVE_TTL_SEC);
  return Number(price);
}

function getBulkPrices_(csv) {
  var parts = String(csv).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (parts.length > MAX_TICKERS_BULK) throw new Error('Trop de tickers');
  var out = {};
  for (var i = 0; i < parts.length; i++) {
    var t = requireTicker_(parts[i]);
    try {
      out[t] = getLivePrice_(t);
    } catch (err) {
      // skip failed ticker
    }
  }
  return out;
}

function getHistory_(p) {
  var ticker = requireTicker_(p.ticker);
  var period1;
  var period2;
  var nowSec = Math.floor(Date.now() / 1000);

  if (p.period1 && p.period2) {
    period1 = isoToUnix_(p.period1);
    period2 = isoToUnix_(p.period2) + 86400;
  } else {
    var days = Math.min(MAX_DAYS, Math.max(1, parseInt(p.days || '365', 10)));
    period2 = nowSec;
    period1 = nowSec - days * 86400;
  }

  if (period2 - period1 > MAX_DAYS * 86400) {
    period1 = period2 - MAX_DAYS * 86400;
  }

  var cache = CacheService.getScriptCache();
  var key = 'hist:' + ticker + ':' + period1 + ':' + period2;
  // CacheService value max ~100KB; store compact JSON
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(ticker) +
    '?interval=1d&period1=' + period1 + '&period2=' + period2;
  var payload = fetchYahoo_(url);
  var result = payload.chart.result[0];
  var ts = result.timestamp || [];
  var closes = (result.indicators.quote[0].close) || [];
  var bars = [];
  for (var i = 0; i < ts.length; i++) {
    if (closes[i] === null || closes[i] === undefined) continue;
    bars.push({ date: unixToIso_(ts[i]), close: Number(closes[i]) });
  }

  try {
    cache.put(key, JSON.stringify(bars), HISTORY_TTL_SEC);
  } catch (e) {
    // ignore cache size errors
  }
  return bars;
}

function fetchYahoo_(url) {
  var cache = CacheService.getScriptCache();
  var ykey = 'ychart:' + Utilities.base64EncodeWebSafe(url).slice(0, 80);
  var cached = cache.get(ykey);
  if (cached) return JSON.parse(cached);

  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; VisualiseurFortuneo/1.0)',
    },
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Yahoo HTTP ' + code);
  }
  var body = resp.getContentText();
  var json = JSON.parse(body);
  if (!json.chart || !json.chart.result || !json.chart.result[0]) {
    throw new Error('Réponse Yahoo invalide');
  }
  try {
    cache.put(ykey, body, LIVE_TTL_SEC);
  } catch (e) {}
  return json;
}

function searchYahoo_(q) {
  q = String(q || '').trim().slice(0, 80);
  if (!q) return [];
  var cache = CacheService.getScriptCache();
  var key = 'search2:' + q.toLowerCase();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  // Try v1 (fr) then v10 (en-US/FR) — same combo as other Fortuneo tools
  var urls = [
    'https://query1.finance.yahoo.com/v1/finance/search?q=' +
      encodeURIComponent(q) + '&lang=fr&region=FR&quotesCount=12&newsCount=0',
    'https://query1.finance.yahoo.com/v10/finance/search?q=' +
      encodeURIComponent(q) + '&lang=en-US&region=FR&quotesCount=10'
  ];
  var out = [];
  for (var u = 0; u < urls.length && out.length === 0; u++) {
    var resp = UrlFetchApp.fetch(urls[u], {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });
    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) continue;
    var json = JSON.parse(resp.getContentText());
    // v10 nests under finance.result
    var raw = json.quotes || (json.finance && json.finance.result && json.finance.result[0] && json.finance.result[0].documents) || [];
    if (!raw.length && json.finance && json.finance.result) {
      // alternate v10 shape
      try {
        var block = json.finance.result;
        if (block.quotes) raw = block.quotes;
        else if (block[0] && block[0].quotes) raw = block[0].quotes;
      } catch (e) {}
    }
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];
      var sym = r.symbol || r.ticker;
      if (!sym) continue;
      out.push({
        symbol: sym,
        shortname: r.shortname || r.shortName || '',
        longname: r.longname || r.longName || '',
        quoteType: r.quoteType || r.typeDisp || '',
        exch: r.exch || r.exchange || r.exchDisp || '',
        isin: r.isin || r.ISIN || '',
      });
    }
  }
  try { cache.put(key, JSON.stringify(out), 86400); } catch (e) {}
  return out;
}

/**
 * Public quote metadata — resolve ISIN via Boursorama faceplate (Yahoo v7 = 401,
 * Morningstar often 403 from Apps Script IPs).
 */
function quoteMeta_(ticker) {
  var cache = CacheService.getScriptCache();
  var key = 'qmeta3:' + ticker;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var bare = String(ticker).replace(/\.[A-Z]{1,4}$/i, '').toUpperCase();
  var resolved = boursoramaIsinFromTicker_(bare);
  var out = {
    symbol: ticker,
    shortname: resolved.name || '',
    longname: resolved.name || '',
    quoteType: 'EQUITY',
    exch: resolved.exchange || '',
    isin: resolved.isin || '',
  };
  try { cache.put(key, JSON.stringify(out), 86400); } catch (e) {}
  return out;
}

/**
 * OpenFIGI /v3/search (NOT mapping with idType NAME — that is invalid).
 * Returns Yahoo-style tickers; ISIN usually absent from OpenFIGI free API.
 */
function openFigiSearch_(q) {
  q = String(q || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  var cache = CacheService.getScriptCache();
  var key = 'figisearch2:' + q.toLowerCase();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var bodies = [
    { query: q, exchCode: 'FP', marketSecDes: 'Equity' },
    { query: q, marketSecDes: 'Equity' },
    { query: q },
  ];
  var seen = {};
  var out = [];
  for (var b = 0; b < bodies.length && out.length < 15; b++) {
    var resp = UrlFetchApp.fetch('https://api.openfigi.com/v3/search', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify(bodies[b]),
      headers: { 'User-Agent': 'VisualiseurFortuneo/1.0' },
    });
    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) continue;
    var json = JSON.parse(resp.getContentText());
    var data = json.data || [];
    for (var j = 0; j < data.length && out.length < 15; j++) {
      var row = data[j];
      if (!row || !row.ticker) continue;
      // Skip futures / weird tickers
      if (String(row.ticker).indexOf('=') >= 0) continue;
      if (row.securityType2 && /Future|Option/i.test(String(row.securityType2))) continue;
      var yahoo = figiToYahoo_(row.ticker, row.exchCode);
      if (seen[yahoo]) continue;
      seen[yahoo] = true;
      out.push({
        ticker: yahoo,
        figiTicker: row.ticker,
        name: row.name || row.securityDescription || '',
        exchCode: row.exchCode || '',
        isin: '',
        securityType: row.securityType || row.securityType2 || '',
      });
    }
  }
  try { cache.put(key, JSON.stringify(out), 86400); } catch (e) {}
  return out;
}

/**
 * Multi-source ISIN search (public name/ticker only).
 * 1) Morningstar (works from browsers; often 403 from Apps Script IPs)
 * 2) OpenFIGI search → Boursorama faceplate (reliable from GAS)
 * 3) Boursorama ajax search → faceplate
 */
function isinSearchDetailed_(q) {
  q = String(q || '').trim().slice(0, 80);
  if (q.length < 2) return { results: [], debug: 'query trop courte' };

  var cache = CacheService.getScriptCache();
  var key = 'isinsearch4:' + q.toLowerCase();
  var hit = cache.get(key);
  if (hit) {
    try {
      var cached = JSON.parse(hit);
      if (cached && cached.results) return cached;
      // legacy cache was a bare array
      if (Array.isArray(cached) && cached.length) {
        return { results: cached, debug: 'cache (legacy)' };
      }
    } catch (e0) {}
  }

  var byIsin = {};
  var out = [];
  var dbg = [];

  function add(row) {
    if (!row || !row.isin || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(row.isin)) return;
    var prev = byIsin[row.isin];
    if (prev) {
      if ((row.score || 0) > (prev.score || 0)) {
        for (var i = 0; i < out.length; i++) {
          if (out[i].isin === row.isin) { out[i] = row; break; }
        }
        byIsin[row.isin] = row;
      }
      return;
    }
    byIsin[row.isin] = row;
    out.push(row);
  }

  // 1) Morningstar (best when allowed — often 403 from Apps Script IPs)
  try {
    var ms = morningstarIsinSearchUncached_(q);
    for (var i = 0; i < ms.length; i++) add(ms[i]);
    dbg.push('morningstar:' + ms.length);
  } catch (e1) {
    dbg.push('morningstar:' + String(e1.message || e1));
  }

  // 2) OpenFIGI → Boursorama ISIN enrichment for Paris tickers
  if (out.length === 0) {
    try {
      var figi = openFigiSearch_(q);
      dbg.push('openfigi:' + figi.length);
      var enriched = 0;
      for (var f = 0; f < figi.length && out.length < 12; f++) {
        var row = figi[f];
        var bare = String(row.figiTicker || row.ticker || '')
          .replace(/\.[A-Z]{1,4}$/i, '')
          .toUpperCase();
        if (!bare || bare.indexOf('=') >= 0) continue;
        var prefer = String(row.ticker).indexOf('.PA') > 0 ||
          row.exchCode === 'FP' || row.exchCode === 'PAR';
        // Always try Paris first; still try others if nothing yet
        if (!prefer && out.length > 0) continue;
        var resolved = boursoramaIsinFromTicker_(bare);
        if (resolved.isin) {
          enriched++;
          add({
            isin: resolved.isin,
            name: resolved.name || row.name || q,
            ticker: String(row.ticker).indexOf('.') > 0 ? row.ticker : bare + '.PA',
            figiTicker: bare,
            exchange: 'XPAR',
            exchangeCountry: 'FRA',
            investmentType: 'EQ',
            score: prefer ? 90 : 50,
            source: 'boursorama+openfigi',
          });
        }
      }
      dbg.push('boursorama-via-figi:' + enriched);
    } catch (e2) {
      dbg.push('openfigi:' + String(e2.message || e2));
    }
  }

  // 3) Boursorama search by label
  if (out.length === 0) {
    try {
      var symbols = boursoramaSearchSymbols_(q);
      dbg.push('boursorama-search:' + symbols.length);
      for (var s = 0; s < symbols.length && out.length < 10; s++) {
        var sym = symbols[s];
        var r2 = boursoramaIsinFromTicker_(sym);
        if (r2.isin) {
          add({
            isin: r2.isin,
            name: r2.name || q,
            ticker: sym + '.PA',
            figiTicker: sym,
            exchange: 'XPAR',
            exchangeCountry: 'FRA',
            investmentType: 'EQ',
            score: 80,
            source: 'boursorama',
          });
        }
      }
    } catch (e3) {
      dbg.push('boursorama-search:' + String(e3.message || e3));
    }
  }

  // EUR / Paris first
  out.sort(function (a, b) {
    function rank(x) {
      var r = Number(x.score) || 0;
      var isin = String(x.isin || '');
      if (isin.indexOf('FR') === 0) r += 50;
      else if (/^(DE|NL|BE|ES|IT|IE|AT|PT|FI|LU)/.test(isin)) r += 35;
      else if (isin.indexOf('US') === 0) r -= 40;
      if (x.exchange === 'XPAR' || x.exchangeCountry === 'FRA') r += 100;
      if (String(x.ticker).indexOf('.PA') > 0) r += 20;
      return r;
    }
    return rank(b) - rank(a);
  });

  var payload = { results: out, debug: dbg.join(' | ') };
  // Only cache successful lookups (empty + MS 403 was poisoning the cache)
  if (out.length > 0) {
    try { cache.put(key, JSON.stringify(payload), 86400); } catch (e) {}
  }
  return payload;
}

/** @deprecated use isinSearchDetailed_ */
function isinSearch_(q) {
  return isinSearchDetailed_(q).results;
}

/** Morningstar — may 403 from Apps Script; ok from browsers. */
function morningstarIsinSearchUncached_(q) {
  var url = 'https://www.morningstar.com/api/v2/search?q=' + encodeURIComponent(q);
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Morningstar HTTP ' + code);
  }
  var text = resp.getContentText() || '';
  if (!text) throw new Error('Morningstar empty body');
  var json = JSON.parse(text);
  var rows = json.results || [];
  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length && out.length < 25; i++) {
    var item = rows[i];
    if (!item || item.type !== 'security' || !item.value) continue;
    var v = item.value;
    var isin = v.isin ? String(v.isin).toUpperCase() : '';
    if (!isin || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) continue;
    var exch = String(v.exchange || '');
    var country = String(v.exchangeCountry || '');
    var dedupe = isin + '|' + exch;
    if (seen[dedupe]) continue;
    seen[dedupe] = true;
    var t = String(v.ticker || '').trim().replace(/\s+/g, '');
    var yahoo = t;
    if (t) {
      if (exch === 'XPAR' || country === 'FRA') yahoo = t + '.PA';
      else if (exch === 'XAMS' || country === 'NLD') yahoo = t + '.AS';
      else if (exch === 'XBRU' || country === 'BEL') yahoo = t + '.BR';
      else if (exch === 'XMAD' || country === 'ESP') yahoo = t + '.MC';
      else if (exch === 'XETR' || country === 'DEU') yahoo = t + '.DE';
      else if (exch === 'XLON' || country === 'GBR') yahoo = t + '.L';
    }
    out.push({
      isin: isin,
      name: v.name || v.shortName || v.companyName || '',
      ticker: yahoo || t,
      figiTicker: t,
      exchange: exch,
      exchangeCountry: country,
      investmentType: String(v.investmentType || ''),
      score: typeof item.score === 'number' ? item.score : 0,
      source: 'morningstar',
    });
  }
  return out;
}

/** Parse ISIN from Boursorama quote page for a Euronext Paris symbol (e.g. AL2SI). */
function boursoramaIsinFromTicker_(bareTicker) {
  bareTicker = String(bareTicker || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!bareTicker) return {};
  var cache = CacheService.getScriptCache();
  var key = 'brsisin:' + bareTicker;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var url = 'https://www.boursorama.com/cours/1rP' + bareTicker + '/';
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'fr-FR,fr;q=0.9',
    },
  });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    return {};
  }
  var html = resp.getContentText() || '';
  var isin = '';
  var m = html.match(/c-faceplate__isin[^>]*>\s*([A-Z]{2}[A-Z0-9]{10})\b/i);
  if (m) isin = m[1].toUpperCase();
  if (!isin) {
    m = html.match(/\b(FR[A-Z0-9]{10})\b/);
    if (m) isin = m[1].toUpperCase();
  }
  var name = '';
  var nm = html.match(/c-faceplate__company-name[^>]*>\s*([^<]+)/i) ||
    html.match(/<title>\s*([^|<]+)/i);
  if (nm) name = nm[1].replace(/\s+/g, ' ').trim();

  var out = { isin: isin, name: name, exchange: 'XPAR', ticker: bareTicker };
  if (isin) {
    try { cache.put(key, JSON.stringify(out), 86400); } catch (e) {}
  }
  return out;
}

/** Boursorama ajax search → list of Paris symbols (AL2SI, …). */
function boursoramaSearchSymbols_(q) {
  q = String(q || '').trim().slice(0, 80);
  if (q.length < 2) return [];
  var url = 'https://www.boursorama.com/recherche/ajax?query=' + encodeURIComponent(q);
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': '*/*',
    },
  });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) return [];
  var html = resp.getContentText() || '';
  var re = /\/cours\/1rP([A-Za-z0-9]+)\//g;
  var seen = {};
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null && out.length < 8) {
    var sym = String(m[1]).toUpperCase();
    if (seen[sym]) continue;
    seen[sym] = true;
    out.push(sym);
  }
  return out;
}

/** OpenFIGI: public ISIN → ticker; map PAR to Yahoo .PA */
function openFigiIsin_(isin) {
  isin = String(isin || '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) {
    return { error: 'ISIN invalide' };
  }
  var cache = CacheService.getScriptCache();
  var key = 'figi:' + isin;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var resp = UrlFetchApp.fetch('https://api.openfigi.com/v3/mapping', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify([{ idType: 'ID_ISIN', idValue: isin }]),
    headers: { 'User-Agent': 'VisualiseurFortuneo/1.0' },
  });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    throw new Error('OpenFIGI HTTP ' + resp.getResponseCode());
  }
  var json = JSON.parse(resp.getContentText());
  var data = (json[0] && json[0].data) || [];
  if (!data.length) return {};

  // Prefer Paris equity
  var best = null;
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row.ticker) continue;
    if (row.exchCode === 'FP' || row.exchCode === 'PAR' || row.exchCode === 'PN') {
      best = row;
      break;
    }
    if (!best) best = row;
  }
  if (!best || !best.ticker) return {};

  var yahoo = figiToYahoo_(best.ticker, best.exchCode);
  var out = { ticker: yahoo, exchCode: best.exchCode || '', figiTicker: best.ticker };
  try { cache.put(key, JSON.stringify(out), 604800); } catch (e) {}
  return out;
}

function figiToYahoo_(ticker, exch) {
  var t = String(ticker).toUpperCase();
  var e = String(exch || '').toUpperCase();
  // Already suffixed?
  if (t.indexOf('.') >= 0) return t;
  var map = {
    FP: '.PA', PAR: '.PA', PN: '.PA', PA: '.PA',
    NA: '.AS', AS: '.AS',
    SM: '.MC', MC: '.MC',
    GY: '.DE', GF: '.DE', DE: '.DE',
    LN: '.L', LO: '.L',
    IM: '.MI', MI: '.MI',
    SW: '.SW', S: '.SW'
  };
  var suf = map[e] || '';
  return t + suf;
}

function isoToUnix_(iso) {
  var parts = String(iso).split('-');
  if (parts.length !== 3) throw new Error('Date invalide');
  return Math.floor(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]) / 1000);
}

function unixToIso_(sec) {
  var d = new Date(sec * 1000);
  var y = d.getUTCFullYear();
  var m = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  var day = ('0' + d.getUTCDate()).slice(-2);
  return y + '-' + m + '-' + day;
}

function json_(obj, status) {
  var out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  // Apps Script Web Apps do not fully support custom CORS headers on all paths;
  // browser apps typically use redirect/CORS-friendly deployment.
  return out;
}
