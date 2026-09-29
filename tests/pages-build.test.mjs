import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPagesSite } from '../scripts/build-pages-site.mjs';

const token = 'github_pat_' + 'SyntheticTestCredential'.repeat(3);
test('Pages build injects shared credential only into output and excludes backend resources', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trip-pages-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let checked = false, disconnected = false;
  await buildPagesSite({ token, directory, verify: async value => {
    assert.equal(value, token); checked = true;
    return { disconnect() { disconnected = true; } };
  } });
  assert.ok(checked && disconnected);
  const generated = await readFile(path.join(directory, 'upload/credential-config.mjs'), 'utf8');
  assert.ok(generated.includes(token));
  assert.equal((await readFile(new URL('../upload/credential-config.mjs', import.meta.url), 'utf8')).includes(token), false);
  const files = await readdir(directory, { recursive: true });
  assert.ok(files.includes('upload/index.html'));
  assert.ok(files.includes('index.html'));
  assert.equal(files.some(name => /(?:backend|\.git|\.env|\.sqlite|package|tests|migrations)/.test(name)), false);
  const html = await readFile(path.join(directory, 'upload/index.html'), 'utf8');
  assert.equal(/id="github-token"|type="password"|id="login-password"/.test(html), false);
});

test('missing, broad-format or rejected token leaves existing build untouched', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trip-pages-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'keep.txt'), 'previous');
  for (const value of [undefined, '', 'ghp_' + 'x'.repeat(40)]) {
    await assert.rejects(buildPagesSite({ token: value, directory }), /PHOTO_UPLOAD_TOKEN/);
  }
  await assert.rejects(buildPagesSite({ token, directory, verify: async () => { throw new Error(token); } }),
    error => !error.message.includes(token) && /校验未通过/.test(error.message));
  assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'previous');
});
