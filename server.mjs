#!/usr/bin/env node
/**
 * StockLens data proxy + static host.
 *
 * Serves the site files and a small JSON API that aggregates live market data:
 *   - Yahoo Finance  : batch quotes (spark), OHLCV charts, fundamentals timeseries,
 *                      full quoteSummary (needs a cookie+crumb handshake), search/news
 *   - Nasdaq's open API : key stats, sector/industry, analyst targets/ratings,
 *                      financial statements, dividends, short interest
 *
 * Design notes
 *   - Zero dependencies, Node >= 18.
 *   - Every upstream call is paced, retried and cached (memory + disk). On failure we
 *     serve the last good copy ("stale-if-error") so the UI degrades instead of breaking.
 *   - Yahoo rate-limits the crumb endpoint hardest, so the crumb is fetched lazily and
 *     only renewed when Yahoo actually rejects a call.
 *   - If a source is unreachable the endpoint still answers, flagged with `source` and
 *     `degraded:true`, and the frontend falls back to its demo dataset.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.STOCKLENS_CACHE || path.join(ROOT, ".cache");
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || "0.0.0.0";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const JSON_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

/* ------------------------------------------------------------------ cache */

const CV = 8; // bump when a cached payload changes shape
const mem = new Map(); // key -> { v, exp, staleExp }
fs.mkdirSync(CACHE_DIR, { recursive: true });

const readDisk = (key) => {
  const f = path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9._:-]/g, "_") + ".json");
  try {
    const st = fs.statSync(f);
    return { raw: fs.readFileSync(f, "utf8"), mtime: st.mtimeMs };
  } catch {
    return null;
  }
};
const writeDisk = (key, raw) => {
  const f = path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9._:-]/g, "_") + ".json");
  fs.writeFile(f, raw, () => {});
};

const ck = (key) => `v${CV}:${key}`;

function cacheGet(rawKey) {
  const key = ck(rawKey);
  const e = mem.get(key);
  if (e && e.exp > Date.now()) return { value: e.v, fresh: true };
  const d = readDisk(key);
  if (d) {
    try {
      const v = JSON.parse(d.raw);
      const ttl = e?.staleExp || Infinity;
      if (e ? d.mtime < ttl : true) {
        if (!e) mem.set(key, { v, exp: 0, staleExp: Infinity });
        return { value: v, fresh: !e || e.exp > Date.now() };
      }
    } catch {
      /* corrupted cache entry */
    }
  }
  if (e) return { value: e.v, fresh: false, stale: true }; // stale-if-error
  return null;
}

function cacheSet(rawKey, value, ttlMs, staleMs = ttlMs * 6) {
  const key = ck(rawKey);
  const now = Date.now();
  mem.set(key, { v: value, exp: now + ttlMs, staleExp: now + ttlMs + staleMs });
  try {
    writeDisk(key, JSON.stringify(value));
  } catch {
    /* disk optional */
  }
}

/* ------------------------------------------------------- pacing + upstream */

const gates = new Map(); // host -> { next, coolUntil, minGap }

function gate(host) {
  if (!gates.has(host)) {
    const yahoo = host.includes("yahoo");
    // Yahoo hands out a small, bursty per-IP budget, so the gap is deliberately
    // wide and a 429 buys a long cool-down instead of an immediate retry.
    gates.set(host, { next: 0, coolUntil: 0, minGap: yahoo ? 900 : 80 });
  }
  return gates.get(host);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a slot on `host`. Throws `busy` instead of queueing indefinitely when the
 * required wait is longer than `maxWait` — callers can then fail over to another host
 * (or to cache) rather than leaving the browser hanging.
 */
async function acquire(host, maxWait = 6000) {
  const g = gate(host);
  for (let i = 0; i < 200; i++) {
    const now = Date.now();
    // Only ever move `g.next` forward when we actually win the slot, otherwise the
    // deadline recedes as fast as we approach it and the wait never terminates.
    const start = Math.max(g.next, g.coolUntil);
    if (start <= now) {
      g.next = now + g.minGap;
      return;
    }
    if (start - now > maxWait) {
      throw Object.assign(new Error(`host ${host} cooling down`), { code: 429, busy: true });
    }
    await wait(Math.min(start - now, 1000));
  }
  throw Object.assign(new Error("upstream gate timeout"), { code: 503 });
}

function penalize(host, ms) {
  const g = gate(host);
  g.coolUntil = Math.max(g.coolUntil, Date.now() + ms);
}

const stats = { requests: 0, hits: 0, upstream: 0, rateLimited: 0, errors: 0, stale: 0 };

async function jget(url, { host, retries = 1, headers = {}, maxWait = 6000 } = {}) {
  const h = host || new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await acquire(h, maxWait);
    stats.upstream++;
    try {
      const res = await fetch(url, {
        headers: { ...JSON_HEADERS, ...headers },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 429) {
        stats.rateLimited++;
        const ra = Number(res.headers.get("retry-after")) || 0;
        penalize(h, Math.max(ra * 1000, 45000));
        throw Object.assign(new Error("upstream rate limited"), { code: 429, fatal: true });
      }
      if (res.status >= 500) {
        penalize(h, 5000);
        throw Object.assign(new Error(`upstream ${res.status}`), { code: res.status, retryable: true });
      }

      const text = await res.text();
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status, body: text.slice(0, 200) });
      }
      try {
        return JSON.parse(text);
      } catch {
        throw Object.assign(new Error("invalid JSON from upstream"), { code: 502, retryable: true });
      }
    } catch (e) {
      lastErr = e;
      // Retrying a 429 on the same host only burns more of the (already exhausted)
      // budget: fail over or serve cache instead.
      if (e.fatal || e.busy) break;
      if (e.code === 401) break;
      if (e.retryable && attempt < retries) {
        await wait(350 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  stats.errors++;
  throw lastErr || new Error("upstream failed");
}

/**
 * Yahoo throttles per-host rather than per-IP: when query1 starts 429ing, query2 often
 * still answers. Every Yahoo call therefore alternates hosts (each has its own pacing
 * gate), skips a host that is already known to be cooling, and only gives up once both
 * refuse — at which point the caller falls back to its cache.
 */
async function yget(path, opts = {}) {
  const first = Math.random() < 0.5 ? "query1" : "query2";
  const order = [first, first === "query1" ? "query2" : "query1"];
  const h = opts.headers ? { ...opts.headers } : {};
  let lastErr;
  for (const host of order) {
    try {
      return await jget(`https://${host}.finance.yahoo.com${path}`, {
        ...opts,
        headers: h,
        host: `${host}.finance.yahoo.com`,
        retries: opts.retries ?? 1,
      });
    } catch (e) {
      lastErr = e;
      if (e.code !== 429) break;
    }
  }
  throw lastErr || new Error("yahoo failed");
}

/** Plain-text GET with the same pacing/caching discipline as `jget`. */
async function tget(url, { host, ttl = 300_000, cacheKey } = {}) {
  const h = host || new URL(url).host;
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit?.fresh) {
      stats.hits++;
      return hit.value;
    }
  }
  try {
    await acquire(h, 6000);
    stats.upstream++;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      stats.rateLimited++;
      penalize(h, 45000);
      throw Object.assign(new Error("rate limited"), { code: 429 });
    }
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status });
    if (cacheKey) cacheSet(cacheKey, text, ttl);
    return text;
  } catch (e) {
    if (cacheKey) {
      const hit = cacheGet(cacheKey);
      if (hit) return hit.value;
    }
    stats.errors++;
    throw e;
  }
}

const decodeXml = (v) =>
  String(v || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

function parseRssItems(xml, limit) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const blk = m[1];
    const tag = (name) => {
      const t = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\/${name}>`).exec(blk);
      return t ? decodeXml(t[1].replace(/<[^>]+>/g, "")) : "";
    };
    const title = tag("title");
    if (!title) continue;
    const link = tag("link");
    const pub = tag("pubDate");
    const srcMatch = /<source[^>]*>([\s\S]*?)<\/source>/.exec(blk);
    const t = pub ? Date.parse(pub) : null;
    items.push({
      id: tag("guid") || link || title,
      title,
      publisher: srcMatch ? decodeXml(srcMatch[1]) : linkHost(link),
      link,
      time: Number.isFinite(t) ? t : null,
      type: "STORY",
      related: [],
      thumbnail: null,
    });
  }
  return items;
}

const linkHost = (link) => {
  try {
    const h = new URL(link).hostname.replace(/^www\./, "");
    return h.includes("yahoo") ? "Yahoo Finance" : h;
  } catch {
    return "Yahoo Finance";
  }
};

/* --------------------------------------------------- Yahoo crumb handshake */

const yahoo = { cookie: "", crumb: "", crumbAt: 0, pending: null };

async function getCrumb() {
  if (yahoo.crumb && Date.now() - yahoo.crumbAt < 45 * 60_000) return yahoo.crumb;
  if (yahoo.pending) return yahoo.pending;
  yahoo.pending = (async () => {
    const host = "fc.yahoo.com";
    await acquire(host);
    stats.upstream++;
    const res = await fetch("https://fc.yahoo.com/", {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });
    const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (sc.length) yahoo.cookie = sc.map((c) => c.split(";")[0]).join("; ");
    if (!yahoo.cookie) throw new Error("no yahoo cookie");

    let lastErr = null;
    for (const h of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
      try {
        await acquire(h);
        stats.upstream++;
        const r2 = await fetch(`https://${h}/v1/test/getcrumb`, {
          headers: { "User-Agent": UA, Cookie: yahoo.cookie, Referer: "https://finance.yahoo.com/", Accept: "*/*" },
          redirect: "follow",
          signal: AbortSignal.timeout(12000),
        });
        const body = (await r2.text()).trim();
        if (!r2.ok || !body || /too many|Unauthorized|error/i.test(body)) {
          lastErr = Object.assign(new Error(`crumb ${r2.status}: ${body.slice(0, 40)}`), { code: r2.status });
          if (r2.status === 429) penalize(h, 25000);
          continue;
        }
        yahoo.crumb = body;
        yahoo.crumbAt = Date.now();
        return body;
      } catch (e) {
        lastErr = e;
      }
    }
    yahoo.cookie = "";
    throw lastErr || new Error("crumb failed");
  })().finally(() => (yahoo.pending = null));
  return yahoo.pending;
}

