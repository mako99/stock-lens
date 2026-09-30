/* ==========================================================================
   StockLens — canvas chart engine
   ========================================================================== */
'use strict';

const PAD = { l: 10, r: 66, t: 10, b: 22 };
const PANE_H = { vol: 58, rsi: 66, macd: 66, stoch: 58, atr: 52 };

function strokeSeries(ctx, arr, start, end, xAt, yAt, color, lw) {
  ctx.beginPath();
  let started = false;
  for (let i = start; i < end; i++) {
    const v = arr[i];
    if (v == null || !isFinite(v)) { started = false; continue; }
    const x = xAt(i), y = yAt(v);
    if (!isFinite(y)) { started = false; continue; }
    if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

function chartLayout(h) {
  const paneKeys = Object.keys(state.panes).filter(k => state.panes[k]);
  const panesH = paneKeys.reduce((s, k) => s + PANE_H[k] + 6, 0);
  const priceH = Math.max(140, h - PAD.t - PAD.b - panesH);
  const panes = [];
  let y = PAD.t + priceH + 6;
  for (const k of paneKeys) { panes.push({ key: k, y: y, h: PANE_H[k] }); y += PANE_H[k] + 6; }
  return { priceH: priceH, panes: panes };
}

function timeLabel(d, intraday) {
  if (intraday) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (state.tf === '5Y' || state.tf === 'MAX') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function paneTitle(k) {
  return { vol: 'VOLUME', rsi: 'RSI 14', macd: 'MACD 12,26,9', stoch: 'STOCH %K/%D 14,3', atr: 'ATR 14' }[k] || k.toUpperCase();
}

function drawPane(ctx, key, o) {
  const start = o.start, end = o.end, xAt = o.xAt, py = o.py, ph = o.ph;
  const bw = o.bw, b = o.b, P = o.P, plotW = o.plotW, right = o.right;
  const yOf = (v, a, z) => py + ph - ((v - a) / (z - a || 1)) * ph;

  if (key === 'vol') {
    let mv = 0;
    for (let i = start; i < end; i++) if (b[i].v > mv) mv = b[i].v;
    for (let i = start; i < end; i++) {
      const hgt = (b[i].v / (mv || 1)) * (ph - 6);
      ctx.fillStyle = b[i].c >= b[i].o ? hexA(P.up, 0.5) : hexA(P.down, 0.5);
      ctx.fillRect(xAt(i) - Math.max(1, bw * 0.3), py + ph - hgt, Math.max(1, bw * 0.6), hgt);
    }
    ctx.fillStyle = P.txt3;
    ctx.font = '9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(fmtBig(mv), o.right - 5, py + 9);
    return;
  }

  if (key === 'rsi') {
    const r = rsi(b.map(x => x.c), 14);
    const y = v => yOf(v, 0, 100);
    ctx.fillStyle = hexA(P.txt3, 0.10);
    ctx.fillRect(PAD.l, y(100), plotW, y(70) - y(100));
    ctx.fillRect(PAD.l, y(30), plotW, y(0) - y(30));
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hexA(P.warn, 0.35);
    ctx.lineWidth = 1;
    for (const lv of [30, 70]) {
      const yy = Math.round(y(lv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(right, yy); ctx.stroke();
    }
    ctx.setLineDash([]);
    strokeSeries(ctx, r, start, end, xAt, y, P.acc2, 1.5);
    const last = r[end - 1];
    if (last != null) {
      ctx.fillStyle = P.acc2;
      ctx.font = '700 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(last.toFixed(1), right - 5, py + 9);
    }
    return;
  }

  if (key === 'macd') {
    const m = macd(b.map(x => x.c));
    let mx = 0;
    for (let i = start; i < end; i++) {
      mx = Math.max(mx, Math.abs(m.line[i] || 0), Math.abs(m.signal[i] || 0), Math.abs(m.hist[i] || 0));
    }
    mx = mx || 1;
    const yz = py + ph / 2;
    const sc = v => yz - (v / mx) * (ph / 2 - 3);
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, Math.round(yz) + 0.5); ctx.lineTo(right, Math.round(yz) + 0.5); ctx.stroke();
    for (let i = start; i < end; i++) {
      const v = m.hist[i];
      if (v == null) continue;
      const hgt = (v / mx) * (ph / 2 - 3);
      ctx.fillStyle = v >= 0 ? hexA(P.up, 0.55) : hexA(P.down, 0.55);
      ctx.fillRect(xAt(i) - Math.max(1, bw * 0.28), hgt >= 0 ? yz - hgt : yz, Math.max(1, bw * 0.56), Math.abs(hgt));
    }
    strokeSeries(ctx, m.line, start, end, xAt, sc, P.acc, 1.5);
    strokeSeries(ctx, m.signal, start, end, xAt, sc, P.warn, 1.3);
    return;
  }

  if (key === 'stoch') {
    const s = stochastic(b);
    const y = v => yOf(v, 0, 100);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hexA(P.warn, 0.32);
    ctx.lineWidth = 1;
    for (const lv of [20, 80]) {
      const yy = Math.round(y(lv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(right, yy); ctx.stroke();
    }
    ctx.setLineDash([]);
    strokeSeries(ctx, s.k, start, end, xAt, y, P.acc, 1.5);
    strokeSeries(ctx, s.d, start, end, xAt, y, P.down, 1.3);
    return;
  }

  if (key === 'atr') {
    const a = atr(b);
    let mx = 0;
    for (let i = start; i < end; i++) if ((a[i] || 0) > mx) mx = a[i] || 0;
    mx = mx || 1;
    const y = v => yOf(v, 0, mx);
    ctx.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
      const v = a[i];
      if (v == null) continue;
      const x = xAt(i), yy = y(v);
      if (started) ctx.lineTo(x, yy); else { ctx.moveTo(x, yy); started = true; }
    }
    if (started) {
      ctx.lineTo(xAt(end - 1), py + ph);
      ctx.lineTo(xAt(start), py + ph);
      ctx.closePath();
      ctx.fillStyle = hexA(P.up, 0.10);
      ctx.fill();
    }
    strokeSeries(ctx, a, start, end, xAt, y, P.up, 1.5);
    const lv = a[end - 1];
    if (lv != null) {
      ctx.fillStyle = P.up;
      ctx.font = '700 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(nf(lv, 2), right - 5, py + 9);
    }
  }
}

function updateTip(b, i, intraday) {
  const tip = $('#ohlcTip');
  if (!tip) return;
  const d = b[i];
  const prev = i > 0 ? b[i - 1].c : d.o;
  const chg = (d.c / prev - 1) * 100;
  tip.hidden = false;
  tip.innerHTML =
    '<span class="ohlc-item"><span class="lbl">O</span><b>' + fmtPrice(d.o) + '</b></span>' +
    '<span class="ohlc-item"><span class="lbl">H</span><b class="up">' + fmtPrice(d.h) + '</b></span>' +
    '<span class="ohlc-item"><span class="lbl">L</span><b class="down">' + fmtPrice(d.l) + '</b></span>' +
    '<span class="ohlc-item"><span class="lbl">C</span><b>' + fmtPrice(d.c) + '</b></span>' +
    '<span class="ohlc-item"><span class="lbl">Δ</span><b class="' + signCls(chg) + '">' + fmtPct(chg) + '</b></span>' +
    '<span class="ohlc-item"><span class="lbl">V</span><b>' + fmtBig(d.v) + '</b></span>' +
    '<span class="ohlc-item" style="color:var(--txt-3)">' +
    d.t.toLocaleString('en-US', intraday
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' }) +
    '</span>';
}

function updateLegend(b, i, ov) {
  const host = $('#chartLegend');
  if (!host) return;
  const defs = [
    ['sma20', 'SMA20', 'var(--warn)'],
    ['sma50', 'SMA50', 'var(--acc)'],
    ['ema120', 'EMA120', 'var(--acc-2)'],
    ['vwap', 'VWAP', '#3fd0ff']
  ];
  const items = [];
  for (const d of defs) if (ov[d[0]]) items.push({ lbl: d[1], v: ov[d[0]][i], col: d[2] });
  if (ov.bb && ov.bb.up[i] != null) items.push({ lbl: 'BB(20,2)', v: ov.bb.up[i], col: 'var(--acc-2)' });
  host.innerHTML = items.filter(x => x.v != null)
    .map(x => '<span class="lg"><i style="background:' + x.col + '"></i>' + x.lbl + ' ' + fmtPrice(x.v) + '</span>')
    .join('');
}

function drawMain() {
  const c = ctx2d($('#mainChart'));
  if (!c) return;
  const ctx = c.ctx, w = c.w, h = c.h;
  const P = pal();
  const b = bars();
  if (!b.length) return;
  const intraday = state.tf === '1D' || state.tf === '5D';
  const layout = chartLayout(h);
  const plotW = w - PAD.l - PAD.r;
  const right = w - PAD.r;

  const start = clamp(Math.round(state.view.start), 0, Math.max(0, b.length - 1));
  const end = clamp(start + Math.round(state.view.count), start + 5, b.length);
  const cnt = end - start;
  const bw = plotW / cnt;
  const xAt = i => PAD.l + (i - start + 0.5) * bw;

  const closes = b.map(x => x.c);
  const ov = {
    sma20: state.overlays.sma20 ? sma(closes, 20) : null,
    sma50: state.overlays.sma50 ? sma(closes, 50) : null,
    ema120: state.overlays.ema120 ? ema(closes, 120) : null,
    bb: state.overlays.bb ? bollinger(closes, 20, 2) : null,
    vwap: state.overlays.vwap ? vwap(b) : null
  };

  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < end; i++) {
    if (b[i].l < lo) lo = b[i].l;
    if (b[i].h > hi) hi = b[i].h;
    const keys = ['sma20', 'sma50', 'ema120'];
    for (const k of keys) {
      const arr = ov[k];
      if (arr && arr[i] != null) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; }
    }
    if (ov.bb && ov.bb.up[i] != null) {
      if (ov.bb.dn[i] < lo) lo = ov.bb.dn[i];
      if (ov.bb.up[i] > hi) hi = ov.bb.up[i];
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) return;
  const pad = (hi - lo) * 0.06 || 1;
  const pMin = lo - pad, pMax = hi + pad;
  const yAt = (state.log)
    ? (function () {
        const a = Math.log10(Math.max(1e-6, pMin));
        const z = Math.log10(Math.max(1e-6, pMax));
        return v => PAD.t + layout.priceH - ((Math.log10(Math.max(1e-6, v)) - a) / (z - a || 1)) * layout.priceH;
      })()
    : (v => PAD.t + layout.priceH - ((v - pMin) / (pMax - pMin || 1)) * layout.priceH);

  /* ---- grid + price axis ---- */
  ctx.font = '10.5px "JetBrains Mono", monospace';
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  const ticks = niceTicks(pMin, pMax, 6).filter(t => t >= pMin && t <= pMax);
  for (const t of ticks) {
    const y = Math.round(yAt(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = P.txt3;
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(t), right + 7, y);
  }

  /* ---- time axis ---- */
  ctx.strokeStyle = P.grid;
  ctx.beginPath(); ctx.moveTo(PAD.l, h - PAD.b + 0.5); ctx.lineTo(right, h - PAD.b + 0.5); ctx.stroke();
  const step = Math.max(1, Math.round(cnt / 7));
  ctx.fillStyle = P.txt3;
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  for (let i = start; i < end; i += step) {
    const x = xAt(i);
    ctx.strokeStyle = P.grid;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, PAD.t); ctx.lineTo(Math.round(x) + 0.5, h - PAD.b); ctx.stroke();
    ctx.fillText(timeLabel(b[i].t, intraday), x, h - PAD.b / 2);
  }

  /* ---- bollinger ---- */
  if (ov.bb) {
    ctx.beginPath();
    let started = false;
    for (let i = start; i < end; i++) {
      if (ov.bb.up[i] == null) continue;
      const x = xAt(i), y = yAt(ov.bb.up[i]);
      if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
    }
    for (let i = end - 1; i >= start; i--) {
      if (ov.bb.dn[i] == null) continue;
      ctx.lineTo(xAt(i), yAt(ov.bb.dn[i]));
    }
    ctx.closePath();
    ctx.fillStyle = hexA(P.acc2, 0.10);
    ctx.fill();
    strokeSeries(ctx, ov.bb.up, start, end, xAt, yAt, hexA(P.acc2, 0.7), 1);
    strokeSeries(ctx, ov.bb.dn, start, end, xAt, yAt, hexA(P.acc2, 0.7), 1);
  }

  /* ---- price ---- */
  if (state.type === 'candle' || state.type === 'hollow') {
    const bodyW = Math.max(1, Math.min(bw * 0.66, 18));
    ctx.lineWidth = Math.max(1, Math.min(1.6, bw * 0.14));
    for (let i = start; i < end; i++) {
      const d = b[i];
      const up = d.c >= d.o;
      const col = up ? P.up : P.down;
      const x = xAt(i);
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(x, yAt(d.h)); ctx.lineTo(x, yAt(d.l)); ctx.stroke();
      const y1 = yAt(Math.max(d.o, d.c));
      const y2 = yAt(Math.min(d.o, d.c));
      const bh = Math.max(1, y2 - y1);
      if (state.type === 'hollow') {
        ctx.lineWidth = 1.2;
        ctx.strokeRect(Math.round(x - bodyW / 2) + 0.5, Math.round(y1) + 0.5, Math.round(bodyW), Math.round(bh));
      } else {
        ctx.fillStyle = col;
        ctx.fillRect(x - bodyW / 2, y1, bodyW, bh);
      }
    }
  } else {
    if (state.type === 'area') {
      ctx.beginPath();
      for (let i = start; i < end; i++) {
        const x = xAt(i), y = yAt(b[i].c);
        if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(xAt(end - 1), PAD.t + layout.priceH);
      ctx.lineTo(xAt(start), PAD.t + layout.priceH);
      ctx.closePath();
      const base = b[end - 1].c >= b[start].c ? P.up : P.down;
      const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + layout.priceH);
      grad.addColorStop(0, hexA(base, 0.42));
      grad.addColorStop(1, hexA(base, 0.01));
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.beginPath();
    for (let i = start; i < end; i++) {
      const x = xAt(i), y = yAt(b[i].c);
      if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = b[end - 1].c >= b[start].c ? P.up : P.down;
    ctx.lineWidth = 1.9;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /* ---- moving averages ---- */
  const maDefs = [
    { k: 'sma20', c: P.warn },
    { k: 'sma50', c: P.acc },
    { k: 'ema120', c: P.acc2 },
    { k: 'vwap', c: '#3fd0ff' }
  ];
  for (const d of maDefs) if (ov[d.k]) strokeSeries(ctx, ov[d.k], start, end, xAt, yAt, d.c, 1.35);

  /* ---- pivots ---- */
  if (state.overlays.pivot) {
    let H = -Infinity, L = Infinity;
    for (let i = start; i < end; i++) { if (b[i].h > H) H = b[i].h; if (b[i].l < L) L = b[i].l; }
    const C = b[end - 1].c;
    const P0 = (H + L + C) / 3;
    const lv = [
      { n: 'R1', v: 2 * P0 - L, c: P.down },
      { n: 'P', v: P0, c: P.acc },
      { n: 'S1', v: 2 * P0 - H, c: P.up }
    ];
    ctx.font = '10px "JetBrains Mono", monospace';
    for (const l of lv) {
      if (l.v < pMin || l.v > pMax) continue;
      const y = Math.round(yAt(l.v)) + 0.5;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = hexA(l.c, 0.75);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = l.c;
      ctx.textAlign = 'right';
      ctx.fillText(l.n, right - 6, y - 6);
    }
  }

  /* ---- last price tag ---- */
  const last = b[end - 1];
  const ly = yAt(last.c);
  const tagW = 62, tagH = 16;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = hexA(P.acc, 0.65);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD.l, Math.round(ly) + 0.5); ctx.lineTo(right, Math.round(ly) + 0.5); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = P.acc;
  roundRect(ctx, right + 3, ly - tagH / 2, tagW, tagH, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.font = '600 10.5px "JetBrains Mono", monospace';
  ctx.fillText(fmtPrice(last.c), right + 7, ly + 0.5);

  /* ---- indicator panes ---- */
  for (const pane of layout.panes) {
    const py = pane.y, ph = pane.h;
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, py, plotW, ph); ctx.clip();
    ctx.fillStyle = hexA('#ffffff', 0.022);
    ctx.fillRect(PAD.l, py, plotW, ph);
    drawPane(ctx, pane.key, {
      start: start, end: end, xAt: xAt, py: py, ph: ph, bw: bw,
      b: b, P: P, plotW: plotW, right: right
    });
    ctx.restore();
    ctx.fillStyle = P.txt3;
    ctx.font = '700 9.5px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(paneTitle(pane.key), PAD.l + 5, py + 9);
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, py + ph + 0.5); ctx.lineTo(right, py + ph + 0.5); ctx.stroke();
  }

  /* ---- crosshair ---- */
  if (state.hover != null && state.hover >= start && state.hover < end) {
    const i = state.hover;
    const x = Math.round(xAt(i)) + 0.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = hexA(P.txt2, 0.65);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke();
    const y = Math.round(yAt(b[i].c)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = P.txt2;
    roundRect(ctx, right + 3, y - 8, tagW, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '600 10.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(b[i].c), right + 7, y + 0.5);

    const dl = timeLabel(b[i].t, intraday);
    ctx.font = '10px "JetBrains Mono", monospace';
    const tw = ctx.measureText(dl).width + 12;
    const chipX = clamp(x - tw / 2, PAD.l, right - tw);
    ctx.fillStyle = hexA(P.txt2, 0.92);
    roundRect(ctx, chipX, h - PAD.b + 3, tw, 15, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(dl, chipX + tw / 2, h - PAD.b + 11);
  }

  const idx = state.hover == null ? end - 1 : clamp(state.hover, start, end - 1);
  updateTip(b, idx, intraday);
  updateLegend(b, idx, ov);
}

/* =========================================================== generic charts */
function drawLineChart(canvas, series, opt) {
  opt = opt || {};
  const c = ctx2d(canvas);
  if (!c) return;
  const ctx = c.ctx, w = c.w, h = c.h;
  const P = pal();
  const padL = opt.padL != null ? opt.padL : 46;
  const padR = opt.padR != null ? opt.padR : 12;
  const padT = opt.padT != null ? opt.padT : 16;
  const padB = opt.padB != null ? opt.padB : 22;

  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    for (const v of s.data) {
      if (v == null || !isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) return;
  if (opt.zeroBase) lo = Math.min(0, lo);
  const pad = (hi - lo) * 0.1 || 1;
  lo -= pad; hi += pad;
  const n = series[0].data.length;
  const X = i => padL + (i / Math.max(1, n - 1)) * (w - padL - padR);
  const Y = v => padT + (h - padT - padB) - ((v - lo) / (hi - lo || 1)) * (h - padT - padB);

  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  for (const t of niceTicks(lo, hi, 4).filter(t => t >= lo && t <= hi)) {
    const y = Math.round(Y(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = P.txt3;
    ctx.textAlign = 'right';
    ctx.fillText(opt.fmtY ? opt.fmtY(t) : nf(t, 0), padL - 6, y);
  }
  if (opt.labels && opt.labels.length) {
    const st = Math.max(1, Math.ceil(opt.labels.length / 6));
    ctx.fillStyle = P.txt3;
    ctx.textAlign = 'center';
    for (let i = 0; i < opt.labels.length; i += st) {
      if (opt.gridX) {
        ctx.strokeStyle = P.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(X(i)) + 0.5, padT);
        ctx.lineTo(Math.round(X(i)) + 0.5, h - padB);
        ctx.stroke();
      }
      let txt = opt.labels[i], k = i;
      while (!txt && k + 1 < i + st && k + 1 < opt.labels.length) { k++; txt = opt.labels[k]; }
      if (txt) ctx.fillText(txt, X(k), h - padB / 2);
    }
  }
  if (opt.baseZero && lo < 0 && hi > 0) {
    ctx.strokeStyle = hexA(P.txt3, 0.55);
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(Y(0)) + 0.5);
    ctx.lineTo(w - padR, Math.round(Y(0)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const s of series) {
    if (s.fill) {
      ctx.beginPath();
      let started = false, first = -1, lastI = -1;
      for (let i = 0; i < s.data.length; i++) {
        const v = s.data[i];
        if (v == null || !isFinite(v)) continue;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; first = i; } else ctx.lineTo(X(i), Y(v));
        lastI = i;
      }
      if (started && first >= 0) {
        const g = ctx.createLinearGradient(0, padT, 0, h - padB);
        g.addColorStop(0, hexA(s.color, 0.36));
        g.addColorStop(1, hexA(s.color, 0.01));
        ctx.lineTo(X(lastI), h - padB);
        ctx.lineTo(X(first), h - padB);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();
      }
    }
    strokeSeries(ctx, s.data, 0, s.data.length, X, Y, s.color, s.w || 1.9);
    if (s.dots) {
      for (let i = 0; i < s.data.length; i++) {
        const v = s.data[i];
        if (v == null) continue;
        ctx.beginPath();
        ctx.arc(X(i), Y(v), 3, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = P.panel;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    if (s.markers && s.markers.length) {
      for (const m of s.markers) {
        const y = Y(m.v), x = X(m.i);
        ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = hexA(P.acc, 0.2); ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = P.acc; ctx.fill();
        if (m.lbl) {
          ctx.font = '600 9.5px Inter, sans-serif';
          ctx.fillStyle = P.acc;
          ctx.textAlign = m.i > n / 2 ? 'right' : 'left';
          ctx.fillText(m.lbl, x + (m.i > n / 2 ? -8 : 8), y - 9);
        }
      }
    }
  }

  if (series.length > 1 && opt.legend !== false) {
    ctx.font = '600 10.5px Inter, sans-serif';
    ctx.textAlign = 'left';
    let x = padL;
    for (const s of series) {
      if (!s.name) continue;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, 5, 11, 3);
      ctx.fillStyle = P.txt2;
      ctx.fillText(s.name, x + 15, 7);
      x += 15 + ctx.measureText(s.name).width + 14;
    }
  }
}

function drawGroupedBars(canvas, labels, groups, opt) {
  opt = opt || {};
  const c = ctx2d(canvas);
  if (!c) return;
  const ctx = c.ctx, w = c.w, h = c.h;
  const P = pal();
  const padL = opt.padL != null ? opt.padL : 52;
  const padR = 10, padT = opt.barValues ? 27 : 18, padB = 24;

  let lo = 0, hi = 0;
  for (const g of groups) for (const v of g.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = (hi - lo) * 0.12 || 1;
  if (lo < 0) lo -= pad;
  hi += pad;
  const Y = v => padT + (h - padT - padB) - ((v - lo) / (hi - lo || 1)) * (h - padT - padB);
  const gw = (w - padL - padR) / labels.length;
  const bw = Math.min(34, (gw - 8) / groups.length);

  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  for (const t of niceTicks(lo, hi, 4).filter(t => t >= lo && t <= hi)) {
    const y = Math.round(Y(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = P.txt3;
    ctx.textAlign = 'right';
    ctx.fillText(opt.fmtY ? opt.fmtY(t) : fmtBig(t), padL - 6, y);
  }
  if (lo < 0 && hi > 0) {
    ctx.strokeStyle = hexA(P.txt3, 0.55);
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(Y(0)) + 0.5);
    ctx.lineTo(w - padR, Math.round(Y(0)) + 0.5);
    ctx.stroke();
  }

  labels.forEach((lb, i) => {
    const cx = padL + gw * (i + 0.5);
    groups.forEach((g, j) => {
      const v = g.data[i];
      if (v == null) return;
      const x = cx - (groups.length * bw) / 2 + j * bw;
      const y0 = Y(Math.max(0, v));
      const y1 = Y(Math.min(0, v));
      ctx.fillStyle = (g.colors && g.colors[i] != null) ? g.colors[i] : g.color;
      roundRect(ctx, x + 1, y0, bw - 2, Math.max(1, y1 - y0), 3);
      ctx.fill();
      if (opt.barValues && v >= 0 && groups.length === 1) {
        ctx.fillStyle = (opt.labelColors && opt.labelColors[i] != null) ? opt.labelColors[i] : P.txt2;
        ctx.font = '600 9.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(typeof opt.barValues === 'function' ? opt.barValues(v) : fmtBig(v), x + bw / 2, y0 - 6);
      }
    });
    ctx.fillStyle = (opt.labelColors && opt.labelColors[i] != null) ? opt.labelColors[i] : P.txt3;
    ctx.textAlign = 'center';
    ctx.font = (opt.labelWeights && opt.labelWeights[i]) ? '700 10px Inter, sans-serif' : '10px Inter, sans-serif';
    ctx.fillText(lb, cx, h - padB / 2 + 1);
  });

  if (opt.legend !== false) {
    ctx.font = '600 10.5px Inter, sans-serif';
    ctx.textAlign = 'left';
    let x = padL;
    for (const g of groups) {
      ctx.fillStyle = g.color;
      ctx.fillRect(x, 5, 11, 3);
      ctx.fillStyle = P.txt2;
      ctx.fillText(g.name, x + 15, 7);
      x += 15 + ctx.measureText(g.name).width + 14;
    }
  }
}

function drawDonut(canvas, segs, centerTop, centerSub) {
  const c = ctx2d(canvas);
  if (!c) return;
  const ctx = c.ctx, w = c.w, h = c.h;
  const P = pal();
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2 - 8, r = R * 0.62;
  const total = segs.reduce((s, x) => s + x.v, 0) || 1;
  let a = -Math.PI / 2;
  for (const s of segs) {
    const ang = (s.v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, a + 0.018, a + ang - 0.018);
    ctx.arc(cx, cy, r, a + ang - 0.018, a + 0.018, true);
    ctx.closePath();
    ctx.fillStyle = s.c;
    ctx.fill();
    a += ang;
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = P.txt;
  ctx.font = '700 21px "JetBrains Mono", monospace';
  ctx.fillText(centerTop, cx, cy - 5);
  ctx.fillStyle = P.txt3;
  ctx.font = '10px Inter, sans-serif';
  ctx.fillText(centerSub, cx, cy + 14);
}

function drawRadar(canvas, labels, values, refs) {
  const c = ctx2d(canvas);
  if (!c) return;
  const ctx = c.ctx, w = c.w, h = c.h;
  const P = pal();
  const cx = w / 2, cy = h / 2 + 6;
  const R = Math.min(w, h) / 2 - 36;
  const n = labels.length;
  const ang = i => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * (v / 100), cy + Math.sin(ang(i)) * R * (v / 100)];

  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  for (const lv of [25, 50, 75, 100]) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const p = pt(i, lv); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
    ctx.closePath();
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const p = pt(i, 100);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1]); ctx.stroke();
  }
  if (refs) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const p = pt(i, refs[i]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
    ctx.closePath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hexA(P.txt3, 0.85);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  for (let i = 0; i < n; i++) { const p = pt(i, values[i]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
  ctx.closePath();
  const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, R);
  g.addColorStop(0, hexA(P.acc, 0.55));
  g.addColorStop(1, hexA(P.acc2, 0.35));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = P.acc;
  ctx.lineWidth = 2;
  ctx.stroke();

  for (let i = 0; i < n; i++) {
    const p = pt(i, values[i]);
    ctx.beginPath();
    ctx.arc(p[0], p[1], 3.4, 0, Math.PI * 2);
    ctx.fillStyle = P.acc;
    ctx.fill();
    ctx.strokeStyle = P.panel;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.font = '600 10px Inter, sans-serif';
  ctx.fillStyle = P.txt2;
  for (let i = 0; i < n; i++) {
    const a = ang(i);
    const lx = cx + Math.cos(a) * (R + 17);
    const ly = cy + Math.sin(a) * (R + 14);
    ctx.textAlign = Math.abs(Math.cos(a)) < 0.3 ? 'center' : Math.cos(a) > 0 ? 'left' : 'right';
    ctx.fillText(labels[i], lx, ly);
  }
}

function drawGauge(canvas, value) {
  const c = ctx2d(canvas);
  if (!c) return;
  const ctx = c.ctx, w = c.w, h = c.h;
  const P = pal();
  const cx = w / 2, cy = h * 0.80;
  const R = Math.min(w / 2 - 14, h * 0.74);
  const a0 = Math.PI, a1 = Math.PI * 2;
  const segs = [
    { from: 0.00, to: 0.30, col: P.down },
    { from: 0.30, to: 0.50, col: P.warn },
    { from: 0.50, to: 0.70, col: '#ffd166' },
    { from: 0.70, to: 1.00, col: P.up }
  ];
  ctx.lineWidth = 13;
  ctx.lineCap = 'butt';
  for (const s of segs) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, lerp(a0, a1, s.from), lerp(a0, a1, s.to));
    ctx.strokeStyle = hexA(s.col, 0.28);
    ctx.stroke();
  }
  const av = lerp(a0, a1, clamp(value, 0, 100) / 100);
  const g = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
  g.addColorStop(0, P.down);
  g.addColorStop(0.5, P.warn);
  g.addColorStop(1, P.up);
  ctx.beginPath();
  ctx.arc(cx, cy, R, lerp(a0, a1, 0.005), av);
  ctx.strokeStyle = g;
  ctx.lineWidth = 13;
  ctx.lineCap = 'round';
  ctx.stroke();

  const nx = cx + Math.cos(av) * (R - 16), ny = cy + Math.sin(av) * (R - 16);
  const bx = cx + Math.cos(av) * (R + 6), by = cy + Math.sin(av) * (R + 6);
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(bx, by);
  ctx.strokeStyle = P.txt;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(bx, by, 4, 0, Math.PI * 2);
  ctx.fillStyle = P.txt;
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = P.txt3;
  ctx.font = '9.5px Inter, sans-serif';
  ctx.fillText('SELL', cx - R + 8, cy + 16);
  ctx.fillText('BUY', cx + R - 8, cy + 16);
  ctx.fillStyle = P.txt;
  ctx.font = '700 23px "JetBrains Mono", monospace';
  ctx.fillText(String(Math.round(value)), cx, cy - 8);
}
