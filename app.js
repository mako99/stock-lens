/* ==========================================================================
   StockLens — analysis, UI rendering, interactions
   ========================================================================== */
'use strict';

/* ============================================================ ANALYSIS === */
function computeAnalysis(sym) {
  const b = genDaily(sym);
  const closes = b.map(x => x.c);
  const last = b[b.length - 1];
  const prev = b[b.length - 2];
  const r = rsi(closes);
  const m = macd(closes);
  const st = stochastic(b);
  const a = atr(b);
  const cciV = cci(b);
  const wV = williams(b);
  const sm = {
    5: sma(closes, 5), 10: sma(closes, 10), 20: sma(closes, 20),
    50: sma(closes, 50), 100: sma(closes, 100), 200: sma(closes, 200)
  };
  const em = { 10: ema(closes, 10), 20: ema(closes, 20), 50: ema(closes, 50), 100: ema(closes, 100), 200: ema(closes, 200) };
  const i = closes.length - 1;
  const price = last.c;
  const chg = price - prev.c;

  const cut = n => b.length > n ? b[b.length - 1 - n].c : b[0].c;
  const thisYear = new Date().getFullYear();
  let ytdBase = b[0].c;
  for (const x of b) if (x.t.getFullYear() === thisYear) { ytdBase = x.c; break; }
  const ret = {
    '1D': (price / prev.c - 1) * 100,
    '1W': (price / cut(5) - 1) * 100,
    '1M': (price / cut(21) - 1) * 100,
    '3M': (price / cut(63) - 1) * 100,
    '6M': (price / cut(126) - 1) * 100,
    'YTD': (price / ytdBase - 1) * 100,
    '1Y': (price / cut(252) - 1) * 100,
    '3Y': (price / cut(756) - 1) * 100,
    '5Y': (price / cut(1260) - 1) * 100
  };

  let hi52 = -Infinity, lo52 = Infinity;
  for (let k = Math.max(0, b.length - 252); k < b.length; k++) {
    if (b[k].h > hi52) hi52 = b[k].h;
    if (b[k].l < lo52) lo52 = b[k].l;
  }
  const H = last.h, L = last.l, C = last.c;
  const P0 = (H + L + C) / 3;
  const piv = {
    P: P0, R1: 2 * P0 - L, S1: 2 * P0 - H,
    R2: P0 + (H - L), S2: P0 - (H - L),
    R3: H + 2 * (P0 - L), S3: L - 2 * (H - P0)
  };

  const rsiV = r[i];
  const macdV = m.line[i], sigV = m.signal[i];
  const stK = st.k[i], stD = st.d[i];
  const cc = cciV[i];
  const wR = wV[i];
  const mom = (C / b[i - 10].c - 1) * 100;

  const signals = [
    { n: 'RSI (14)', v: rsiV, t: rsiV > 70 ? 'Overbought' : rsiV < 30 ? 'Oversold' : rsiV > 55 ? 'Bullish' : rsiV < 45 ? 'Bearish' : 'Neutral', s: rsiV > 70 ? -1 : rsiV < 30 ? 1 : rsiV > 55 ? 1 : rsiV < 45 ? -1 : 0 },
    { n: 'MACD (12,26)', v: macdV, t: macdV > sigV ? 'Bullish cross' : 'Bearish cross', s: macdV > sigV ? 1 : -1 },
    { n: 'Stochastic', v: stK, t: stK > 80 ? 'Overbought' : stK < 20 ? 'Oversold' : stK > stD ? 'Bullish' : 'Bearish', s: stK > 80 ? -1 : stK < 20 ? 1 : stK > stD ? 1 : -1 },
    { n: 'CCI (20)', v: cc, t: cc > 100 ? 'Strong +ve' : cc < -100 ? 'Strong −ve' : 'Neutral', s: cc > 100 ? 1 : cc < -100 ? -1 : 0 },
    { n: 'Williams %R', v: wR, t: wR > -20 ? 'Overbought' : wR < -80 ? 'Oversold' : 'Neutral', s: wR > -20 ? -1 : wR < -80 ? 1 : 0 },
    { n: 'Momentum (10)', v: mom, t: mom > 0 ? 'Bullish' : 'Bearish', s: mom > 0 ? 1 : -1 }
  ];

  const maRows = [];
  for (const p of [5, 10, 20, 50, 100, 200]) {
    const v = sm[p][i];
    maRows.push({ p: p, type: 'SMA', v: v, sig: v == null ? 0 : C > v ? 1 : -1 });
  }
  for (const p of [10, 20, 50, 100, 200]) {
    const v = em[p][i];
    maRows.push({ p: p, type: 'EMA', v: v, sig: v == null ? 0 : C > v ? 1 : -1 });
  }

  const bull = signals.filter(x => x.s > 0).length + maRows.filter(x => x.sig > 0).length;
  const bear = signals.filter(x => x.s < 0).length + maRows.filter(x => x.sig < 0).length;
  const total = signals.length + maRows.length;
  const score = Math.round(((bull - bear) / total) * 100);

  const sl = b.slice(-756);
  const lastVol = last.v;
  let avgVol = 0;
  for (const x of b.slice(-30)) avgVol += x.v;
  avgVol /= 30;

  return {
    b: b, closes: closes, price: price, prevClose: prev.c, chg: chg,
    chgPct: chg / prev.c * 100, dayH: H, dayL: L,
    rsi: rsiV, macd: { line: macdV, signal: sigV, hist: m.hist[i] },
    stoch: { k: stK, d: stD }, atr: a[i], sma: sm, ema: em, ret: ret,
    hi52: hi52, lo52: lo52, piv: piv, signals: signals, maRows: maRows,
    score: score, bull: bull, bear: bear, total: total,
    vol1y: annVol(b.slice(-252)), maxDD: maxDD(sl), sharpe: sharpe(sl),
    volume: lastVol, avgVol: avgVol, atrPct: (a[i] / C) * 100
  };
}

function radarScores(sym) {
  const u = UNIVERSE[sym];
  const A = computeAnalysis(sym);
  const cl = v => clamp(Math.round(v), 5, 100);
  return {
    v: [
      cl(100 - (u.pe > 0 ? clamp(u.pe * 1.4, 0, 94) : 94)),
      cl(u.growth * 2.4 + 24),
      cl(u.net * 2.6 + 18),
      cl(50 + A.ret['6M'] * 1.6),
      cl(74 - u.debt * 13 + (u.cash || 0) * 0.1),
      cl(u.div * 12 + (u.eps > 0 ? 24 : 0))
    ],
    ref: [58, 54, 52, 50, 56, 46]
  };
}

function newsItems(sym) {
  if (LIVE.news[sym] && LIVE.news[sym].length) return LIVE.news[sym];
  const u = liveMeta(sym) || UNIVERSE.SPY;
  if (!UNIVERSE[sym]) return [];
  const rnd = mulberry32(hashStr(sym) ^ 0x77aa);
  const A = computeAnalysis(sym);
  const heads = [
    ['{S} beats quarterly expectations as {SEG} demand stays firm', 0.72],
    ['Analysts lift {S} price targets after upbeat guidance', 0.64],
    ['{S} expands {SEG} capacity with new multi-year investment', 0.48],
    ['Institutional ownership in {S} rises for third straight quarter', 0.41],
    ['{S} board approves fresh share repurchase authorisation', 0.35],
    ['Regulators open routine review into {S} market practices', -0.46],
    ['{S} slips as {SEG} margins compress amid cost pressure', -0.58],
    ['Supply-chain delays push {S} deliveries into next quarter', -0.52],
    ['{S} to present at upcoming global investor conference', 0.18],
    ['Short interest in {S} climbs to highest level this year', -0.40],
    ['{S} announces dividend of $' + (u.div / 100 * u.price / 4).toFixed(2) + ' per share', 0.26],
    ['Currency headwinds trim {S} full-year revenue outlook', -0.34],
    ['{S} unveils refreshed product lineup at annual event', 0.55],
    ['Options traders position for elevated {S} volatility', 0.08]
  ];
  const sources = ['MarketWatch', 'Reuters', 'Bloomberg', 'Barron\'s', 'The Street', 'Zacks', 'Seeking Alpha', 'CNBC'];
  const out = [];
  const bag = heads.map((_, i) => i);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
  }
  const tails = [
    'Options markets imply a muted move into the next print.',
    'Street desks remain split on how durable the trend proves.',
    'Volume ran above the 20-day average through the session.',
    'The move leaves the shares inside their recent trading range.',
    'Positioning data show little change from the prior week.',
    'Futures-implied volatility drifts lower into month-end.'
  ];
  for (let i = 0; i < 9; i++) {
    const pick = heads[bag[i]];
    let title = pick[0].replace('{S}', u.name.split(' ')[0]).replace('{SEG}', u.industry.split('—')[0].trim());
    const base = pick[1];
    const score = clamp(base + (rnd() - 0.5) * 0.3, -1, 1);
    const hrs = Math.floor(rnd() * 200) + i * 6;
    const days = Math.floor(hrs / 24);
    out.push({
      title: title,
      score: score,
      src: sources[Math.floor(rnd() * sources.length)],
      time: days === 0 ? (hrs === 0 ? 'just now' : hrs + 'h ago') : days + 'd ago',
      sum: 'Coverage highlights ' + (score > 0.2 ? 'constructive momentum' : score < -0.2 ? 'near-term risk factors' : 'a balanced risk-reward setup') +
        ' around ' + u.name + ', with traders focused on ' + (u.growth > 8 ? 'growth durability' : 'valuation support') +
        ' and ' + (A.rsi > 60 ? 'extended technicals' : A.rsi < 40 ? 'oversold conditions' : 'neutral momentum') +
        '. ' + tails[Math.floor(rnd() * tails.length)]
    });
  }
  return out.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

/* ============================================================== QUOTE ==== */
function renderQuote() {
  const u = currentMeta();
  const A = computeAnalysis(state.sym);
  const q = LIVE.quotes[state.sym];
  const price = q && q.price != null ? q.price : A.price;
  const chg = q && q.change != null ? q.change : A.chg;
  const chgPct = q && q.changePct != null ? q.changePct : A.chgPct;
  const prev = q && q.prevClose != null ? q.prevClose : A.prevClose;
  const dLo = q && q.low != null ? q.low : A.dayL;
  const dHi = q && q.high != null ? q.high : A.dayH;
  const live = !!q && q.live !== false;

  $('#qSym').textContent = state.sym;
  $('#qExch').textContent = (q && q.exchange ? q.exchange : u.exch) + ' · ' + (q && q.currency ? q.currency : 'USD') +
    ' · ' + (q && q.marketStatus ? q.marketStatus : 'Regular Session');
  $('#qName').textContent = (q && q.name) || u.name;
  $('#qTags').innerHTML =
    '<span class="tag sec">' + esc(u.sector) + '</span>' +
    '<span class="tag">' + esc(u.industry) + '</span>' +
    (u.div > 0 ? '<span class="tag">Div ' + nf(u.div, 2) + '%</span>' : '<span class="tag">No Dividend</span>') +
    '<span class="tag">Beta ' + nf(u.beta, 2) + '</span>' +
    (live ? '<span class="tag live">Live</span>' : '');
  $('#qPrice').textContent = fmtPrice(price);
  const chgEl = $('#qChg');
  chgEl.className = 'qh-chg ' + signCls(chgPct);
  chgEl.textContent = (chg >= 0 ? '+' : '') + fmtPrice(chg) + ' (' + fmtPct(chgPct) + ')';
  $('#qSub').textContent = 'Prev close ' + fmtPrice(prev) + ' · Day range ' + fmtPrice(dLo) + ' – ' + fmtPrice(dHi) +
    (q && q.marketTime ? ' · ' + q.marketTime : '');

  const star = $('#starBtn');
  const inWl = state.watch.has(state.sym);
  star.textContent = inWl ? '★' : '☆';
  star.classList.toggle('on', inWl);

  const hi52 = (q && q.high52 != null) ? q.high52 : A.hi52;
  const lo52 = (q && q.low52 != null) ? q.low52 : A.lo52;
  const vol = q && q.volume != null ? q.volume : A.volume;
  const avgVol = q && q.avgVolume ? q.avgVolume : A.avgVol;
  const d52 = (price / hi52 - 1) * 100;
  const qk = [
    { k: 'Market Cap', v: fmtCap(u.mcap), s: u.mcap > 1e12 ? 'Mega cap' : u.mcap > 1e11 ? 'Large cap' : 'Mid cap' },
    { k: 'P/E (TTM)', v: nf(u.pe, 1), s: u.pe == null ? '—' : u.pe < 0 ? 'Loss-making' : 'Trailing' },
    { k: 'EPS (TTM)', v: '$' + nf(u.eps, 2), s: 'Diluted' },
    { k: 'Div Yield', v: nf(u.div, 2) + '%', s: u.div > 2 ? 'High yield' : u.div > 0 ? 'Paying' : 'None' },
    { k: '52W High', v: fmtPrice(hi52), s: nf(d52, 1) + '% from high' },
    { k: '52W Low', v: fmtPrice(lo52), s: '+' + nf((price / lo52 - 1) * 100, 1) + '% from low' },
    { k: 'Volume', v: fmtBig(vol), s: 'Avg ' + fmtBig(avgVol) },
    { k: 'Beta', v: nf(u.beta, 2), s: 'vs S&P 500' }
  ];
  $('#qhQuick').innerHTML = qk.map(x =>
    '<div class="qk"><div class="k">' + x.k + '</div><div class="v">' + x.v + '</div><div class="s">' + x.s + '</div></div>'
  ).join('');

  const navChg = $('#navSymChg');
  if (navChg) {
    navChg.textContent = fmtPct(chgPct);
    navChg.className = 'nav-sym-chg ' + signCls(chgPct);
  }
}

function currentMeta() { return liveMeta(state.sym) || UNIVERSE[state.sym] || UNIVERSE.SPY; }

