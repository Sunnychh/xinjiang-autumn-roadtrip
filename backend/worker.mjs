import { randomUUID } from 'node:crypto';
import { DUMMY_PASSWORD_HASH, hashPassword, randomToken, sha256, validPassword, verifyPassword } from './crypto.mjs';

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const WINDOW_SECONDS = 15 * 60;
const BODY_LIMIT = 8192;
const USERNAME = /^[A-Za-z0-9_-]{3,32}$/;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function secure(response) {
  const result = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) result.headers.set(key, value);
  return result;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function cookieSettings(request, env) {
  const url = new URL(request.url);
  const development = env.ENVIRONMENT === 'development' && url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return { name: development ? 'itinerary_session_dev' : '__Host-itinerary_session', secure: !development };
}

function cookie(request, env, token = '', maxAge = SESSION_SECONDS) {
  const settings = cookieSettings(request, env);
  return `${settings.name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${settings.secure ? '; Secure' : ''}`;
}

function sessionToken(request, env) {
  const prefix = `${cookieSettings(request, env).name}=`;
  const values = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(prefix));
  if (values.length !== 1) return null;
  const token = values[0].slice(prefix.length);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function database(env) {
  if (!env.DB) throw new HttpError(503, '账号服务尚未配置，请稍后重试。');
  return env.DB;
}

function username(value) {
  if (typeof value !== 'string' || !USERNAME.test(value)) return null;
  return { display: value, normalized: value.toLowerCase() };
}

const userView = user => ({ id: user.id, username: user.username, role: user.role });
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function authenticated(request, env) {
  const token = sessionToken(request, env);
  if (!token) return null;
  return database(env).prepare(`SELECT u.id, u.username, u.username_normalized, u.role,
    u.password_hash, u.auth_version FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0 AND s.auth_version = u.auth_version`)
    .bind(sha256(token), nowSeconds()).first();
}

async function requireUser(request, env, admin = false) {
  const user = await authenticated(request, env);
  if (!user) throw new HttpError(401, '请先登录。');
  if (admin && user.role !== 'admin') throw new HttpError(403, '此操作需要管理员权限。');
  return user;
}

function mutationGuard(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin
    || request.headers.get('X-Requested-With') !== 'itinerary') {
    throw new HttpError(403, '请求来源不合法，请刷新页面后重试。');
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, '请使用 JSON 格式提交。');
  }
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > BODY_LIMIT) throw new HttpError(413, '提交内容过大。');
  if (!request.body) throw new HttpError(400, '提交内容不是有效的 JSON。');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        throw new HttpError(413, '提交内容过大。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, '提交内容不是有效的 JSON。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '提交内容必须是 JSON 对象。');
  return body;
}

async function consumeLimit(db, key, maximum, now) {
  const start = Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
  const row = await db.prepare(`INSERT INTO rate_limits (bucket_key, window_start, attempts, expires_at)
    VALUES (?, ?, 1, ?) ON CONFLICT (bucket_key, window_start)
    DO UPDATE SET attempts = attempts + 1 RETURNING attempts`)
    .bind(key, start, start + WINDOW_SECONDS).first();
  if (!row || row.attempts > maximum) {
    throw new HttpError(429, '尝试次数过多，请稍后再试。', { 'Retry-After': String(start + WINDOW_SECONDS - now) });
  }
}

async function rateLimit(request, env, action, account) {
  const db = database(env), now = nowSeconds();
  const ip = sha256(request.headers.get('CF-Connecting-IP') || 'unavailable');
  // Check the IP first, so exhausted clients cannot create unlimited account buckets.
  await consumeLimit(db, `${action}:ip:${ip}`, 40, now);
  await consumeLimit(db, `${action}:account:${sha256(account)}`, 10, now);
}

function method(request, expected) {
  if (request.method !== expected) throw new HttpError(405, '不支持此请求方式。', { Allow: expected });
}

