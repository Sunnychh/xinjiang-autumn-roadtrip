'use strict';

(() => {
  const page = document.body.dataset.page;
  const $ = (id) => document.getElementById(id);
  let currentUser = null;
  let membersLoading = false;

  class ApiError extends Error {
    constructor(status, data) {
      super('API request failed');
      this.status = status;
      this.code = typeof data?.error === 'string' ? data.error : data?.error?.code || data?.code;
    }
  }

  async function api(path, method = 'GET', body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Requested-With': 'itinerary' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, data);
      if (data === null && response.status !== 204) throw new ApiError(502, null);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function status(element, message = '', state = '') {
    element.textContent = message;
    element.dataset.state = state;
  }

  function describeError(error, context) {
    if (error.name === 'AbortError') return '请求超时，请检查网络。若刚刚提交了修改，请先确认是否已生效。';
    if (!(error instanceof ApiError)) return '暂时无法连接，请检查网络后重试。';
    if (error.status === 429) return '操作太频繁，请稍等片刻后再试。';
    if (error.status === 401) return context === 'login' ? '账号或密码不正确，请重新输入。' : context === 'password' ? '当前密码不正确，或登录状态已失效。请核对后重试。' : '登录已失效，请重新登录。';
    if (error.status === 403) return '当前账号无权执行此操作，请刷新页面确认权限。';
    if (error.status === 409) return context === 'member' ? '该账号已存在，请换一个账号名。' : '账号状态已改变，请刷新后重试。';
    if (error.status === 400 || error.status === 422) return context === 'password' ? '当前密码不正确，或新密码不符合要求。请检查后重试。' : '提交的信息不符合要求，请检查账号和密码格式。';
    if (error.status === 404) return context === 'member' ? '未找到该账号，请刷新列表后重试。' : '登录服务暂时不可用，请稍后重试。';
    return '服务暂时不可用，请稍后重试。';
  }

  async function busy(control, task) {
    const form = control.tagName === 'FORM' ? control : null;
    const button = form ? form.querySelector('button[type="submit"]') : control;
    const fieldset = form?.querySelector('fieldset');
    if (button.disabled) return;
    const previous = button.textContent;
    button.disabled = true;
    if (fieldset) fieldset.disabled = true;
    button.textContent = button.dataset.busyLabel || '请稍候…';
    (form || button).setAttribute('aria-busy', 'true');
    try { await task(); }
    finally {
      button.textContent = previous;
      button.disabled = false;
      if (fieldset) fieldset.disabled = false;
      (form || button).removeAttribute('aria-busy');
    }
  }

  function safeNext() {
    const raw = new URLSearchParams(location.search).get('next') || '/';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) return '/';
    try {
      const next = new URL(raw, location.origin);
      if (next.origin !== location.origin || /^\/(?:login(?:\/|$|\.)|account-ui\/login(?:\.|\/|$)|api(?:\/|$))/i.test(next.pathname)) return '/';
      return next.pathname + next.search + (next.hash || location.hash);
    } catch { return '/'; }
  }

  function toLogin() {
    location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
  }

  function sessionError(error, target, context) {
    if (error instanceof ApiError && error.status === 401 && context !== 'password') {
      toLogin();
      return;
    }
    status(target, describeError(error, context), 'error');
  }

  document.querySelectorAll('[data-password]').forEach((button) => {
    const input = $(button.dataset.password);
    const originalLabel = button.getAttribute('aria-label');
    button.addEventListener('click', () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.textContent = visible ? '隐藏' : '显示';
      button.setAttribute('aria-pressed', String(visible));
      button.setAttribute('aria-label', visible ? originalLabel.replace('显示', '隐藏') : originalLabel);
    });
  });

  async function initLogin() {
    const form = $('login-form');
    const feedback = $('login-status');
    if (new URLSearchParams(location.search).get('passwordChanged') === '1') status(feedback, '密码已更新，请使用新密码登录。', 'success');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const credentials = { username: form.elements.username.value.trim(), password: form.elements.password.value };
      busy(form, async () => {
        status(feedback);
        try {
          const result = await api('/api/auth/login', 'POST', credentials);
          if (!result?.user?.id) throw new ApiError(502, null);
          form.elements.password.value = '';
          location.replace(safeNext());
        } catch (error) { status(feedback, describeError(error, 'login'), 'error'); }
      });
    });
    const checkSession = async () => {
      try {
        const result = await api('/api/auth/me');
        if (result?.user?.id) location.replace(safeNext());
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) status(feedback, describeError(error, 'login'), 'error');
      }
    };
    checkSession();
    window.addEventListener('pageshow', (event) => { if (event.persisted) checkSession(); });
  }

  function renderMember(user) {
    const item = document.createElement('li');
    item.className = 'member-row';
    item.dataset.disabled = String(Boolean(user.disabled));
    const information = document.createElement('div');
    information.className = 'member-info';
    const name = document.createElement('strong');
    name.textContent = user.username;
    const detail = document.createElement('small');
    const role = user.role === 'admin' ? '管理员' : '成员';
    detail.textContent = role + (user.id === currentUser.id ? ' · 当前账号' : '') + (user.disabled ? ' · 已停用' : ' · 使用中');
    information.append(name, detail);
    item.append(information);
    if (user.role === 'member' && user.id !== currentUser.id) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.textContent = user.disabled ? '启用' : '停用';
      button.setAttribute('aria-label', (user.disabled ? '启用账号 ' : '停用账号 ') + user.username);
      button.addEventListener('click', () => busy(button, async () => {
        status($('members-status'));
        try {
          await api('/api/admin/users/' + encodeURIComponent(user.id), 'PATCH', { disabled: !user.disabled });
          status($('members-status'), '已' + (user.disabled ? '启用' : '停用') + '账号 ' + user.username + '。', 'success');
          await loadMembers(true);
        } catch (error) { sessionError(error, $('members-status'), 'member'); }
      }));
      item.append(button);
    } else {
      const badge = document.createElement('span');
      badge.className = 'member-state';
      badge.textContent = '管理员';
      item.append(badge);
    }
    return item;
  }

  async function loadMembers(keepStatus = false) {
    if (membersLoading) return;
    membersLoading = true;
    const refresh = $('refresh-members');
    refresh.disabled = true;
    $('members-list').setAttribute('aria-busy', 'true');
    if (!keepStatus) status($('members-status'), '正在加载账号…');
    try {
      const result = await api('/api/admin/users');
      if (!Array.isArray(result?.users)) throw new ApiError(502, null);
      $('members-list').replaceChildren(...result.users.map(renderMember));
      if (!keepStatus) status($('members-status'), result.users.length ? '' : '暂无账号。');
    } catch (error) { sessionError(error, $('members-status'), 'member'); }
    finally {
      membersLoading = false;
      refresh.disabled = false;
      $('members-list').removeAttribute('aria-busy');
    }
  }

  async function loadAccount() {
    $('retry-account').hidden = true;
    $('account-content').hidden = true;
    status($('page-status'), '正在确认登录状态…');
    try {
      const result = await api('/api/auth/me');
      if (!result?.user?.id) throw new ApiError(502, null);
      currentUser = result.user;
      $('current-username').textContent = currentUser.username;
      $('current-role').textContent = currentUser.role === 'admin' ? '管理员' : '成员';
      $('user-avatar').textContent = currentUser.username.slice(0, 1).toUpperCase();
      $('admin-section').hidden = currentUser.role !== 'admin';
      $('account-content').hidden = false;
      status($('page-status'));
      if (currentUser.role === 'admin') await loadMembers();
    } catch (error) {
      sessionError(error, $('page-status'));
      if (!(error instanceof ApiError && error.status === 401)) $('retry-account').hidden = false;
    }
  }

  function initAccount() {
    $('retry-account').addEventListener('click', loadAccount);
    $('refresh-members').addEventListener('click', () => loadMembers());
    $('logout-button').addEventListener('click', () => busy($('logout-button'), async () => {
      status($('page-status'));
      try {
        await api('/api/auth/logout', 'POST', {});
        location.replace('/login');
      } catch (error) { sessionError(error, $('page-status')); }
    }));
    const passwordForm = $('password-form');
    $('confirm-password').addEventListener('input', () => $('confirm-password').setCustomValidity(''));
    $('new-password').addEventListener('input', () => $('confirm-password').setCustomValidity(''));
    passwordForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const fields = passwordForm.elements;
      $('confirm-password').setCustomValidity(fields.newPassword.value !== fields.confirmPassword.value ? '两次输入的新密码不一致。' : '');
      if (!passwordForm.reportValidity()) return;
      const credentials = { currentPassword: fields.currentPassword.value, newPassword: fields.newPassword.value };
      busy(passwordForm, async () => {
        status($('password-status'));
        try {
          await api('/api/auth/password', 'POST', credentials);
          passwordForm.reset();
          location.replace('/login?passwordChanged=1&next=%2Faccount');
        } catch (error) { sessionError(error, $('password-status'), 'password'); }
      });
    });
    const memberForm = $('member-form');
    memberForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!memberForm.reportValidity()) return;
      const credentials = { username: memberForm.elements.username.value.trim(), password: memberForm.elements.password.value };
      busy(memberForm, async () => {
        status($('member-status'));
        try {
          await api('/api/admin/users', 'POST', credentials);
          memberForm.reset();
          status($('member-status'), '已创建账号 ' + credentials.username + '。', 'success');
          await loadMembers();
        } catch (error) { sessionError(error, $('member-status'), 'member'); }
      });
    });
    loadAccount();
    window.addEventListener('pageshow', (event) => { if (event.persisted) loadAccount(); });
  }

  if (page === 'login') initLogin();
  if (page === 'account') initAccount();
})();