function renderStats() {
  const u = currentMeta();
  const A = computeAnalysis(state.sym);
  const f = fundamentals(state.sym);
  const open = A.b[A.b.length - 1].o;
  const payout = u.eps <= 0 ? '—' : nf((u.div > 0 ? (u.div / 100 * u.price) / u.eps : 0) * 100, 1) + '%';
  const items = [
    { k: 'Open', v: fmtPrice(open), s: 'Session' },
    { k: 'Day Range', v: fmtPrice(A.dayL) + '–' + fmtPrice(A.dayH), s: nf((A.dayH - A.dayL) / A.price * 100, 2) + '% width' },
    { k: 'Volume', v: fmtBig(A.volume), s: 'vs avg ' + nf(A.volume / A.avgVol, 2) + '×', pct: clamp(A.volume / A.avgVol * 30, 4, 100) },
    { k: 'RSI (14)', v: nf(A.rsi, 1), s: A.rsi > 70 ? 'Overbought' : A.rsi < 30 ? 'Oversold' : 'Neutral', pct: A.rsi },
    { k: 'ATR (14)', v: nf(A.atr, 2), s: nf(A.atrPct, 2) + '% of price', pct: clamp(A.atrPct * 12, 4, 100) },
    { k: 'Volatility 1Y', v: nf(A.vol1y, 1) + '%', s: 'Annualised', pct: clamp(A.vol1y, 4, 100) },
    { k: 'Max Drawdown', v: nf(A.maxDD, 1) + '%', s: '3-year window', pct: clamp(Math.abs(A.maxDD), 4, 100) },
    { k: 'Sharpe Ratio', v: nf(A.sharpe, 2), s: '3Y · rf 4.1%', pct: clamp((A.sharpe + 1) * 33, 4, 100) },
    { k: 'Return 1Y', v: fmtPct(A.ret['1Y']), s: 'Total', cls: signCls(A.ret['1Y']) },
    { k: 'Return 1M', v: fmtPct(A.ret['1M']), s: 'Total', cls: signCls(A.ret['1M']) },
    { k: 'ROE', v: nf(u.roe, 1) + '%', s: 'Return on equity', pct: clamp(u.roe / 2, 4, 100) },
    { k: 'Net Margin', v: nf(u.net, 1) + '%', s: 'TTM', pct: clamp(u.net * 2, 4, 100) },
    { k: 'Debt / Equity', v: nf(u.debt, 2), s: u.debt > 2 ? 'Levered' : 'Conservative', pct: clamp(u.debt * 25, 4, 100) },
    { k: 'Payout Ratio', v: payout, s: 'Of earnings' },
    { k: 'Shares Out', v: fmtBig(f.shares * 1e6), s: 'Diluted' },
    { k: 'Free Float', v: fmtCap(u.mcap * 0.94), s: 'Est. tradable' }
  ];
  $('#statsGrid').innerHTML = items.map(x =>
    '<div class="stat"><div class="k">' + x.k + '</div><div class="v ' + (x.cls || '') + '">' + x.v +
    '</div><div class="s">' + x.s + '</div>' +
    (x.pct != null ? '<div class="meter"><i style="width:' + clamp(x.pct, 2, 100) + '%"></i></div>' : '') +
    '</div>').join('');
}

function renderWatchlist() {
  const el = $('#watchlist');
  const rows = [];
  state.watch.forEach(sym => {
    const q = LIVE.quotes[sym];
    const u = liveMeta(sym);
    let price = null, chg = null;
    if (q && q.price != null) { price = q.price; chg = q.changePct; }
    else {
      try { const A = computeAnalysis(sym); price = A.price; chg = A.chgPct; } catch (e) { return; }
    }
    rows.push({ s: sym, price: price, chg: chg, name: (u && u.name) || sym });
  });
  el.innerHTML = rows.length ? rows.map(r =>
    '<div class="wl-item ' + (r.s === state.sym ? 'active' : '') + '" data-sym="' + r.s + '">' +
    '<div class="wl-sym"><b>' + r.s + '</b><span>' + esc(String(r.name).split(' ')[0]) + '</span></div>' +
    '<div class="wl-price">' + fmtPrice(r.price) + '</div>' +
    '<div class="wl-chg ' + (r.chg >= 0 ? 'chip-up' : 'chip-down') + '">' + fmtPct(r.chg) + '</div>' +
    '</div>').join('') : '<div style="color:var(--txt-3);font-size:11.5px;padding:8px 4px">Watchlist empty — hit ★ on a symbol.</div>';
  $$('.wl-item', el).forEach(n => { n.onclick = () => selectSymbol(n.dataset.sym); });
}

/* =========================================================== OVERVIEW ==== */
function renderOverview() {
  const A = computeAnalysis(state.sym);
  const u = currentMeta();
  const f = fundamentals(state.sym);
  const P = pal();

  const n = 252;
  const mine = A.b.slice(-n);
  const spy = spyDaily().slice(-n);
  const b1 = mine[0].c, b2 = spy[0].c;
  drawLineChart($('#cmpChart'), [
    { name: state.sym, color: P.acc, data: mine.map(x => (x.c / b1 - 1) * 100), fill: true },
    { name: 'S&P 500', color: P.warn, data: spy.map(x => (x.c / b2 - 1) * 100) }
  ], {
    fmtY: t => nf(t, 0) + '%',
    labels: mine.map(x => x.t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
    baseZero: true
  });

  const sp = { '1W': retOver(spyDaily(), 5), '1M': retOver(spyDaily(), 22), '3M': retOver(spyDaily(), 63), '6M': retOver(spyDaily(), 126), 'YTD': 0, '1Y': retOver(spyDaily(), 252) };
  sp['YTD'] = retOver(spyDaily(), 190);
  $('#perfRow').innerHTML = ['1W', '1M', '3M', '6M', 'YTD', '1Y'].map(k => {
    const v = A.ret[k];
    const d = v - sp[k];
    return '<div class="perf"><div class="k">' + k + '</div><div class="v ' + signCls(v) + '">' + fmtPct(v, 1) +
      '</div><div class="k" style="margin-top:3px;color:' + (d >= 0 ? 'var(--up)' : 'var(--down)') + '">α ' + fmtPct(d, 1) + '</div></div>';
  }).join('');

  const q = f.quarters.slice().reverse();
  drawGroupedBars($('#finChart'), q.map(x => x.label), [
    { name: 'Revenue', color: P.acc, data: q.map(x => x.rev) },
    { name: 'Net Income', color: P.up, data: q.map(x => x.ni) }
  ], { fmtY: mUSD });

  drawLineChart($('#marginChart'), [
    { name: 'Gross', color: P.acc, data: f.gm },
    { name: 'Operating', color: P.acc2, data: f.om },
    { name: 'Net', color: P.up, data: f.nm }
  ], { labels: f.years.map(fyLabel), fmtY: t => nf(t, 0) + '%' });

  const sc = radarScores(state.sym);
  drawRadar($('#radarChart'), ['Valuation', 'Growth', 'Profit', 'Momentum', 'Health', 'Income'], sc.v, sc.ref);

  $('#profileMeta').textContent = u.exch + ' · ' + u.hq + ' · Founded ' + u.born;
  $('#profile').innerHTML = '<p>' + esc(u.desc) + '</p>';
  $('#profileStats').innerHTML = [
    ['Sector', u.sector], ['Industry', u.industry],
    ['Employees', u.emp ? fmtBig(u.emp) : '—'], ['Headquarters', u.hq],
    ['Founded', String(u.born)], ['Exchange', u.exch],
    ['Revenue (TTM)', u.rev ? '$' + fmtBig(u.rev * 1e9) : '—'],
    ['Net Income', u.ni ? '$' + fmtBig(u.ni * 1e9) : '—']
  ].map(x => '<div class="ps"><div class="k">' + x[0] + '</div><div class="v">' + esc(String(x[1])) + '</div></div>').join('');
}

/* ========================================================= TECHNICALS ==== */
function renderTechnicals() {
  const A = computeAnalysis(state.sym);
  const u = currentMeta();

  const osc = A.signals.map(s => {
    const badge = s.s > 0 ? 'buy' : s.s < 0 ? 'sell' : 'hold';
    const label = s.s > 0 ? 'Buy' : s.s < 0 ? 'Sell' : 'Neutral';
    const v = Math.abs(s.v) > 999 ? fmtBig(s.v) : nf(s.v, 2);
    return '<tr><td>' + s.n + '</td><td>' + v + '</td><td>' + s.t +
      '</td><td><span class="badge ' + badge + '">' + label + '</span></td></tr>';
  }).join('');
  $('#oscTable').innerHTML =
    '<thead><tr><th>Indicator</th><th>Value</th><th>Signal</th><th>Action</th></tr></thead><tbody>' + osc + '</tbody>';

  const ma = A.maRows.map(r => {
    const badge = r.sig > 0 ? 'buy' : r.sig < 0 ? 'sell' : 'hold';
    const label = r.sig > 0 ? 'Buy' : r.sig < 0 ? 'Sell' : 'Neutral';
    const diff = r.v ? (A.price / r.v - 1) * 100 : 0;
    return '<tr><td>' + r.type + ' (' + r.p + ')</td><td>' + (r.v ? fmtPrice(r.v) : '—') +
      '</td><td class="' + signCls(diff) + '">' + (r.v ? fmtPct(diff) : '—') +
      '</td><td><span class="badge ' + badge + '">' + label + '</span></td></tr>';
  }).join('');
  const buyN = A.maRows.filter(r => r.sig > 0).length;
  const sellN = A.maRows.filter(r => r.sig < 0).length;
  $('#maTable').innerHTML =
    '<thead><tr><th>Moving Avg</th><th>Value</th><th>Δ vs Price</th><th>Action</th></tr></thead><tbody>' + ma +
    '<tr class="section"><td colspan="4">Summary: ' + buyN + ' buy · ' + sellN + ' sell · ' +
    (A.maRows.length - buyN - sellN) + ' neutral</td></tr></tbody>';

  const p = A.piv;
  const pRows = [['R3', p.R3], ['R2', p.R2], ['R1', p.R1], ['Pivot', p.P], ['S1', p.S1], ['S2', p.S2], ['S3', p.S3]]
    .map(x => '<tr' + (x[0] === 'Pivot' ? ' class="section"' : '') + '><td>' + x[0] + '</td><td>' + fmtPrice(x[1]) +
      '</td><td class="' + signCls(x[1] - A.price) + '">' + fmtPct((x[1] / A.price - 1) * 100) +
      '</td><td>' + (x[0] === 'Pivot' ? 'Pivot' : x[1] > A.price ? 'Resistance' : 'Support') + '</td></tr>').join('');
  $('#pivotTable').innerHTML = '<thead><tr><th>Level</th><th>Price</th><th>Distance</th><th>Type</th></tr></thead><tbody>' + pRows + '</tbody>';

  const risk = [
    ['ATR (14)', nf(A.atr, 2), nf(A.atrPct, 2) + '% of price'],
    ['Historical Vol (1Y)', nf(A.vol1y, 1) + '%', '252 sessions, annualised'],
    ['Max Drawdown (3Y)', nf(A.maxDD, 1) + '%', 'Peak to trough'],
    ['Sharpe Ratio', nf(A.sharpe, 2), 'Risk-adjusted return'],
    ['Beta', nf(u.beta, 2), 'vs S&P 500'],
    ['Day Range Width', nf((A.dayH - A.dayL) / A.price * 100, 2) + '%', 'Intraday spread'],
    ['52W Range Position', nf((A.price - A.lo52) / (A.hi52 - A.lo52) * 100, 1) + '%', '0 = low · 100 = high'],
    ['ATR Percentile', nf(pctRankLocal(A), 1) + '%', 'vs 1Y distribution']
  ].map(x => '<tr><td>' + x[0] + '</td><td>' + x[1] + '</td><td style="color:var(--txt-3)">' + x[2] + '</td></tr>').join('');
  $('#riskTable').innerHTML = '<thead><tr><th>Metric</th><th>Value</th><th>Note</th></tr></thead><tbody>' + risk + '</tbody>';

  $('#signalStrip').innerHTML = A.signals.map(s =>
    '<div class="sig ' + (s.s > 0 ? 'buy' : s.s < 0 ? 'sell' : 'neutral') + '">' +
    '<span class="n">' + s.n + '</span>' +
    '<span class="r">' + (Math.abs(s.v) > 999 ? fmtBig(s.v) : nf(s.v, 2)) + '</span>' +
    '<span class="t ' + (s.s > 0 ? 'up' : s.s < 0 ? 'down' : 'flat') + '">' + s.t + '</span></div>').join('');

  const neutral = A.total - A.bull - A.bear;
  const verdict = A.score > 25 ? 'Strong Buy' : A.score > 8 ? 'Buy' : A.score < -25 ? 'Strong Sell' : A.score < -8 ? 'Sell' : 'Hold';
  const vcol = A.score > 8 ? 'up' : A.score < -8 ? 'down' : 'flat';
  const sma200 = A.sma[200][A.b.length - 1];
  $('#signalSummary').innerHTML =
    '<div class="ss-score ' + vcol + '">' + (A.score > 0 ? '+' : '') + A.score + '</div>' +
    '<div class="ss-bars">' +
    '<div class="ss-b"><div class="lab"><span>Buy</span><span>' + A.bull + '</span></div><div class="ss-track"><i style="width:' +
    (A.bull / A.total * 100) + '%;background:var(--up)"></i></div></div>' +
    '<div class="ss-b"><div class="lab"><span>Neutral</span><span>' + neutral + '</span></div><div class="ss-track"><i style="width:' +
    (neutral / A.total * 100) + '%;background:var(--warn)"></i></div></div>' +
    '<div class="ss-b"><div class="lab"><span>Sell</span><span>' + A.bear + '</span></div><div class="ss-track"><i style="width:' +
    (A.bear / A.total * 100) + '%;background:var(--down)"></i></div></div></div>' +
    '<div class="ss-note">Composite read: <b class="' + vcol + '">' + verdict + '</b>. ' + A.bull +
    ' of ' + A.total + ' tracked signals lean bullish, ' + A.bear +
    ' bearish. Price is ' + (sma200 && A.price > sma200 ? 'above' : 'below') + ' the 200-day SMA.</div>';
  /* ---- indicator history: RSI and stochastic share the 0-100 scale ---- */
  const P = pal();
  const win = Math.min(180, A.b.length);
  const rsiAll = rsi(A.b.map(x => x.c));
  const stAll = stochastic(A.b);
  const startIdx = A.b.length - win;
  const rsiWin = rsiAll.slice(startIdx);
  const stKWin = stAll.k.slice(startIdx);
  drawLineChart($('#techChart'), [
    { name: 'RSI 14', color: P.acc, data: rsiWin },
    { name: 'Stoch %K', color: P.warn, data: stKWin, fill: true }
  ], {
    fmtY: t => nf(t, 0),
    labels: A.b.slice(startIdx).map((x, i) => i % Math.ceil(win / 6) === 0 ? x.t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''),
    yMin: 0, yMax: 100, baseZero: false, grid: true
  });

  /* ---- trend & momentum readout ---- */
  const roc = (n) => A.b.length > n ? (A.price / A.b[A.b.length - 1 - n].c - 1) * 100 : 0;
  const smaV = (n) => { const arr = A.sma[n]; return arr && arr[A.b.length - 1] != null && isFinite(arr[A.b.length - 1]) ? arr[A.b.length - 1] : null; };
  const slope = (n) => {
    const arr = A.sma[n];
    if (!arr || A.b.length < n + 10) return null;
    const a = arr[A.b.length - 11], b = arr[A.b.length - 1];
    if (a == null || b == null || !isFinite(a) || !isFinite(b) || !a) return null;
    return (b / a - 1) * 100;
  };
  const relToSpy = (n) => {
    try {
      const mine = A.b[A.b.length - 1].c / A.b[A.b.length - 1 - n].c;
      const sp = spyDaily();
      const s = sp[sp.length - 1].c / sp[sp.length - 1 - n].c;
      return (mine / s - 1) * 100;
    } catch (e) { return null; }
  };
  const pos200 = smaV(200) ? (A.price / smaV(200) - 1) * 100 : null;
  const tRows = [
    ['Price vs SMA 50', pos200 == null ? '—' : fmtPct((A.price / (smaV(50) || A.price) - 1) * 100), (A.price >= (smaV(50) || A.price) ? 'bull' : 'bear'), 'Trend'],
    ['Price vs SMA 200', pos200 == null ? '—' : fmtPct(pos200), (A.price >= (smaV(200) || A.price) ? 'bull' : 'bear'), 'Long-term trend'],
    ['SMA 50 slope (10d)', slope(50) == null ? '—' : fmtPct(slope(50)), (slope(50) || 0) >= 0 ? 'bull' : 'bear', 'Rising / falling'],
    ['MACD histogram', nf(A.macd.hist[A.b.length - 1], 3), A.macd.hist[A.b.length - 1] >= 0 ? 'bull' : 'bear', 'Momentum'],
    ['ROC 10d', fmtPct(roc(10)), roc(10) >= 0 ? 'bull' : 'bear', 'Rate of change'],
    ['ROC 30d', fmtPct(roc(30)), roc(30) >= 0 ? 'bull' : 'bear', 'Rate of change'],
    ['Relative to S&P (1M)', relToSpy(21) == null ? '—' : fmtPct(relToSpy(21)), (relToSpy(21) || 0) >= 0 ? 'bull' : 'bear', 'Outperformance'],
    ['Relative to S&P (3M)', relToSpy(63) == null ? '—' : fmtPct(relToSpy(63)), (relToSpy(63) || 0) >= 0 ? 'bull' : 'bear', 'Outperformance'],
    ['52W range position', nf((A.price - A.lo52) / (A.hi52 - A.lo52) * 100, 1) + '%', 'flat', '0 = low · 100 = high'],
    ['ATR percentile', nf(pctRankLocal(A), 1) + '%', 'flat', 'Volatility vs 1Y']
  ].map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td><span class="badge ' +
    (r[2] === 'bull' ? 'buy' : r[2] === 'bear' ? 'sell' : 'hold') + '">' +
    (r[2] === 'bull' ? 'Bullish' : r[2] === 'bear' ? 'Bearish' : 'Neutral') + '</span></td>' +
    '<td style="color:var(--txt-3)">' + r[3] + '</td></tr>').join('');
  $('#trendTable').innerHTML = '<thead><tr><th>Metric</th><th>Value</th><th>Bias</th><th>Note</th></tr></thead><tbody>' + tRows + '</tbody>';
}

