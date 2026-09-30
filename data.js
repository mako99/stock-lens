/* ==========================================================================
   StockLens — data layer: utils, universe, price series, indicators
   ========================================================================== */
'use strict';

/* ------------------------------------------------------------- utilities - */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussFrom(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const nf = (v, d = 2) => (v == null || !isFinite(v)) ? '—' :
  v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPrice = (v) => nf(v, Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 2 : 3);
const fmtPct = (v, d = 2) => {
  let r = Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
  if (r === 0) r = 0;
  return (r > 0 ? '+' : '') + nf(r, d) + '%';
};
function fmtBig(v) {
  const a = Math.abs(v);
  if (!isFinite(v)) return '—';
  if (a >= 1e12) return nf(v / 1e12, 2) + 'T';
  if (a >= 1e9) return nf(v / 1e9, 2) + 'B';
  if (a >= 1e6) return nf(v / 1e6, 2) + 'M';
  if (a >= 1e3) return nf(v / 1e3, 1) + 'K';
  return nf(v, 0);
}
const fmtCap = (v) => v >= 1e12 ? '$' + nf(v / 1e12, 2) + 'T' : '$' + nf(v / 1e9, 1) + 'B';
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const signCls = (v) => Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'up' : 'down';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function pal() {
  return {
    up: cssVar('--up') || '#2ee6a8',
    down: cssVar('--down') || '#ff5c7c',
    acc: cssVar('--acc') || '#5b8cff',
    acc2: cssVar('--acc-2') || '#a879ff',
    warn: cssVar('--warn') || '#ffb547',
    txt: cssVar('--txt') || '#e8edf7',
    txt2: cssVar('--txt-2') || '#93a1bd',
    txt3: cssVar('--txt-3') || '#64728d',
    grid: cssVar('--grid') || 'rgba(255,255,255,.055)',
    stroke: cssVar('--stroke') || 'rgba(255,255,255,.08)',
    panel: cssVar('--panel-solid') || '#0e1524'
  };
}
function niceTicks(min, max, n) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const step0 = (max - min) / Math.max(1, n);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  let step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  step *= mag;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) out.push(+t.toPrecision(12));
  return out;
}
function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (isNaN(n)) return 'rgba(128,128,128,' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function ctx2d(canvas) {
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  if (r.width < 3 || r.height < 3) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(r.width), h = Math.round(r.height);
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  return { ctx: ctx, w: w, h: h };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

/* -------------------------------------------------------------- universe - */
const UNIVERSE = {
  AAPL: { name: 'Apple Inc.', sector: 'Technology', industry: 'Consumer Electronics', exch: 'NASDAQ', price: 269.42, mcap: 3.98e12, rev: 416, ni: 112, eps: 7.42, beta: 1.12, div: 0.42, emp: 164000, born: 1976, hq: 'Cupertino, CA', pe: 36.3, ps: 9.6, roe: 147, gross: 46.5, op: 31.5, net: 26.4, growth: 6.1, debt: 1.87, cash: 65, shares: 14740, desc: 'Designs and markets smartphones, personal computers, tablets, wearables and a fast-growing services franchise spanning payments, media and cloud.' },
  MSFT: { name: 'Microsoft Corporation', sector: 'Technology', industry: 'Software — Infrastructure', exch: 'NASDAQ', price: 512.44, mcap: 3.81e12, rev: 281, ni: 105, eps: 14.12, beta: 0.93, div: 0.72, emp: 228000, born: 1975, hq: 'Redmond, WA', pe: 36.3, ps: 13.6, roe: 34.2, gross: 69.4, op: 44.6, net: 36.4, growth: 15.2, debt: 0.47, cash: 79, shares: 7430, desc: 'Global software leader spanning Azure cloud, Office and Dynamics productivity suites, Windows, LinkedIn and a large gaming portfolio.' },
  NVDA: { name: 'NVIDIA Corporation', sector: 'Technology', industry: 'Semiconductors', exch: 'NASDAQ', price: 186.31, mcap: 4.52e12, rev: 187, ni: 79, eps: 3.21, beta: 1.68, div: 0.02, emp: 36000, born: 1993, hq: 'Santa Clara, CA', pe: 58.0, ps: 24.2, roe: 91.4, gross: 74.9, op: 55.1, net: 42.4, growth: 62.4, debt: 0.16, cash: 54, shares: 24260, desc: 'Designs GPUs and full-stack accelerated computing platforms that power AI training, inference, graphics and autonomous systems.' },
  AMZN: { name: 'Amazon.com, Inc.', sector: 'Consumer Cyclical', industry: 'Internet Retail', exch: 'NASDAQ', price: 236.18, mcap: 2.51e12, rev: 670, ni: 68, eps: 6.32, beta: 1.31, div: 0, emp: 1556000, born: 1994, hq: 'Seattle, WA', pe: 37.4, ps: 3.7, roe: 21.6, gross: 49.2, op: 11.2, net: 10.1, growth: 11.4, debt: 0.32, cash: 92, shares: 10630, desc: 'Operates the largest online marketplace alongside AWS cloud infrastructure, advertising, logistics and Prime subscriptions.' },
  GOOGL: { name: 'Alphabet Inc.', sector: 'Communication', industry: 'Internet Content', exch: 'NASDAQ', price: 212.44, mcap: 2.56e12, rev: 381, ni: 111, eps: 8.94, beta: 1.03, div: 0.44, emp: 187000, born: 1998, hq: 'Mountain View, CA', pe: 23.8, ps: 6.7, roe: 32.1, gross: 58.2, op: 32.4, net: 29.1, growth: 13.8, debt: 0.11, cash: 96, shares: 12060, desc: 'Parent of Google Search, YouTube, Android and Google Cloud, plus long-run bets on autonomous driving and AI research.' },
  META: { name: 'Meta Platforms, Inc.', sector: 'Communication', industry: 'Internet Content', exch: 'NASDAQ', price: 705.12, mcap: 1.78e12, rev: 178, ni: 62, eps: 23.61, beta: 1.22, div: 0.32, emp: 76800, born: 2004, hq: 'Menlo Park, CA', pe: 29.9, ps: 10.0, roe: 38.4, gross: 81.7, op: 40.2, net: 34.8, growth: 20.1, debt: 0.28, cash: 74, shares: 2520, desc: 'Operates Facebook, Instagram, WhatsApp and Threads, monetised through advertising while investing heavily in AI and Reality Labs.' },
  TSLA: { name: 'Tesla, Inc.', sector: 'Consumer Cyclical', industry: 'Auto Manufacturers', exch: 'NASDAQ', price: 342.68, mcap: 1.10e12, rev: 98, ni: 8.4, eps: 2.39, beta: 2.30, div: 0, emp: 125665, born: 2003, hq: 'Austin, TX', pe: 143.4, ps: 11.2, roe: 10.4, gross: 17.9, op: 6.9, net: 8.5, growth: 1.4, debt: 0.18, cash: 36, shares: 3210, desc: 'EV manufacturer with expanding energy storage, autonomy software and robotics ambitions across global gigafactories.' },
  JPM: { name: 'JPMorgan Chase & Co.', sector: 'Financials', industry: 'Diversified Banks', exch: 'NYSE', price: 312.44, mcap: 8.70e11, rev: 175, ni: 55, eps: 19.42, beta: 1.10, div: 1.94, emp: 317000, born: 1799, hq: 'New York, NY', pe: 16.1, ps: 5.0, roe: 17.2, gross: 74, op: 41.8, net: 31.4, growth: 9.2, debt: 2.1, cash: 4, shares: 2780, desc: 'Largest US bank by assets, spanning consumer banking, investment banking, markets, asset management and commercial banking.' },
  V: { name: 'Visa Inc.', sector: 'Financials', industry: 'Credit Services', exch: 'NYSE', price: 358.16, mcap: 7.00e11, rev: 39, ni: 21, eps: 10.82, beta: 0.92, div: 0.74, emp: 31600, born: 1958, hq: 'San Francisco, CA', pe: 33.1, ps: 17.9, roe: 51.3, gross: 79.6, op: 66.9, net: 53.8, growth: 10.2, debt: 0.55, cash: 15, shares: 1950, desc: 'Operates a global payment network processing card transactions across more than 200 countries and territories.' },
  XOM: { name: 'Exxon Mobil Corporation', sector: 'Energy', industry: 'Integrated Oil & Gas', exch: 'NYSE', price: 122.36, mcap: 5.20e11, rev: 345, ni: 36, eps: 8.42, beta: 0.86, div: 3.34, emp: 61000, born: 1870, hq: 'Spring, TX', pe: 14.5, ps: 1.5, roe: 13.8, gross: 32, op: 12.4, net: 10.4, growth: -2.1, debt: 0.24, cash: 23, shares: 4250, desc: 'Integrated oil and gas major with upstream, downstream and chemical operations plus a growing low-carbon solutions unit.' },
  JNJ: { name: 'Johnson & Johnson', sector: 'Healthcare', industry: 'Drug Manufacturers', exch: 'NYSE', price: 168.24, mcap: 4.05e11, rev: 89, ni: 26, eps: 10.91, beta: 0.54, div: 3.12, emp: 131900, born: 1886, hq: 'New Brunswick, NJ', pe: 15.4, ps: 4.5, roe: 24.6, gross: 69.1, op: 25.7, net: 29.2, growth: 5.4, debt: 0.51, cash: 21, shares: 2410, desc: 'Healthcare conglomerate focused on innovative medicine and medical technology following the spin-off of its consumer unit.' },
  WMT: { name: 'Walmart Inc.', sector: 'Consumer Defensive', industry: 'Discount Stores', exch: 'NYSE', price: 108.62, mcap: 8.70e11, rev: 680, ni: 20, eps: 2.51, beta: 0.62, div: 1.02, emp: 2100000, born: 1962, hq: 'Bentonville, AR', pe: 43.3, ps: 1.3, roe: 22.4, gross: 24.4, op: 4.1, net: 2.9, growth: 4.8, debt: 0.78, cash: 12, shares: 8010, desc: "World's largest retailer operating supermarkets, discount stores and a rapidly scaling e-commerce and advertising business." },
  NFLX: { name: 'Netflix, Inc.', sector: 'Communication', industry: 'Entertainment', exch: 'NASDAQ', price: 1184.30, mcap: 5.00e11, rev: 43, ni: 9.6, eps: 22.04, beta: 1.29, div: 0, emp: 13000, born: 1997, hq: 'Los Gatos, CA', pe: 53.7, ps: 11.6, roe: 32.8, gross: 46.1, op: 26.7, net: 22.3, growth: 15.6, debt: 0.44, cash: 9, shares: 425, desc: 'Streaming entertainment leader with ad-supported tiers, live events and a global content library across 190 countries.' },
  AMD: { name: 'Advanced Micro Devices, Inc.', sector: 'Technology', industry: 'Semiconductors', exch: 'NASDAQ', price: 168.44, mcap: 2.72e11, rev: 29, ni: 2.1, eps: 1.31, beta: 1.95, div: 0, emp: 28000, born: 1969, hq: 'Santa Clara, CA', pe: 128.6, ps: 9.4, roe: 4.2, gross: 51.4, op: 8.1, net: 7.2, growth: 21.7, debt: 0.06, cash: 5, shares: 1615, desc: 'Designs high-performance CPUs, GPUs and adaptive SoCs for data centre, gaming, PC and embedded markets.' },
  DIS: { name: 'The Walt Disney Company', sector: 'Communication', industry: 'Entertainment', exch: 'NYSE', price: 122.18, mcap: 2.22e11, rev: 94, ni: 6.8, eps: 3.72, beta: 1.40, div: 0.86, emp: 225000, born: 1923, hq: 'Burbank, CA', pe: 32.8, ps: 2.4, roe: 5.9, gross: 35.8, op: 10.7, net: 7.2, growth: 4.2, debt: 0.42, cash: 14, shares: 1820, desc: 'Global entertainment company spanning streaming, parks and experiences, film studios, television networks and consumer products.' },
  KO: { name: 'The Coca-Cola Company', sector: 'Consumer Defensive', industry: 'Beverages — Non-Alcoholic', exch: 'NYSE', price: 72.14, mcap: 3.10e11, rev: 47, ni: 11.5, eps: 2.68, beta: 0.58, div: 2.94, emp: 79100, born: 1886, hq: 'Atlanta, GA', pe: 26.9, ps: 6.6, roe: 41.2, gross: 60.6, op: 30.1, net: 24.5, growth: 3.4, debt: 1.85, cash: 12, shares: 4310, desc: 'Owns and franchises a portfolio of sparkling and still beverages sold in more than 200 countries and territories.' },
  PFE: { name: 'Pfizer Inc.', sector: 'Healthcare', industry: 'Drug Manufacturers', exch: 'NYSE', price: 26.42, mcap: 1.47e11, rev: 62, ni: 8.5, eps: 1.49, beta: 0.61, div: 6.35, emp: 88000, born: 1849, hq: 'New York, NY', pe: 17.7, ps: 2.4, roe: 8.4, gross: 68.2, op: 15.7, net: 13.7, growth: -8.4, debt: 0.76, cash: 9, shares: 5560, desc: 'Global biopharmaceutical company with oncology, vaccines, inflammation and specialty care franchises.' },
  BA: { name: 'The Boeing Company', sector: 'Industrials', industry: 'Aerospace & Defense', exch: 'NYSE', price: 228.64, mcap: 1.71e11, rev: 70, ni: -4.9, eps: -6.21, beta: 1.52, div: 0, emp: 171000, born: 1916, hq: 'Arlington, VA', pe: -36.8, ps: 2.4, roe: -18.2, gross: 18.4, op: -1.8, net: -7.0, growth: 6.8, debt: 4.6, cash: 14, shares: 748, desc: 'Aerospace manufacturer building commercial jets, defence platforms and services while working through a multi-year turnaround.' },
  SPY: { name: 'SPDR S&P 500 ETF Trust', sector: 'Index', industry: 'ETF — Broad Market', exch: 'NYSE Arca', price: 685.24, mcap: 6.40e11, rev: 0, ni: 0, eps: 0, beta: 1.00, div: 1.18, emp: 0, born: 1993, hq: 'New York, NY', pe: 27.4, ps: 3.1, roe: 0, gross: 48, op: 0, net: 0, growth: 11.0, debt: 0, cash: 0, shares: 934, desc: 'Passive exchange-traded fund tracking the S&P 500 Index, the standard benchmark for US large-cap equity performance.' }
};
const SYMBOLS = Object.keys(UNIVERSE);
const DEFAULT_WATCH = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'V'];

