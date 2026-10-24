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
    // Parallel Yahoo history for many tickers (UrlFetchApp.fetchAll).
    if (action === 'historybulk') {
      return json_({
        histories: getHistoryBulk_(p.tickers || '', p.period1 || '', p.period2 || ''),
      });
    }
    if (action === 'search') {
      return json_({ quotes: searchYahoo_(p.q || '') });
    }
    if (action === 'quotemeta') {
      return json_(quoteMeta_(requireTicker_(p.ticker)));
    }
    if (action === 'openfigi') {
      return json_(openFigiIsin_(p.q || '', p.venues || ''));
    }
    // Batch ISIN → ticker (Euronext Paris/Amsterdam only). Public ISINs, comma-separated.
    if (action === 'openfigibatch') {
      return json_({ results: openFigiIsinBatch_(p.isins || p.q || '') });
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

function resolveHistoryWindow_(p) {
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
  return { period1: period1, period2: period2 };
}

function chartUrl_(ticker, period1, period2) {
  return (
    'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(ticker) +
    '?interval=1d&period1=' +
    period1 +
    '&period2=' +
    period2
  );
}

function numOrUndef_(v) {
  if (v === null || v === undefined) return undefined;
  var n = Number(v);
  return isFinite(n) ? n : undefined;
}

function barsFromYahooPayload_(payload) {
  var result = payload.chart.result[0];
  var ts = result.timestamp || [];
  var quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  var closes = quote.close || [];
  var opens = quote.open || [];
  var highs = quote.high || [];
  var lows = quote.low || [];
  var volumes = quote.volume || [];
  var adj =
    (result.indicators &&
      result.indicators.adjclose &&
      result.indicators.adjclose[0] &&
      result.indicators.adjclose[0].adjclose) ||
    [];
  var bars = [];
  for (var i = 0; i < ts.length; i++) {
    var c = closes[i];
    if (c === null || c === undefined) c = adj[i];
    if (c === null || c === undefined) continue;
    var bar = { date: unixToIso_(ts[i]), close: Number(c) };
    var o = numOrUndef_(opens[i]);
    var h = numOrUndef_(highs[i]);
    var l = numOrUndef_(lows[i]);
    var v = numOrUndef_(volumes[i]);
    if (o !== undefined) bar.open = o;
    if (h !== undefined) bar.high = h;
    if (l !== undefined) bar.low = l;
    if (v !== undefined && v >= 0) bar.volume = v;
    bars.push(bar);
  }
  return bars;
}

/** Reject Yahoo payloads that cannot cover the requested window (cache poison). */
function barsCoverWindow_(bars, period1Sec, period2Sec) {
  if (!bars || !bars.length) return false;
  var spanDays = (period2Sec - period1Sec) / 86400;
  if (spanDays <= 21) return bars.length >= 1;
  // ~2Y window → expect dozens of sessions; a handful = wrong/short cache hit
  if (spanDays > 180) return bars.length >= 40;
  return bars.length >= 10;
}

/** Boursorama EOD: `d` = days since 1970-01-01 UTC. */
function boursoramaGetTicksEod_(symbol, length) {
  symbol = String(symbol || '').replace(/^\/+|\/+$/g, '');
  if (!symbol) return [];
  length = Math.min(7300, Math.max(30, parseInt(length || '730', 10) || 730));
  var cache = CacheService.getScriptCache();
  var ckey = 'breod:' + symbol + ':' + length;
  var cached = cache.get(ckey);
  if (cached) return JSON.parse(cached);

  var url =
    'https://www.boursorama.com/bourse/action/graph/ws/GetTicksEOD?symbol=' +
    encodeURIComponent(symbol) +
    '&length=' +
    length +
    '&period=0';
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: 'https://www.boursorama.com/cours/' + symbol + '/',
      'Accept-Language': 'fr-FR,fr;q=0.9',
    },
  });
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) return [];
  var text = resp.getContentText() || '';
  if (!text || text === '[]') return [];
  var json;
  try {
    json = JSON.parse(text);
  } catch (eParse) {
    return [];
  }
  var tab = json && json.d && json.d.QuoteTab;
  if (!tab || !tab.length) return [];
  var bars = [];
  for (var i = 0; i < tab.length; i++) {
    var row = tab[i];
    if (row == null || row.c === null || row.c === undefined) continue;
    var day = Number(row.d);
    if (!isFinite(day)) continue;
    var bar = { date: unixToIso_(Math.floor(day * 86400)), close: Number(row.c) };
    var o = numOrUndef_(row.o);
    var h = numOrUndef_(row.h);
    var l = numOrUndef_(row.l);
    var v = numOrUndef_(row.v);
    if (o !== undefined) bar.open = o;
    if (h !== undefined) bar.high = h;
    if (l !== undefined) bar.low = l;
    if (v !== undefined && v >= 0) bar.volume = v;
    bars.push(bar);
  }
  try {
    if (bars.length) cache.put(ckey, JSON.stringify(bars), HISTORY_TTL_SEC);
  } catch (eCache) {}
  return bars;
}