function pctRankLocal(A) {
  const arr = A.b.slice(-252).map(x => x.h - x.l);
  const cur = A.b[A.b.length - 1].h - A.b[A.b.length - 1].l;
  let c = 0;
  for (const v of arr) if (v < cur) c++;
  return c / arr.length * 100;
}

/* ========================================================= FINANCIALS ==== */
function finTable(el, head, body) {
  if (!el) return;
  const th = '<thead><tr><th>Line item</th>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead>';
  const tb = body.map(r => {
    if (r.section) return '<tr class="section"><td colspan="' + (head.length + 1) + '">' + r.section + '</td></tr>';
    return '<tr><td>' + r.k + '</td>' + r.v.map(v => '<td class="' + (v.cls || '') + '">' + v.t + '</td>').join('') + '</tr>';
  }).join('');
  el.innerHTML = th + '<tbody>' + tb + '</tbody>';
}
function V(n, d) { d = d == null ? 0 : d; return { t: nf(n, d), cls: n < 0 ? 'neg' : '' }; }
function mUSD(t) { const a = Math.abs(t); if (a >= 1e6) return nf(t / 1e6, 2) + 'T'; if (a >= 1e3) return nf(t / 1e3, 0) + 'B'; return nf(t, 0) + 'M'; }
function Pc(n, d) { d = d == null ? 1 : d; return { t: nf(n, d) + '%', cls: n < 0 ? 'neg' : '' }; }
function Dl(n) { return { t: '$' + nf(n, 2), cls: n < 0 ? 'neg' : '' }; }

function renderFinancials() {
  const f = fundamentals(state.sym);
  const u = currentMeta();
  const n = f.years.length;
  const head = [];
  for (let i = 0; i < n; i++) head.push(fyLabel(f.years[i]));

  const rev = f.rev, ni = f.ni;
  finTable($('#incomeTable'), head, [
    { section: 'Revenue' },
    { k: 'Total Revenue', v: rev.map(x => V(x)) },
    { k: 'Cost of Goods Sold', v: rev.map((x, i) => V(-x * (1 - f.gm[i] / 100))) },
    { k: 'Gross Profit', v: rev.map((x, i) => V(x * f.gm[i] / 100)) },
    { section: 'Profitability' },
    { k: 'Operating Income', v: rev.map((x, i) => V(x * f.om[i] / 100)) },
    { k: 'Interest Expense', v: rev.map(x => V(-x * 0.021)) },
    { k: 'Pre-tax Income', v: rev.map((x, i) => V(x * (f.om[i] / 100 - 0.021))) },
    { k: 'Net Income', v: ni.map(x => V(x)) },
    { section: 'Per Share & Margins' },
    { k: 'Diluted EPS', v: ni.map(x => Dl(x / f.shares)) },
    { k: 'Gross Margin', v: f.gm.map(x => Pc(x)) },
    { k: 'Operating Margin', v: f.om.map(x => Pc(x)) },
    { k: 'Net Margin', v: f.nm.map(x => Pc(x)) }
  ]);

  const aI = i => f.assets * (1 + i * 0.045);
  const lI = i => f.liab * (1 + i * 0.04);
  const eI = i => aI(i) - lI(i);
  const nRow = (fn) => { const o = []; for (let i = 0; i < n; i++) o.push(V(fn(i))); return o; };
  const ratioRow = () => { const o = []; for (let i = 0; i < n; i++) o.push({ t: nf(lI(i) / eI(i), 2) }); return o; };
  finTable($('#balanceTable'), head, [
    { section: 'Assets' },
    { k: 'Cash & Equivalents', v: nRow(i => f.cash * (1 + i * 0.03)) },
    { k: 'Receivables', v: nRow(i => aI(i) * 0.11) },
    { k: 'Inventory', v: nRow(i => aI(i) * 0.06) },
    { k: 'Total Current Assets', v: nRow(i => aI(i) * 0.33) },
    { k: 'Property & Equipment', v: nRow(i => aI(i) * 0.19) },
    { k: 'Goodwill & Intangibles', v: nRow(i => aI(i) * 0.24) },
    { k: 'Total Assets', v: nRow(aI) },
    { section: 'Liabilities & Equity' },
    { k: 'Total Current Liabilities', v: nRow(i => lI(i) * 0.42) },
    { k: 'Long-term Debt', v: nRow(i => lI(i) * 0.34) },
    { k: 'Total Liabilities', v: nRow(lI) },
    { k: "Shareholders' Equity", v: nRow(eI) },
    { k: 'Liabilities / Equity', v: ratioRow() }
  ]);

  const paysDiv = u.div > 0 ? 0.45 : 0;
  finTable($('#cashTable'), head, [
    { section: 'Operating' },
    { k: 'Net Income', v: ni.map(x => V(x)) },
    { k: 'Depreciation & Amortisation', v: ni.map(x => V(Math.abs(x) * 0.14)) },
    { k: 'Stock-based Compensation', v: ni.map(x => V(Math.abs(x) * 0.09)) },
    { k: 'Change in Working Capital', v: ni.map(x => V(-Math.abs(x) * 0.05)) },
    { k: 'Cash from Operations', v: f.opCF.map(x => V(x)) },
    { section: 'Investing & Financing' },
    { k: 'Capital Expenditure', v: f.capex.map(x => V(-x)) },
    { k: 'Acquisitions & Investing', v: f.capex.map(x => V(-x * 1.35)) },
    { k: 'Dividends Paid', v: f.ni.map(x => V(-Math.max(0, x) * paysDiv)) },
    { k: 'Share Repurchase', v: f.ni.map(x => V(-Math.max(0, x) * 0.55)) },
    { k: 'Free Cash Flow', v: f.fcf.map(x => V(x)) }
  ]);

  const yl = [];
  for (let i = 0; i < n; i++) yl.push(fyLabel(f.years[i]));
  const P = pal();
  drawGroupedBars($('#fcfChart'), yl, [
    { name: 'Operating CF', color: P.acc, data: f.opCF },
    { name: 'Capex', color: P.down, data: f.capex.map(x => -x) },
    { name: 'Free Cash Flow', color: P.up, data: f.fcf }
  ], { fmtY: mUSD });

  finTable($('#fcfTable'), yl, [
    { k: 'Operating Cash Flow', v: f.opCF.map(x => V(x)) },
    { k: 'Capital Expenditure', v: f.capex.map(x => V(-x)) },
    { k: 'Free Cash Flow', v: f.fcf.map(x => V(x)) },
    { k: 'FCF Margin', v: f.fcf.map((x, i) => Pc(x / f.rev[i] * 100)) },
    { k: 'FCF per Share', v: f.fcf.map(x => Dl(x / f.shares)) }
  ]);
}

/* ========================================================== VALUATION ==== */
function renderValuation() {
  const u = currentMeta();
  const A = computeAnalysis(state.sym);
  const P = pal();

  const mults = [
    { k: 'P/E (Trailing)', v: u.pe, lo: Math.min(0, u.pe * 0.5), hi: u.pe * 1.5, med: u.pe * 0.95, peer: u.pe * 0.92 },
    { k: 'Forward P/E', v: u.pe * 0.86, lo: Math.min(0, u.pe * 0.45), hi: u.pe * 1.3, med: u.pe * 0.8, peer: u.pe * 0.78 },
    { k: 'PEG Ratio', v: u.growth > 0 ? u.pe / u.growth : 99, lo: 0.5, hi: 4, med: 1.6, peer: 1.8 },
    { k: 'Price / Sales', v: u.ps, lo: 0, hi: Math.max(1, u.ps * 1.7), med: u.ps * 0.95, peer: u.ps * 0.88 },
    { k: 'Price / Book', v: Math.max(0.4, u.roe > 0 ? Math.abs(u.pe) * 0.16 : 1.4), lo: 0.4, hi: 14, med: 4.2, peer: 4.6 },
    { k: 'EV / EBITDA', v: Math.abs(u.pe) * 0.68, lo: 0, hi: Math.abs(u.pe) * 1.3, med: Math.abs(u.pe) * 0.62, peer: Math.abs(u.pe) * 0.6 },
    { k: 'Price / FCF', v: Math.abs(u.pe) * 1.18, lo: 0, hi: Math.abs(u.pe) * 2, med: Math.abs(u.pe) * 1.1, peer: Math.abs(u.pe) * 1.05 },
    { k: 'Dividend Yield %', v: u.div, lo: 0, hi: Math.max(7, u.div * 1.6), med: 1.4, peer: 1.7, invert: true }
  ];
  const rows = mults.map(m => {
    const span = (m.hi - m.lo) || 1;
    const pct = clamp((m.v - m.lo) / span * 100, 2, 100);
    const medPct = clamp((m.med - m.lo) / span * 100, 1, 99);
    const peerPct = clamp((m.peer - m.lo) / span * 100, 1, 99);
    const cheap = m.invert ? m.v > m.med : m.v < m.med;
    return '<tr><td>' + m.k + '</td><td><b>' + nf(m.v, 2) + '</b></td><td>' + nf(m.med, 2) + '</td><td>' + nf(m.peer, 2) +
      '</td><td><div class="val-bar"><i style="width:' + pct + '%"></i><u style="left:' + medPct +
      '%"></u><em style="left:' + peerPct + '%"></em></div></td>' +
      '<td><span class="badge ' + (cheap ? 'buy' : 'sell') + '">' + (cheap ? 'Cheap' : 'Rich') + '</span></td></tr>';
  }).join('');
  $('#valTable').innerHTML =
    '<thead><tr><th>Metric</th><th>Current</th><th>5Y Median</th><th>Sector</th><th>Range</th><th>Verdict</th></tr></thead><tbody>' + rows + '</tbody>';

  const all = genDaily(state.sym);
  const seg = all.slice(-130);
  const peSeries = seg.map((x, i) => {
    const eps = Math.max(0.2, u.eps * (0.78 + 0.22 * (i / seg.length)));
    return x.c / eps;
  });
  const mean = peSeries.reduce((a, b) => a + b, 0) / peSeries.length;
  const sd = Math.sqrt(peSeries.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / peSeries.length);
  drawLineChart($('#peChart'), [
    { name: 'P/E', color: P.acc, data: peSeries, fill: true },
    { name: 'Mean', color: P.warn, data: peSeries.map(() => mean) },
    { name: '+1σ', color: hexA(P.down, 0.75), data: peSeries.map(() => mean + sd) },
    { name: '−1σ', color: hexA(P.up, 0.75), data: peSeries.map(() => mean - sd) }
  ], {
    fmtY: t => nf(t, 0) + '×',
    labels: seg.map(x => x.t.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }))
  });

  renderDCF();
  renderPeers();
}

