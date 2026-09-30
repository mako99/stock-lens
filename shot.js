(function () {
  window.__SHOT_HASH__ = location.hash || '';
  var s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(s);
})();

window.addEventListener('load', function () {
  setTimeout(function () {
    var raw = (window.__SHOT_HASH__ || '').replace(/^#\/?/, '');
    var p = {};
    raw.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      if (i < 0) p[kv] = '';
      else p[kv.slice(0, i)] = kv.slice(i + 1);
    });
    if (p.theme && p.theme !== state.theme) {
      state.theme = p.theme;
      document.documentElement.setAttribute('data-theme', state.theme);
      redrawAll();
    }
    if (p.sym) selectSymbol(p.sym);
    if (p.tf) setTF(p.tf);
    var page = null;
    raw.split('&').forEach(function (kv) { if (kv && kv.indexOf('=') < 0 && !page) page = kv; });
    var target = p.tab || page || 'overview';
    setTab(target);
    document.fonts && document.fonts.ready.then(function () { redrawAll(); setTab(target); });
    document.title = 'READY';
  }, 300);
});