/* ---------------------------------------------------------- live overlay -- */
/* Populated by api.js-backed loaders in app.js. Any slot left empty makes the
   matching accessor fall through to the synthetic generator above, so the whole
   UI still works with no proxy running. */
const LIVE = {
  meta: {},    // sym  -> UNIVERSE-shaped fields from live quotes/company
  daily: {},   // sym  -> full daily history from /api/chart
  intra: {},   // sym:tf -> 1D/5D intraday bars
  spark: {},   // sym:range -> short history for market tables/scrub sparklines
  fund: {},    // sym  -> fundamentals in US$ millions
  quotes: {},  // sym  -> last quote from /api/quotes
  company: {}, // sym  -> full /api/company payload
  holders: {}, // sym  -> institutional ownership + top holders (/api/holders)
  short: {},   // sym  -> short interest history (/api/short)
  news: {},    // sym  -> mapped live headlines
  market: null,
  marketNews: null,
  marketTs: 0,
  src: {},     // sym  -> 'yahoo' | 'nasdaq' | 'simulated'
  ts: {},
  loading: {}
};

function liveMeta(sym) {
  const u = UNIVERSE[sym];
  const m = LIVE.meta[sym];
  if (!m) return u || null;
  if (u) return Object.assign({}, u, m);
  return Object.assign({
    name: sym, sector: '—', industry: '—', exch: '—', price: 0, mcap: 0,
    rev: 0, ni: 0, eps: 0, beta: 1, div: 0, emp: 0, born: null, hq: '—',
    pe: null, ps: null, roe: 0, gross: 0, op: 0, net: 0, growth: 0,
    debt: 0, cash: 0, shares: 0, desc: ''
  }, m);
}