/** Yahoo ticker → Boursorama history (illiquid .PA etc. when Yahoo chart is empty). */
function boursoramaHistoryBars_(yahooTicker) {
  yahooTicker = String(yahooTicker || '').trim();
  if (!yahooTicker) return [];
  var bare = yahooTicker.replace(/\.[A-Za-z]{1,4}$/, '');
  var paths = boursoramaPathsFor_(bare, yahooTicker);
  for (var i = 0; i < paths.length; i++) {
    var bars = boursoramaGetTicksEod_(paths[i], 730);
    if (bars.length >= 5) return bars;
  }
  return [];
}

function filterBarsWindow_(bars, period1Sec, period2Sec) {
  if (!bars || !bars.length) return [];
  var from = unixToIso_(period1Sec);
  var to = unixToIso_(period2Sec);
  var out = [];
  for (var i = 0; i < bars.length; i++) {
    if (bars[i].date >= from && bars[i].date <= to) out.push(bars[i]);
  }
  return out.length ? out : bars;
}

function fetchHistoryBars_(ticker, period1, period2) {
  var bars = [];
  try {
    var payload = fetchYahoo_(chartUrl_(ticker, period1, period2));
    bars = barsFromYahooPayload_(payload);
  } catch (eY) {
    bars = [];
  }
  if (!barsCoverWindow_(bars, period1, period2)) {
    bars = [];
  }
  // Fallback if Yahoo empty / too short for the window
  if (!bars.length) {
    var br = boursoramaHistoryBars_(ticker);
    bars = filterBarsWindow_(br, period1, period2);
  }
  return bars;
}

function getHistory_(p) {
  var ticker = requireTicker_(p.ticker);
  var win = resolveHistoryWindow_(p);
  var period1 = win.period1;
  var period2 = win.period2;

  var cache = CacheService.getScriptCache();
  // v2 key — ignore hist: entries poisoned by the truncated ychart cache bug
  var key = 'hist2:' + ticker + ':' + period1 + ':' + period2;
  var hit = cache.get(key);
  if (hit) {
    var cachedBars = JSON.parse(hit);
    if (barsCoverWindow_(cachedBars, period1, period2)) return cachedBars;
  }

  var bars = fetchHistoryBars_(ticker, period1, period2);

  try {
    if (barsCoverWindow_(bars, period1, period2)) {
      cache.put(key, JSON.stringify(bars), HISTORY_TTL_SEC);
    }
  } catch (e) {
    // ignore cache size errors
  }
  return bars;
}

/**
 * Fetch daily history for many tickers in parallel (Yahoo via UrlFetchApp.fetchAll).
 * Same period1/period2 for the whole batch (ISO dates).
 * @returns {Object.<string, Array<{date:string, close:number}>>}
 */
