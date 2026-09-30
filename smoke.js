(function () {
  const out = [];
  const errs = [];
  const origErr = console.error;
  console.error = function () {
    errs.push(Array.prototype.map.call(arguments, String).join(' '));
    origErr.apply(console, arguments);
  };
  function step(name, fn) {
    try { fn(); out.push(name + ':OK'); }
    catch (e) { out.push(name + ':FAIL ' + (e && e.message) + ' @ ' + (e && e.stack ? e.stack.split('\n')[1] : '')); }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  function finish() {
    const bad = out.filter(x => x.indexOf('FAIL') >= 0).length;
    const pre = document.createElement('pre');
    pre.id = 'smokeOut';
    pre.textContent = out.join('\n');
    document.body.appendChild(pre);
    const sum = document.createElement('div');
    sum.id = 'smokeSummary';
    sum.textContent = 'SMOKE ' + (bad ? 'FAILED' : 'PASSED') + ' ' + out.filter(x => x.indexOf(':OK') >= 0).length + '/' + out.length;
    document.body.appendChild(sum);
    document.title = 'SMOKE ' + (bad ? 'FAILED' : 'PASSED');
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      const PAGES7 = ['market', 'stock', 'technicals', 'financials', 'valuation', 'holdings', 'news'];
      PAGES7.forEach(function (p) {
        step('route:' + p, function () {
          setView(p);
          assert(state.page === p, 'state.page=' + state.page);
          const view = p === 'market' ? 'market' : 'stock';
          assert(document.body.dataset.view === view, 'body view=' + document.body.dataset.view);
          const on = document.querySelectorAll('.page.on');
          assert(on.length === 1 && on[0].id === 'pg-' + p, 'page.on=' + (on[0] && on[0].id) + ' n=' + on.length);
          const cur = document.querySelectorAll('#pagenav a[aria-current="page"]');
          assert(cur.length === 1 && cur[0].dataset.page === p, 'nav current n=' + cur.length);
          assert(pageFromHash() === p, 'pageFromHash=' + pageFromHash());
          assert(PAGE_TAB[p], 'PAGE_TAB missing');
        });
      });
      ['overview', 'technicals', 'financials', 'valuation', 'flow', 'news'].forEach(function (t) {
        step('tab:' + t, function () { setTab(t); renderTab(t); });
      });
      ['AAPL', 'TSLA', 'JPM', 'BA', 'PFE', 'SPY', 'XOM'].forEach(function (s) {
        step('symbol:' + s, function () { selectSymbol(s); });
      });
      ['1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'MAX'].forEach(function (t) {
        step('tf:' + t, function () { setTF(t); });
      });
      ['candle', 'area', 'line', 'hollow'].forEach(function (t) {
        step('type:' + t, function () { state.type = t; drawMain(); });
      });
      step('log-scale', function () { state.log = true; drawMain(); state.log = false; drawMain(); });
      step('overlays', function () {
        Object.keys(state.overlays).forEach(function (k) { state.overlays[k] = true; });
        drawMain();
      });
      step('all-panes', function () {
        Object.keys(state.panes).forEach(function (k) { state.panes[k] = true; });
        drawMain();
      });
      step('theme', function () {
        document.documentElement.setAttribute('data-theme', 'light');
        redrawAll();
        document.documentElement.setAttribute('data-theme', 'dark');
        redrawAll();
      });
      step('zoom-pan', function () {
        state.view.count = 40; state.view.start = 10; drawMain();
        state.view.start = 0; drawMain();
      });
      step('hover', function () { state.hover = 5; drawMain(); state.hover = null; drawMain(); });
      step('dcf-input', function () {
        const el = document.getElementById('dcfG');
        if (!el) throw new Error('dcf input missing');
        el.value = '20';
        el.dispatchEvent(new Event('input'));
      });
      step('peers', function () {
        ['pe', 'ps', 'roe', 'growth', 'margin'].forEach(function (p) {
          state.peer = p; renderPeers();
        });
      });
      step('search', function () {
        const i = document.getElementById('searchInput');
        i.value = 'nv';
        i.dispatchEvent(new Event('input'));
        if (document.getElementById('searchResults').hidden) throw new Error('no results');
      });
      step('market-content', function () {
        renderMarket();
        assert(document.querySelectorAll('#idxStrip .idx-card').length >= 3, 'index cards');
        assert(document.querySelectorAll('#sectorTable tbody tr').length >= 8, 'sector rows');
        assert(document.querySelectorAll('#moversGainers .mover, #moversGainers .m-row').length >= 3, 'gainers');
        const b = document.getElementById('breadth');
        assert(b && b.innerText.trim().length > 20, 'breadth empty');
        assert(document.querySelectorAll('#mktWatch tbody tr').length >= 5, 'watchlist rows');
      });
      step('watchlist-live', function () {
        renderWatchlist();
        assert(document.querySelectorAll('#watchlist .wl-item').length >= 5, 'watch rows');
      });
      step('flow-content', function () {
        setView('holdings');
        renderFlow();
        assert(document.querySelectorAll('#holdersTable tbody tr').length >= 6, 'holders rows');
        assert(document.querySelectorAll('#ownLegend .lg-row').length >= 2, 'legend rows');
        assert(document.getElementById('ownChart'), 'own canvas');
        assert(document.getElementById('flowChart'), 'flow canvas');
        assert(document.getElementById('shortChart'), 'short canvas');
        assert(document.getElementById('holdersSub').textContent.length > 3, 'holdersSub empty');
      });
      step('route-market-final', function () {
        setView('market');
        assert(document.getElementById('pg-market').classList.contains('on'), 'market not on');
      });

      setTimeout(function () {
        step('render-errors', function () {
          const r = errs.filter(e => e.indexOf('render ') === 0);
          assert(r.length === 0, r.slice(0, 3).join(' | '));
        });
        finish();
      }, 700);
    }, 400);
  });
})();