/* Only write fields that actually carry a value: an undefined must not wipe a
   synthetic default we still want as a fallback. */
function livePut(sym, key, val) {
  if (val == null || val === '' || (typeof val === 'number' && !isFinite(val))) return;
  const m = LIVE.meta[sym] || (LIVE.meta[sym] = {});
  m[key] = val;
}

/* ---------------------------------------------------------- price series - */
const _dailyCache = {};
const _intraCache = {};

function tradingDates(n, end) {
  const out = [];
  const d = new Date(end || Date.now());
  d.setHours(0, 0, 0, 0);
  while (out.length < n) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(d));
    d.setDate(d.getDate() - 1);
  }
  return out.reverse();
}

function genDaily(sym) {
  const live = LIVE.daily[sym];
  if (live && live.length > 120) return live;
  if (_dailyCache[sym]) return _dailyCache[sym];
  const lm = liveMeta(sym);
  const meta = (lm && lm.price > 0) ? lm : UNIVERSE.SPY;
  const N = 1560;
  const rnd = mulberry32(hashStr(sym) ^ 0x5eed);
  const dates = tradingDates(N);
  const bars = [];
  let drift = 0.0004 + (rnd() - 0.42) * 0.0011;
  let vol = 0.011 + rnd() * 0.013;
  let prevClose = 100;

  for (let i = 0; i < N; i++) {
    if (i % (90 + Math.floor(rnd() * 90)) === 0) {
      drift = (rnd() - 0.40) * 0.0018;
      vol = 0.009 + rnd() * 0.020;
    }
    let r = gaussFrom(rnd) * vol + drift;
    if (rnd() < 0.014) r += (rnd() < 0.45 ? -1 : 1) * vol * (2.5 + rnd() * 4);
    const o = prevClose * (1 + (rnd() - 0.5) * vol * 0.55);
    const c = Math.max(1, prevClose * (1 + r));
    const hi = Math.max(o, c) * (1 + rnd() * vol * 0.75);
    const lo = Math.min(o, c) * (1 - rnd() * vol * 0.75);
    const v = (0.55 + rnd() * 1.0) * (1 + Math.abs(r) * 22) * 1e6 * (meta.mcap > 1e12 ? 3.2 : 1);
    bars.push({ t: dates[i], o: o, h: hi, l: lo, c: c, v: v });
    prevClose = c;
  }
  const scale = meta.price / bars[bars.length - 1].c;
  for (const b of bars) { b.o *= scale; b.h *= scale; b.l *= scale; b.c *= scale; }
  _dailyCache[sym] = bars;
  return bars;
}

