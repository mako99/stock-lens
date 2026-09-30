'use strict';

/* ==========================================================================
   StockLens — live data layer: cached proxy client + front-end shaping
   ========================================================================== */

/* ------------------------------------------------------------- transport -- */

/* '' when this page is served by the proxy itself, absolute otherwise (file://). */
const API_BASE = (typeof location !== 'undefined' && String(location.port) === '8788')
  ? ''
  : 'http://localhost:8788';

const TTL = {
  quotes: 20e3,
  chartIntraday: 45e3,
  chartDurable: 6 * 3600e3,
  company: 10 * 60e3,
  financials: 60 * 60e3,
  news: 10 * 60e3,
  market: 60e3,
  analyst: 60 * 60e3,
  dividends: 60 * 60e3,
  shortInterest: 60 * 60e3,
  holders: 6 * 3600e3,
  search: 10 * 60e3
};

const _store = new Map();
const _inflight = new Map();

function timeoutSignal() {
  return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(15000)
    : undefined;
}

/* Fetch + TTL cache + in-flight dedupe. Resolves to the payload or null. */
function req(path, ttl) {
  const hit = _store.get(path);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.v);
  const pending = _inflight.get(path);
  if (pending) return pending;
  const job = attempt(path, ttl, 0).finally(() => { _inflight.delete(path); });
  _inflight.set(path, job);
  return job;
}

function isTimeout(e) {
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /abort|timeout/i.test(e.message || ''));
}

/*
 * Only a timeout is worth retrying: /api/market rebuilds synchronously on the proxy and
 * routinely outruns the 15s budget, so it gets two long cool-offs — the first lands
 * after the rebuild already in flight has finished and cached. Every other endpoint
 * gets one short pause. HTTP errors, dead sockets and empty payloads never retry.
 */
const RETRY_WAIT = (path) => (path.indexOf('/api/market') === 0 ? [20000, 30000] : [10000]);

function attempt(path, ttl, step) {
  return fetch(API_BASE + path, { signal: timeoutSignal() })
    .then((res) => (res && res.ok ? res.json() : null))
    .then((data) => {
      if (!data || typeof data !== 'object' || data.error || !Object.keys(data).length) return null;
      _store.set(path, { v: data, exp: Date.now() + ttl });
      return data;
    })
    .catch((err) => {
      const waits = RETRY_WAIT(path);
      if (step < waits.length && isTimeout(err)) {
        return new Promise((r) => setTimeout(r, waits[step])).then(() => attempt(path, ttl, step + 1));
      }
      return null;
    });
}

/* No public method may ever reject: sync throws and rejections collapse to null. */
function method(fn) {
  return function () {
    try {
      const out = fn.apply(null, arguments);
      if (out && typeof out.then === 'function') {
        return Promise.resolve(out).then((v) => (v === undefined ? null : v)).catch(() => null);
      }
      return Promise.resolve(out === undefined ? null : out);
    } catch (e) {
      return Promise.resolve(null);
    }
  };
}

function normSymbol(sym) {
  const s = String(sym == null ? '' : sym).trim().toUpperCase();
  return /^[A-Z0-9^][A-Z0-9.^=_-]{0,14}$/.test(s) ? s : '';
}

/* ------------------------------------------------------------ normalisers -- */

/* Yahoo reports these as fractions, Nasdaq-ish feeds sometimes as percents. */
const FRACTION_KEYS = [
  'grossMargins', 'ebitdaMargins', 'operatingMargins', 'profitMargins',
  'returnOnEquity', 'returnOnAssets', 'debtToEquity', 'revenueGrowth',
  'earningsGrowth', 'payoutRatio', 'heldByInsiders', 'heldByInstitutions',
  'heldByInstitutionsFloat'
];

function asFraction(v) {
  if (v == null) return null;
  if (typeof v !== 'number' || !isFinite(v)) return v;
  return Math.abs(v) > 1.5 ? v / 100 : v;
}

