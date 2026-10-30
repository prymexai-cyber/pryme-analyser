/* ============================================================
   PRYME ANALYSER — backend
   - Market data proxy: Crypto (Binance), Forex/Gold/Indices/Intl stocks (Yahoo),
     Sri Lanka CSE (cse.lk public JSON API)
   - Daily news (Google News RSS)
   - AI proxy for free LLM keys (Groq, Gemini, OpenRouter, Mistral, Cerebras)
   Keys are NEVER stored on the server — they come from the user's browser per request.
   ============================================================ */
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

/* ---------- tiny cache ---------- */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json,*/*', ...(opts.headers || {}) } });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

/* ---------- helpers ---------- */
function aggregate(candles, sec) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = Math.floor(c.time / sec) * sec;
    if (!cur || cur.time !== b) {
      if (cur) out.push(cur);
      cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------- CRYPTO (Binance public market data) ---------- */
function normCrypto(s) {
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/(USDT|USDC|BTC|ETH|FDUSD|BUSD)$/.test(s)) s += 'USDT';
  return s;
}
async function cryptoCandles(symbol, tf, limit) {
  const s = normCrypto(symbol);
  const hosts = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com'];
  let lastErr;
  for (const h of hosts) {
    try {
      const rows = await fetchJSON(`${h}/api/v3/klines?symbol=${s}&interval=${tf}&limit=${Math.min(limit, 1000)}`);
      return {
        symbol: s,
        candles: rows.map(r => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ---------- FOREX / GOLD / INDICES / INTL STOCKS (Yahoo Finance chart API) ---------- */
const FX_MAP = {
  XAUUSD: 'GC=F', GOLD: 'GC=F', XAGUSD: 'SI=F', SILVER: 'SI=F', USOIL: 'CL=F', WTI: 'CL=F', UKOIL: 'BZ=F',
  US30: '^DJI', DJI: '^DJI', NAS100: '^NDX', NDX: '^NDX', US100: '^NDX', SPX500: '^GSPC', US500: '^GSPC',
  GER40: '^GDAXI', UK100: '^FTSE', JP225: '^N225', DXY: 'DX-Y.NYB'
};
function normYahoo(symbol, market) {
  let s = symbol.toUpperCase().trim().replace(/\s+/g, '');
  if (FX_MAP[s]) return FX_MAP[s];
  if (market === 'forex') {
    s = s.replace('/', '');
    if (/^[A-Z]{6}$/.test(s)) return s + '=X';
  }
  return s;
}
const YH = {
  '1m': ['1m', '5d'], '5m': ['5m', '1mo'], '15m': ['15m', '1mo'], '30m': ['30m', '1mo'],
  '1h': ['60m', '6mo'], '4h': ['60m', '2y'], '1d': ['1d', '5y']
};
async function yahooCandles(symbol, market, tf, limit) {
  const ys = normYahoo(symbol, market);
  const [interval, range] = YH[tf] || YH['1h'];
  let data, lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      data = await fetchJSON(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?interval=${interval}&range=${range}&includePrePost=false`);
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr;
  const res = data?.chart?.result?.[0];
  if (!res || !res.timestamp) throw new Error('No data for symbol ' + ys);
  const q = res.indicators.quote[0];
  let candles = [];
  res.timestamp.forEach((t, i) => {
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    candles.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 });
  });
  if (tf === '4h') candles = aggregate(candles, 14400);
  return { symbol: ys, currency: res.meta?.currency, name: res.meta?.longName || res.meta?.shortName, candles: candles.slice(-limit) };
}

/* ---------- SRI LANKA CSE (unofficial public JSON API on cse.lk) ---------- */
const cseTicks = new Map(); // symbol -> [{time, price, vol}] built while server runs
function normCSE(s) {
  s = s.toUpperCase().trim();
  if (!s.includes('.')) s += '.N0000';
  return s;
}
async function csePost(endpoint, body) {
  return fetchJSON(`https://www.cse.lk/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://www.cse.lk', Referer: 'https://www.cse.lk/' },
    body
  });
}
function pickNum(o, keys) { for (const k of keys) if (o[k] != null && !isNaN(+o[k])) return +o[k]; return null; }

async function cseCandles(symbol, tf, limit) {
  const s = normCSE(symbol);
  const info = await csePost(`companyInfoSummery?symbol=${encodeURIComponent(s)}`, `symbol=${encodeURIComponent(s)}`);
  const ri = info?.reqSymbolInfo || {};
  const id = ri.id || ri.securityId;
  const quote = {
    name: ri.name, last: +ri.lastTradedPrice || null, prevClose: +ri.previousClose || null,
    change: ri.change, changePct: ri.changePercentage,
    dayHigh: +ri.hiTrade || null, dayLow: +ri.lowTrade || null,
    wk52High: +(info?.reqSymbolBetaInfo?.wk52High || ri.p12HiPrice || 0) || null,
    wk52Low: +(info?.reqSymbolBetaInfo?.wk52Low || ri.p12LowPrice || 0) || null,
    marketCap: ri.marketCap
  };

  // record a tick so intraday candles build up over time even if chart endpoint fails
  if (quote.last) {
    const arr = cseTicks.get(s) || [];
    arr.push({ time: Math.floor(Date.now() / 1000), price: quote.last });
    if (arr.length > 20000) arr.shift();
    cseTicks.set(s, arr);
  }

  let candles = [];
  // Try chart endpoints (period: 1=1D, 2=1W, 3=1M, 4=3M/6M, 5=1Y). Response shape varies, parse defensively.
  const periods = tf === '1d' ? [5, 4, 3] : (tf === '4h' || tf === '1h') ? [3, 2, 1] : [1, 2];
  for (const p of periods) {
    if (!id) break;
    try {
      const d = await csePost('companyChartDataByStock', `stockId=${id}&period=${p}`);
      const rows = d?.chartData || d?.reqChartData || (Array.isArray(d) ? d : []);
      const pts = rows.map(r => {
        let t = r.t ?? r.time ?? r.tradeDate ?? r.date ?? r.d;
        if (typeof t === 'string') t = Date.parse(t);
        if (t > 1e12) t = Math.floor(t / 1000);
        const c = pickNum(r, ['c', 'close', 'p', 'price', 'closingPrice', 'lastTradedPrice']);
        if (!t || c == null) return null;
        return {
          time: t,
          open: pickNum(r, ['o', 'open', 'openingPrice']) ?? c,
          high: pickNum(r, ['h', 'high', 'highPrice']) ?? c,
          low: pickNum(r, ['l', 'low', 'lowPrice']) ?? c,
          close: c,
          volume: pickNum(r, ['q', 'v', 'volume', 'qty', 'shareVolume']) || 0
        };
      }).filter(Boolean).sort((a, b) => a.time - b.time);
      if (pts.length > 10) { candles = pts; break; }
    } catch (_) { /* try next */ }
  }
  if (candles.length) {
    candles = aggregate(candles, TF_SEC[tf] || 3600);
  } else {
    // fallback: candles from ticks collected by this server
    const ticks = (cseTicks.get(s) || []).map(t => ({ time: t.time, open: t.price, high: t.price, low: t.price, close: t.price }));
    candles = aggregate(ticks, TF_SEC[tf] || 3600);
  }
  return { symbol: s, currency: 'LKR', name: quote.name, quote, candles: candles.slice(-limit), limited: candles.length < 30 };
}

/* ---------- routes ---------- */
app.get('/api/health', (_, res) => res.json({ ok: true, time: Date.now() }));

app.get('/api/candles', async (req, res) => {
  const market = (req.query.market || 'crypto').toLowerCase();
  const symbol = (req.query.symbol || 'BTCUSDT').trim();
  const tf = TF_SEC[req.query.tf] ? req.query.tf : '1h';
  const limit = Math.min(+req.query.limit || 500, 1000);
  try {
    const ttl = tf === '1m' ? 5000 : 15000;
    const out = await cached(`${market}|${symbol}|${tf}|${limit}`, ttl, async () => {
      if (market === 'crypto') return cryptoCandles(symbol, tf, limit);
      if (market === 'cse') return cseCandles(symbol, tf, limit);
      return yahooCandles(symbol, market, tf, limit);
    });
    res.json({ market, tf, ...out });
  } catch (e) {
    res.status(502).json({ error: 'Data fetch failed: ' + e.message });
  }
});

/* ---------- NEWS (Google News RSS, free) ---------- */
const CUR_NAMES = { USD: 'US dollar Fed', EUR: 'euro ECB', GBP: 'pound Bank of England', JPY: 'yen Bank of Japan', AUD: 'Australian dollar RBA', CAD: 'Canadian dollar', CHF: 'Swiss franc', NZD: 'New Zealand dollar', XAU: 'gold price', XAG: 'silver price' };
function newsQuery(market, symbol, name) {
  const s = symbol.toUpperCase();
  if (market === 'forex') {
    const a = s.slice(0, 3), b = s.slice(3, 6);
    const parts = [CUR_NAMES[a] || a, CUR_NAMES[b] || b].join(' OR ');
    return `${parts} forex`;
  }
  if (market === 'crypto') {
    const coin = s.replace(/(USDT|USDC|FDUSD|BUSD)$/, '');
    const names = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP Ripple', BNB: 'BNB', DOGE: 'Dogecoin', ADA: 'Cardano' };
    return `${names[coin] || coin} crypto`;
  }
  if (market === 'cse') return `${name || s.split('.')[0]} Colombo Stock Exchange`;
  return `${name || s} stock`;
}
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  const tag = (block, t) => {
    const r = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`).exec(block);
    return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
  };
  while ((m = re.exec(xml)) && items.length < 15) {
    items.push({ title: tag(m[1], 'title'), link: tag(m[1], 'link'), date: tag(m[1], 'pubDate'), source: tag(m[1], 'source') });
  }
  return items;
}
app.get('/api/news', async (req, res) => {
  const market = (req.query.market || 'crypto').toLowerCase();
  const symbol = req.query.symbol || 'BTCUSDT';
  const q = newsQuery(market, symbol, req.query.name);
  try {
    const items = await cached('news|' + q, 10 * 60 * 1000, async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const geo = market === 'cse' ? 'hl=en-LK&gl=LK&ceid=LK:en' : 'hl=en-US&gl=US&ceid=US:en';
        const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&${geo}`, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
        return parseRSS(await r.text());
      } finally { clearTimeout(timer); }
    });
    res.json({ query: q, items });
  } catch (e) {
    res.json({ query: q, items: [], error: e.message });
  }
});