function genIntraday(sym, sessions, perSession) {
  const key = sym + ':' + sessions + 'x' + perSession;
  if (_intraCache[key]) return _intraCache[key];
  const daily = genDaily(sym);
  const tail = daily.slice(-sessions);
  const rnd = mulberry32(hashStr(key) ^ 0xa11);
  const bars = [];
  for (let s = 0; s < tail.length; s++) {
    const d = tail[s];
    const n = perSession;
    const vol = (d.h - d.l) / Math.max(1e-6, d.c) / Math.sqrt(n) * 0.95;
    const walk = [];
    let cum = 0;
    for (let i = 0; i < n; i++) { cum += gaussFrom(rnd) * vol; walk.push(cum); }
    const endAdj = walk[n - 1];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1 || 1);
      const bridge = walk[i] - t * endAdj;
      const px = d.o + (d.c - d.o) * t + d.c * bridge * 0.55;
      const o = i === 0 ? d.o : bars[bars.length - 1].c;
      const c = px;
      const hi = Math.max(o, c) * (1 + Math.abs(gaussFrom(rnd)) * vol * 0.4);
      const lo = Math.min(o, c) * (1 - Math.abs(gaussFrom(rnd)) * vol * 0.4);
      const mins = 9 * 60 + 30 + i * Math.round(390 / n);
      const tm = new Date(d.t);
      tm.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      bars.push({ t: tm, o: o, h: Math.max(hi, o, c), l: Math.min(lo, o, c), c: c, v: (0.5 + rnd() * 1.1) * 4e5 * (1 + (s % 2) * 0.4) });
    }
  }
  _intraCache[key] = bars;
  return bars;
}