/* dividendYield is the odd one out: the front-end prints it straight as "0.32%". */
function asPercent(v) {
  if (v == null) return null;
  if (typeof v !== 'number' || !isFinite(v)) return v;
  return Math.abs(v) < 0.05 ? v * 100 : v;
}

function normaliseCompany(c) {
  const src = c.valuation;
  if (!src || typeof src !== 'object') return c;
  const v = Object.assign({}, src);
  for (let i = 0; i < FRACTION_KEYS.length; i++) {
    const k = FRACTION_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(v, k)) v[k] = asFraction(v[k]);
  }
  if (Object.prototype.hasOwnProperty.call(v, 'dividendYield')) v.dividendYield = asPercent(v.dividendYield);
  if (typeof v.sharesOutstanding === 'number' && isFinite(v.sharesOutstanding)) {
    v.sharesOutstanding = v.sharesOutstanding / 1e6; // absolute shares -> millions
  }
  return Object.assign({}, c, { valuation: v });
}

/* Per-share and share-count lines are not money and must not be rescaled. */
function isPerShareRow(label) {
  const l = String(label || '');
  return /(^|[^A-Za-z])(eps|per share)/i.test(l) || /shares outstanding|share count|ordinary shares/i.test(l);
}

/**
 * Statement values arrive in US dollars from Yahoo but in thousands from Nasdaq;
 * both land in US$ millions here, which is the unit the demo generator uses.
 * Rows are copied, never mutated — the cached payload stays pristine.
 */
function scaleStatements(d) {
  const div = d.source === 'yahoo' ? 1e6 : 1e3;
  const statements = (Array.isArray(d.statements) ? d.statements : []).map((g) => ({
    group: g && g.group,
    rows: ((g && g.rows) || []).map((r) => {
      if (!r || !Array.isArray(r.values)) return { key: r && r.key, label: r && r.label, values: [] };
      if (isPerShareRow(r.label)) return { key: r.key, label: r.label, values: r.values.slice() };
      return {
        key: r.key,
        label: r.label,
        values: r.values.map((v) => (typeof v === 'number' && isFinite(v) ? v / div : v))
      };
    })
  }));
  return {
    source: d.source || null,
    periods: Array.isArray(d.periods) ? d.periods.slice() : [],
    periodLabels: Array.isArray(d.periodLabels) ? d.periodLabels.slice() : [],
    statements: statements,
    ratios: d.ratios && Array.isArray(d.ratios.rows)
      ? { periods: Array.isArray(d.ratios.periods) ? d.ratios.periods.slice() : [], rows: d.ratios.rows }
      : null
  };
}

/* ------------------------------------------------------------- endpoints -- */

