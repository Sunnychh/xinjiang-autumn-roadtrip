import catalog from '../data/preparation-checklist.json' with { type: 'json' };

const itemIds = new Set(catalog.stages.flatMap(stage => stage.items.map(item => item.id)));
const untouched = () => ({ completed: false, version: 0, updatedAt: null });
const stateView = row => row
  ? { completed: Boolean(row.completed), version: row.version, updatedAt: row.updated_at }
  : untouched();

// Recheck the actor and session inside each write, not only during authentication.
// Logout, expiry, password changes and account disabling therefore revoke saves.
const validActor = `EXISTS (
  SELECT 1 FROM users actor JOIN sessions session ON session.user_id = actor.id
  WHERE actor.id = ? AND actor.disabled = 0 AND actor.auth_version = ?
    AND session.token_hash = ? AND session.auth_version = actor.auth_version
    AND session.expires_at > ?
)`;

export async function checklistApi(request, pathname, context) {
  const { db, user, sessionHash, readJson, json, method, HttpError, nowSeconds, requireCurrentUser } = context;
  if (pathname === '/api/checklist') {
    method(request, 'GET');
    const rows = await db.prepare(`SELECT item_id, completed, version, updated_at
      FROM checklist_items WHERE user_id = ?`).bind(user.id).all();
    const states = Object.fromEntries([...itemIds].map(id => [id, untouched()]));
    for (const row of rows.results) {
      if (itemIds.has(row.item_id)) states[row.item_id] = stateView(row);
    }
    return json({ catalogVersion: catalog.version, states,
      user: { id: user.id, username: user.username }, serverTime: nowSeconds() });
  }

  method(request, 'PATCH');
  const id = pathname.slice('/api/checklist/'.length);
  if (!itemIds.has(id)) throw new HttpError(404, '准备事项不存在，请刷新页面后重试。');
  const body = await readJson(request);
  if (typeof body.completed !== 'boolean' || !Number.isSafeInteger(body.version)
    || body.version < 0 || body.version >= Number.MAX_SAFE_INTEGER
    || Object.keys(body).some(key => !['completed', 'version'].includes(key))) {
    throw new HttpError(400, '请提交事项的勾选状态与有效版本。');
  }

  const now = nowSeconds();
  const actor = [user.id, user.auth_version, sessionHash, now];
  let saved;
  if (body.version === 0) {
    saved = await db.prepare(`INSERT INTO checklist_items (user_id, item_id, completed, version, updated_at)
      SELECT ?, ?, ?, 1, ? WHERE ${validActor}
      ON CONFLICT (user_id, item_id) DO NOTHING
      RETURNING completed, version, updated_at`)
      .bind(user.id, id, body.completed ? 1 : 0, now, ...actor).first();
  } else {
    saved = await db.prepare(`UPDATE checklist_items
      SET completed = ?, version = version + 1, updated_at = ?
      WHERE user_id = ? AND item_id = ? AND version = ? AND ${validActor}
      RETURNING completed, version, updated_at`)
      .bind(body.completed ? 1 : 0, now, user.id, id, body.version, ...actor).first();
  }
  if (saved) return json({ item: { id, ...stateView(saved) } });

  // A revoked actor is a login failure, not a checklist conflict. An unchanged
  // desired value is still a conflict when its supplied version is stale.
  await requireCurrentUser();
  const current = await db.prepare(`SELECT completed, version, updated_at
    FROM checklist_items WHERE user_id = ? AND item_id = ?`).bind(user.id, id).first();
  return json({ error: '此事项已在其他页面更新，已同步最新状态，请重新操作。',
    item: { id, ...stateView(current) } }, 409);
}