/* ---------- AI PROXY ---------- */
const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
  cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama-3.3-70b' },
  gemini: { model: 'gemini-2.5-flash' }
};

async function callAI({ provider, key, model, system, prompt }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('Unknown provider ' + provider);
  const m = (model || '').trim() || p.model;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    if (provider === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.25, responseMimeType: 'application/json', maxOutputTokens: 4096 }
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `Gemini HTTP ${r.status}`);
      return { text: j?.candidates?.[0]?.content?.parts?.map(x => x.text).join('') || '', model: m };
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://pryme-analyser.onrender.com'; headers['X-Title'] = 'Pryme Analyser'; }
    const body = { model: m, temperature: 0.25, max_tokens: 4096, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
    if (provider !== 'openrouter') body.response_format = { type: 'json_object' };
    const r = await fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || j?.message || `${provider} HTTP ${r.status}`);
    return { text: j?.choices?.[0]?.message?.content || '', model: m };
  } finally { clearTimeout(timer); }
}

// Tries each enabled key in order until one works (auto failover).
app.post('/api/ai', async (req, res) => {
  const { keys = [], system, prompt } = req.body || {};
  const errors = [];
  for (const k of keys) {
    if (!k || !k.key || !k.provider) continue;
    try {
      const out = await callAI({ provider: k.provider, key: k.key, model: k.model, system, prompt });
      if (out.text) return res.json({ provider: k.provider, model: out.model, text: out.text, errors });
      errors.push(`${k.provider}: empty response`);
    } catch (e) {
      errors.push(`${k.provider}: ${e.message}`);
    }
  }
  res.status(502).json({ error: 'All AI keys failed', errors });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pryme Analyser running on http://localhost:${PORT}`));