const api = {

  quotes: method(function (symbols) {
    const list = (Array.isArray(symbols) ? symbols : String(symbols == null ? '' : symbols).split(','))
      .map(normSymbol).filter(Boolean);
    if (!list.length) return Promise.resolve(null);
    return req('/api/quotes?symbols=' + encodeURIComponent(list.join(',')), TTL.quotes)
      .then((d) => (d && Array.isArray(d.quotes) && d.quotes.length ? d : null));
  }),

  chart: method(function (sym, range) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    const r = String(range == null ? '1M' : range).toUpperCase();
    const ttl = (r === '1D' || r === '5D') ? TTL.chartIntraday : TTL.chartDurable;
    return req('/api/chart?symbol=' + encodeURIComponent(s) + '&range=' + encodeURIComponent(r), ttl)
      .then((d) => {
        if (!d || !Array.isArray(d.bars)) return null;
        const bars = [];
        for (let i = 0; i < d.bars.length; i++) {
          const b = d.bars[i];
          if (!b || typeof b !== 'object') continue;
          const t = Number(b.t), c = Number(b.c);
          if (!isFinite(t) || !isFinite(c)) continue;
          // Nasdaq intraday bars only populate c; o/h/l/v stay null on purpose.
          bars.push({ t: t, o: b.o, h: b.h, l: b.l, c: c, v: b.v });
        }
        return bars.length ? Object.assign({}, d, { bars: bars }) : null;
      });
  }),

  company: method(function (sym) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    return req('/api/company?symbol=' + encodeURIComponent(s), TTL.company)
      .then((d) => {
        // A real symbol always carries a price (Nasdaq info answers even when Yahoo is
        // rate-limited); an unknown one comes back as a shell of nulls — that is a miss.
        if (!d || !d.symbol || !d.price || d.price.last == null) return null;
        return normaliseCompany(d);
      });
  }),

  financials: method(function (sym, freq) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    const f = String(freq == null ? 'annual' : freq).toLowerCase() === 'quarterly' ? 'quarterly' : 'annual';
    return req('/api/financials?symbol=' + encodeURIComponent(s) + '&freq=' + f, TTL.financials)
      .then((d) => (d && Array.isArray(d.statements) && d.statements.length ? scaleStatements(d) : null));
  }),

  analyst: method(function (sym) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    return req('/api/analyst?symbol=' + encodeURIComponent(s), TTL.analyst)
      .then((d) => (d && (d.target || (Array.isArray(d.history) && d.history.length)) ? d : null));
  }),

  dividends: method(function (sym) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    return req('/api/dividends?symbol=' + encodeURIComponent(s), TTL.dividends)
      .then((d) => (d && (d.summary || (Array.isArray(d.payments) && d.payments.length)) ? d : null));
  }),

  short: method(function (sym) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    return req('/api/short?symbol=' + encodeURIComponent(s), TTL.shortInterest)
      .then((d) => (d && Array.isArray(d.rows) && d.rows.length ? d : null));
  }),

  holders: method(function (sym) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    return req('/api/holders?symbol=' + encodeURIComponent(s), TTL.holders)
      .then((d) => (d && (d.institutionsPct != null || (d.holders && d.holders.length)) ? d : null));
  }),

  news: method(function (sym, limit) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    const n = Math.max(1, Math.min(30, Number(limit) || 12));
    return req('/api/news?symbol=' + encodeURIComponent(s) + '&limit=' + n, TTL.news)
      .then((d) => (d && Array.isArray(d.news) && d.news.length ? d : null));
  }),

  search: method(function (q) {
    const term = String(q == null ? '' : q).trim();
    if (!term) return Promise.resolve(null);
    return req('/api/search?q=' + encodeURIComponent(term), TTL.search)
      .then((d) => (d && Array.isArray(d.quotes) ? d : null));
  }),

  market: method(function () {
    return req('/api/market', TTL.market).then((d) => {
      if (!d || !Array.isArray(d.indices) || !Array.isArray(d.sectors)) return null;
      if (!d.indices.length && !d.sectors.length && !(Array.isArray(d.universe) && d.universe.length)) return null;
      return d;
    });
  }),

  /* Drops every cached response whose query string names this symbol. */
  reset: method(function (sym) {
    const s = normSymbol(sym);
    if (!s) return Promise.resolve(null);
    for (const key of Array.from(_store.keys())) if (keyHasSymbol(key, s)) _store.delete(key);
    return Promise.resolve(true);
  }),

  fundamentals: method(function (sym) {
    return buildFundamentals(normSymbol(sym));
  })
};

function keyHasSymbol(key, sym) {
  const qs = key.split('?')[1];
  if (!qs) return false;
  const pairs = qs.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const eq = pairs[i].indexOf('=');
    if (eq < 0) continue;
    const val = decodeURIComponent(pairs[i].slice(eq + 1)).toUpperCase();
    if (val === sym || val.split(',').indexOf(sym) >= 0) return true;
  }
  return false;
}

/* ---------------------------------------------------------- fundamentals -- */

/*
 * Row labels differ between the two upstreams ("Total Revenue" vs "Revenue"), so
 * every lookup tries exact labels first (most specific first) then a substring
 * test. Values are already in US$ millions, newest period first.
 */
