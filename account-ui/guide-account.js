(() => {
  const link = document.createElement('a');
  link.className = 'trip-account-link';
  link.href = '/account';
  link.textContent = '我的账户';
  const header = document.querySelector('.app-header');
  if (header) header.append(link);
  else { link.classList.add('trip-account-floating'); document.body.append(link); }
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
