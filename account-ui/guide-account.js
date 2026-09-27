(() => {
  const link = document.createElement('a');
  link.className = 'trip-account-link';
  link.href = '/account';
  link.textContent = '我的账户';
  const upload = document.createElement('a');
  upload.className = 'trip-account-link';
  upload.href = '/upload';
  upload.textContent = '上传照片';
  const actions = document.createElement('div');
  actions.className = 'trip-account-actions';
  actions.append(upload, link);
  const header = document.querySelector('.app-header');
  if (header) header.append(actions);
  else { actions.classList.add('trip-account-floating'); document.body.append(actions); }
  async function check() {
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) {
        link.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
        link.textContent = '登录';
        // A private page is never delivered anonymously; ask the server again on expiry.
        if (document.documentElement.dataset.authenticated === 'true') location.reload();
        return;
      }
      if (!response.ok) return;
      const data = await response.json();
      link.textContent = data.user.username + ' · 账户';
      document.documentElement.dataset.authenticated = 'true';
    } catch { /* The trip already loaded; account navigation can report network failures. */ }
  }
  check();
  window.addEventListener('pageshow', event => { if (event.persisted) check(); });
})();