function getHistoryBulk_(csv, period1Iso, period2Iso) {
  var parts = String(csv)
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
  if (!parts.length) return {};
  if (parts.length > MAX_TICKERS_BULK) throw new Error('Trop de tickers');

  var win = resolveHistoryWindow_({
    period1: period1Iso,
    period2: period2Iso,
  });
  var period1 = win.period1;
  var period2 = win.period2;
  var cache = CacheService.getScriptCache();
  var out = {};
  var need = [];

  for (var i = 0; i < parts.length; i++) {
    var t = requireTicker_(parts[i]);
    var key = 'hist2:' + t + ':' + period1 + ':' + period2;
    var cached = cache.get(key);
    if (cached) {
      var cachedBars = JSON.parse(cached);
      if (barsCoverWindow_(cachedBars, period1, period2)) {
        out[t] = cachedBars;
      } else {
        need.push(t);
      }
    } else {
      need.push(t);
    }
  }

  if (!need.length) return out;

  var reqs = need.map(function (t) {
    return {
      url: chartUrl_(t, period1, period2),
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
      },
    };
  });
  var responses = UrlFetchApp.fetchAll(reqs);

  for (var j = 0; j < need.length; j++) {
    var ticker = need[j];
    try {
      var resp = responses[j];
      var code = resp.getResponseCode();
      var bars = [];
      if (code >= 200 && code < 300) {
        var payload = JSON.parse(resp.getContentText());
        if (
          payload &&
          payload.chart &&
          payload.chart.result &&
          payload.chart.result[0]
        ) {
          bars = barsFromYahooPayload_(payload);
        }
      }
      // Illiquid / Yahoo-empty → Boursorama EOD (e.g. CAT31.PA)
      if (!barsCoverWindow_(bars, period1, period2)) {
        bars = filterBarsWindow_(
          boursoramaHistoryBars_(ticker),
          period1,
          period2,
        );
      }
      if (!barsCoverWindow_(bars, period1, period2)) continue;
      out[ticker] = bars;
      try {
        if (barsCoverWindow_(bars, period1, period2)) {
          cache.put(
            'hist2:' + ticker + ':' + period1 + ':' + period2,
            JSON.stringify(bars),
            HISTORY_TTL_SEC,
          );
        }
      } catch (eCache) {}
    } catch (eOne) {
      // skip failed ticker
    }
  }
  return out;
}

/**
 * Full-URL cache key. NEVER truncate base64(url): the old
 * `base64EncodeWebSafe(url).slice(0, 80)` stopped before `period1`/`period2`,
 * so a 5-day delta response was reused for a 2Y request (CAT31.PA etc.).
 */
function yahooChartCacheKey_(url) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    String(url),
  );
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var b = (digest[i] + 256) % 256;
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return 'ych5:' + hex;
}