function renderDCF() {
  const u = currentMeta();
  const f = fundamentals(state.sym);
  const A = computeAnalysis(state.sym);
  const host = $('#dcf');
  if (!host) return;
  if (!host.dataset.built) {
    host.dataset.built = '1';
    host.innerHTML =
      '<div class="dcf-grid">' +
      '<div class="dcf-in"><label>Revenue growth (Y1-5)</label><input id="dcfG" type="number" value="' + clamp(u.growth, -5, 45).toFixed(1) + '" step="0.5"></div>' +
      '<div class="dcf-in"><label>FCF margin</label><input id="dcfM" type="number" value="' + clamp(f.fcf[f.years.length - 1] / f.rev[f.years.length - 1] * 100, 2, 60).toFixed(1) + '" step="0.5"></div>' +
      '<div class="dcf-in"><label>WACC / discount rate</label><input id="dcfW" type="number" value="9.0" step="0.25"></div>' +
      '<div class="dcf-in"><label>Terminal growth</label><input id="dcfT" type="number" value="2.5" step="0.25"></div>' +
      '</div><div class="dcf-out" id="dcfOut"></div>';
    $$('#dcf input').forEach(i => i.addEventListener('input', runDCF));
  }
  runDCF();

  function runDCF() {
    const g = parseFloat($('#dcfG').value) / 100;
    const m = parseFloat($('#dcfM').value) / 100;
    const w = parseFloat($('#dcfW').value) / 100;
    const tg = parseFloat($('#dcfT').value) / 100;
    const rev0 = f.rev[f.years.length - 1];
    let pv = 0;
    let lastFcf = rev0 * m;
    for (let y = 1; y <= 5; y++) {
      const gr = g * (1 - (y - 1) * 0.14);
      const fcf = rev0 * Math.pow(1 + gr, y) * m;
      pv += fcf / Math.pow(1 + w, y);
      lastFcf = fcf;
    }
    const tv = w > tg ? (lastFcf * (1 + tg)) / (w - tg) : NaN;
    const ev = pv + (isFinite(tv) ? tv / Math.pow(1 + w, 5) : pv * 2);
    const equity = ev - f.netDebt;
    const perShare = equity / f.shares;
    const upside = (perShare / A.price - 1) * 100;
    const exitMult = tv / lastFcf;
    const curEVm = (u.mcap + f.netDebt * 1e6) / 1e6;
    const curMult = curEVm / Math.max(1, rev0 * m);
    $('#dcfOut').innerHTML =
      '<div class="dcf-o"><div class="k">Enterprise Value</div><div class="v">' + fmtCap(ev * 1e6) +
      '</div><div class="s">PV of 5Y FCF + terminal</div></div>' +
      '<div class="dcf-o"><div class="k">Equity Value</div><div class="v">' + fmtCap(equity * 1e6) +
      '</div><div class="s">Less net debt ' + fmtCap(f.netDebt * 1e6) + '</div></div>' +
      '<div class="dcf-o fair"><div class="k">Fair Value / Share</div><div class="v ' + signCls(upside) + '">$' + nf(perShare, 2) +
      '</div><div class="s">' + fmtPct(upside, 1) + ' vs market</div></div>' +
      '<div class="dcf-note" style="grid-column:1/-1">Implied exit multiple <b>' + nf(exitMult, 1) +
      '×</b> FCF vs <b>' + nf(curMult, 1) + '×</b> in the market today — the gap is the growth and discount-rate assumption you have not modelled. Margin held flat; no extrapolation past year 5.</div>';
  }
}

function renderPeers() {
  const metric = state.peer;
  const defs = {
    pe: { f: s => UNIVERSE[s].pe, label: 'P/E', fmt: t => nf(t, 0) + '×' },
    ps: { f: s => UNIVERSE[s].ps, label: 'P/S', fmt: t => nf(t, 0) + '×' },
    roe: { f: s => UNIVERSE[s].roe, label: 'ROE %', fmt: t => nf(t, 0) + '%' },
    growth: { f: s => UNIVERSE[s].growth, label: 'Growth %', fmt: t => nf(t, 0) + '%' },
    margin: { f: s => UNIVERSE[s].net, label: 'Net Margin %', fmt: t => nf(t, 0) + '%' }
  };
  const d = defs[metric];
  const u = currentMeta();
  const sectorPeers = SYMBOLS.filter(s => UNIVERSE[s].sector === u.sector);
  let set = sectorPeers.slice();
  if (set.length < 6) {
    const rest = SYMBOLS.filter(s => set.indexOf(s) < 0)
      .sort((a, b) => Math.abs(UNIVERSE[a].mcap - u.mcap) - Math.abs(UNIVERSE[b].mcap - u.mcap));
    set = set.concat(rest.slice(0, 6 - set.length));
  }
  set = set.slice(0, 7);
  if (set.indexOf(state.sym) < 0) set = [state.sym].concat(set).slice(0, 8);

  const P = pal();
  drawGroupedBars($('#peerChart'), set, [
    {
      name: d.label, color: P.acc,
      colors: set.map(s => s === state.sym ? P.acc2 : hexA(P.acc, 0.38)),
      data: set.map(s => d.f(s))
    }
  ], {
    fmtY: t => d.fmt(t), legend: false, barValues: t => d.fmt(t),
    labelColors: set.map(s => s === state.sym ? P.txt : P.txt3),
    labelWeights: set.map(s => s === state.sym)
  });
}

/* ============================================================== FLOW ===== */
/* Fetches institutional ownership + short interest, then repaints Holdings. */
function loadOwnership(sym) {
  if (!sym) return Promise.resolve(null);
  if (LIVE.loading['own:' + sym]) return LIVE.loading['own:' + sym];
  const job = Promise.all([api.holders(sym), api.short(sym)]).then(rs => {
    if (rs[0]) LIVE.holders[sym] = rs[0];
    if (rs[1]) LIVE.short[sym] = rs[1];
    if (state.sym === sym && state.page === 'holdings') renderFlow();
    return sym;
  }).catch(() => null).finally(() => { delete LIVE.loading['own:' + sym]; });
  LIVE.loading['own:' + sym] = job;
  return job;
}

function renderFlow() {
  const u = currentMeta();
  const rnd = mulberry32(hashStr(state.sym) ^ 0x0dd5);
  const P = pal();
  const h = LIVE.holders[state.sym] || null;
  const sh = LIVE.short[state.sym] || null;
  const sub = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

  /* ---- shareholder breakdown: real institutional % when live ---- */
  const instPct = h && h.institutionsPct != null ? clamp(h.institutionsPct, 0, 100) : null;
  if (instPct != null) {
    const segs = [
      { n: 'Institutions', v: instPct, c: P.acc },
      { n: 'Retail & Other', v: 100 - instPct, c: P.up }
    ];
    drawDonut($('#ownChart'), segs, fmtCap(u.mcap * 0.94), 'Free float');
    $('#ownLegend').innerHTML = segs.map(s =>
      '<div class="lg-row"><span class="sw" style="background:' + s.c + '"></span><span class="nm">' + s.n +
      '</span><span class="pc">' + nf(s.v, 2) + '%</span><span class="sh">' + fmtCap(u.mcap * 0.94 * s.v / 100) + '</span></div>').join('') +
      '<div class="lg-note">' +
      (h.totals && h.totals.holders ? nf(h.totals.holders, 0) + ' institutions hold ' +
        (h.holdingsValueM ? fmtCap(h.holdingsValueM * 1e6) : '—') : '') +
      (h.asOf ? ' · as of ' + h.asOf : '') + '</div>';
    sub('#ownSub', 'Live 13F · Nasdaq');
  } else {
    const inst = 55 + rnd() * 20;
    const fund = 12 + rnd() * 10;
    const insider = 1 + rnd() * 8;
    const retail = Math.max(4, 100 - inst - fund - insider);
    const segs = [
      { n: 'Institutions', v: inst, c: P.acc },
      { n: 'Mutual Funds', v: fund, c: P.acc2 },
      { n: 'Insiders', v: insider, c: P.warn },
      { n: 'Retail & Other', v: retail, c: P.up }
    ];
    drawDonut($('#ownChart'), segs, fmtCap(u.mcap * 0.94), 'Free float');
    $('#ownLegend').innerHTML = segs.map(s =>
      '<div class="lg-row"><span class="sw" style="background:' + s.c + '"></span><span class="nm">' + s.n +
      '</span><span class="pc">' + nf(s.v, 1) + '%</span><span class="sh">' + fmtCap(u.mcap * 0.94 * s.v / 100) + '</span></div>').join('');
    sub('#ownSub', 'Modelled split — 13F feed pending');
  }

  /* ---- institutional position changes: real 13F flow when live ---- */
  const flowRows = []
    .concat(h && h.positions ? h.positions : [])
    .concat(h && h.movement ? h.movement : [])
    .filter(r => r && r.shares != null && r.label &&
      !/^held/i.test(r.label) && !/^total/i.test(r.label));
  if (flowRows.length >= 2) {
    const SHORT = { 'increased': 'Added', 'decreased': 'Trimmed', 'new': 'New', 'sold out': 'Sold Out' };
    const trim = l => {
      const k = String(l).replace(/\s+Positions?$/i, '').toLowerCase();
      return SHORT[k] || String(l).replace(/\s+Positions?$/i, '');
    };
    drawGroupedBars($('#flowChart'), flowRows.map(r => trim(r.label)), [
      { name: 'Shares', color: P.acc, data: flowRows.map(r => r.shares / 1e6) }
    ], { fmtY: t => nf(t, t >= 100 ? 0 : 1) + 'M', padL: 52 });
    sub('#flowSub', 'Shares added vs trimmed · latest 13F' + (h.asOf ? ' · ' + h.asOf : ''));
  } else {
    const q = ['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'];
    const instFlow = q.map(() => (rnd() - 0.42) * 42);
    const insFlow = q.map(() => (rnd() - 0.5) * 9);
    drawGroupedBars($('#flowChart'), q, [
      { name: 'Institutional', color: P.acc, data: instFlow },
      { name: 'Insider', color: P.warn, data: insFlow }
    ], { fmtY: t => (t === 0 ? '0' : nf(t, 1) + 'M'), padL: 56 });
    sub('#flowSub', 'Modelled flow — 13F feed pending');
  }

  /* ---- short interest: real semi-monthly series when live ---- */
  const f = fundamentals(state.sym);
  const outM = (h && h.sharesOutM) || (f && f.shares) || u.shares;
  const sRows = sh && sh.rows ? sh.rows.slice().reverse() : null;
  const sPct = sRows && outM
    ? sRows.map(r => (r.interest != null && outM > 0) ? r.interest / (outM * 1e6) * 100 : null)
    : null;
  if (sPct && sPct.length >= 3 && sPct.every(v => v != null)) {
    drawLineChart($('#shortChart'), [
      { name: '% of shares', color: P.down, data: sPct, fill: true, dots: true }
    ], {
      fmtY: t => nf(t, 2) + '%',
      labels: sRows.map(r => {
        const p = String(r.date || '').replace(/^0/g, '').replace('/0', '/');
        return p.split('/').slice(0, 2).join('/');
      }),
      dots: true
    });
    sub('#shortSub', 'Semi-monthly · Nasdaq · latest ' + (sRows[sRows.length - 1].date || ''));
  } else {
    const sq = ['Q1', 'Q2', 'Q3', 'Q4', 'Q1', 'Q2', 'Q3', 'Q4'];
    const short = [];
    let lvl = 1.6 + rnd() * 3;
    for (let i = 0; i < 8; i++) { lvl = Math.max(0.3, lvl + (rnd() - 0.5) * 1.3); short.push(lvl); }
    drawLineChart($('#shortChart'), [
      { name: '% of float', color: P.down, data: short, fill: true, dots: true }
    ], { fmtY: t => nf(t, 1) + '%', labels: sq, dots: true });
    sub('#shortSub', 'Modelled series — short feed pending');
  }

  /* ---- top institutional holders: real 13F roster when live ---- */
  if (h && h.holders && h.holders.length) {
    const out = outM ? outM * 1e6 : null;
    $('#holdersTable').innerHTML =
      '<thead><tr><th>Holder</th><th>Shares</th><th>% Out</th><th>Value</th><th>QoQ Change</th></tr></thead><tbody>' +
      h.holders.map(x =>
        '<tr><td>' + esc(x.name) + '</td><td>' + fmtBig(x.shares) + '</td><td>' +
        (out ? nf(x.shares / out * 100, 2) + '%' : '—') + '</td><td>' +
        fmtCap((x.valueK || 0) * 1000) + '</td><td class="' + signCls(x.chgPct || 0) + '">' +
        (x.chgPct != null ? fmtPct(x.chgPct) : '—') + '</td></tr>').join('') +
      '</tbody>';
    sub('#holdersSub', '13F holdings · as of ' + (h.asOf || 'latest'));
  } else {
    const holders = [
      ['The Vanguard Group', 8.42, 0.31], ['BlackRock Inc.', 7.18, 0.22],
      ['State Street Corporation', 4.06, 0.14], ['Fidelity Investments', 3.44, -0.09],
      ['Geode Capital Management', 2.11, 0.18], ['T. Rowe Price', 1.86, -0.24],
      ['Northern Trust', 1.52, 0.07], ['Morgan Stanley', 1.34, 0.41]
    ].map(x => ({ name: x[0], pct: x[1] * (0.7 + rnd() * 0.6), chg: x[2] + (rnd() - 0.5) * 0.1 }))
      .map(x => Object.assign(x, { shares: u.mcap * x.pct / 100 / u.price }))
      .sort((a, b) => b.pct - a.pct);

    $('#holdersTable').innerHTML =
      '<thead><tr><th>Holder</th><th>Shares</th><th>% Out</th><th>Value</th><th>QoQ Change</th></tr></thead><tbody>' +
      holders.map(x =>
        '<tr><td>' + x.name + '</td><td>' + fmtBig(x.shares) + '</td><td>' + nf(x.pct, 2) + '%</td><td>' +
        fmtCap(x.shares * u.price) + '</td><td class="' + signCls(x.chg) + '">' + fmtPct(x.chg) + '</td></tr>').join('') +
      '</tbody>';
    sub('#holdersSub', 'Modelled roster — 13F feed pending');
  }

  /* warm the live feeds on first visit; repaints once they land */
  if (!LIVE.holders[state.sym] || !LIVE.short[state.sym]) loadOwnership(state.sym);
}