const ROW = {
  rev: {
    exact: ['total revenue', 'revenue', 'total net revenue', 'net revenue', 'total net sales', 'net sales', 'revenues'],
    fuzzy: (l) => /(revenue|net sales)/.test(l) && !/cost|deferred|recogni/.test(l)
  },
  ni: {
    exact: ['net income', 'net income attributable to parent company', 'net earnings', 'net income attributable to owners of parent'],
    fuzzy: (l) => /net (income|earnings)/.test(l) && !/cont|applicable|attributable|adjust|non-recurring/.test(l)
  },
  assets: { exact: ['total assets'] },
  liab: { exact: ['total liabilities'] },
  equity: {
    exact: ["shareholders' equity", "stockholders' equity", 'total equity', 'total shareholders equity',
      'total stockholders equity', 'total equity (deficit)', 'equity attributable to parent'],
    fuzzy: (l) => /equity/.test(l) && !/liabilit|&/.test(l)
  },
  cash: {
    exact: ['cash and cash equivalents', 'cash & equivalents', 'cash and equivalents',
      'cash cash equivalents and short term investments'],
    fuzzy: (l) => /cash/.test(l) && /equivalent/.test(l) && !/net cash|flow/.test(l)
  },
  opCF: {
    exact: ['net cash flow-operating', 'operating cash flow', 'net cash provided by operating activities',
      'cash flow from operations', 'net cash from operating activities'],
    fuzzy: (l) => /operating/.test(l) && /(cash flow|net cash)/.test(l) && !/other|investing|financing/.test(l)
  },
  capex: {
    exact: ['capital expenditures', 'capital expenditure', 'payments to acquire property and equipment',
      'purchases of property and equipment', 'purchase of property and equipment'],
    fuzzy: (l) => /capital/.test(l) && /(expend|equipment)/.test(l)
  },
  fcf: { exact: ['free cash flow'] },
  grossProfit: { exact: ['gross profit'] },
  cost: { exact: ['cost of revenue', 'cost of goods sold', 'cost of sales'] },
  opInc: { exact: ['operating income', 'income from operations', 'operating profit', 'operating earnings'] },
  eps: {
    exact: ['diluted eps ($)', 'diluted eps', 'diluted earnings per share', 'earnings per share diluted',
      'basic eps', 'earnings per share']
  },
  shares: {
    exact: ['shares outstanding', 'total shares outstanding', 'ordinary shares number',
      'weighted average diluted shares', 'diluted average shares']
  },
  ltDebt: { exact: ['long-term debt', 'long term debt'] },
  stDebt: {
    exact: ['short-term debt / current portion of long-term debt', 'current portion of long-term debt',
      'short-term debt', 'short term debt']
  }
};

function findRow(rows, spec) {
  const exact = spec.exact || [];
  for (let i = 0; i < exact.length; i++) {
    for (let j = 0; j < rows.length; j++) if (rows[j].low === exact[i]) return rows[j];
  }
  if (spec.fuzzy) for (let j = 0; j < rows.length; j++) if (spec.fuzzy(rows[j].low)) return rows[j];
  return null;
}

function flatRows(fin) {
  const out = [];
  const groups = (fin && fin.statements) || [];
  for (let i = 0; i < groups.length; i++) {
    const rows = (groups[i] && groups[i].rows) || [];
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j];
      if (!r || !Array.isArray(r.values)) continue;
      const label = String(r.label != null ? r.label : r.key != null ? r.key : '');
      out.push({ label: label, low: label.toLowerCase().trim(), values: r.values });
    }
  }
  return out;
}

/* Newest-first source arrays -> a length-n series, oldest first (index n-1 = latest). */
function series(row, n) {
  if (!row) return null;
  const v = row.values;
  if (!Array.isArray(v) || v.length < n) return null;
  const out = v.slice(0, n).reverse();
  for (let i = 0; i < out.length; i++) if (typeof out[i] !== 'number' || !isFinite(out[i])) return null;
  return out;
}

/** Shared annual span for the required statement rows: 4..6 periods, else 0. */
function spanLen(rows) {
  let k = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i] && rows[i].values;
    if (!Array.isArray(v) || v.length < 4) return 0;
    if (v.length < k) k = v.length;
  }
  return k === Infinity ? 0 : Math.min(k, 6);
}

