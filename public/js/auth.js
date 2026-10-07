/* Sign in, first-time account setup, change password, sign out. */
App.auth = (() => {
  const { $, api, toast } = App;
  let mode = 'login';

  async function check() {
    const s = await api('/api/auth/status');
    if (s.username) {
      App.state.user = s.username;
      return true;
    }
    show(s.setupRequired ? 'setup' : 'login');
    return false;
  }

  function show(m) {
    if (m) mode = m;
    $('#appShell').hidden = true;
    $('#authScreen').hidden = false;
    const setup = mode === 'setup';
    $('#authTitle').textContent = setup ? 'Create your admin account' : 'Sign in';
    $('#authIntro').textContent = setup
      ? 'This account protects your wallet data and API key. You\'ll use it to sign in from now on.'
      : 'Sign in to manage wallet statements.';
    $('#authPass2Wrap').hidden = !setup;
    $('#authPass2').required = setup;
    $('#authPass').autocomplete = setup ? 'new-password' : 'current-password';
    $('#authSubmit').textContent = setup ? 'Create account' : 'Sign in';
    $('#authMsg').textContent = '';
    $('#authUser').focus();
  }

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#authUser').value.trim();
    const password = $('#authPass').value;
    if (mode === 'setup' && password !== $('#authPass2').value) {
      $('#authMsg').textContent = 'The passwords don\'t match';
      return;
    }
    try {
      const r = await api(`/api/auth/${mode === 'setup' ? 'setup' : 'login'}`, { method: 'POST', body: { username, password } });
      App.state.user = r.username;
      $('#authPass').value = '';
      $('#authPass2').value = '';
      $('#authScreen').hidden = true;
      App.start();
    } catch (err) {
      $('#authMsg').textContent = err.message;
    }
  });

  $('#btnLogout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    App.state.user = null;
    location.hash = '#/';
    show('login');
  });

  $('#btnChangePw').addEventListener('click', () => {
    ['#pwCurrent', '#pwNext', '#pwNext2'].forEach((id) => ($(id).value = ''));
    $('#pwMsg').textContent = '';
    $('#pwDialog').showModal();
  });

  $('#pwSave').addEventListener('click', async (e) => {
    e.preventDefault();
    if ($('#pwNext').value !== $('#pwNext2').value) { $('#pwMsg').textContent = 'The new passwords don\'t match'; return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: $('#pwCurrent').value, next: $('#pwNext').value } });
      $('#pwDialog').close();
      toast('Password changed. Other devices have been signed out.');
    } catch (err) {
      $('#pwMsg').textContent = err.message;
    }
  });

  return { check, show };
})();