/* ============================================================== NEWS ===== */
function renderNews() {
  const P = pal();
  const items = newsItems(state.sym);
  $('#newsList').innerHTML = items.map(x => {
    const cls = x.score > 0.15 ? 'p' : x.score < -0.15 ? 'n' : 'm';
    const title = esc(x.title);
    const head = x.link
      ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + title + '</a>'
      : title;
    return '<article class="news"><div class="score ' + cls + '">' + (x.score > 0 ? '+' : '') + nf(x.score * 100, 0) +
      '</div><div><div class="hd">' + head + '</div>' +
      '<div class="mt"><span>' + x.src + '</span><span>' + x.time + '</span><span>' + state.sym + '</span></div>' +
      '<div class="sum">' + esc(x.sum) + '</div></div></article>';
  }).join('');
  $$('.news', $('#newsList')).forEach(n => {
    const a = n.querySelector('a');
    if (!a) { n.style.cursor = 'default'; return; }
    n.onclick = (e) => { if (e.target.closest('a')) return; window.open(a.href, '_blank', 'noopener'); };
  });

  /*30-day polarity: real article scores when timestamps exist, synthetic otherwise */
  const now = Date.now();
  const buckets = [];
  for (let i = 0; i < 30; i++) buckets.push([]);
  let dated = 0;
  items.forEach(x => {
    const t = typeof x.ts === 'number' ? x.ts : (x.ts ? Date.parse(x.ts) : NaN);
    if (!isFinite(t)) return;
    const age = Math.floor((now - t) / 86400000);
    if (age >= 0 && age < 30) { buckets[29 - age].push(x.score); dated++; }
  });
  let series = null;
  if (dated >= 5) {
    series = [];
    let last = 0, seen = false;
    for (let i = 0; i < 30; i++) {
      if (buckets[i].length) {
        last = buckets[i].reduce((a, c) => a + c, 0) / buckets[i].length;
        seen = true;
      }
      series.push(seen ? last : null);
    }
  } else {
    const rnd = mulberry32(hashStr(state.sym) ^ 0x5e77);
    series = [];
    for (let i = 0; i < 30; i++) series.push((rnd() - 0.45) * 1.6);
  }
  const sub = $('#sentSub');
  if (sub) sub.textContent = dated >= 5
    ? '30-day polarity · ' + dated + ' dated headlines'
    : '30-day article polarity';
  drawLineChart($('#sentChart'), [
    { name: 'Sentiment', color: P.acc, data: series, fill: true, dots: true }
  ], { fmtY: t => nf(t, 1), labels: series.map((_, i) => i % 6 === 0 ? 'D-' + (30 - i) : ''), baseZero: true });

  $('#events').innerHTML = eventList().map(ev =>
    '<div class="ev"><span class="d">' + ev.d + '</span><div><div class="t">' + ev.t + '</div><div class="s">' + ev.s + '</div></div></div>').join('');
}

function eventList() {
  const u = currentMeta();
  const now = new Date();
  const fmt = d => ({ m: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(), d: String(d.getDate()).padStart(2, '0') });
  const mk = (daysFromNow) => fmt(new Date(now.getTime() + daysFromNow * 86400000));
  const dateOf = (v) => {
    if (!v) return null;
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (!isFinite(t)) return null;
    const d = new Date(t);
    return now - d > 90 * 86400000 ? null : d;
  };
  const co = LIVE.company[state.sym] || {};
  const earn = co.earnings || {};
  const liveNext = dateOf(earn.next);
  const liveEx = dateOf(earn.exDividendDate);

  const e1 = liveNext ? fmt(liveNext) : mk(11 + (hashStr(state.sym) % 25));
  const e2 = liveEx ? fmt(liveEx) : mk(24 + (hashStr(state.sym + 'd') % 30));
  const e3 = mk(45 + (hashStr(state.sym + 'm') % 40));
  const e4 = mk(68 + (hashStr(state.sym + 'c') % 45));
  const cons = earn.consensus || (earn.quarterly && earn.quarterly[0] && earn.quarterly[0].estimate);
  return [
    { d: e1.m + ' ' + e1.d, t: 'Quarterly Earnings', s: (liveNext ? 'Scheduled' : 'Estimated') + ' after the closing bell' + (cons ? ' · consensus $' + nf(cons, 2) + ' EPS' : '') },
    { d: e2.m + ' ' + e2.d, t: 'Ex-Dividend Date', s: u.div > 0 ? 'Payout $' + nf(u.div / 100 * u.price / 4, 2) + ' per share' : 'No dividend declared' },
    { d: e3.m + ' ' + e3.d, t: 'Investor Day / Conference', s: 'Management presentation and Q&A' },
    { d: e4.m + ' ' + e4.d, t: 'Index Rebalance Review', s: 'Quarterly weighting adjustment window' }
  ];
}

/* ============================================================== RAIL ===== */
function renderRail() {
  const u = currentMeta();
  const A = computeAnalysis(state.sym);
  const f = fundamentals(state.sym);
  const P = pal();

  const valScore = radarScores(state.sym).v[0];
  const combo = clamp(A.score * 0.6 + (valScore - 50) * 0.8 + 22, -100, 100);
  /* real analyst counts when the proxy delivered them, modelled scores otherwise */
  const co = LIVE.company[state.sym] || {};
  const tg = co.targets || {};
  const tr = (co.trend && co.trend[0]) || null;
  const strongB = tr ? tr.strongBuy || 0 : 0;
  const strongS = tr ? tr.strongSell || 0 : 0;
  const lBuy = tr && tr.buy != null ? tr.buy : (tg.buy != null ? tg.buy : null);
  const lHold = tr && tr.hold != null ? tr.hold : (tg.hold != null ? tg.hold : null);
  const lSell = tr && tr.sell != null ? tr.sell : (tg.sell != null ? tg.sell : null);
  const hasRatings = lBuy != null && lHold != null && lSell != null;
  const modelTotal = 38 + (hashStr(state.sym + 'ratings') % 23);
  const bull = clamp(combo / 62, -1, 1);
  const total = hasRatings ? lBuy + lHold + lSell + strongB + strongS : modelTotal;
  const buy = hasRatings ? lBuy + strongB : clamp(Math.round(modelTotal * clamp(0.32 + bull * 0.3, 0.03, 0.82)), 1, modelTotal - 2);
  const sell = hasRatings ? lSell + strongS : clamp(Math.round(modelTotal * clamp(0.13 - bull * 0.13, 0.01, 0.4)), 0, modelTotal - buy - 1);
  const hold = Math.max(0, total - buy - sell);
  const consScore = total ? Math.round((buy - sell) / total * 100) : 0;
  const cons = tg.recommendation || (consScore > 30 ? 'Strong Buy' : consScore > 10 ? 'Buy'
    : consScore < -30 ? 'Strong Sell' : consScore < -10 ? 'Sell' : 'Hold');
  const consCls = /buy/i.test(cons) && !/hold/i.test(cons) ? 'buy' : /sell/i.test(cons) ? 'sell' : 'hold';
  const consSrc = hasRatings ? (String(co.source || 'live').toUpperCase()) : 'modelled';

  $('#consensus').innerHTML =
    '<div class="cons-badge ' + consCls + '">' + esc(cons) + '</div>' +
    '<div class="cons-meta">Based on <b>' + total + '</b> analyst ratings' +
    (tg.mean != null ? ' · PT <b>' + fmtPrice(tg.mean) + '</b>' : '') +
    '<br>Consensus score <b>' + (consScore > 0 ? '+' : '') + consScore + '</b> / 100 · ' + consSrc + '</div>';

  const barsHtml = [
    { n: 'Buy', v: buy, c: 'var(--up)' },
    { n: 'Hold', v: hold, c: 'var(--warn)' },
    { n: 'Sell', v: sell, c: 'var(--down)' }
  ].map(x => '<div class="rb"><span class="lab">' + x.n + '</span><span class="tr"><i style="width:' +
    (total ? (x.v / total * 100) : 0) + '%;background:' + x.c + '"></i></span><span class="num">' + x.v + '</span></div>').join('');
  $('#ratingBars').innerHTML = barsHtml;

  if (tg.low != null && tg.mean != null && tg.high != null) {
    const upside = A.price ? (tg.mean / A.price - 1) * 100 : 0;
    $('#priceTarget').innerHTML =
      '<div class="pt"><div class="k">Low</div><div class="v down">' + fmtPrice(tg.low) + '</div></div>' +
      '<div class="pt"><div class="k">Average</div><div class="v">' + fmtPrice(tg.mean) + '</div></div>' +
      '<div class="pt"><div class="k">High</div><div class="v up">' + fmtPrice(tg.high) + '</div></div>' +
      '<div class="pt pt-note"><div class="k">Avg vs last</div><div class="v ' + signCls(upside) + '">' +
      fmtPct(upside) + '</div></div>';
  } else {
    const base = A.price * (1 + consScore / 100 * 0.28);
    $('#priceTarget').innerHTML =
      '<div class="pt"><div class="k">Low</div><div class="v down">' + fmtPrice(base * 0.86) + '</div></div>' +
      '<div class="pt"><div class="k">Average</div><div class="v">' + fmtPrice(base) + '</div></div>' +
      '<div class="pt"><div class="k">High</div><div class="v up">' + fmtPrice(base * 1.16) + '</div></div>';
  }

  const gaugeVal = clamp(A.score + 50, 2, 98);
  drawGauge($('#gaugeChart'), gaugeVal);
  const gLabel = gaugeVal > 70 ? 'Strong Buy' : gaugeVal > 55 ? 'Buy' : gaugeVal < 30 ? 'Strong Sell' : gaugeVal < 45 ? 'Sell' : 'Hold';
  const gCol = gaugeVal > 55 ? 'up' : gaugeVal < 45 ? 'down' : 'flat';
  $('#gaugeLabel').innerHTML = '<div class="big ' + gCol + '">' + gLabel + '</div>' +
    '<div class="sub">Technical score ' + Math.round(gaugeVal) + ' / 100</div>';

  const levels = [
    { cls: 'res', n: 'Resistance R2', v: A.piv.R2 },
    { cls: 'res', n: 'Resistance R1', v: A.piv.R1 },
    { cls: 'piv', n: 'Classic Pivot', v: A.piv.P },
    { cls: 'now', n: 'Last Price', v: A.price },
    { cls: 'sup', n: 'Support S1', v: A.piv.S1 },
    { cls: 'sup', n: 'Support S2', v: A.piv.S2 },
    { cls: 'sup', n: '52W Low', v: A.lo52 },
    { cls: 'res', n: '52W High', v: A.hi52 }
  ];
  $('#levels').innerHTML = levels.map(x =>
    '<div class="lv ' + x.cls + '"><span class="n">' + x.n + '</span><span class="v">' + fmtPrice(x.v) + '</span></div>').join('');

  $('#railEvents').innerHTML = eventList().slice(0, 3).map(ev =>
    '<div class="ev"><span class="d">' + ev.d + '</span><div><div class="t">' + ev.t + '</div><div class="s">' + ev.s + '</div></div></div>').join('');

  renderDepth(A.price);
  $('#footStats').textContent = SYMBOLS.length + ' instruments · 1,560 sessions · ' + A.signals.length + ' oscillators + ' + A.maRows.length + ' moving averages tracked';
}

function renderDepth(price) {
  const rnd = mulberry32(hashStr(state.sym + 'book'));
  const tick = Math.max(0.01, price * 0.0004);
  const rows = [];
  let cumA = 0, cumB = 0;
  const asks = [], bids = [];
  for (let i = 1; i <= 7; i++) {
    const sz = Math.round(200 + rnd() * 3800);
    cumA += sz;
    asks.push({ p: price + tick * i, sz: sz, cum: cumA });
    const sz2 = Math.round(200 + rnd() * 3800);
    cumB += sz2;
    bids.push({ p: price - tick * i, sz: sz2, cum: cumB });
  }
  const mxCum = Math.max(cumA, cumB);
  const row = (x, side) => '<div class="dp ' + side + '"><i style="width:' + (x.cum / mxCum * 100) + '%"></i>' +
    '<span class="pr">' + fmtPrice(x.p) + '</span><span class="sz">' + x.sz.toLocaleString('en-US') +
    '</span><span class="tot">' + x.cum.toLocaleString('en-US') + '</span></div>';
  asks.slice().reverse().forEach(x => rows.push(row(x, 'ask')));
  rows.push('<div class="dp-spread"><span>SPREAD</span><span>' + fmtPrice(tick * 2) + ' · ' + nf(tick * 2 / price * 10000, 1) + ' bps</span></div>');
  bids.forEach(x => rows.push(row(x, 'bid')));
  $('#depth').innerHTML = rows.join('');
}