async function login(request, env) {
  const body = await readJson(request);
  const name = username(body.username);
  await rateLimit(request, env, 'login', name?.normalized || 'invalid-username');
  const failure = () => new HttpError(401, '账号或密码错误。');
  if (!name || !validPassword(body.password)) throw failure();
  const db = database(env);
  const user = await db.prepare('SELECT * FROM users WHERE username_normalized = ?').bind(name.normalized).first();
  const valid = await verifyPassword(body.password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!valid || !user || user.disabled) throw failure();
  const token = randomToken(), now = nowSeconds();
  // A concurrent password or status change makes this insertion fail instead of reviving access.
  const inserted = await db.prepare(`INSERT INTO sessions (token_hash, user_id, auth_version, created_at, expires_at)
    SELECT ?, id, auth_version, ?, ? FROM users
    WHERE id = ? AND password_hash = ? AND auth_version = ? AND disabled = 0`)
    .bind(sha256(token), now, now + SESSION_SECONDS, user.id, user.password_hash, user.auth_version).run();
  if (inserted.meta.changes !== 1) throw failure();
  return json({ user: userView(user) }, 200, { 'Set-Cookie': cookie(request, env, token) });
}

async function changePassword(request, env) {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  await rateLimit(request, env, 'password', user.username_normalized);
  if (!validPassword(body.newPassword)) throw new HttpError(400, '新密码长度应为 10–128 个字符。');
  if (!await verifyPassword(body.currentPassword, user.password_hash)) throw new HttpError(400, '当前密码错误。');
  const replacement = await hashPassword(body.newPassword);
  const db = database(env);
  const result = await db.batch([
    db.prepare(`UPDATE users SET password_hash = ?, auth_version = auth_version + 1, updated_at = ?
      WHERE id = ? AND password_hash = ? AND auth_version = ? AND disabled = 0`)
      .bind(replacement, nowSeconds(), user.id, user.password_hash, user.auth_version),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?
      AND auth_version <> (SELECT auth_version FROM users WHERE id = ?)`)
      .bind(user.id, user.id),
  ]);
  if (result[0].meta.changes !== 1) throw new HttpError(409, '账号状态已更新，请重新登录后再试。');
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, env, '', 0) });
}

async function createMember(request, env) {
  const admin = await requireUser(request, env, true);
  const body = await readJson(request);
  await rateLimit(request, env, 'create-user', admin.username_normalized);
  const name = username(body.username);
  if (!name) throw new HttpError(400, '账号应为 3–32 位英文字母、数字、下划线或短横线。');
  if (!validPassword(body.password)) throw new HttpError(400, '密码长度应为 10–128 个字符。');
  const id = randomUUID(), now = nowSeconds(), encoded = await hashPassword(body.password);
  const db = database(env);
  const inserted = await db.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, role, disabled, auth_version, created_at, updated_at)
    SELECT ?, ?, ?, ?, 'member', 0, 0, ?, ? FROM users
    WHERE id = ? AND role = 'admin' AND disabled = 0 AND auth_version = ?
    ON CONFLICT(username_normalized) DO NOTHING`)
    .bind(id, name.display, name.normalized, encoded, now, now, admin.id, admin.auth_version).run();
  if (inserted.meta.changes !== 1) throw new HttpError(409, '账号已存在或登录状态已改变，请刷新后重试。');
  return json({ user: { id, username: name.display, role: 'member', disabled: false, createdAt: now } }, 201);
}

async function changeMember(request, env, id) {
  const admin = await requireUser(request, env, true);
  const body = await readJson(request);
  await rateLimit(request, env, 'manage-user', admin.username_normalized);
  if (typeof body.disabled !== 'boolean' || Object.keys(body).some(key => key !== 'disabled')) {
    throw new HttpError(400, '只允许修改账号启用状态。');
  }
  if (id === admin.id) throw new HttpError(403, '不能修改自己的账号状态。');
  const db = database(env);
  const result = await db.batch([
    db.prepare(`UPDATE users SET disabled = ?, auth_version = auth_version + 1, updated_at = ?
      WHERE id = ? AND role = 'member' AND id <> ? AND EXISTS
      (SELECT 1 FROM users actor WHERE actor.id = ? AND actor.role = 'admin'
       AND actor.disabled = 0 AND actor.auth_version = ?)`)
      .bind(body.disabled ? 1 : 0, nowSeconds(), id, admin.id, admin.id, admin.auth_version),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?
      AND auth_version <> (SELECT auth_version FROM users WHERE id = ?)`)
      .bind(id, id),
  ]);
  if (result[0].meta.changes !== 1) throw new HttpError(404, '可管理的成员账号不存在，或登录状态已改变。');
  return json({ ok: true });
}

async function api(request, env, pathname) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) mutationGuard(request);
  if (pathname === '/api/auth/login') { method(request, 'POST'); return login(request, env); }
  if (pathname === '/api/auth/me') {
    method(request, 'GET'); return json({ user: userView(await requireUser(request, env)) });
  }
  if (pathname === '/api/auth/logout') {
    method(request, 'POST'); await readJson(request);
    const token = sessionToken(request, env);
    if (token) await database(env).prepare('DELETE FROM sessions WHERE token_hash = ?').bind(sha256(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, env, '', 0) });
  }
  if (pathname === '/api/auth/password') { method(request, 'POST'); return changePassword(request, env); }
  if (pathname === '/api/admin/users') {
    if (request.method === 'POST') return createMember(request, env);
    method(request, 'GET'); await requireUser(request, env, true);
    const result = await database(env).prepare('SELECT id, username, role, disabled, created_at FROM users ORDER BY created_at, id').all();
    return json({ users: result.results.map(row => ({ ...userView(row), disabled: Boolean(row.disabled), createdAt: row.created_at })) });
  }
  const match = /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  if (match) { method(request, 'PATCH'); return changeMember(request, env, match[1]); }
  throw new HttpError(404, '接口不存在。');
}

async function dispatch(request, env) {
  const url = new URL(request.url), pathname = url.pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) return api(request, env, pathname);
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, '不支持此请求方式。', { Allow: 'GET, HEAD' });
  const isLogin = pathname === '/login' || pathname === '/login/';
  const publicAsset = ['/account-ui/auth.css', '/account-ui/auth.js'].includes(pathname);
  // Raw or extensionless account-ui paths must not bypass the protected /account route.
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch { throw new HttpError(400, '页面地址格式不正确。'); }
  const accountPage = ['/account', '/account/'].includes(decodedPath) || decodedPath.startsWith('/account-ui/');
  if (!isLogin && !publicAsset && (accountPage || env.GUIDE_ACCESS !== 'public')) {
    if (!await authenticated(request, env)) {
      return new Response(null, { status: 302, headers: { Location: `/login?next=${encodeURIComponent(pathname + url.search)}` } });
    }
  }
  if (!env.ASSETS) throw new HttpError(503, '页面服务尚未配置，请稍后重试。');
  if (pathname === '/') url.pathname = '/index.html';
  if (isLogin) url.pathname = '/account-ui/login.html';
  if (pathname === '/account' || pathname === '/account/') url.pathname = '/account-ui/account.html';
  return env.ASSETS.fetch(new Request(url, request));
}

export async function cleanup(env) {
  const db = database(env), now = nowSeconds();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now),
  ]);
}

export default {
  async fetch(request, env) {
    try { return secure(await dispatch(request, env)); }
    catch (error) {
      if (error instanceof HttpError) return secure(json({ error: error.message }, error.status, error.headers));
      return secure(json({ error: '服务暂时不可用，请稍后重试。' }, 503));
    }
  },
  async scheduled(_event, env) { await cleanup(env); },
};