function aggregate(bars, per) {
  if (per <= 1) return bars;
  const out = [];
  for (let i = 0; i < bars.length; i += per) {
    const g = bars.slice(i, i + per);
    if (!g.length) break;
    let h = -Infinity, l = Infinity, v = 0;
    for (const x of g) { if (x.h > h) h = x.h; if (x.l < l) l = x.l; v += x.v; }
    out.push({ t: g[0].t, o: g[0].o, c: g[g.length - 1].c, h: h, l: l, v: v });
  }
  return out;
}

function seriesFor(sym, tf) {
  if (tf === '1D' || tf === '5D') {
    const live = LIVE.intra[sym + ':' + tf];
    if (live && live.length > 10) return live;
  }
  const daily = genDaily(sym);
  const W = 320;
  if (tf === '1D') return genIntraday(sym, 8, 78);
  if (tf === '5D') return genIntraday(sym, 12, 26);
  if (tf === '1M') return daily.slice(-(22 + W));
  if (tf === '6M') return daily.slice(-(126 + W));
  if (tf === 'YTD') {
    const y = new Date().getFullYear();
    let idx = -1;
    for (let i = 0; i < daily.length; i++) if (daily[i].t.getFullYear() === y) { idx = i; break; }
    if (idx < 0) return daily.slice(-(252 + W));
    return daily.slice(Math.max(0, idx - W));
  }
  if (tf === '1Y') return daily.slice(-(252 + W));
  if (tf === '5Y') return aggregate(daily, 5);
  if (tf === 'MAX') return aggregate(daily, 21);
  return daily;
}
const TF_DEFAULT = { '1D': 78, '5D': 130, '1M': 22, '6M': 126, 'YTD': 90, '1Y': 252, '5Y': 260, 'MAX': 74 };

