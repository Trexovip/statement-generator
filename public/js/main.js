/* Page routing and start-up. */
(() => {
  const { $, $$, toast } = App;
  let started = false;
  let currentHash = location.hash;

  function route() {
    // leaving Settings with unsaved changes?
    if (!$('#viewSettings').hidden && App.settingsPage.hasUnsaved() && !location.hash.startsWith('#/settings')) {
      if (!window.confirm('You have unsaved settings. Leave without saving?')) {
        history.replaceState(null, '', currentHash || '#/settings');
        return;
      }
    }
    currentHash = location.hash;
    const hash = location.hash || '#/';
    const walletMatch = hash.match(/^#\/wallet\/(.+)$/);
    const view = walletMatch ? 'statement' : hash.startsWith('#/settings') ? 'settings' : 'wallets';

    $('#viewWallets').hidden = view !== 'wallets';
    $('#viewStatement').hidden = view !== 'statement';
    $('#viewSettings').hidden = view !== 'settings';
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (view === 'statement' ? 'wallets' : view)));

    if (view === 'wallets') App.wallets.show();
    if (view === 'statement') App.statement.show(decodeURIComponent(walletMatch[1]));
    if (view === 'settings') App.settingsPage.show();
    window.scrollTo(0, 0);
  }

  App.start = async function start() {
    $('#authScreen').hidden = true;
    $('#appShell').hidden = false;
    $('#userName').textContent = App.state.user || '';
    try { await App.loadSettings(); } catch (e) { toast(e.message); }
    if (!started) {
      started = true;
      window.addEventListener('hashchange', route);
      App.sync.onChange(() => { if (!$('#viewWallets').hidden) App.wallets.refresh(); });
    }
    route();
    App.sync.poll();
  };

  App.auth.check().then((ok) => ok && App.start()).catch((e) => {
    document.body.innerHTML = `<p style="padding:24px;font-family:sans-serif">Can't reach the server: ${App.esc(e.message)}</p>`;
  });
})();