async function yahooSummary(symbol, modules) {
  const key = `qsum:${symbol}:${modules.length}`;
  const hit = cacheGet(key);
  if (hit?.fresh) {
    stats.hits++;
    return { ...hit.value, cached: true };
  }
  const attempts = [true, false]; // retry once after renewing the crumb
  let lastErr;
  for (const renew of attempts) {
    try {
      const crumb = renew ? await getCrumb() : yahoo.crumb;
      if (!crumb) throw Object.assign(new Error("no crumb"), { code: 401 });
      const path =
        `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
        `?modules=${modules.join(",")}&crumb=${encodeURIComponent(crumb)}`;
      const raw = await yget(path, { retries: 1, headers: { Cookie: yahoo.cookie, Referer: "https://finance.yahoo.com/" } });
      const out = { source: "yahoo", data: raw?.quoteSummary?.result?.[0] || null };
      if (out.data) cacheSet(key, out, 6 * 3600_000);
      return out;
    } catch (e) {
      lastErr = e;
      if (e.code === 401 || e.code === 429) {
        yahoo.crumb = "";
        await wait(300);
      } else break;
    }
  }
  if (hit) return { ...hit.value, cached: true, degraded: true, error: String(lastErr?.message || lastErr) };
  throw lastErr || new Error("quoteSummary failed");
}

/* -------------------------------------------------------------- yahoo core */

const RANGES = {
  "1D": { range: "1d", interval: "5m", axis: "time" },
  "5D": { range: "5d", interval: "15m", axis: "time" },
  "1M": { range: "1mo", interval: "1d", axis: "date" },
  "3M": { range: "3mo", interval: "1d", axis: "date" },
  "6M": { range: "6mo", interval: "1d", axis: "date" },
  YTD: { range: "ytd", interval: "1d", axis: "date" },
  "1Y": { range: "1y", interval: "1d", axis: "date" },
  "5Y": { range: "5y", interval: "1wk", axis: "date" },
  MAX: { range: "max", interval: "1mo", axis: "date" },
  "2Y": { range: "2y", interval: "1d", axis: "date" }, // internal: MA50/MA200 warm-up
};

/** Ranges Nasdaq's ~9-month daily feed can satisfy on its own. */
const NASDAQ_RANGES = new Set(["1M", "3M", "6M", "YTD"]);
const TRIM_DAYS = { "1M": 31, "3M": 92, "6M": 184, "1Y": 366 };

function trimToRange(bars, rangeKey) {
  if (!bars?.length) return bars || [];
  if (rangeKey === "YTD") {
    const start = Date.UTC(new Date().getFullYear(), 0, 1);
    const kept = bars.filter((b) => b.t >= start);
    return kept.length > 10 ? kept : bars;
  }
  const days = TRIM_DAYS[rangeKey];
  if (!days) return bars;
  const cutoff = Date.now() - days * 86400_000;
  const kept = bars.filter((b) => b.t >= cutoff);
  return kept.length > 5 ? kept : bars;
}

async function yahooChart(symbol, rangeKey) {
  const cfg = RANGES[rangeKey] || RANGES["1M"];
  const key = `chart:${symbol}:${cfg.range}:${cfg.interval}`;
  const hit = cacheGet(key);
  const ttl = cfg.axis === "time" ? 45_000 : 6 * 3600_000;
  if (hit?.fresh) {
    stats.hits++;
    return hit.value;
  }
  // Nasdaq carries 11+ years of daily bars plus today's minute series, so every
  // timeframe except the 5-day intraday view is answered without touching Yahoo.
  if (rangeKey !== "5D") {
    try {
      const nd = await nasdaqChart(symbol, rangeKey);
      const bars = cfg.axis === "date" ? trimToRange(nd.bars, rangeKey) : nd.bars;
      const out = { ...nd, range: rangeKey, bars };
      cacheSet(key, out, ttl, 3 * 86400_000);
      return out;
    } catch {
      /* fall through to Yahoo */
    }
  }
  // Only the 5-day intraday view still asks Yahoo; everything else answered above.
  try {
    const path =
      `/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=${cfg.range}&interval=${cfg.interval}&includePrePost=${cfg.axis === "time"}` +
      `&events=div%2Csplit`;
    const raw = await yget(path, { retries: 2 });
    const r = raw?.chart?.result?.[0];
    if (!r) throw new Error(raw?.chart?.error?.description || "empty chart");
    const m = r.meta || {};
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (c == null) continue;
      bars.push({ t: ts[i] * 1000, o: o ?? c, h: h ?? c, l: l ?? c, c, v: q.volume?.[i] || 0 });
    }
    const prev = m.chartPreviousClose ?? m.previousClose;
    const out = {
      source: "yahoo",
      symbol: m.symbol || symbol,
      name: m.longName || m.shortName || symbol,
      currency: m.currency || "USD",
      exchange: m.fullExchangeName || m.exchangeName || "",
      type: m.instrumentType || "EQUITY",
      granularity: cfg.interval,
      axis: cfg.axis,
      range: rangeKey,
      bars,
      prevClose: prev,
      price: m.regularMarketPrice ?? bars.at(-1)?.c ?? null,
      change: m.fulldayChange ?? (prev != null && m.regularMarketPrice != null ? m.regularMarketPrice - prev : null),
      changePct:
        m.fulldayChangePercent ??
        (prev && m.regularMarketPrice != null ? ((m.regularMarketPrice - prev) / prev) * 100 : null),
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      open: bars.find((b) => b.o != null)?.o ?? m.regularMarketOpen ?? null,
      volume: m.regularMarketVolume ?? null,
      high52: m.fiftyTwoWeekHigh ?? null,
      low52: m.fiftyTwoWeekLow ?? null,
      marketTime: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
      timezone: m.exchangeTimezoneName || "America/New_York",
      session: m.currentTradingPeriod || null,
      events: r.events || null,
    };
    cacheSet(key, out, ttl, 3 * 86400_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    // Yahoo is refusing: Nasdaq still has the daily bars for most US equities.
    try {
      const nd = await nasdaqChart(symbol, rangeKey === "5D" ? "1M" : rangeKey);
      const bars =
        rangeKey === "5D"
          ? nd.bars.slice(-5)
          : trimToRange(nd.bars, rangeKey);
      const out = { ...nd, range: rangeKey, granularity: rangeKey === "5D" ? "1d" : nd.granularity, bars, degraded: true };
      cacheSet(key, out, ttl, 3 * 86400_000);
      return out;
    } catch {
      /* nothing else to try */
    }
    throw e;
  }
}

async function yahooQuotes(symbols) {
  const key = "spark:" + symbols.join(",");
  const hit = cacheGet(key);
  if (hit?.fresh && Date.now() - (hit.value?.fetchedAt || 0) < 40_000) {
    stats.hits++;
    return hit.value;
  }
  try {
    const path =
      "/v7/finance/spark?symbols=" + encodeURIComponent(symbols.join(",")) + "&range=1d&interval=5m";
    const raw = await yget(path, { retries: 2 });
    const list = raw?.spark?.result || [];
    const quotes = list.map((item) => {
      const resp = Array.isArray(item.response) ? item.response : [item.response];
      const m = resp?.[0]?.meta || {};
      return {
        symbol: m.symbol || item.symbol,
        name: m.longName || m.shortName || item.symbol,
        price: m.regularMarketPrice ?? null,
        change: m.fulldayChange ?? null,
        changePct: m.fulldayChangePercent ?? m.regularMarketChangePercent ?? null,
        prevClose: m.previousClose ?? m.chartPreviousClose ?? null,
        open: m.regularMarketOpen ?? null,
        high: m.regularMarketDayHigh ?? null,
        low: m.regularMarketDayLow ?? null,
        volume: m.regularMarketVolume ?? null,
        currency: m.currency || "USD",
        exchange: m.fullExchangeName || m.exchangeName || "",
        type: m.instrumentType || "EQUITY",
        marketTime: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
        high52: m.fiftyTwoWeekHigh ?? null,
        low52: m.fiftyTwoWeekLow ?? null,
      };
    });
    const out = { source: "yahoo", fetchedAt: Date.now(), quotes };
    cacheSet(key, out, 40_000, 86400_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    try {
      const live = await nasdaqLiveQuotes(symbols);
      if (live?.quotes?.length) return live;
    } catch {
      /* fall through to the delayed bulk feed */
    }
    try {
      const bulk = await nasdaqBatchQuotes(symbols);
      if (bulk?.quotes?.length) return bulk;
    } catch {
      /* nothing else to try */
    }
    throw e;
  }
}

async function yahooTimeseries(symbol, types, freq) {
  const key = `ts:${symbol}:${freq}:${types.join(",")}`;
  const hit = cacheGet(key);
  if (hit?.fresh) {
    stats.hits++;
    return hit.value;
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const path =
      `/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
      `?type=${types.join(",")}&period1=${now - 12 * 31557600}&period2=${now + 86400}`;
    const raw = await yget(path, { retries: 2 });
    const res = raw?.timeseries?.result || [];
    const series = {};
    for (const r of res) {
      const t = r.meta?.type?.[0];
      if (!t) continue;
      const arr = r[t] || [];
      series[t] = arr
        .filter(Boolean)
        .map((p) => ({
          date: p.asOfDate,
          raw: p.reportedValue?.raw ?? null,
          fmt: p.reportedValue?.fmt ?? null,
          periodType: p.periodType,
        }));
    }
    const out = { source: "yahoo", symbol, series };
    cacheSet(key, out, 24 * 3600_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

/* ----------------------------------------------------------- Nasdaq (open) */

const ND = "api.nasdaq.com";
const ndget = (p) => jget(`https://${ND}${p}`, { host: ND, retries: 1, headers: { Referer: "https://www.nasdaq.com/" } });

const num = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[$,%\s,]/g, "").replace(/^\((.*)\)$/, "-$1");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
const raw = (o) => (o && typeof o === "object" && "raw" in o ? o.raw : o);

async function nasdaqQuoteInfo(symbol) {
  const key = `nd:info:${symbol}`;
  const hit = cacheGet(key);
  if (hit?.fresh) return hit.value;
  try {
    const a = await ndget(`/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`);
    const b = await ndget(`/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=stocks`);
    const info = a?.data || {};
    const p = info.primaryData || {};
    const ks = info.keyStats || {};
    const sd = b?.data?.summaryData || {};
    const split = (v) => String(v || "").split("-").map((x) => num(x));
    const [low52, high52] = split(ks.fiftyTwoWeekHighLow?.value);
    const [dayLow, dayHigh] = split(ks.dayrange?.value);
    const summary = Object.fromEntries(Object.entries(sd).map(([k, v]) => [k, v.value]));
    const last = num(p.lastSalePrice);
    const change = num(p.netChange);
    const out = {
      source: "nasdaq",
      company: info.companyName || null,
      exchange: info.exchange || null,
      marketStatus: info.marketStatus || null,
      realTime: p.isRealTime ?? null,
      asOf: p.lastTradeTimestamp || null,
      bid: num(p.bidPrice),
      ask: num(p.askPrice),
      sector: sd.Sector?.value || null,
      industry: sd.Industry?.value || null,
      target1y: num(sd.OneYrTarget?.value),
      marketCap: num(sd.MarketCap?.value),
      avgVolume: num(sd.AverageVolume?.value),
      prevClose: num(sd.PreviousClose?.value),
      last,
      change,
      changePct: num(p.percentageChange),
      open: null,
      dayHigh,
      dayLow,
      volume: num(p.volume),
      high52,
      low52,
      yieldPct: num(sd.Yield?.value),
      annualDividend: num(sd.AnnualizedDividend?.value),
      exDividendDate: sd.ExDividendDate?.value || null,
      summary,
    };
    cacheSet(key, out, 3600_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

/**
 * Daily OHLCV straight from Nasdaq's open API: ~9 months of history, keyless and not
 * subject to Yahoo's budget. Short-range charts therefore cost no upstream quota at all.
 */
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Nasdaq stamps intraday points with the New York *wall clock* rendered as if it were
 * UTC (4:00 AM ET arrives as 04:00Z). Subtracting the zone offset at that instant puts
 * them back on the real timeline so 09:30-16:00 ET labels correctly everywhere.
 */
const nyOffsetCache = new Map();
function nyOffset(ms) {
  const day = Math.floor(ms / 86400_000);
  if (nyOffsetCache.has(day)) return nyOffsetCache.get(day);
  let off = -5 * 3600_000;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === "24" ? 0 : +p.hour, +p.minute, +p.second);
    off = asUTC - ms;
  } catch {
    /* keep the standard-time guess */
  }
  nyOffsetCache.set(day, off);
  return off;
}

async function nasdaqChart(symbol, rangeKey = "6M") {
  // Bare endpoint -> today's 1-minute series (right for 1D); with from/to dates it
  // returns daily OHLCV for the window (right for every daily range).
  const intraday = rangeKey === "1D";
  const key = `nd:chart:${symbol}:${intraday ? "1d-intraday" : rangeKey}`;
  const hit = cacheGet(key);
  if (hit?.fresh) {
    stats.hits++;
    return hit.value;
  }
  const days = { "1M": 31, "3M": 92, "6M": 184, YTD: 0, "1Y": 370, "5Y": 1830, MAX: 4000 }[rangeKey] ?? 184;
  const to = Date.now();
  const from = rangeKey === "YTD" ? Date.UTC(new Date().getFullYear(), 0, 1) : to - days * 86400_000;
  try {
    /* ETFs (SPY, XLK, ...) only answer under assetclass=etf */
    let d = null, rows = null;
    for (const ac of ["stocks", "etf"]) {
      const qs = intraday
        ? `/api/quote/${encodeURIComponent(symbol)}/chart?assetclass=${ac}`
        : `/api/quote/${encodeURIComponent(symbol)}/chart?assetclass=${ac}&fromdate=${iso(from)}&todate=${iso(to)}`;
      try {
        const res = (await ndget(qs))?.data;
        if (res?.chart?.length) { d = res; rows = res.chart; break; }
      } catch {
        /* wrong asset class (or throttled) — try the next */
      }
    }
    if (!rows) throw new Error("empty nasdaq chart");
    const bars = rows
      .map((r) => {
        const wall = Number(r.x);
        return {
          t: intraday ? wall - nyOffset(wall) : wall,
          o: num(r.z?.open) ?? (intraday ? null : num(r.z?.value)),
          h: num(r.z?.high) ?? (intraday ? null : num(r.z?.value)),
          l: num(r.z?.low) ?? (intraday ? null : num(r.z?.value)),
          c: num(r.z?.close) ?? num(r.z?.value) ?? num(r.y),
          v: num(r.z?.volume),
        };
      })
      .filter((b) => b.t && b.c != null);
    if (!bars.length) throw new Error("nasdaq chart had no bars");
    const price = num(d.lastSalePrice);
    const change = num(d.netChange);
    const out = {
      source: "nasdaq",
      symbol: d.symbol || symbol,
      name: d.company || symbol,
      currency: "USD",
      exchange: d.exchange || null,
      type: "EQUITY",
      granularity: intraday ? "1m" : "1d",
      axis: intraday ? "time" : "date",
      range: rangeKey,
      bars,
      prevClose: num(d.previousClose),
      price,
      change,
      changePct: num(d.percentageChange),
      dayHigh: null,
      dayLow: null,
      open: null,
      volume: null,
      high52: null,
      low52: null,
      marketTime: null,
      timezone: "America/New_York",
      session: null,
      events: null,
    };
    cacheSet(key, out, intraday ? 45_000 : 5 * 60_000, 7 * 86400_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

/**
 * Live per-symbol quotes from Nasdaq's `info` feed. The screener only carries the
 * previous close, so it is used purely as a last resort and is flagged `delayed`.
 */
async function nasdaqLiveQuotes(symbols) {
  const wanted = symbols.filter((s) => !s.includes("^"));
  const out = [];
  await pool(wanted.slice(0, 40), 6, async (s) => {
    try {
      // Sector/style ETFs live under `assetclass=etf`; stocks are the default feed.
      let d = null;
      for (const ac of ["stocks", "etf"]) {
        const r = await ndget(`/api/quote/${encodeURIComponent(s)}/info?assetclass=${ac}`);
        if (r?.data?.primaryData?.lastSalePrice) {
          d = r.data;
          break;
        }
      }
      if (!d) return;
      const p = d.primaryData || {};
      const price = num(p.lastSalePrice);
      const change = num(p.netChange);
      out.push({
        symbol: d.symbol || s,
        name: d.companyName || s,
        price,
        change,
        changePct: num(p.percentageChange),
        prevClose: price != null && change != null ? price - change : null,
        open: null,
        high: num(d.keyStats?.dayrange?.value?.split("-")[1]),
        low: num(d.keyStats?.dayrange?.value?.split("-")[0]),
        volume: num(p.volume),
        currency: "USD",
        exchange: d.exchange || null,
        type: "EQUITY",
        marketTime: null,
        asOf: p.lastTradeTimestamp || null,
        bid: num(p.bidPrice),
        ask: num(p.askPrice),
        marketStatus: d.marketStatus || null,
        live: true,
        high52: num(d.keyStats?.fiftyTwoWeekHighLow?.value?.split("-")[1]),
        low52: num(d.keyStats?.fiftyTwoWeekHighLow?.value?.split("-")[0]),
      });
    } catch {
      /* one missing symbol must not sink the batch */
    }
  });
  if (!out.length) throw new Error("nasdaq quotes unavailable");
  return { source: "nasdaq", fetchedAt: Date.now(), quotes: out, degraded: true };
}

/** Last resort: the screener is a bulk feed of the previous close. */
async function nasdaqBatchQuotes(symbols) {
  const key = "nd:screen";
  const hit = cacheGet(key);
  if (hit?.fresh && Date.now() - (hit.value?.fetchedAt || 0) < 45_000) {
    stats.hits++;
    return hit.value;
  }
  try {
    const d = (await ndget("/api/screener/stocks?tableonly=true&limit=500"))?.data;
    const rows = d?.table?.rows || [];
    if (!rows.length) throw new Error("empty screener");
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    const quotes = symbols
      .filter((s) => !s.includes("^"))
      .map((s) => {
        const r = bySym.get(s) || bySym.get(s.replace(".", "-"));
        if (!r) return null;
        const price = num(r.lastsale);
        const change = num(r.netchange);
        return {
          symbol: s,
          name: r.name || s,
          price,
          change,
          changePct: num(r.pctchange),
          prevClose: price != null && change != null ? price - change : null,
          open: null,
          high: null,
          low: null,
          volume: null,
          currency: "USD",
          exchange: null,
          type: "EQUITY",
          marketTime: null,
          high52: null,
          low52: null,
          marketCap: num(r.marketCap),
          delayed: true,
        };
      })
      .filter(Boolean);
    if (!quotes.length) throw new Error("no screener overlap");
    const out = { source: "nasdaq", fetchedAt: Date.now(), quotes, delayed: true };
    cacheSet(key, out, 45_000, 86400_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}

async function nasdaqFinancials(symbol, freq) {
  const key = `nd:fin:${symbol}:${freq}`;
  const hit = cacheGet(key);
  if (hit?.fresh) return hit.value;
  try {
    const d = (await ndget(`/api/company/${encodeURIComponent(symbol)}/financials?frequency=${freq}`))?.data;
    if (!d) throw new Error("no nasdaq financials");
    // Nasdaq puts the row name in `value1` and the four (newest-first) periods in
    // `value2..value5`; rows whose period cells are all empty are section headings.
    const parse = (t) => {
      if (!t) return null;
      const heads = t.headers || {};
      const cols = Object.keys(heads).filter((k) => /^value[2-9]$/.test(k));
      const periods = cols.map((c) => heads[c]);
      const rows = (t.rows || [])
        .filter((r) => r.value1)
        .map((r) => ({
          label: r.value1,
          values: cols.map((c) => num(r[c])),
          heading: cols.every((c) => !r[c]),
        }));
      return { periods, rows };
    };
    const out = {
      source: "nasdaq",
      symbol,
      tabs: d.tabs || null,
      income: parse(d.incomeStatementTable),
      balance: parse(d.balanceSheetTable),
      cashflow: parse(d.cashFlowTable),
      ratios: parse(d.financialRatiosTable),
    };
    cacheSet(key, out, 12 * 3600_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

async function nasdaqAnalyst(symbol) {
  const key = `nd:an:${symbol}`;
  const hit = cacheGet(key);
  if (hit?.fresh) return hit.value;
  try {
    const [t, r] = await Promise.allSettled([
      ndget(`/api/analyst/${encodeURIComponent(symbol)}/targetprice`),
      ndget(`/api/analyst/${encodeURIComponent(symbol)}/ratings`),
    ]);
    const td = t.status === "fulfilled" ? t.value?.data : null;
    const rd = r.status === "fulfilled" ? r.value?.data : null;
    const out = {
      source: "nasdaq",
      target: td?.consensusOverview || null,
      history: (td?.historicalConsensus || []).map((h) => ({
        date: h.z?.date,
        consensus: h.z?.consensus,
        buy: h.z?.buy,
        hold: h.z?.hold,
        sell: h.z?.sell,
        price: h.y,
      })),
      meanRating: rd?.meanRatingType || null,
      ratingSummary: rd?.ratingsSummary || null,
      brokers: rd?.brokerNames || [],
      upgradesDowngrades: (rd?.upgradesDowngrades || []).map((u) => ({
        date: u.datePosted,
        action: u.action,
        firm: u.firm,
        from: u.ratingFrom,
        to: u.ratingTo,
        target: num(u.targetFrom || u.targetTo),
      })),
    };
    if (td || rd) cacheSet(key, out, 6 * 3600_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

/** Nasdaq reports trailing P/E next to the dividend yield; usable when Yahoo is down. */
async function nasdaqPe(symbol) {
  const key = `nd:pe:${symbol}`;
  const hit = cacheGet(key);
  if (hit?.fresh) return hit.value;
  try {
    const d = (await nasdaqDividends(symbol))?.summary;
    if (!d?.payoutRatio) throw new Error("no pe");
    const out = { pe: d.payoutRatio };
    cacheSet(key, out, 6 * 3600_000);
    return out;
  } catch {
    return null;
  }
}

async function nasdaqDividends(symbol) {
  const key = `nd:div:${symbol}`;
  const hit = cacheGet(key);
  if (hit?.fresh) return hit.value;
  try {
    const d = (await ndget(`/api/quote/${encodeURIComponent(symbol)}/dividends?assetclass=stocks`))?.data;
    if (!d) throw new Error("no dividend data");
    const rows = (d.dividends?.rows || []).map((x) => ({
      date: x.exOrEffDate || null,
      type: x.type || null,
      amount: num(x.amount),
      declared: x.declarationDate || null,
      record: x.recordDate || null,
      paid: x.paymentDate || null,
    }));
    const out = {
      source: "nasdaq",
      summary: {
        yieldPct: num(d.yield),
        annual: num(d.annualizedDividend),
        payoutRatio: num(d.payoutRatio),
        exDate: d.exDividendDate || null,
        payDate: d.dividendPaymentDate || null,
        headers: d.dividendHeaderValues || [],
      },
      payments: rows,
    };
    cacheSet(key, out, 12 * 3600_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

async function nasdaqShort(symbol) {
  const key = `nd:short:${symbol}`;
  const hit = cacheGet(key);
  if (hit?.fresh) return hit.value;
  try {
    const d = (await ndget(`/api/quote/${encodeURIComponent(symbol)}/short-interest?assetclass=stocks`))?.data;
    const rows = (d?.shortInterestTable?.rows || []).map((r) => ({
      date: r.settlementDate || null,
      interest: num(r.interest),
      avgVolume: num(r.avgDailyShareVolume),
      daysToCover: num(r.daysToCover),
    }));
    if (!rows.length) throw new Error("no short interest");
    const out = {
      source: "nasdaq",
      rows: rows.slice(0, 8),
      latest: rows[0] || null,
    };
    cacheSet(key, out, 6 * 3600_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

/** Institutional ownership, position changes and top holders from Nasdaq's 13F feed. */
async function nasdaqHolders(symbol) {
  const key = `nd:holders:${symbol}`;
  const hit = cacheGet(key);
  if (hit?.fresh) return hit.value;
  try {
    const d = (await ndget(
      `/api/company/${encodeURIComponent(symbol)}/institutional-holdings?limit=12&offset=0`
    ))?.data;
    const os = d?.ownershipSummary || {};
    const instPct = num(os.SharesOutstandingPCT?.value);
    const sharesOutM = num(os.ShareoutstandingTotal?.value);
    const holdingsValueM = num(os.TotalHoldingsValue?.value); // upstream label: millions
    const rowsOf = (t) => (t?.rows || []).map((r) => ({
      label: r.positions || null,
      holders: num(r.holders),
      shares: num(r.shares),
    })).filter((r) => r.label);
    const positions = rowsOf(d?.activePositions);
    const movement = rowsOf(d?.newSoldOutPositions);
    const ht = d?.holdingsTransactions || {};
    const holders = (ht.table?.rows || []).map((r) => ({
      name: r.ownerName || null,
      date: r.date || null,
      shares: num(r.sharesHeld),
      chg: num(r.sharesChange),
      chgPct: num(r.sharesChangePCT),
      valueK: num(r.marketValue), // upstream: value in 1,000s
    })).filter((h) => h.name && h.shares != null);
    if (instPct == null && !holders.length) throw new Error("no holdings");
    const asOf = holders.reduce((best, x) => {
      const t = x.date ? Date.parse(x.date) : 0;
      return t > best.t ? { t, d: x.date } : best;
    }, { t: 0, d: null }).d;
    const out = {
      source: "nasdaq",
      symbol,
      institutionsPct: instPct,
      sharesOutM,
      holdingsValueM,
      positions,
      movement,
      totals: { holders: num(ht.totalRecords), sharesHeld: num(ht.sharesHeld) },
      holders: holders.slice(0, 10),
      asOf,
    };
    cacheSet(key, out, 6 * 3600_000);
    return out;
  } catch (e) {
    if (hit) return { ...hit.value, stale: true };
    throw e;
  }
}

/* ---------------------------------------------------------- normalization */

const SUMMARY_MODULES = [
  "price",
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
  "assetProfile",
  "recommendationTrend",
  "majorHoldersBreakdown",
  "institutionOwnership",
  "insiderTransactions",
  "insiderTransactions",
  "earnings",
  "calendarEvents",
  "indexTrend",
  "industryTrend",
].filter((v, i, a) => a.indexOf(v) === i);

/** Fills targets/consensus from Nasdaq when quoteSummary could not be reached. */
function mergeAnalyst(out, an) {
  const t = an.target || {};
  const tgt = out.targets;
  tgt.mean ??= t.priceTarget;
  tgt.low ??= t.lowPriceTarget;
  tgt.high ??= t.highPriceTarget;
  tgt.buy ??= t.buy;
  tgt.hold ??= t.hold;
  tgt.sell ??= t.sell;
  tgt.nasdaqRating ??= an.meanRating;
  tgt.nasdaqSummary ??= an.ratingSummary;
  tgt.brokers = tgt.brokers?.length ? tgt.brokers : an.brokers || [];
  tgt.upgradesDowngrades = tgt.upgradesDowngrades?.length ? tgt.upgradesDowngrades : an.upgradesDowngrades || [];
  if (!out.trend?.length && an.history?.length) {
    const last = an.history[an.history.length - 1];
    out.trend = [
      { period: last.date, strongBuy: 0, buy: last.buy, hold: last.hold, sell: last.sell, strongSell: 0 },
    ];
  }
}

function parseNdDate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function normalizeCompany(sym, ys, nd) {
  const g = (mod, k) => ys?.[mod]?.[k];
  const price = ys?.price || {};
  const sd = ys?.summaryDetail || {};
  const dk = ys?.defaultKeyStatistics || {};
  const fd = ys?.financialData || {};
  const ap = ys?.assetProfile || {};
  const mh = ys?.majorHoldersBreakdown || {};
  const rec = ys?.recommendationTrend?.trend || [];
  const earn = ys?.earnings?.earningsChart || {};
  const cal = ys?.calendarEvents?.earnings || {};

  const instList = (ys?.institutionOwnership?.ownershipList || []).slice(0, 12).map((o) => ({
    org: o.organization,
    pctHeld: raw(o.pctHeld),
    shares: raw(o.position),
    value: raw(o.value),
    change: raw(o.pctChange),
  }));
  const insider = (ys?.insiderTransactions?.transactions || []).slice(0, 12).map((t) => ({
    name: t.filer || t.name,
    text: t.text,
    shares: raw(t.shares),
    value: raw(t.value),
    start: t.startText || null,
    ownership: t.ownership || null,
  }));

  return {
    source: ys ? "yahoo" : "nasdaq",
    symbol: sym,
    name: price.longName || price.shortName || nd?.company || sym,
    shortName: price.shortName || null,
    exchange: price.fullExchangeName || nd?.exchange || null,
    currency: price.currency || "USD",
    quoteType: price.quoteType || "EQUITY",
    sector: ap.industry ? ap.sector || nd?.sector : nd?.sector,
    industry: ap.industry || nd?.industry || null,
    employees: raw(ap.fullTimeEmployees) || null,
    website: ap.website || null,
    description: ap.longBusinessSummary || null,
    country: ap.country || null,
    price: {
      last: raw(price.regularMarketPrice) ?? nd?.last ?? null,
      prevClose: raw(sd.regularMarketPreviousClose ?? sd.previousClose) ?? nd?.prevClose ?? null,
      open: raw(sd.regularMarketOpen ?? sd.open) ?? nd?.open ?? null,
      high: raw(sd.regularMarketDayHigh ?? sd.dayHigh) ?? nd?.dayHigh ?? null,
      low: raw(sd.regularMarketDayLow ?? sd.dayLow) ?? nd?.dayLow ?? null,
      change: raw(price.regularMarketChange) ?? nd?.change ?? null,
      changePct: raw(price.regularMarketChangePercent) ?? nd?.changePct ?? null,
      volume: raw(price.regularMarketVolume) ?? nd?.volume ?? null,
      avgVolume: raw(sd.averageVolume ?? sd.averageDailyVolume10Day) ?? nd?.avgVolume ?? null,
      marketCap: raw(price.marketCap) ?? nd?.marketCap ?? null,
      high52: raw(sd.fiftyTwoWeekHigh) ?? nd?.high52 ?? null,
      low52: raw(sd.fiftyTwoWeekLow) ?? nd?.low52 ?? null,
      beta: raw(sd.beta) ?? null,
      asOf: nd?.asOf ?? null,
      marketStatus: nd?.marketStatus ?? null,
      preMarket: raw(price.preMarketPrice) ?? null,
      postMarket: raw(price.postMarketPrice) ?? null,
      bid: nd?.bid ?? null,
      ask: nd?.ask ?? null,
      marketTime: raw(price.regularMarketTime) ? raw(price.regularMarketTime) * 1000 : null,
      isRealTime: nd?.realTime ?? null,
    },
    valuation: {
      trailingPE: raw(sd.trailingPE) ?? null,
      forwardPE: raw(sd.forwardPE ?? dk.forwardPE) ?? null,
      peg: raw(dk.pegRatio) ?? null,
      priceToSales: raw(sd.priceToSalesTrailing12Months ?? dk.priceToSalesTrailing12Months) ?? null,
      priceToBook: raw(dk.priceToBook) ?? null,
      enterpriseValue: raw(dk.enterpriseValue) ?? null,
      evToEbitda: raw(dk.enterpriseToEbitda) ?? null,
      evToRevenue: raw(dk.enterpriseToRevenue) ?? null,
      eps: raw(dk.trailingEps) ?? null,
      epsForward: raw(dk.forwardEps) ?? null,
      epsCurrentYear: raw(dk.epsCurrentYear) ?? null,
      priceToEpsCurrentYear: raw(dk.priceToCurrentYearEps) ?? null,
      bookValue: raw(dk.bookValue) ?? null,
      cashPerShare: raw(dk.cashPerShare) ?? null,
      totalCash: raw(fd.totalCash) ?? null,
      totalDebt: raw(fd.totalDebt) ?? null,
      debtToEquity: raw(fd.debtToEquity) ?? null,
      currentRatio: raw(fd.currentRatio) ?? null,
      quickRatio: raw(fd.quickRatio) ?? null,
      grossMargins: raw(fd.grossMargins) ?? null,
      ebitdaMargins: raw(fd.ebitdaMargins) ?? null,
      operatingMargins: raw(fd.operatingMargins) ?? null,
      profitMargins: raw(fd.profitMargins ?? dk.profitMargins) ?? null,
      returnOnEquity: raw(fd.returnOnEquity) ?? null,
      returnOnAssets: raw(fd.returnOnAssets) ?? null,
      revenueGrowth: raw(fd.revenueGrowth) ?? null,
      earningsGrowth: raw(fd.earningsGrowth) ?? null,
      dividendYield: raw(sd.dividendYield) ?? nd?.yieldPct ?? null,
      dividendRate: raw(sd.dividendRate) ?? nd?.annualDividend ?? null,
      payoutRatio: raw(sd.payoutRatio) ?? null,
      // Nasdaq's dividend feed labels this field "P/E Ratio" — a usable trailing PE.
      peFromNasdaq: nd?.payoutRatio != null ? nd.payoutRatio : null,
      exDividendDate: raw(sd.exDividendDate)
        ? raw(sd.exDividendDate) * 1000
        : parseNdDate(nd?.exDividendDate),
      freeCashFlow: raw(fd.freeCashFlow) ?? null,
      operatingCashFlow: raw(fd.operatingCashFlow) ?? null,
      sharesOutstanding: raw(dk.sharesOutstanding) ?? null,
      floatShares: raw(dk.floatShares) ?? null,
      shortRatio: raw(dk.shortRatio) ?? null,
      shortPctFloat: raw(dk.sharesPercentSharesOut) ?? null,
      heldByInsiders: raw(mh.insidersPercentHeld) ?? null,
      heldByInstitutions: raw(mh.institutionsPercentHeld) ?? null,
      heldByInstitutionsFloat: raw(mh.institutionsFloatPercentHeld) ?? null,
      institutionsCount: raw(mh.institutionsCount) ?? null,
      enterpriseToEbitda: raw(dk.enterpriseToEbitda) ?? null,
    },
    targets: {
      mean: raw(fd.targetMeanPrice) ?? nd?.target?.priceTarget ?? null,
      median: raw(fd.targetMedianPrice) ?? null,
      low: raw(fd.targetLowPrice) ?? nd?.target?.lowPriceTarget ?? null,
      high: raw(fd.targetHighPrice) ?? nd?.target?.highPriceTarget ?? null,
      current: raw(fd.currentPrice) ?? null,
      recommendation: fd.recommendationKey || null,
      recommendationMean: raw(fd.recommendationMean) ?? null,
      analysts: raw(fd.numberOfAnalysts) ?? null,
      buy: nd?.target?.buy ?? null,
      hold: nd?.target?.hold ?? null,
      sell: nd?.target?.sell ?? null,
      nasdaqRating: nd?.meanRating || null,
      nasdaqSummary: nd?.ratingSummary || null,
      brokers: nd?.brokers || [],
      upgradesDowngrades: nd?.upgradesDowngrades || [],
    },
    trend: rec.map((t) => ({
      period: t.period,
      strongBuy: t.strongBuy,
      buy: t.buy,
      hold: t.hold,
      sell: t.sell,
      strongSell: t.strongSell,
    })),
    holders: {
      insidersPct: raw(mh.insidersPercentHeld) ?? null,
      institutionsPct: raw(mh.institutionsPercentHeld) ?? null,
      institutionsFloatPct: raw(mh.institutionsFloatPercentHeld) ?? null,
      institutionsCount: raw(mh.institutionsCount) ?? null,
      institutions: instList,
      insiders: insider,
    },
    earnings: {
      quarterly: (earn.quarterlyEstimated || []).map((q) => ({
        date: q.date,
        estimate: raw(q.estimate),
        actual: raw(q.actual),
      })),
      financialsChart: (earn.financialsChart?.revenue || []).map((r) => ({ date: r.date, value: raw(r.value) })),
      earningsChart: earn.financialsChart || null,
      next: cal?.earningsDate?.[0] ? new Date(cal.earningsDate[0] * 1000).toISOString().slice(0, 10) : null,
      exDividendDate: cal?.exDividendDate ? new Date(cal.exDividendDate * 1000).toISOString().slice(0, 10) : null,
    },
    flags: {
      degraded: !ys,
      marketStatus: nd?.marketStatus || null,
      nasdaqSummary: nd?.summary || null,
    },
  };
}


/**
 * Ratio maths that normally arrive with quoteSummary. Yahoo's crumb-free
 * fundamentals-timeseries carries every line item, so ratios are recomputed from the
 * latest annual period whenever the crumb endpoint is refusing us.
 */
function deriveValuation(out, ts) {
  const series = ts?.series || {};
  const latest = (t) => {
    const arr = series[t];
    return arr?.length ? arr[arr.length - 1].raw : null;
  };
  const price = out.price?.last;
  const mcap = out.price?.marketCap;
  const v = out.valuation;

  const eps = latest("annualDilutedEPS");
  const revenue = latest("annualTotalRevenue");
  const netIncome = latest("annualNetIncome");
  const grossProfit = latest("annualGrossProfit");
  const operatingIncome = latest("annualOperatingIncome");
  const ebitda = latest("annualNormalizedEBITDA");
  const equity = latest("annualStockholdersEquity");
  const assets = latest("annualTotalAssets");
  const cash = latest("annualCashAndCashEquivalents");
  const totalDebt = latest("annualTotalDebt");
  const curAssets = latest("annualCurrentAssets");
  const curLiabs = latest("annualCurrentLiabilities");
  const shares = latest("annualOrdinarySharesNumber");
  const dividendsPaid = latest("annualCashDividendsPaid");
  const revPrior = series.annualTotalRevenue?.length > 1
    ? series.annualTotalRevenue[series.annualTotalRevenue.length - 2].raw
    : null;
  const niPrior = series.annualNetIncome?.length > 1
    ? series.annualNetIncome[series.annualNetIncome.length - 2].raw
    : null;

  const ev = mcap != null && totalDebt != null && cash != null ? mcap + totalDebt - cash : null;
  const pct = (n, d) => (n != null && d ? n / d : null);

  v.eps ??= eps;
  v.grossMargins ??= pct(grossProfit, revenue);
  v.operatingMargins ??= pct(operatingIncome, revenue);
  v.profitMargins ??= pct(netIncome, revenue);
  v.ebitdaMargins ??= pct(ebitda, revenue);
  v.returnOnEquity ??= pct(netIncome, equity);
  v.returnOnAssets ??= pct(netIncome, assets);
  v.debtToEquity ??= pct(totalDebt, equity);
  v.currentRatio ??= pct(curAssets, curLiabs);
  v.enterpriseValue ??= ev;
  v.evToEbitda ??= pct(ev, ebitda);
  v.evToRevenue ??= pct(ev, revenue);
  v.freeCashFlow ??= latest("annualFreeCashFlow");
  v.operatingCashFlow ??= latest("annualOperatingCashFlow");
  v.totalCash ??= cash;
  v.totalDebt ??= totalDebt;
  v.sharesOutstanding ??= shares;
  v.bookValue ??= pct(equity, shares);
  v.cashPerShare ??= pct(cash, shares);
  v.revenueGrowth ??= pct(revenue != null && revPrior != null ? revenue - revPrior : null, revPrior);
  v.earningsGrowth ??= pct(netIncome != null && niPrior != null ? netIncome - niPrior : null, niPrior);
  v.payoutRatio ??= pct(dividendsPaid != null ? Math.abs(dividendsPaid) : null, netIncome);

  if (price != null && eps) v.trailingPE ??= price / eps;
  if (price != null && equity && shares) v.priceToBook ??= mcap / equity;
  if (mcap != null && revenue) v.priceToSales ??= mcap / revenue;
  if (mcap != null && equity && shares && price != null && v.trailingPE) {
    v.peg ??= null; // needs a forward growth estimate; only quoteSummary supplies one
  }
  if (price != null && v.eps != null && v.trailingPE == null) v.trailingPE = price / v.eps;
  return out;
}

/* ------------------------------------------------------ financials shaping */

const TS_GROUPS = [
  {
    group: "Income statement",
    rows: [
      ["annualTotalRevenue", "quarterlyTotalRevenue", "Revenue"],
      ["annualCostOfRevenue", "quarterlyCostOfRevenue", "Cost of revenue"],
      ["annualGrossProfit", "quarterlyGrossProfit", "Gross profit"],
      ["annualResearchAndDevelopment", "quarterlyResearchAndDevelopment", "Research & development"],
      ["annualOperatingIncome", "quarterlyOperatingIncome", "Operating income"],
      ["annualPretaxIncome", "quarterlyPretaxIncome", "Pre-tax income"],
      ["annualTaxProvision", "quarterlyTaxProvision", "Income tax"],
      ["annualNetIncome", "quarterlyNetIncome", "Net income"],
      ["annualDilutedEPS", "quarterlyDilutedEPS", "Diluted EPS ($)"],
      ["annualBasicEPS", "quarterlyBasicEPS", "Basic EPS ($)"],
    ],
  },
  {
    group: "Balance sheet",
    rows: [
      ["annualTotalAssets", "quarterlyTotalAssets", "Total assets"],
      ["annualCurrentAssets", "quarterlyCurrentAssets", "Current assets"],
      ["annualCashAndCashEquivalents", "quarterlyCashAndCashEquivalents", "Cash & equivalents"],
      ["annualInventory", "quarterlyInventory", "Inventory"],
      ["annualTotalLiabilitiesNetMinorityInterest", "quarterlyTotalLiabilitiesNetMinorityInterest", "Total liabilities"],
      ["annualCurrentLiabilities", "quarterlyCurrentLiabilities", "Current liabilities"],
      ["annualLongTermDebt", "quarterlyLongTermDebt", "Long-term debt"],
      ["annualStockholdersEquity", "quarterlyStockholdersEquity", "Shareholders' equity"],
      ["annualCommonStockSharesOutstanding", "quarterlyCommonStockSharesOutstanding", "Shares outstanding"],
    ],
  },
  {
    group: "Cash flow",
    rows: [
      ["annualOperatingCashFlow", "quarterlyOperatingCashFlow", "Operating cash flow"],
      ["annualCapitalExpenditure", "quarterlyCapitalExpenditure", "Capital expenditure"],
      ["annualFreeCashFlow", "quarterlyFreeCashFlow", "Free cash flow"],
      ["annualDepreciationAndAmortization", "quarterlyDepreciationAndAmortization", "D&A"],
      ["annualShareBasedCompensation", "quarterlyShareBasedCompensation", "Stock-based comp"],
    ],
  },
];

function shapeFinancials(symbol, freq, ts, nd) {
  const isQ = freq === "quarterly";
  const present = Object.entries(ts?.series || {})
    .filter(([, v]) => v?.length)
    .map(([k]) => k);

  // No Yahoo series (it is the endpoint that rate-limits hardest): use Nasdaq's own
  // statement tables, which carry the same four periods with labels already attached.
  if (!present.length && nd) {
    const pick = (t, group) =>
      t
        ? {
            group,
            rows: t.rows.filter((r) => !r.heading).map((r) => ({ key: r.label, label: r.label, values: r.values })),
          }
        : null;
    const statements = [pick(nd.income, "Income statement"), pick(nd.balance, "Balance sheet"), pick(nd.cashflow, "Cash flow")]
      .filter((g) => g && g.rows.length);
    const periods = nd.income?.periods?.length ? nd.income.periods : [];
    return {
      source: "nasdaq",
      symbol,
      freq,
      periods,
      periodLabels: periods.map((x) => fmtPeriod(x, freq)),
      statements,
      ratios: nd.ratios ? { periods: nd.ratios.periods, rows: nd.ratios.rows } : null,
      nasdaq: { tabs: nd.tabs },
      availableTypes: [],
    };
  }

  // union of all dates, newest first
  const dates = new Set();
  for (const t of present) for (const p of ts.series[t]) if (p.date) dates.add(p.date);
  const periods = [...dates].sort().reverse().slice(0, 6);

  const valueAt = (type, date) => {
    const p = (ts?.series?.[type] || []).find((x) => x.date === date);
    return p ? p.raw : null;
  };

  const statements = TS_GROUPS.map((g) => ({
    group: g.group,
    rows: g.rows
      .map(([, , label], i) => {
        const type = g.rows[i][isQ ? 1 : 0];
        if (!present.includes(type)) return null;
        return {
          key: type,
          label,
          values: periods.map((d) => valueAt(type, d)),
        };
      })
      .filter(Boolean),
  })).filter((g) => g.rows.length);

  return {
    source: present.length ? "yahoo" : "nasdaq",
    symbol,
    freq,
    periods,
    periodLabels: periods.map((x) => fmtPeriod(x, freq)),
    statements,
    ratios: nd?.ratios ? { periods: nd.ratios.periods, rows: nd.ratios.rows } : null,
    nasdaq: nd ? { tabs: nd.tabs } : null,
    availableTypes: present,
  };
}

/** "9/27/2025" -> FY25 (annual) or Q4 25 (quarterly); "2025-09-30" -> FY25. */
function fmtPeriod(p, freq) {
  if (!p) return "";
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(p).trim());
  if (m) {
    const [, mo, , yr] = m;
    if (freq === "annual") return `FY${String(yr).slice(2)}`;
    const q = Math.floor((Number(mo) - 1) / 3) + 1;
    return `Q${q} ${String(yr).slice(2)}`;
  }
  const d = new Date(p);
  if (isNaN(d)) return String(p);
  if (freq === "annual") return `FY${String(d.getFullYear()).slice(2)}`;
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} ${String(d.getFullYear()).slice(2)}`;
}

/* -------------------------------------------------------------- API router */

const F = { t: Date.now() };

/** Liquid US large caps used for offline symbol lookup and the default watchlist. */
const UNIVERSE = [
  { symbol: "AAPL", name: "Apple Inc." }, { symbol: "MSFT", name: "Microsoft Corporation" },
  { symbol: "NVDA", name: "NVIDIA Corporation" }, { symbol: "AMZN", name: "Amazon.com, Inc." },
  { symbol: "GOOGL", name: "Alphabet Inc." }, { symbol: "META", name: "Meta Platforms, Inc." },
  { symbol: "TSLA", name: "Tesla, Inc." }, { symbol: "AVGO", name: "Broadcom Inc." },
  { symbol: "BRK-B", name: "Berkshire Hathaway Inc." }, { symbol: "JPM", name: "JPMorgan Chase & Co." },
  { symbol: "LLY", name: "Eli Lilly and Company" }, { symbol: "V", name: "Visa Inc." },
  { symbol: "XOM", name: "Exxon Mobil Corporation" }, { symbol: "UNH", name: "UnitedHealth Group" },
  { symbol: "MA", name: "Mastercard Incorporated" }, { symbol: "COST", name: "Costco Wholesale" },
  { symbol: "HD", name: "The Home Depot, Inc." }, { symbol: "PG", name: "Procter & Gamble Company" },
  { symbol: "NFLX", name: "Netflix, Inc." }, { symbol: "ORCL", name: "Oracle Corporation" },
  { symbol: "JNJ", name: "Johnson & Johnson" }, { symbol: "ABBV", name: "AbbVie Inc." },
  { symbol: "CRM", name: "Salesforce, Inc." }, { symbol: "AMD", name: "Advanced Micro Devices" },
  { symbol: "KO", name: "The Coca-Cola Company" }, { symbol: "PEP", name: "PepsiCo, Inc." },
  { symbol: "WMT", name: "Walmart Inc." }, { symbol: "CSCO", name: "Cisco Systems, Inc." },
  { symbol: "ADBE", name: "Adobe Inc." }, { symbol: "MRK", name: "Merck & Co., Inc." },
  { symbol: "TMO", name: "Thermo Fisher Scientific" }, { symbol: "LIN", name: "Linde plc" },
  { symbol: "ACN", name: "Accenture plc" }, { symbol: "MCD", name: "McDonald's Corporation" },
  { symbol: "IBM", name: "International Business Machines" }, { symbol: "QCOM", name: "QUALCOMM Incorporated" },
  { symbol: "GE", name: "GE Aerospace" }, { symbol: "ABT", name: "Abbott Laboratories" },
  { symbol: "CAT", name: "Caterpillar Inc." }, { symbol: "INTC", name: "Intel Corporation" },
  { symbol: "DIS", name: "The Walt Disney Company" }, { symbol: "BA", name: "The Boeing Company" },
  { symbol: "NKE", name: "NIKE, Inc." }, { symbol: "PFE", name: "Pfizer Inc." },
  { symbol: "PLTR", name: "Palantir Technologies" }, { symbol: "UBER", name: "Uber Technologies" },
  { symbol: "CRWD", name: "CrowdStrike Holdings" }, { symbol: "PANW", name: "Palo Alto Networks" },
  { symbol: "MU", name: "Micron Technology, Inc." }, { symbol: "SBUX", name: "Starbucks Corporation" },
  { symbol: "TXN", name: "Texas Instruments" }, { symbol: "AMAT", name: "Applied Materials" },
  { symbol: "NOW", name: "ServiceNow, Inc." }, { symbol: "ISRG", name: "Intuitive Surgical" },
  { symbol: "BKNG", name: "Booking Holdings" }, { symbol: "SYK", name: "Stryker Corporation" },
];

const API = {
  "/api/health"() {
    return {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      cache: { mem: mem.size },
      stats,
      cooling: [...gates].map(([h, g]) => ({ host: h, coolUntil: g.coolUntil })).filter((g) => g.coolUntil > Date.now()),
      time: new Date().toISOString(),
    };
  },

  async "/api/quotes"(q) {
    const symbols = (q.get("symbols") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40);
    if (!symbols.length) throw bad("symbols required");
    return yahooQuotes(symbols);
  },

  async "/api/chart"(q) {
    const symbol = (q.get("symbol") || "").trim();
    if (!symbol) throw bad("symbol required");
    return yahooChart(symbol.toUpperCase(), (q.get("range") || "1M").toUpperCase());
  },

  async "/api/company"(q) {
    const symbol = (q.get("symbol") || "").trim().toUpperCase();
    if (!symbol) throw bad("symbol required");
    const key = `company:${symbol}`;
    const hit = cacheGet(key);
    if (hit?.fresh) {
      stats.hits++;
      return hit.value;
    }
    let ys = null,
      ysErr = null;
    try {
      const r = await yahooSummary(symbol, SUMMARY_MODULES);
      ys = r.data;
    } catch (e) {
      ysErr = String(e?.message || e);
    }
    const [nd, an] = await Promise.all([
      nasdaqQuoteInfo(symbol).catch(() => null),
      nasdaqAnalyst(symbol).catch(() => null),
    ]);
    if (!ys && !nd) throw new Error(`no data for ${symbol}`);
    const out = normalizeCompany(symbol, ys, nd);
    if (an) mergeAnalyst(out, an);
    companySeen.add(symbol);
    if (!ys) {
      try {
        deriveValuation(out, await yahooTimeseries(symbol, DERIVE_TYPES, "annual"));
      } catch {
        /* ratios stay null rather than guessed */
      }
      const pe = await nasdaqPe(symbol);
      if (pe?.pe && out.valuation.trailingPE == null) out.valuation.trailingPE = pe.pe;
    }
    out.errors = ysErr ? { quoteSummary: ysErr } : undefined;
    // A payload built without quoteSummary is missing valuation and ownership data:
    // keep it around only long enough to retry, never for hours.
    cacheSet(key, out, ys ? 3 * 3600_000 : 45_000, ys ? 7 * 86400_000 : 6 * 3600_000);
    return out;
  },

  async "/api/financials"(q) {
    const symbol = (q.get("symbol") || "").trim().toUpperCase();
    const freq = q.get("freq") === "quarterly" ? "quarterly" : "annual";
    if (!symbol) throw bad("symbol required");
    const types = [];
    for (const g of TS_GROUPS) for (const r of g.rows) types.push(r[freq === "quarterly" ? 1 : 0]);

    let ts = null,
      nd = null;
    const [a, b] = await Promise.allSettled([
      yahooTimeseries(symbol, types, freq),
      nasdaqFinancials(symbol, freq === "quarterly" ? 2 : 1),
    ]);
    if (a.status === "fulfilled") ts = a.value;
    if (b.status === "fulfilled") nd = b.value;
    if (!ts && !nd) throw new Error(`no financials for ${symbol}`);
    return shapeFinancials(symbol, freq, ts, nd);
  },

  async "/api/analyst"(q) {
    const symbol = (q.get("symbol") || "").trim().toUpperCase();
    if (!symbol) throw bad("symbol required");
    return nasdaqAnalyst(symbol);
  },

  async "/api/dividends"(q) {
    const symbol = (q.get("symbol") || "").trim().toUpperCase();
    if (!symbol) throw bad("symbol required");
    return nasdaqDividends(symbol);
  },

  async "/api/short"(q) {
    const symbol = (q.get("symbol") || "").trim().toUpperCase();
    if (!symbol) throw bad("symbol required");
    return nasdaqShort(symbol);
  },

  async "/api/holders"(q) {
    const symbol = (q.get("symbol") || "").trim().toUpperCase();
    if (!symbol) throw bad("symbol required");
    return nasdaqHolders(symbol);
  },

  async "/api/search"(q) {
    const term = (q.get("q") || "").trim();
    if (!term) return { quotes: [], news: [] };
    const key = "search:" + term.toLowerCase();
    const hit = cacheGet(key);
    if (hit?.fresh) return hit.value;
    try {
      const raw = await yget(
        `/v1/finance/search?q=${encodeURIComponent(term)}&quotesCount=8&newsCount=8&enableFuzzyQuery=false`,
        { retries: 0 }
      );
      const out = {
        source: "yahoo",
        quotes: (raw.quotes || []).map((s) => ({
          symbol: s.symbol,
          name: s.shortname || s.longname || s.symbol,
          exchange: s.exchDisp || s.exchange || null,
          type: s.quoteType || null,
        })),
        news: shapeNews(raw.news || []),
      };
      cacheSet(key, out, 600_000);
      return out;
    } catch (e) {
      try {
        const fromScreener = await screenerLookup(term);
        if (fromScreener.length) return { source: "nasdaq-screener", quotes: fromScreener, news: [] };
      } catch {
        /* fall through to the static universe */
      }
      const local = fallbackSearch(term);
      if (local.quotes.length) return { source: "local", ...local };
      if (hit) return hit.value;
      throw e;
    }
  },

  async "/api/news"(q) {
    const symbol = (q.get("symbol") || "").trim().toUpperCase();
    const query = (q.get("q") || "").trim() || symbol || "";
    const limit = Math.min(Number(q.get("limit")) || 12, 30);
    if (!query) return { news: [] };
    const key = `news:${query}:${limit}`;
    const hit = cacheGet(key);
    if (hit?.fresh) {
      stats.hits++;
      return hit.value;
    }
    const cache = (out) => {
      cacheSet(key, out, 900_000);
      return out;
    };
    try {
      const raw = await yget(
        `/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${limit + 6}&quotesCount=1`,
        { retries: 0 }
      );
      const news = shapeNews(raw.news || []).slice(0, limit);
      if (news.length) return cache({ source: "yahoo-search", news });
    } catch {
      /* fall through to the RSS feeds, which are not crumb-gated */
    }
    try {
      const xml = await tget(
        `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(query)}&region=US&lang=en-US`,
        { ttl: 900_000, cacheKey: `rss:${query}` }
      );
      const news = parseRssItems(xml, limit).filter((n) => n.link);
      if (news.length) return cache({ source: "yahoo-rss", news });
    } catch {
      /* rss unavailable */
    }
    try {
      const xml = await tget(
        `https://news.google.com/rss/search?q=${encodeURIComponent(query + " stock")}&hl=en-US&gl=US&ceid=US:en`,
        { ttl: 900_000, cacheKey: `gn:${query}` }
      );
      const news = parseRssItems(xml, limit);
      if (news.length) return cache({ source: "google-news", news });
    } catch {
      /* give up */
    }
    if (hit) return hit.value;
    throw new Error("no news source available");
  },

  async "/api/market"(q) {
    const key = "market";
    const hit = cacheGet(key);
    if (hit?.fresh && Date.now() - (hit.value?.fetchedAt || 0) < 60_000) {
      stats.hits++;
      return hit.value;
    }
    const INDICES = ["^GSPC", "^IXIC", "^DJI", "^RUT", "^VIX", "^TNX"];
    const SECTORS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC"];
    const MOVERS = [
      "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK-B", "JPM",
      "LLY", "V", "XOM", "UNH", "MA", "COST", "HD", "PG", "NFLX", "ORCL",
      "JNJ", "ABBV", "CRM", "AMD", "KO", "PEP", "WMT", "CSCO", "ADBE", "MRK",
      "TMO", "LIN", "ACN", "MCD", "IBM", "QCOM", "GE", "ABT", "CAT", "INTC",
      "DIS", "BA", "NKE", "PFE", "PLTR", "UBER", "SHOP", "CRWD", "PANW", "SNOW",
      "MU", "ARM", "SMCI", "COIN", "SHOP", "SBUX", "T", "VZ", "CMCSA", "RTX",
    ];
    const uniq = [...new Set(MOVERS)];
    const [idx, sec, mv] = await Promise.allSettled([
      yahooQuotes(INDICES),
      yahooQuotes(SECTORS),
      yahooQuotes(uniq),
    ]);
    const quotesOf = (r) => (r.status === "fulfilled" ? r.value?.quotes || [] : []);
    // Sector SPDRs are ETFs, so Nasdaq can backfill them when Yahoo is refusing.
    let sectors = quotesOf(sec);
    if (!sectors.length) {
      try {
        sectors = (await nasdaqLiveQuotes(SECTORS)).quotes;
      } catch {
        /* leave the sector strip empty */
      }
    }
    let indices = quotesOf(idx);
    let indexSource = "yahoo";
    if (!indices.length) {
      // Nasdaq has no index feed, so a blocking Yahoo degrades to the tracking ETFs.
      const proxyOf = { "^GSPC": "SPY", "^IXIC": "QQQ", "^DJI": "DIA", "^RUT": "IWM" };
      try {
        const prox = await nasdaqLiveQuotes(Object.values(proxyOf));
        const bySym = new Map(prox.quotes.map((q) => [q.symbol, q]));
        indices = Object.entries(proxyOf)
          .map(([ix, etf]) => {
            const q = bySym.get(etf);
            return q ? { ...q, symbol: ix, proxySymbol: etf, proxy: true, name: `${q.name} (${etf})` } : null;
          })
          .filter(Boolean);
        indexSource = "nasdaq-etf";
      } catch {
        /* leave empty rather than invent numbers */
      }
    }
    const all = quotesOf(mv).filter((x) => x.price != null && x.changePct != null);
    const ranked = [...all].sort((a, b) => b.changePct - a.changePct);
    const out = {
      fetchedAt: Date.now(),
      source: "yahoo",
      indices,
      indexSource,
      sectors,
      movers: {
        gainers: ranked.slice(0, 8),
        losers: ranked.slice(-8).reverse(),
        mostActive: [...all].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 8),
      },
      universe: all,
      degraded: !(idx.status === "fulfilled") || indexSource !== "yahoo",
    };
    if (out.indices.length || out.universe.length) cacheSet(key, out, 60_000, 86400_000);
    return out;
  },
};

function bad(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/**
 * Symbol lookup when Yahoo search is unavailable: the bulk screener carries name and
 * symbol for every listed US equity, so autocomplete keeps working offline.
 */
async function screenerLookup(term) {
  const d = (await ndget("/api/screener/stocks?tableonly=true&limit=1000"))?.data;
  const rows = d?.table?.rows || [];
  const t = term.toLowerCase();
  return rows
    .filter((r) => r.symbol?.toLowerCase().includes(t) || r.name?.toLowerCase().includes(t))
    .slice(0, 8)
    .map((r) => ({ symbol: r.symbol, name: r.name, exchange: null, type: "EQUITY" }));
}

function fallbackSearch(term) {
  const t = term.toUpperCase();
  const known = UNIVERSE.filter((u) => u.symbol.includes(t) || u.name.toUpperCase().includes(t)).slice(0, 8);
  return { quotes: known.map((u) => ({ symbol: u.symbol, name: u.name, exchange: null, type: "EQUITY" })), news: [] };
}

function shapeNews(list) {
  return list
    .filter((n) => n?.title)
    .map((n) => ({
      id: n.uuid || n.link,
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      time: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
      type: n.type || null,
      related: (n.relatedTickers || []).filter((t, i, a) => a.indexOf(t) === i).slice(0, 6),
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
    }));
}

function buildPeriodLabels(periods, nd, freq) {
  if (periods?.length) {
    return periods.map((p) => {
      const d = new Date(p + "T00:00:00");
      return isNaN(d) ? p : freq === "quarterly" ? fmtQ(d) : `FY${String(d.getFullYear()).slice(2)}`;
    });
  }
  const heads = nd?.income?.periods || [];
  return heads;
}

function fmtQ(d) {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `Q${q} ${String(d.getFullYear()).slice(2)}`;
}


/**
 * Yahoo only exposes quoteSummary (valuations, ownership, insider activity) through a
 * crumb that it hands out intermittently. Rather than making callers wait on that, a
 * background worker keeps trying quietly and, once it succeeds, back-fills the symbols
 * the site has actually been asked about.
 */
const companySeen = new Set();

function isFreshCompany(symbol) {
  const e = mem.get(ck(`company:${symbol}`));
  return !!e && e.exp > Date.now() && e.v?.source === "yahoo";
}

async function crumbWorker() {
  let lastTry = 0;
  for (;;) {
    await wait(30_000);
    const symbols = [...companySeen].filter((s) => !isFreshCompany(s)).slice(0, 6);
    if (!symbols.length) continue;
    if (Date.now() - lastTry < 45_000) continue;
    lastTry = Date.now();
    try {
      await getCrumb();
    } catch {
      continue; // still refusing; try again next cycle
    }
    for (const sym of symbols) {
      try {
        await yahooSummary(sym, SUMMARY_MODULES);
      } catch {
        break; // the crumb went away again
      }
      await wait(2500);
    }
  }
}

/* --------------------------------------------------------- static + server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return sendText(res, 403, "forbidden");
  fs.readFile(file, (err, buf) => {
    if (err) return sendText(res, 404, "not found");
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  });
}

function sendText(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const handler = API[url.pathname];
  if (handler) {
    stats.requests++;
    try {
      const payload = await handler(url.searchParams);
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Response-ms": Date.now() - started,
      });
      return res.end(body);
    } catch (e) {
      const code = e.status || (e.code === 400 ? 400 : 502);
      stats.errors++;
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: String(e.message || e), code: e.code || code }));
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed");
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`StockLens serving http://localhost:${PORT}  (root: ${ROOT})`);
  warm().catch(() => {});
  crumbWorker().catch(() => {});
});

/**
 * Pre-fetches the handful of calls a fresh page load needs, one at a time with a
 * polite gap. Without this the first visitor pays for every upstream round trip;
 * with it (and the disk cache) page loads are served locally.
 */
async function warm() {
  const WARM_SYMBOLS = (process.env.WARM_SYMBOLS || "AAPL").split(",");
  const steps = [
    () => API["/api/market"](new URLSearchParams()),
    () => API["/api/quotes"](new URLSearchParams({ symbols: WARM_SYMBOLS.join(",") })),
    () => API["/api/chart"](new URLSearchParams({ symbol: WARM_SYMBOLS[0], range: "6M" })),
    () => API["/api/company"](new URLSearchParams({ symbol: WARM_SYMBOLS[0] })),
    () => API["/api/financials"](new URLSearchParams({ symbol: WARM_SYMBOLS[0], freq: "annual" })),
    () => API["/api/news"](new URLSearchParams({ symbol: WARM_SYMBOLS[0] })),
  ];
  await wait(4000);
  let failures = 0;
  for (const step of steps) {
    if (failures >= 2) break; // stop burning the upstream budget when Yahoo is refusing
    try {
      await step();
      failures = 0;
    } catch (e) {
      if (e?.code === 429) failures++;
    }
    await wait(2500);
  }
  console.log(`warmup done (mem=${mem.size}, upstream=${stats.upstream}, 429=${stats.rateLimited})`);
}