/* ------------------------------------------------------------ indicators - */
function sma(src, p) {
  const out = new Array(src.length).fill(null);
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    s += src[i];
    if (i >= p) s -= src[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}
function ema(src, p) {
  const out = new Array(src.length).fill(null);
  const k = 2 / (p + 1);
  let prev = null;
  for (let i = 0; i < src.length; i++) {
    if (i === p - 1) {
      let s = 0;
      for (let j = 0; j < p; j++) s += src[j];
      prev = s / p; out[i] = prev;
    } else if (i >= p) { prev = src[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}
function stdev(src, p) {
  const out = new Array(src.length).fill(null);
  for (let i = p - 1; i < src.length; i++) {
    let m = 0;
    for (let j = i - p + 1; j <= i; j++) m += src[j];
    m /= p;
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) v += Math.pow(src[j] - m, 2);
    out[i] = Math.sqrt(v / p);
  }
  return out;
}
function bollinger(src, p, k) {
  p = p || 20; k = k || 2;
  const m = sma(src, p), s = stdev(src, p);
  return {
    mid: m,
    up: m.map((v, i) => v == null ? null : v + k * s[i]),
    dn: m.map((v, i) => v == null ? null : v - k * s[i])
  };
}
function rsi(src, p) {
  p = p || 14;
  const out = new Array(src.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    const up = Math.max(0, d), dn = Math.max(0, -d);
    if (i <= p) {
      g += up / p; l += dn / p;
      if (i === p) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    } else {
      g = (g * (p - 1) + up) / p;
      l = (l * (p - 1) + dn) / p;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}
function macd(src, f, s, sig) {
  f = f || 12; s = s || 26; sig = sig || 9;
  const ef = ema(src, f), es = ema(src, s);
  const line = src.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const cleaned = line.map(v => v == null ? 0 : v);
  const sg = ema(cleaned, sig).map((v, i) => line[i] == null ? null : v);
  const hist = line.map((v, i) => (v == null || sg[i] == null) ? null : v - sg[i]);
  return { line: line, signal: sg, hist: hist };
}
function stochastic(bars, p, d) {
  p = p || 14; d = d || 3;
  const k = bars.map((b, i) => {
    if (i < p - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; }
    return hi === lo ? 50 : ((b.c - lo) / (hi - lo)) * 100;
  });
  const kv = k.map(v => v == null ? 0 : v);
  const dv = ema(kv, d).map((v, i) => k[i] == null ? null : v);
  return { k: k, d: dv };
}
function atr(bars, p) {
  p = p || 14;
  const tr = bars.map((b, i) => i === 0 ? b.h - b.l :
    Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)));
  return ema(tr, p);
}
function vwap(bars) {
  const out = [];
  let pv = 0, vv = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    out.push(vv ? pv / vv : b.c);
  }
  return out;
}
function cci(bars, p) {
  p = p || 20;
  const tp = bars.map(b => (b.h + b.l + b.c) / 3);
  const m = sma(tp, p);
  return tp.map((v, i) => {
    if (i < p - 1 || m[i] == null) return null;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += Math.abs(tp[j] - m[i]);
    s /= p;
    return s === 0 ? 0 : (v - m[i]) / (0.015 * s);
  });
}
function williams(bars, p) {
  p = p || 14;
  return bars.map((b, i) => {
    if (i < p - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; }
    return hi === lo ? -50 : ((b.c - hi) / (hi - lo)) * 100;
  });
}
function returns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i++) out.push(bars[i].c / bars[i - 1].c - 1);
  return out;
}
function annVol(bars, per) {
  per = per || 252;
  const r = returns(bars);
  if (r.length < 2) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(per) * 100;
}
function maxDD(bars) {
  let peak = -Infinity, dd = 0;
  for (const b of bars) {
    if (b.c > peak) peak = b.c;
    const d = b.c / peak - 1;
    if (d < dd) dd = d;
  }
  return dd * 100;
}
function sharpe(bars, rf) {
  rf = rf == null ? 4.1 : rf;
  const r = returns(bars);
  if (!r.length) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + Math.pow(b - m, 2), 0) / Math.max(1, r.length - 1));
  if (!sd) return 0;
  return (m * 252 - rf / 100) / (sd * Math.sqrt(252));
}