/* ============================================================= TABS ====== */
const TAB_RENDER = {
  market: renderMarket,
  overview: renderOverview,
  technicals: renderTechnicals,
  financials: renderFinancials,
  valuation: renderValuation,
  flow: renderFlow,
  news: renderNews
};
const tabDone = {};

function renderTab(tab) {
  try {
    TAB_RENDER[tab]();
    tabDone[tab] = true;
  } catch (err) {
    console.error('render ' + tab, err);
  }
}

function setTab(tab) {
  const key = String(tab || '').replace(/^#\/?/, '').split('/')[0];
  const page = TAB_PAGE[key] || (PAGES.indexOf(key) >= 0 ? key : 'stock');
  setView(page);
}

/* ============================================================ CHART UI ==== */
function setTF(tf) {
  tf = String(tf || '').toUpperCase();
  if (!TF_DEFAULT[tf]) tf = TF_DEFAULT[state.tf] ? state.tf : '1M';
  state.tf = tf;
  $$('#tfSeg button').forEach(b => b.classList.toggle('on', b.dataset.tf === tf));
  const apply = () => {
    const data = bars();
    const want = Math.min(TF_DEFAULT[state.tf] || 60, data.length);
    state.view = { start: Math.max(0, data.length - want), count: want };
    state.hover = null;
    drawMain();
  };
  apply();
  if (tf === '1D' || tf === '5D') {
    const sym = state.sym;
    loadIntraday(sym, tf).then(() => {
      if (state.tf !== tf || state.sym !== sym) return;
      apply();
    });
  }
}

function redrawAll() {
  renderQuote();
  renderStats();
  renderWatchlist();
  drawMain();
  renderRail();
  Object.keys(tabDone).forEach(k => { if (tabDone[k]) renderTab(k); });
}

function selectSymbol(sym) {
  if (!sym) return;
  sym = String(sym).toUpperCase();
  if (!UNIVERSE[sym] && !LIVE.quotes[sym] && !LIVE.meta[sym]) {
    /* symbol outside the built-in universe: ask the proxy for its quote first */
    api.quotes([sym]).then(r => {
      if (r && r.quotes && r.quotes[0]) { applyQuote(sym, r.quotes[0]); selectSymbol(sym); }
      else toast(sym + ' not found');
    });
    return;
  }
  state.sym = sym;
  $$('#searchResults .sr-item').forEach(n => n.classList.remove('sel'));
  const nav = $('#navSym');
  if (nav) nav.childNodes[0].nodeValue = sym + ' ';
  setTF(state.tf);
  redrawAll();
  const u = liveMeta(sym);
  toast('Loaded ' + sym + (u && u.name && u.name !== sym ? ' · ' + u.name : ''));
  loadSymbol(sym).then(() => {
    if (state.sym !== sym) return;
    setTF(state.tf);
    redrawAll();
    renderPage(state.page);
    const note = $('#dataNote');
    if (note) {
      const src = LIVE.src[sym];
      note.hidden = false;
      note.textContent = src
        ? 'Live data for ' + sym + ' from ' + String(src).toUpperCase() + ' · refreshed ' + new Date(LIVE.ts[sym] || Date.now()).toLocaleTimeString('en-US', { hour12: false })
        : 'Showing built-in sample data for ' + sym + ' — the live proxy has not answered yet.';
    }
  });
}

function fitChart() {
  const wrap = $('#chartWrap');
  if (!wrap) return;
  drawMain();
}

/* ========================================================== INTERACTION === */
function bindChart() {
  const cv = $('#mainChart');
  const wrap = $('#chartWrap');
  let dragging = false, lastX = 0;

  const idxFromX = (clientX) => {
    const r = cv.getBoundingClientRect();
    const x = clientX - r.left;
    const plotW = r.width - PAD.l - PAD.r;
    const bw = plotW / state.view.count;
    return Math.round((x - PAD.l) / bw - 0.5 + state.view.start);
  };

  cv.addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    if (dragging) {
      const plotW = r.width - PAD.l - PAD.r;
      const bw = plotW / state.view.count;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      const shift = -dx / bw;
      const data = bars();
      const maxStart = Math.max(0, data.length - Math.round(state.view.count));
      state.view.start = clamp(state.view.start + shift, 0, maxStart);
      drawMain();
      return;
    }
    const i = clamp(idxFromX(e.clientX), 0, bars().length - 1);
    if (i !== state.hover) { state.hover = i; drawMain(); }
  });

  cv.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; cv.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; cv.style.cursor = 'crosshair'; } });
  cv.addEventListener('mouseleave', () => { state.hover = null; drawMain(); });

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const data = bars();
    const anchor = state.hover == null ? state.view.start + state.view.count / 2 : state.hover;
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const newCount = clamp(Math.round(state.view.count * factor), 12, data.length);
    const rel = (anchor - state.view.start) / state.view.count;
    let start = anchor - rel * newCount;
    state.view.count = newCount;
    state.view.start = clamp(start, 0, Math.max(0, data.length - newCount));
    drawMain();
  }, { passive: false });

  /* touch pan */
  let touchX = null;
  cv.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  cv.addEventListener('touchmove', e => {
    if (touchX == null) return;
    const plotW = cv.getBoundingClientRect().width - PAD.l - PAD.r;
    const bw = plotW / state.view.count;
    const dx = e.touches[0].clientX - touchX;
    touchX = e.touches[0].clientX;
    const data = bars();
    state.view.start = clamp(state.view.start - dx / bw, 0, Math.max(0, data.length - state.view.count));
    drawMain();
  }, { passive: true });
  cv.addEventListener('touchend', () => { touchX = null; });

  wrap.addEventListener('mouseleave', () => { state.hover = null; drawMain(); });
}

function bindToolbar() {
  $$('#tfSeg button').forEach(b => { b.onclick = () => setTF(b.dataset.tf); });

  $$('#typeSeg button').forEach(b => {
    b.onclick = () => {
      state.type = b.dataset.type;
      $$('#typeSeg button').forEach(x => x.classList.toggle('on', x === b));
      drawMain();
    };
  });

  $$('#ovChips .chip').forEach(ch => {
    ch.onclick = () => {
      const k = ch.dataset.ov;
      state.overlays[k] = !state.overlays[k];
      ch.classList.toggle('on', state.overlays[k]);
      drawMain();
    };
  });

  $$('#paneChips .chip').forEach(ch => {
    ch.onclick = () => {
      const k = ch.dataset.pane;
      state.panes[k] = !state.panes[k];
      ch.classList.toggle('on', state.panes[k]);
      drawMain();
    };
  });

  $$('#logSeg button').forEach(b => {
    b.onclick = () => {
      state.log = b.dataset.scale === 'log';
      $$('#logSeg button').forEach(x => x.classList.toggle('on', x === b));
      drawMain();
    };
  });

  $('#resetZoom').onclick = () => setTF(state.tf);

  $$('#peerSeg button').forEach(b => {
    b.onclick = () => {
      state.peer = b.dataset.peer;
      $$('#peerSeg button').forEach(x => x.classList.toggle('on', x === b));
      renderPeers();
    };
  });

  $$('#tabs .tab').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
}

function bindSearch() {
  const input = $('#searchInput');
  const box = $('#searchResults');
  let sel = -1;
  let matches = [];

  const close = () => { box.hidden = true; sel = -1; };

  let remote = [];
  let remoteQ = null;

  const pull = (q) => {
    if (!q || remoteQ === q) return;
    remoteQ = q;
    api.search(q).then(res => {
      const list = (res && res.quotes) || [];
      remote = list.filter(x => x && x.symbol && SYMBOLS.indexOf(x.symbol) < 0).slice(0, 5);
      if (input.value.trim().toUpperCase() === q) draw();
    });
  };

  const draw = () => {
    const q = input.value.trim().toUpperCase();
    const rows = SYMBOLS.filter(s => !q || s.indexOf(q) === 0 || UNIVERSE[s].name.toUpperCase().indexOf(q) >= 0)
      .slice(0, 9)
      .map(s => ({ sym: s, name: UNIVERSE[s].name, sector: UNIVERSE[s].sector, kind: 'local' }));
    if (q && rows.length < 9) {
      remote.forEach(r => {
        if (rows.some(x => x.sym === r.symbol)) return;
        rows.push({ sym: r.symbol, name: r.name || r.symbol, sector: r.exchange || '', kind: 'remote' });
      });
    }
    matches = rows.map(r => r.sym);
    if (!rows.length) { close(); return; }
    box.hidden = false;
    box.innerHTML = rows.map((r, i) => {
      let price = null;
      if (LIVE.quotes[r.sym] && LIVE.quotes[r.sym].price != null) price = LIVE.quotes[r.sym].price;
      else if (r.kind === 'local') { try { price = computeAnalysis(r.sym).price; } catch (e) { price = null; } }
      const sector = r.kind === 'local'
        ? (liveMeta(r.sym) || UNIVERSE[r.sym]).sector
        : r.sector;
      return '<div class="sr-item ' + (i === sel ? 'sel' : '') + '" data-sym="' + r.sym + '">' +
        '<span class="sr-sym">' + r.sym + '</span><span class="sr-name">' + esc(r.name) + '</span>' +
        '<span class="sr-name" style="flex:0 0 auto;font-family:var(--mono)">' + (price != null ? fmtPrice(price) : '—') + '</span>' +
        '<span class="sr-sec">' + esc(sector || '') + '</span></div>';
    }).join('');
    $$('.sr-item', box).forEach(n => { n.onclick = () => { selectSymbol(n.dataset.sym); input.value = ''; close(); }; });
  };

  input.addEventListener('input', () => { draw(); pull(input.value.trim().toUpperCase()); });
  input.addEventListener('focus', draw);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, matches.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const s = matches[sel < 0 ? 0 : sel];
      if (s) { selectSymbol(s); input.value = ''; close(); input.blur(); }
    } else if (e.key === 'Escape') { close(); input.blur(); }
  });
  document.addEventListener('click', e => { if (!$('#search').contains(e.target)) close(); });

  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); input.select(); }
  });
}

function bindMisc() {
  $('#starBtn').onclick = () => {
    if (state.watch.has(state.sym)) { state.watch.delete(state.sym); toast(state.sym + ' removed from watchlist'); }
    else { state.watch.add(state.sym); toast(state.sym + ' added to watchlist'); }
    renderQuote();
    renderWatchlist();
  };

  $('#addWatch').onclick = () => {
    state.watch.add(state.sym);
    renderWatchlist();
    renderQuote();
    toast(state.sym + ' pinned to watchlist');
  };

  $('#collapseSide').onclick = () => {
    const side = $('#sidebar');
    side.style.display = side.style.display === 'none' ? '' : 'none';
  };

  $('#themeBtn').onclick = () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    try { localStorage.setItem('sl-theme', state.theme); } catch (e) {}
    redrawAll();
    toast(state.theme === 'dark' ? 'Dark theme' : 'Light theme');
  };

  $('#exportBtn').onclick = () => {
    const A = computeAnalysis(state.sym);
    const u = currentMeta();
    const snap = {
      symbol: state.sym, company: u.name, exchange: u.exch,
      price: A.price, changePct: +A.chgPct.toFixed(2),
      technicalScore: A.score, rsi14: +A.rsi.toFixed(2),
      macd: +A.macd.line.toFixed(3), sma20: +A.sma[20][A.b.length - 1].toFixed(2),
      sma50: +A.sma[50][A.b.length - 1].toFixed(2), sma200: +A.sma[200][A.b.length - 1].toFixed(2),
      returns: A.ret, volatility1Y: +A.vol1y.toFixed(2), maxDrawdown: +A.maxDD.toFixed(2),
      valuation: { pe: u.pe, ps: u.ps, roe: u.roe, dividendYield: u.div },
      dataSources: {
        chart: LIVE.src[state.sym] || null,
        fundamentals: LIVE.fund[state.sym] ? 'live' : 'demo',
        holders: LIVE.holders[state.sym] ? LIVE.holders[state.sym].source : null,
        news: LIVE.news[state.sym] ? 'live' : null
      },
      generatedAt: new Date().toISOString(),
      note: 'StockLens research snapshot generated from live exchange feeds where available; technical indicators are computed client-side from the exported price history.'
    };
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.sym + '-stocklens-snapshot.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Snapshot exported for ' + state.sym);
  };

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      drawMain();
      if (state.tab) renderTab(state.tab);
      renderRail();
    }, 120);
  });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(drawMain, 60); });
    ro.observe($('#chartWrap'));
  }
}

function tickClock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString('en-US', { hour12: false });
  const day = d.getDay();
  const mins = d.getHours() * 60 + d.getMinutes();
  const open = day >= 1 && day <= 5 && mins >= 570 && mins < 960;
  const pill = $('#mktStatus');
  pill.classList.toggle('closed', !open);
  $('#mktText').textContent = open ? 'MARKET OPEN' : 'MARKET CLOSED';
}

/* ============================================================ LIVE DATA ==== */
const POS_WORDS = ['beat', 'beats', 'rise', 'rises', 'rising', 'jump', 'jumps', 'surge', 'record',
  'upgrade', 'upgraded', 'raise', 'raises', 'lift', 'boost', 'strong', 'growth', 'win', 'wins',
  'deal', 'deal$', 'buy', 'buyback', 'bullish', 'outperform', 'approve', 'approved', 'soar',
  'rally', 'higher', 'tops', 'exceeds', 'expands', 'optimistic', 'rebound', 'gain'];