function fetchYahoo_(url) {
  var cache = CacheService.getScriptCache();
  var ykey = yahooChartCacheKey_(url);
  var cached = cache.get(ykey);
  if (cached) return JSON.parse(cached);

  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
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
  // Strip Yahoo venue suffix so "IBE.MC" searches as "IBE"
  var bareQ = q.replace(/\.[A-Za-z]{1,4}$/, '');
  if (bareQ.length < 2) return [];
  var cache = CacheService.getScriptCache();
  var key = 'figisearch3:' + bareQ.toLowerCase();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var bodies = [
    { query: bareQ, exchCode: 'FP', marketSecDes: 'Equity' },
    { query: bareQ, exchCode: 'SM', marketSecDes: 'Equity' },
    { query: bareQ, marketSecDes: 'Equity' },
    { query: bareQ },
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
  var key = 'isinsearch5:' + q.toLowerCase();
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

  // 0) Direct resolve when q looks like a Yahoo ticker (IBE.MC, AL2SI.PA)
  var yahooHint = String(q).match(/^([A-Za-z0-9.-]+)\.([A-Za-z]{1,4})$/);
  if (yahooHint) {
    try {
      var direct = boursoramaIsinFromTicker_(yahooHint[1], yahooHint[0]);
      if (direct.isin) {
        add({
          isin: direct.isin,
          name: direct.name || q,
          ticker: yahooHint[0].toUpperCase(),
          figiTicker: yahooHint[1].toUpperCase(),
          exchange: direct.exchange || '',
          exchangeCountry: direct.exchangeCountry || '',
          investmentType: 'EQ',
          score: 95,
          source: 'boursorama+yahoo-ticker',
        });
        dbg.push('boursorama-direct:' + direct.isin);
      } else {
        dbg.push('boursorama-direct:0');
      }
    } catch (e0) {
      dbg.push('boursorama-direct:' + String(e0.message || e0));
    }
  }

  // 1) Morningstar (best when allowed — often 403 from Apps Script IPs)
  if (out.length === 0) {
    try {
      var ms = morningstarIsinSearchUncached_(q);
      for (var i = 0; i < ms.length; i++) add(ms[i]);
      dbg.push('morningstar:' + ms.length);
    } catch (e1) {
      dbg.push('morningstar:' + String(e1.message || e1));
    }
  }

  // 2) OpenFIGI → Boursorama (Paris, Madrid, Amsterdam, …)
  if (out.length === 0) {
    try {
      var figi = openFigiSearch_(q);
      dbg.push('openfigi:' + figi.length);
      var enriched = 0;
      // Prefer EU equity venues first
      var ordered = figi.slice().sort(function (a, b) {
        function pr(x) {
          var e = String(x.exchCode || '').toUpperCase();
          var t = String(x.ticker || '');
          if (e === 'FP' || e === 'PAR' || t.indexOf('.PA') > 0) return 0;
          if (e === 'SM' || e === 'MC' || t.indexOf('.MC') > 0) return 1;
          if (e === 'NA' || e === 'AS' || t.indexOf('.AS') > 0) return 2;
          if (e === 'GY' || e === 'GF' || t.indexOf('.DE') > 0) return 3;
          return 9;
        }
        return pr(a) - pr(b);
      });
      for (var f = 0; f < ordered.length && out.length < 12; f++) {
        var row = ordered[f];
        var bare = String(row.figiTicker || row.ticker || '')
          .replace(/\.[A-Z]{1,4}$/i, '')
          .toUpperCase();
        if (!bare || bare.indexOf('=') >= 0) continue;
        var yahooT = String(row.ticker).indexOf('.') > 0
          ? row.ticker
          : figiToYahoo_(bare, row.exchCode);
        var resolved = boursoramaIsinFromTicker_(bare, yahooT || row.exchCode);
        if (resolved.isin) {
          enriched++;
          add({
            isin: resolved.isin,
            name: resolved.name || row.name || q,
            ticker: yahooT,
            figiTicker: bare,
            exchange: resolved.exchange || row.exchCode || '',
            exchangeCountry: resolved.exchangeCountry || '',
            investmentType: 'EQ',
            score: 70,
            source: 'boursorama+openfigi',
          });
        }
      }
      dbg.push('boursorama-via-figi:' + enriched);
    } catch (e2) {
      dbg.push('openfigi:' + String(e2.message || e2));
    }
  }

  // 3) Boursorama search by label (all venues, not only 1rP)
  if (out.length === 0) {
    try {
      var symbols = boursoramaSearchSymbols_(q);
      dbg.push('boursorama-search:' + symbols.length);
      for (var s = 0; s < symbols.length && out.length < 10; s++) {
        var symPath = symbols[s]; // e.g. FF55-IBE or 1rPAL2SI or IBE
        var r2 = boursoramaIsinFromPath_(symPath);
        if (r2.isin) {
          var bare2 = String(symPath).replace(/^1rP/i, '').replace(/^FF55-/i, '');
          add({
            isin: r2.isin,
            name: r2.name || q,
            ticker: r2.yahooTicker || bare2,
            figiTicker: bare2,
            exchange: r2.exchange || '',
            exchangeCountry: r2.exchangeCountry || '',
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

/**
 * Candidate Boursorama /cours/ paths for a ticker.
 * Paris = 1rP…, Madrid/Sibe = FF55-… or bare, etc.
 */
function boursoramaPathsFor_(bareTicker, hint) {
  bareTicker = String(bareTicker || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!bareTicker) return [];
  var h = String(hint || '').toUpperCase();
  var paths = [];
  function push(p) {
    if (p && paths.indexOf(p) < 0) paths.push(p);
  }
  // Order by venue hint
  if (/\.MC\b|\bSM\b|\bXMAD\b|\bSIBE\b/.test(h)) {
    push('FF55-' + bareTicker);
    push(bareTicker);
    push('1rP' + bareTicker);
  } else if (/\.PA\b|\bFP\b|\bPAR\b|\bXPAR\b/.test(h)) {
    push('1rP' + bareTicker);
    push(bareTicker);
    push('FF55-' + bareTicker);
  } else if (/\.AS\b|\bNA\b|\bXAMS\b/.test(h)) {
    push(bareTicker);
    push('1rP' + bareTicker);
  } else if (/\.DE\b|\.F\b|\bGY\b|\bGF\b|\bXETR\b|\bXFRA\b/.test(h)) {
    push('1z' + bareTicker);
    push(bareTicker);
    push('1rP' + bareTicker);
  } else {
    // No venue hint: try common Boursorama path prefixes then bare
    push('1rP' + bareTicker);
    push('FF55-' + bareTicker);
    push('1z' + bareTicker);
    push(bareTicker);
  }
  return paths;
}

function boursoramaIsinFromPath_(path) {
  path = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!path) return {};
  var cache = CacheService.getScriptCache();
  var key = 'brspath:' + path;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var url = 'https://www.boursorama.com/cours/' + path + '/';
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
  // Empty / soft "error" shell pages
  if (html.length < 50000 && !/c-faceplate__isin/i.test(html)) return {};

  var isin = '';
  var m = html.match(/c-faceplate__isin[^>]*>\s*([A-Z]{2}[A-Z0-9]{10})\b/i);
  if (m) isin = m[1].toUpperCase();
  if (!isin) {
    m = html.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
    if (m) isin = m[1].toUpperCase();
  }
  if (!isin || !/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) return {};

  var name = '';
  var nm = html.match(/c-faceplate__company-name[^>]*>\s*([^<]+)/i) ||
    html.match(/<title>\s*([^|<]+)/i);
  if (nm) name = nm[1].replace(/\s+/g, ' ').trim();

  var exchange = '';
  var exchangeCountry = '';
  var yahooTicker = '';
  if (/^1rP/i.test(path)) {
    exchange = 'XPAR'; exchangeCountry = 'FRA';
    yahooTicker = path.replace(/^1rP/i, '') + '.PA';
  } else if (/^FF55-/i.test(path) || /Sibe/i.test(html)) {
    exchange = 'XMAD'; exchangeCountry = 'ESP';
    yahooTicker = path.replace(/^FF55-/i, '') + '.MC';
  } else if (/^1z/i.test(path) || /XETRA|Frankfurt|Francfort/i.test(html)) {
    exchange = 'XETR'; exchangeCountry = 'DEU';
    yahooTicker = path.replace(/^1z/i, '') + '.DE';
  }

  var out = {
    isin: isin,
    name: name,
    exchange: exchange,
    exchangeCountry: exchangeCountry,
    yahooTicker: yahooTicker,
    path: path,
  };
  try { cache.put(key, JSON.stringify(out), 86400); } catch (e) {}
  return out;
}

/** Parse ISIN from Boursorama for a bare ticker (+ optional Yahoo/exch hint). */
function boursoramaIsinFromTicker_(bareTicker, hint) {
  bareTicker = String(bareTicker || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!bareTicker) return {};
  var paths = boursoramaPathsFor_(bareTicker, hint);
  for (var i = 0; i < paths.length; i++) {
    var got = boursoramaIsinFromPath_(paths[i]);
    if (got.isin) return got;
  }
  return {};
}

/** Boursorama ajax search → /cours/ path segments (1rPAL2SI, FF55-IBE, IBE, …). */
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
  var re = /\/cours\/([A-Za-z0-9._-]+)\//g;
  var seen = {};
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null && out.length < 12) {
    var sym = String(m[1]);
    if (seen[sym]) continue;
    // skip junk
    if (/^(actualite|bourse|fonds)$/i.test(sym)) continue;
    seen[sym] = true;
    out.push(sym);
  }
  return out;
}

/** Euronext Paris (PAR/FP) or Amsterdam (NA) — preferred PEA venues. */
function isFigiPaAm_(exch) {
  var e = String(exch || '').toUpperCase();
  return (
    e === 'FP' || e === 'PAR' || e === 'PN' || e === 'PA' ||
    e === 'NA' || e === 'AS'
  );
}

function pickFigiRow_(data, venues) {
  var onlyPaAm = String(venues || '').toLowerCase() === 'pa-am';
  var bestPa = null;
  var bestAm = null;
  var bestAny = null;
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row || !row.ticker) continue;
    var e = String(row.exchCode || '').toUpperCase();
    if (e === 'FP' || e === 'PAR' || e === 'PN' || e === 'PA') {
      if (!bestPa) bestPa = row;
    } else if (e === 'NA' || e === 'AS') {
      if (!bestAm) bestAm = row;
    } else if (!onlyPaAm && !bestAny) {
      bestAny = row;
    }
  }
  return bestPa || bestAm || (onlyPaAm ? null : bestAny);
}

/**
 * OpenFIGI: public ISIN → ticker.
 * venues=pa-am → only Euronext Paris / Amsterdam (no US/OTC fallback).
 */
function openFigiIsin_(isin, venues) {
  isin = String(isin || '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) {
    return { error: 'ISIN invalide' };
  }
  var onlyPaAm = String(venues || '').toLowerCase() === 'pa-am';
  var cache = CacheService.getScriptCache();
  var key = (onlyPaAm ? 'figiPaAm:' : 'figi:') + isin;
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

  var best = pickFigiRow_(data, venues);
  if (!best || !best.ticker) return {};

  var yahoo = figiToYahoo_(best.ticker, best.exchCode);
  var out = { ticker: yahoo, exchCode: best.exchCode || '', figiTicker: best.ticker };
  try { cache.put(key, JSON.stringify(out), 604800); } catch (e) {}
  return out;
}

/**
 * Batch OpenFIGI mapping — Euronext Paris / Amsterdam only.
 * Free API: max 10 jobs / request. Returns only PA/AM hits.
 * @returns {Array<{isin:string, ticker?:string, exchCode?:string}>}
 */
function openFigiIsinBatch_(csv) {
  var raw = String(csv || '').split(/[,;\s]+/);
  var isins = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var id = String(raw[i] || '').trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(id)) continue;
    if (seen[id]) continue;
    seen[id] = true;
    isins.push(id);
    if (isins.length >= 100) break;
  }
  if (!isins.length) return [];

  var cache = CacheService.getScriptCache();
  var out = [];
  var need = [];
  for (var j = 0; j < isins.length; j++) {
    var isin = isins[j];
    var cached = cache.get('figiPaAm:' + isin);
    if (cached) {
      var parsed = JSON.parse(cached);
      out.push({
        isin: isin,
        ticker: parsed.ticker || '',
        exchCode: parsed.exchCode || '',
      });
    } else {
      need.push(isin);
    }
  }

  // OpenFIGI free tier: 10 mappings per request
  var CHUNK = 10;
  for (var c = 0; c < need.length; c += CHUNK) {
    var chunk = need.slice(c, c + CHUNK);
    var jobs = [];
    for (var k = 0; k < chunk.length; k++) {
      jobs.push({ idType: 'ID_ISIN', idValue: chunk[k] });
    }
    var resp = UrlFetchApp.fetch('https://api.openfigi.com/v3/mapping', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify(jobs),
      headers: { 'User-Agent': 'VisualiseurFortuneo/1.0' },
    });
    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
      throw new Error('OpenFIGI HTTP ' + resp.getResponseCode());
    }
    var json = JSON.parse(resp.getContentText());
    for (var r = 0; r < chunk.length; r++) {
      var isin2 = chunk[r];
      var block = json[r] || {};
      var data2 = block.data || [];
      var best2 = pickFigiRow_(data2, 'pa-am');
      if (best2 && best2.ticker) {
        var yahoo2 = figiToYahoo_(best2.ticker, best2.exchCode);
        var rowOut = {
          isin: isin2,
          ticker: yahoo2,
          exchCode: best2.exchCode || '',
          figiTicker: best2.ticker,
        };
        out.push(rowOut);
        try {
          cache.put(
            'figiPaAm:' + isin2,
            JSON.stringify({
              ticker: yahoo2,
              exchCode: best2.exchCode || '',
              figiTicker: best2.ticker,
            }),
            604800,
          );
        } catch (eCache) {}
      } else {
        // Cache negative briefly to avoid re-hitting free quota in the same run
        out.push({ isin: isin2, ticker: '', exchCode: '' });
        try {
          cache.put('figiPaAm:' + isin2, JSON.stringify({}), 3600);
        } catch (eNeg) {}
      }
    }
    if (c + CHUNK < need.length) {
      Utilities.sleep(250);
    }
  }
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