/* --------------------------------------------------------- fundamentals -- */
const _fundCache = {};
function qLabel(back) {
  const d = new Date();
  d.setMonth(d.getMonth() - back * 3);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return 'Q' + q + " '" + String(d.getFullYear()).slice(2);
}
function yLabel(i) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - i);
  return 'FY' + String(d.getFullYear()).slice(2);
}
function fyLabel(y) {
  return y == null ? '—' : 'FY' + String(y).slice(2);
}
function fundamentals(sym) {
  if (LIVE.fund[sym]) return LIVE.fund[sym];
  if (_fundCache[sym]) return _fundCache[sym];
  const u = UNIVERSE[sym];
  const rnd = mulberry32(hashStr(sym) ^ 0xbeef);
  const years = [];
  const y0 = new Date().getFullYear() - 1;
  const g = u.growth / 100;
  const rev = [], ni = [], gm = [], om = [], nm = [];
  for (let i = 5; i >= 0; i--) {
    const k = Math.pow(1 + g + (rnd() - 0.5) * 0.05, -i);
    const r = u.rev * 1000 * k;
    rev.push(r);
    const m = clamp(u.net + (rnd() - 0.5) * 4 - i * 0.35, -30, 65);
    nm.push(m);
    ni.push(r * m / 100);
    gm.push(clamp(u.gross + (rnd() - 0.5) * 3.5 - i * 0.4, 5, 92));
    om.push(clamp(u.op + (rnd() - 0.5) * 3 - i * 0.45, -40, 75));
    years.push(y0 - i + 1);
  }
  const assets = rev[0] * (0.9 + rnd() * 1.4);
  const liab = assets * (u.debt / (1 + u.debt));
  const equity = assets - liab;
  const intDebt = assets * (0.14 + rnd() * 0.12);
  const debt = liab;
  const cashV = u.cash * 1000;
  const shares = u.shares;
  const quarters = [];
  for (let i = 0; i < 8; i++) {
    const k = 1 + (7 - i) * (g / 4 + (rnd() - 0.5) * 0.02);
    const r = u.rev * 1000 / 4 * k;
    quarters.push({ label: qLabel(i), rev: r, ni: r * clamp(u.net + (rnd() - 0.5) * 5, -35, 65) / 100 });
  }
  const fcf = ni.map(v => v * (0.72 + rnd() * 0.45));
  const opCF = ni.map(v => v * (1.35 + rnd() * 0.5));
  const capex = opCF.map((v, i) => Math.max(0, v - fcf[i]));
  const res = {
    years: years, rev: rev, ni: ni, gm: gm, om: om, nm: nm,
    quarters: quarters, shares: shares, eps: ni[5] / shares,
    assets: assets, liab: liab, equity: equity, debt: debt, cash: cashV,
    netDebt: intDebt - cashV, opCF: opCF, capex: capex, fcf: fcf
  };
  _fundCache[sym] = res;
  return res;
}

/* ---------------------------------------------------------------- state -- */
const state = {
  sym: 'AAPL',
  tf: '1M',
  type: 'candle',
  log: false,
  overlays: { sma20: true, sma50: true, ema120: false, bb: false, vwap: false, pivot: false },
  panes: { vol: true, rsi: true, macd: true, stoch: false, atr: false },
  view: { start: 0, count: 22 },
  hover: null,
  tab: 'overview',
  peer: 'pe',
  watch: new Set(DEFAULT_WATCH),
  theme: 'dark'
};

function bars() { return seriesFor(state.sym, state.tf); }
function spyDaily() { return genDaily('SPY'); }
function retOver(b, n) {
  if (b.length <= n) return 0;
  return (b[b.length - 1].c / b[b.length - 1 - n].c - 1) * 100;
}