const NEG_WORDS = ['miss', 'misses', 'fall', 'falls', 'falling', 'drop', 'drops', 'slump', 'warn',
  'warns', 'cuts', 'cuts$', 'delay', 'probe', 'sues', 'lawsuit', 'recall', 'weak', 'decline',
  'bearish', 'downgrade', 'downgraded', 'risk', 'loss', 'losses', 'fraud', 'investigation',
  'halt', 'plunge', 'tumbles', 'lower', 'concern', 'slashes', 'misses'];

function scoreHeadline(t) {
  const w = String(t || '').toLowerCase().split(/[^a-z]+/);
  let s = 0;
  for (const x of w) { if (POS_WORDS.indexOf(x) >= 0) s++; else if (NEG_WORDS.indexOf(x) >= 0) s--; }
  return clamp(s / 4, -1, 1);
}

function relTime(ts) {
  if (!ts) return 'recently';
  const ms = Date.now() - ts;
  if (ms < 0) return 'just now';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return Math.max(1, Math.floor(ms / 60000)) + 'm ago';
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

/* Google News titles end in " - publisher"; the publisher has its own field. */
function cleanTitle(title, publisher) {
  let t = String(title || '');
  if (publisher) {
    const tail = ' - ' + publisher;
    if (t.length > tail.length && t.slice(-tail.length).toLowerCase() === tail.toLowerCase()) t = t.slice(0, -tail.length);
  }
  const m = t.match(/\s+-\s+[A-Za-z0-9.\s&]{3,40}$/);
  if (m && publisher && t.slice(-m[0].length).toLowerCase().indexOf(String(publisher).toLowerCase().slice(0, 12)) >= 0) {
    t = t.slice(0, -m[0].length);
  }
  return t.trim();
}

function mapNews(payload) {
  const rows = (payload && payload.news) || [];
  return rows.map(n => ({
    id: n.id || n.link,
    title: cleanTitle(n.title, n.publisher),
    score: scoreHeadline(n.title),
    src: n.publisher || (payload.source === 'google-news' ? 'Google News' : 'Wire'),
    time: relTime(n.time),
    sum: n.summary || (n.related && n.related.length ? 'Related: ' + n.related.slice(0, 4).join(', ') : ''),
    link: n.link,
    ts: n.time || null
  })).filter(x => x.title);
}

function applyQuote(sym, q) {
  if (!q) return;
  LIVE.quotes[sym] = q;
  livePut(sym, 'price', q.price);
  livePut(sym, 'mcap', q.marketCap);
  livePut(sym, 'name', q.name);
  if (q.exchange) livePut(sym, 'exch', String(q.exchange).replace(/-GS$/, ''));
  if (q.volume != null) livePut(sym, 'vol', q.volume);
}

function applyCompany(sym, c) {
  if (!c) return;
  LIVE.company[sym] = c;
  LIVE.src[sym] = c.source || LIVE.src[sym];
  const v = c.valuation || {}, p = c.price || {};
  livePut(sym, 'name', c.name);
  livePut(sym, 'sector', c.sector);
  livePut(sym, 'industry', c.industry);
  livePut(sym, 'exch', c.exchange);
  livePut(sym, 'price', p.last);
  livePut(sym, 'mcap', p.marketCap);
  livePut(sym, 'beta', p.beta);
  livePut(sym, 'pe', v.trailingPE);
  livePut(sym, 'ps', v.priceToSales);
  livePut(sym, 'eps', v.eps);
  livePut(sym, 'div', v.dividendYield);
  livePut(sym, 'roe', v.returnOnEquity != null ? v.returnOnEquity * 100 : null);
  livePut(sym, 'gross', v.grossMargins != null ? v.grossMargins * 100 : null);
  livePut(sym, 'op', v.operatingMargins != null ? v.operatingMargins * 100 : null);
  livePut(sym, 'net', v.profitMargins != null ? v.profitMargins * 100 : null);
  livePut(sym, 'growth', v.revenueGrowth != null ? v.revenueGrowth * 100 : null);
  livePut(sym, 'debt', v.debtToEquity);
  livePut(sym, 'cash', v.totalCash != null ? v.totalCash / 1e9 : null);
  livePut(sym, 'shares', v.sharesOutstanding);
  livePut(sym, 'emp', c.employees);
  livePut(sym, 'desc', c.description);
  livePut(sym, 'hq', c.country);
}

function seedFundamentals(sym, f) {
  if (!f) return;
  LIVE.fund[sym] = f;
  const last = f.years ? f.years.length - 1 : -1;
  if (last >= 0) {
    livePut(sym, 'rev', f.rev[last] / 1000);
    livePut(sym, 'ni', f.ni[last] / 1000);
  }
  if (f.eps != null) livePut(sym, 'eps', f.eps);
}

function loadDaily(sym, range) {
  if (!sym) return Promise.resolve(null);
  const k = 'spark:' + sym + ':' + range;
  if (LIVE.loading[k] || LIVE.spark[sym + ':' + range]) return Promise.resolve(LIVE.spark[sym + ':' + range]);
  const job = api.chart(sym, range).then(ch => {
    if (!ch || !ch.bars || !ch.bars.length) return null;
    const bars = ch.bars.map(b => ({ t: new Date(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    LIVE.spark[sym + ':' + range] = bars;
    return bars;
  }).catch(() => null).finally(() => { delete LIVE.loading[k]; });
  LIVE.loading[k] = job;
  return job;
}

/* Pulls everything one symbol needs: history, profile, model, news, quote. */
function loadSymbol(sym) {
  if (!sym) return Promise.resolve(null);
  if (LIVE.loading['sym:' + sym]) return LIVE.loading['sym:' + sym];
  const job = Promise.all([
    api.chart(sym, 'MAX'),
    api.company(sym),
    api.fundamentals(sym),
    api.news(sym, 12),
    api.quotes([sym])
  ]).then(rs => {
    const ch = rs[0], co = rs[1], fu = rs[2], nw = rs[3], qs = rs[4];
    if (ch && ch.bars && ch.bars.length > 120) {
      LIVE.daily[sym] = ch.bars.map(b => ({ t: new Date(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
      LIVE.src[sym] = ch.source || LIVE.src[sym];
      LIVE.ts[sym] = Date.now();
      delete _dailyCache[sym];
    }
    if (co) applyCompany(sym, co);
    if (fu) seedFundamentals(sym, fu);
    if (nw) LIVE.news[sym] = mapNews(nw);
    if (qs && qs.quotes && qs.quotes[0]) applyQuote(sym, qs.quotes[0]);
    loadOwnership(sym);
    return sym;
  }).catch(() => null).finally(() => { delete LIVE.loading['sym:' + sym]; });
  LIVE.loading['sym:' + sym] = job;
  return job;
}

/* 1D/5D intraday windows are fetched only when the toolbar asks for them. */
function loadIntraday(sym, tf) {
  const k = sym + ':' + tf;
  if (!sym || (tf !== '1D' && tf !== '5D')) return Promise.resolve(null);
  if (LIVE.intra[k] || LIVE.loading['intra:' + k]) return Promise.resolve(LIVE.intra[k] || null);
  const job = api.chart(sym, tf).then(ch => {
    if (!ch || !ch.bars || !ch.bars.length) return null;
    const bars = ch.bars.map(b => ({ t: new Date(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    LIVE.intra[k] = bars;
    return bars;
  }).catch(() => null).finally(() => { delete LIVE.loading['intra:' + k]; });
  LIVE.loading['intra:' + k] = job;
  return job;
}

function loadWatchQuotes() {
  const syms = Array.from(state.watch);
  if (!syms.length) return Promise.resolve(null);
  const job = api.quotes(syms).then(res => {
    if (!res || !res.quotes) return null;
    res.quotes.forEach(q => { if (q && q.symbol) applyQuote(q.symbol, q); });
    renderWatchlist();
    if (state.page === 'market') renderMarket();
    return res;
  }).catch(() => null).finally(() => { delete LIVE.loading.watch; });
  if (!LIVE.loading.watch) LIVE.loading.watch = job;
  return job;
}


/* ================================================================ ROUTER == */
const PAGES = ['market', 'stock', 'technicals', 'financials', 'valuation', 'holdings', 'news'];
const PAGE_TAB = {
  market: 'market', stock: 'overview', technicals: 'technicals',
  financials: 'financials', valuation: 'valuation', holdings: 'flow', news: 'news'
};
const TAB_PAGE = {
  market: 'market', overview: 'stock', technicals: 'technicals',
  financials: 'financials', valuation: 'valuation', flow: 'holdings', news: 'news'
};

function pageFromHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const head = raw.split('/')[0].toLowerCase();
  const alias = { overview: 'stock', ownership: 'holdings', flow: 'holdings', 'valuation-ratios': 'valuation' };
  if (alias[head]) return alias[head];
  return PAGES.indexOf(head) >= 0 ? head : null;
}

function setView(page) {
  if (PAGES.indexOf(page) < 0) page = 'market';
  state.page = page;
  state.tab = PAGE_TAB[page] || 'overview';
  const view = page === 'market' ? 'market' : 'stock';
  document.body.dataset.view = view;
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'pg-' + page));
  $$('#pagenav a').forEach(a => {
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const navSym = $('#navSym');
  if (navSym) navSym.style.display = view === 'stock' ? '' : 'none';
  const want = '#/' + page;
  if (location.hash !== want) {
    try { history.replaceState(null, '', want); } catch (e) { location.hash = want; }
  }
  requestAnimationFrame(() => {
    renderPage(page);
    if (view === 'stock') { drawMain(); renderRail(); }
  });
}

function renderPage(page) {
  renderTab(PAGE_TAB[page] || page);
}

function bindNav() {
  $$('#pagenav a').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      setView(a.dataset.page);
    });
  });
  const navSym = $('#navSym');
  if (navSym) navSym.addEventListener('click', () => { $('#searchInput').focus(); });
  window.addEventListener('hashchange', () => {
    const p = pageFromHash();
    if (p && p !== state.page) setView(p);
  });
}

/* ============================================================== MARKET ==== */
const INDEX_NAME = {
  '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq Composite', '^DJI': 'Dow Jones',
  '^RUT': 'Russell 2000', '^VIX': 'Volatility', '^NDX': 'Nasdaq 100'
};
const SECTOR_NAME = {
  XLK: 'Technology', XLF: 'Financials', XLE: 'Energy', XLV: 'Health Care',
  XLY: 'Consumer Discretionary', XLC: 'Communication Services', XLI: 'Industrials',
  XLP: 'Consumer Staples', XLU: 'Utilities', XLRE: 'Real Estate', XLB: 'Materials'
};

function idxLabel(sym) { return INDEX_NAME[sym] || String(sym || '').replace(/^\^/, ''); }
function sectorLabel(sym) { return SECTOR_NAME[sym] || sym; }
function sparkBars(sym, range) { return LIVE.spark[sym + ':' + range] || null; }
function retBack(bars, n) {
  if (!bars || bars.length <= n) return null;
  const last = bars[bars.length - 1].c, base = bars[bars.length - 1 - n].c;
  if (!base) return null;
  return (last / base - 1) * 100;
}

function fallbackIndices() {
  const g = (sym, name, symbol) => {
    try {
      const b = genDaily(sym);
      const prev = b[b.length - 2].c, last = b[b.length - 1].c;
      return { symbol: symbol, name: name, price: last, change: last - prev,
        changePct: (last / prev - 1) * 100, prevClose: prev, proxy: false };
    } catch (e) { return null; }
  };
  return [
    g('SPY', 'S&P 500', '^GSPC'), g('QQQ', 'Nasdaq Composite', '^IXIC'),
    g('DIA', 'Dow Jones', '^DJI'), g('IWM', 'Russell 2000', '^RUT')
  ].filter(Boolean);
}

function fallbackSectors() {
  return Object.keys(SECTOR_NAME).map(sym => {
    try {
      const b = genDaily(sym);
      const prev = b[b.length - 2].c, last = b[b.length - 1].c;
      return { symbol: sym, price: last, changePct: (last / prev - 1) * 100, prevClose: prev, proxy: false };
    } catch (e) { return null; }
  }).filter(Boolean);
}

function fallbackMovers() {
  const all = SYMBOLS.filter(s => s !== 'SPY').map(s => {
    try { const A = computeAnalysis(s); return { symbol: s, name: UNIVERSE[s].name, price: A.price, changePct: A.chgPct, volume: A.volume }; }
    catch (e) { return null; }
  }).filter(Boolean);
  const byChg = all.slice().sort((a, b) => b.changePct - a.changePct);
  return {
    gainers: byChg.slice(0, 8),
    losers: byChg.slice(-8).reverse(),
    mostActive: all.slice().sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 8)
  };
}

function moverRows(list, cls) {
  if (!list || !list.length) return '<div class="mover"><span class="mv-n">No data</span></div>';
  return list.slice(0, 8).map(x => {
    const chg = x.changePct || 0;
    return '<div class="mover" data-sym="' + x.symbol + '">' +
      '<span class="mv-s">' + x.symbol + '</span>' +
      '<span class="mv-n">' + esc(String(x.name || '').replace(/ (Common Stock|Inc\.?|Corporation|Corp\.?)$/i, '')) + '</span>' +
      '<span class="mv-p">' + fmtPrice(x.price) + '</span>' +
      '<span class="mv-c ' + signCls(chg) + '">' + fmtPct(chg) + '</span>' +
      '</div>';
  }).join('');
}

function renderMarket() {
  const m = LIVE.market;
  const live = !!m;

  /* ---- indices ---- */
  const idx = (m && m.indices && m.indices.length) ? m.indices : fallbackIndices();
  const strip = $('#idxStrip');
  if (strip) {
    strip.innerHTML = idx.map((x, i) => {
      const chg = x.changePct || 0;
      const target = x.proxySymbol || x.symbol;
      return '<div class="idx-card" data-sym="' + target + '" title="' + esc(idxLabel(x.symbol)) + '">' +
        '<div class="idx-top"><span class="idx-name">' + esc(idxLabel(x.symbol)) + '</span>' +
        '<span class="idx-tag">' + (x.proxy ? 'via ' + x.proxySymbol : (x.exchange || '')) + '</span></div>' +
        '<div class="idx-val">' + fmtPrice(x.price) + '</div>' +
        '<div class="idx-chg ' + signCls(chg) + '">' + fmtPct(chg) + '</div>' +
        '<div class="idx-spark"><canvas data-idx="' + i + '"></canvas></div>' +
        '<div class="idx-meta"><span>Prev ' + fmtPrice(x.prevClose) + '</span><span>' +
        esc(x.marketStatus || '') + '</span></div>' +
        '</div>';
    }).join('');
    idx.forEach((x, i) => {
      const target = x.proxySymbol || x.symbol;
      const bars = sparkBars(target, '1M');
      if (bars && bars.length > 4) {
        drawLineChart(strip.querySelector('canvas[data-idx="' + i + '"]'), [
          { name: idxLabel(x.symbol), color: (x.changePct || 0) >= 0 ? pal().up : pal().down, data: bars.map(b => b.c), fill: true }
        ], { padL: 3, padR: 3, padT: 5, padB: 3, fmtY: () => '' });
      }
    });
    $$('.idx-card', strip).forEach(c => {
      c.onclick = () => selectSymbol(c.dataset.sym);
    });
  }

  /* ---- sectors ---- */
  const sec = (m && m.sectors && m.sectors.length) ? m.sectors : fallbackSectors();
  const rows = sec.slice().map(x => {
    const b1m = sparkBars(x.symbol, '3M');
    return {
      symbol: x.symbol,
      label: sectorLabel(x.symbol),
      price: x.price,
      chg1d: x.changePct || 0,
      chg5d: retBack(b1m, 5),
      chg1m: retBack(b1m, 21)
    };
  }).sort((a, b) => b.chg1d - a.chg1d);
  const tbl = $('#sectorTable');
  if (tbl) {
    tbl.innerHTML =
      '<thead><tr><th>Sector</th><th>ETF</th><th class="n">Last</th><th class="n">1D</th><th class="n">5D</th><th class="n">1M</th><th class="w">Day</th></tr></thead><tbody>' +
      rows.map(r => {
        const mx = Math.max(0.6, Math.abs(r.chg1d));
        const w = Math.min(100, Math.abs(r.chg1d) / mx * 100);
        return '<tr data-sym="' + r.symbol + '">' +
          '<td>' + esc(r.label) + '</td>' +
          '<td class="mono dim">' + r.symbol + '</td>' +
          '<td class="n mono">' + fmtPrice(r.price) + '</td>' +
          '<td class="n mono ' + signCls(r.chg1d) + '">' + fmtPct(r.chg1d) + '</td>' +
          '<td class="n mono ' + signCls(r.chg5d) + '">' + (r.chg5d == null ? '—' : fmtPct(r.chg5d)) + '</td>' +
          '<td class="n mono ' + signCls(r.chg1m) + '">' + (r.chg1m == null ? '—' : fmtPct(r.chg1m)) + '</td>' +
          '<td class="w"><span class="mkt-bar"><i style="width:' + w + '%;background:' +
          (r.chg1d >= 0 ? 'var(--up)' : 'var(--down)') + ';' + (r.chg1d < 0 ? 'margin-left:auto' : '') + '"></i></span></td>' +
          '</tr>';
      }).join('') + '</tbody>';
    $$('tbody tr', tbl).forEach(tr => { tr.onclick = () => selectSymbol(tr.dataset.sym); });
  }

  /* ---- movers ---- */
  const mv = (m && m.movers) || fallbackMovers();
  const set = (id, list) => { const el = $(id); if (el) el.innerHTML = moverRows(list); };
  set('#moversGainers', mv.gainers);
  set('#moversLosers', mv.losers);
  set('#moversActive', mv.mostActive);
  $$('.mover[data-sym]').forEach(n => {
    n.onclick = () => {
      const sym = n.dataset.sym;
      const src = [].concat(mv.gainers || [], mv.losers || [], mv.mostActive || []).filter(x => x.symbol === sym)[0];
      if (src) applyQuote(sym, src);
      selectSymbol(sym);
    };
  });

  /* ---- breadth ---- */
  const uni = (m && m.universe) || [];
  const adv = uni.filter(x => x.changePct > 0.05).length;
  const dec = uni.filter(x => x.changePct < -0.05).length;
  const unc = Math.max(0, uni.length - adv - dec);
  const avg = uni.length ? uni.reduce((a, x) => a + (x.changePct || 0), 0) / uni.length : 0;
  const sorted = uni.slice().sort((a, b) => (a.changePct || 0) - (b.changePct || 0));
  const med = sorted.length ? (sorted[Math.floor(sorted.length / 2)].changePct || 0) : 0;
  const best = sorted.length ? sorted[sorted.length - 1] : null;
  const worst = sorted.length ? sorted[0] : null;
  const hi = uni.filter(x => x.changePct > 1).length, lo = uni.filter(x => x.changePct < -1).length;
  const br = $('#breadth');
  if (br) {
    const total = Math.max(1, adv + dec + unc);
    br.innerHTML =
      '<div class="breadth-bar">' +
      '<i class="adv" style="width:' + (adv / total * 100) + '%"></i>' +
      '<i class="unc" style="width:' + (unc / total * 100) + '%"></i>' +
      '<i class="dec" style="width:' + (dec / total * 100) + '%"></i>' +
      '</div>' +
      '<div class="breadth-key">' +
      '<span><i class="bk-dot" style="background:var(--up)"></i>Advancing <b>' + adv + '</b></span>' +
      '<span><i class="bk-dot" style="background:var(--stroke-2)"></i>Flat <b>' + unc + '</b></span>' +
      '<span><i class="bk-dot" style="background:var(--down)"></i>Declining <b>' + dec + '</b></span>' +
      '</div>' +
      '<div class="breadth-stats">' +
      '<div class="breadth-stat"><div class="bs-l">Avg move</div><div class="bs-v ' + signCls(avg) + '">' + fmtPct(avg) + '</div></div>' +
      '<div class="breadth-stat"><div class="bs-l">Median</div><div class="bs-v ' + signCls(med) + '">' + fmtPct(med) + '</div></div>' +
      '<div class="breadth-stat"><div class="bs-l">&gt; +1%</div><div class="bs-v up">' + hi + '</div></div>' +
      '<div class="breadth-stat"><div class="bs-l">&gt; −1%</div><div class="bs-v down">' + lo + '</div></div>' +
      '</div>' +
      '<div class="breadth-stats">' +
      '<div class="breadth-stat"><div class="bs-l">Best</div><div class="bs-v ' + signCls(best ? best.changePct : 0) + '">' +
      (best ? best.symbol + ' ' + fmtPct(best.changePct) : '—') + '</div></div>' +
      '<div class="breadth-stat"><div class="bs-l">Worst</div><div class="bs-v ' + signCls(worst ? worst.changePct : 0) + '">' +
      (worst ? worst.symbol + ' ' + fmtPct(worst.changePct) : '—') + '</div></div>' +
      '<div class="breadth-stat"><div class="bs-l">Unchanged</div><div class="bs-v">' + unc + '</div></div>' +
      '<div class="breadth-stat"><div class="bs-l">Universe</div><div class="bs-v">' + uni.length + '</div></div>' +
      '</div>';
    const sub = $('#breadthSub');
    if (sub) sub.textContent = live ? 'Across ' + uni.length + ' liquid large caps' : 'Simulated breadth — proxy offline';
  }

  /* ---- watchlist detail ---- */
  const wt = $('#mktWatch');
  if (wt) {
    const syms = Array.from(state.watch).filter(s => liveMeta(s) || LIVE.quotes[s]);
    wt.innerHTML =
      '<thead><tr><th>Symbol</th><th>Name</th><th class="n">Last</th><th class="n">Chg%</th>' +
      '<th class="n">Mkt Cap</th><th class="n">Volume</th><th class="n">52W Range</th></tr></thead><tbody>' +
      (syms.length ? syms.map(s => {
        const q = LIVE.quotes[s], u = liveMeta(s);
        let price, chg;
        if (q && q.price != null) { price = q.price; chg = q.changePct; }
        else { try { const A = computeAnalysis(s); price = A.price; chg = A.chgPct; } catch (e) { price = 0; chg = 0; } }
        const hi52 = q && q.high52 != null ? q.high52 : (u ? price * 1.12 : null);
        const lo52 = q && q.low52 != null ? q.low52 : (u ? price * 0.86 : null);
        const pos = hi52 > lo52 ? clamp((price - lo52) / (hi52 - lo52) * 100, 0, 100) : 50;
        return '<tr data-sym="' + s + '">' +
          '<td class="mono"><b>' + s + '</b></td>' +
          '<td class="dim">' + esc((u && u.name) || s) + '</td>' +
          '<td class="n mono">' + fmtPrice(price) + '</td>' +
          '<td class="n mono ' + signCls(chg) + '">' + fmtPct(chg) + '</td>' +
          '<td class="n mono">' + (u ? fmtCap(u.mcap) : '—') + '</td>' +
          '<td class="n mono dim">' + (q && q.volume ? fmtBig(q.volume) : '—') + '</td>' +
          '<td class="n mono dim">' + (hi52 ? fmtPrice(lo52) + ' – ' + fmtPrice(hi52) : '—') + '</td>' +
          '</tr>';
      }).join('') : '<tr><td colspan="7" class="dim">Watchlist empty</td></tr>') + '</tbody>';
    $$('tbody tr[data-sym]', wt).forEach(tr => { tr.onclick = () => selectSymbol(tr.dataset.sym); });
  }

  /* ---- market news ---- */
  const nl = $('#mktNews');
  if (nl) {
    const items = LIVE.marketNews && LIVE.marketNews.length ? LIVE.marketNews : newsItems('SPY').slice(0, 8);
    nl.innerHTML = items.slice(0, 10).map(x => {
      const cls = x.score > 0.15 ? 'p' : x.score < -0.15 ? 'n' : 'm';
      const body = '<div class="score ' + cls + '">' + (x.score > 0 ? '+' : '') + nf(x.score * 100, 0) + '</div>' +
        '<div><div class="hd">' + (x.link ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>' : esc(x.title)) + '</div>' +
        '<div class="mt"><span>' + esc(x.src) + '</span><span>' + esc(x.time) + '</span></div>' +
        (x.sum ? '<div class="sum">' + esc(x.sum) + '</div>' : '') + '</div>';
      return '<article class="news">' + body + '</article>';
    }).join('');
  }

  /* ---- badges ---- */
  const src = live ? (m.source || 'live') : 'simulated';
  const badge = $('#mktSrc');
  if (badge) {
    badge.textContent = live ? 'Live · ' + String(src).toUpperCase() : 'Simulated';
    badge.classList.toggle('sim', !live);
  }
  const stamp = $('#mktStamp');
  if (stamp) stamp.textContent = live && m.fetchedAt ? 'Updated ' + new Date(m.fetchedAt).toLocaleTimeString('en-US', { hour12: false }) : 'Offline — demo figures';
  const sub = $('#mktSub');
  if (sub) sub.textContent = live
    ? 'US equities · indices shown through tracking ETFs when direct quotes are unavailable'
    : 'US equities · running on built-in sample data (start the StockLens proxy for live quotes)';
  const mvSub = $('#moversSub');
  if (mvSub) mvSub.textContent = live ? 'Screened across ' + ((m.universe || []).length) + ' liquid names' : 'Simulated screen';
}

/* Loads the market snapshot plus the small histories its tables need. */
function loadMarket() {
  if (LIVE.loading.market) return LIVE.loading.market;
  const job = Promise.all([api.market(), api.news('SPY', 10)]).then(rs => {
    const m = rs[0], nw = rs[1];
    if (m) { LIVE.market = m; LIVE.marketTs = Date.now(); }
    if (nw) LIVE.marketNews = mapNews(nw);
    const warm = [];
    if (m && m.indices) m.indices.slice(0, 4).forEach(x => warm.push(loadDaily(x.proxySymbol || x.symbol, '1M')));
    if (m && m.sectors) m.sectors.forEach(x => warm.push(loadDaily(x.symbol, '3M')));
    return Promise.all(warm);
  }).then(() => {
    if (state.page === 'market') renderMarket();
    return LIVE.market;
  }).catch(() => null).finally(() => { delete LIVE.loading.market; });
  LIVE.loading.market = job;
  return job;
}

/* ================================================================ INIT ==== */
function init() {
  try {
    const saved = localStorage.getItem('sl-theme');
    if (saved) { state.theme = saved; document.documentElement.setAttribute('data-theme', saved); }
  } catch (e) {}

  bindChart();
  bindToolbar();
  bindSearch();
  bindMisc();
  bindNav();
  tickClock();
  setInterval(tickClock, 1000);

  setTF(state.tf);
  setView(pageFromHash() || 'market');
  redrawAll();

  loadMarket();
  loadWatchQuotes();
  loadSymbol(state.sym).then(() => {
    /* fundamentals/profile/quotes land async — repaint the visible page once ready */
    if (state.page === 'market') return;
    renderPage(state.page);
    drawMain();
    renderRail();
  });
  if (state.page === 'market') loadMarket();

  /* keep the tape fresh without hammering the proxy */
  setInterval(loadWatchQuotes, 60000);
  setInterval(() => { if (state.page === 'market') loadMarket(); else loadSymbol(state.sym); }, 180000);

  setTimeout(() => { drawMain(); renderRail(); }, 60);
  document.fonts && document.fonts.ready.then(() => { drawMain(); renderPage(state.page); renderRail(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