function latestValue(row) {
  const v = row && row.values && row.values[0];
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function derive(a, b, fn) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const v = fn(a[i], b[i]);
    if (typeof v !== 'number' || !isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

function periodYear(p) {
  const s = String(p == null ? '' : p).trim();
  const m = /(\d{4})\s*$/.exec(s);
  if (m) return +m[1];
  const d = new Date(s);
  return isNaN(d) ? null : d.getFullYear();
}

function quarterLabel(p) {
  const s = String(p == null ? '' : p).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  let mo, yr;
  if (m) {
    mo = +m[1]; yr = +m[3];
  } else {
    const d = new Date(s);
    if (isNaN(d)) return null;
    mo = d.getMonth() + 1; yr = d.getFullYear();
  }
  return 'Q' + (Math.floor((mo - 1) / 3) + 1) + ' ' + String(yr).slice(2);
}

function quarterLabels(fin) {
  const pl = Array.isArray(fin.periodLabels) ? fin.periodLabels : [];
  const ps = Array.isArray(fin.periods) ? fin.periods : [];
  const n = Math.max(pl.length, ps.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const fromLabel = pl[i] && /^Q[1-4]/i.test(String(pl[i])) ? String(pl[i]) : null;
    out.push(fromLabel || (ps[i] != null ? quarterLabel(ps[i]) : null));
  }
  return out;
}

function stepBackQuarter(label) {
  const m = /^Q\s*([1-4])\s*'?\s*(\d{2}|\d{4})$/i.exec(String(label == null ? '' : label).trim());
  if (!m) return null;
  let q = +m[1], y = +m[2];
  if (y < 100) y += 2000;
  q -= 1;
  if (q === 0) { q = 4; y -= 1; }
  return { label: 'Q' + q + ' ' + String(y).slice(2), year: y };
}

function flatMargin(co, key, k) {
  const v = co && co.valuation && co.valuation[key];
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const pct = v * 100; // valuation margins are normalised to fractions
  const out = [];
  for (let i = 0; i < k; i++) out.push(pct);
  return out;
}

async function buildFundamentals(sym) {
  if (!sym) return null;
  const res = await Promise.all([
    api.financials(sym, 'annual'),
    api.financials(sym, 'quarterly'),
    api.company(sym)
  ]);
  const ann = res[0], qtr = res[1], co = res[2];
  if (!ann || !qtr) return null;

  const aRows = flatRows(ann);
  const qRows = flatRows(qtr);

  /* --- yearly income + cash flow (up to 6 periods, oldest first; >=4 required) --- */
  const revRow = findRow(aRows, ROW.rev);
  const niRow = findRow(aRows, ROW.ni);
  const opCFRow = findRow(aRows, ROW.opCF);
  const capexRow = findRow(aRows, ROW.capex);
  const K = spanLen([revRow, niRow, opCFRow, capexRow]);
  if (!K) return null; // fewer than four years -> let demo data answer
  const rev = series(revRow, K);
  const ni = series(niRow, K);
  if (!rev || !ni) return null;

  const assets = latestValue(findRow(aRows, ROW.assets));
  const liab = latestValue(findRow(aRows, ROW.liab));
  const equity = latestValue(findRow(aRows, ROW.equity));
  const cash = latestValue(findRow(aRows, ROW.cash));
  const opCF = series(opCFRow, K);
  const capexRaw = series(capexRow, K);
  if (assets == null || liab == null || equity == null || cash == null || !opCF || !capexRaw) return null;
  const capex = capexRaw.map((v) => Math.abs(v));

  const gp = series(findRow(aRows, ROW.grossProfit), K);
  const cost = series(findRow(aRows, ROW.cost), K);
  const opInc = series(findRow(aRows, ROW.opInc), K);
  const gm = gp
    ? derive(gp, rev, (g, r) => (r ? g / r * 100 : null))
    : cost
      ? derive(cost, rev, (c, r) => (r ? (r - c) / r * 100 : null))
      : flatMargin(co, 'grossMargins', K);
  const om = opInc
    ? derive(opInc, rev, (o, r) => (r ? o / r * 100 : null))
    : flatMargin(co, 'operatingMargins', K);
  const nm = derive(ni, rev, (n, r) => (r ? n / r * 100 : null));
  if (!gm || !om || !nm) return null;

  const fcfRow = series(findRow(aRows, ROW.fcf), K);
  const fcf = fcfRow || derive(opCF, capex, (o, c) => o - c);
  if (!fcf) return null;

  /* --- balance sheet scalars: latest year --- */
  const lt = latestValue(findRow(aRows, ROW.ltDebt));
  const st = latestValue(findRow(aRows, ROW.stDebt));
  const debt = (lt != null || st != null) ? (lt || 0) + (st || 0) : assets * 0.2;
  const netDebt = debt - cash;

  /* --- shares (millions) and eps (dollars) --- */
  let shares = null;
  const v = co && co.valuation;
  if (v && typeof v.sharesOutstanding === 'number' && isFinite(v.sharesOutstanding) && v.sharesOutstanding > 0) {
    shares = v.sharesOutstanding;
  }
  if (shares == null) {
    const sv = latestValue(findRow(aRows, ROW.shares));
    if (sv != null) shares = sv >= 1e7 ? sv / 1e6 : sv;
  }
  if (shares == null && co && co.price && co.price.marketCap > 0 && co.price.last > 0) {
    shares = co.price.marketCap / co.price.last / 1e6;
  }
  if (!(shares > 0)) return null;

  let eps = latestValue(findRow(aRows, ROW.eps));
  if (eps == null && v && typeof v.eps === 'number' && isFinite(v.eps)) eps = v.eps;
  if (eps == null) eps = ni[K - 1] / shares;
  if (!isFinite(eps)) return null;

  /* --- years, newest last --- */
  const periods = Array.isArray(ann.periods) ? ann.periods : [];
  const years = [];
  for (let i = 0; i < K; i++) {
    const p = periods[periods.length - 1 - i];
    years.push(p == null ? null : periodYear(p));
  }
  if (years.some((y) => y == null)) {
    const now = new Date().getFullYear();
    for (let i = 0; i < K; i++) if (years[i] == null) years[i] = now - (K - 1 - i);
  }

  /* --- quarters, newest first, padded to 8 with annual/4 estimates --- */
  const qRevRow = findRow(qRows, ROW.rev);
  const qNiRow = findRow(qRows, ROW.ni);
  if (!qRevRow || !qNiRow) return null;
  const qLabels = quarterLabels(qtr);
  const qn = Math.min(qRevRow.values.length, qNiRow.values.length, qLabels.length);
  const quarters = [];
  for (let i = 0; i < qn; i++) {
    const r = qRevRow.values[i], n = qNiRow.values[i];
    if (typeof r === 'number' && isFinite(r) && typeof n === 'number' && isFinite(n)) {
      quarters.push({ label: qLabels[i], rev: r, ni: n });
    }
  }
  if (!quarters.length) return null;
  if (quarters.length > 8) quarters.length = 8;

  const byYear = new Map();
  for (let i = 0; i < K; i++) byYear.set(years[i], { rev: rev[i], ni: ni[i] });
  while (quarters.length < 8) {
    const step = stepBackQuarter(quarters[quarters.length - 1].label);
    if (!step) return null;
    const y = byYear.get(step.year) || byYear.get(years[0]);
    if (!y) return null;
    quarters.push({ label: step.label, rev: y.rev / 4, ni: y.ni / 4 });
  }

  return {
    years: years, rev: rev, ni: ni, gm: gm, om: om, nm: nm,
    quarters: quarters, shares: shares, eps: eps,
    assets: assets, liab: liab, equity: equity, debt: debt, cash: cash,
    netDebt: netDebt, opCF: opCF, capex: capex, fcf: fcf
  };
}
