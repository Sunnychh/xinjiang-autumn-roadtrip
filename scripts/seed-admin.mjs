import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashPassword } from '../backend/crypto.mjs';
import { requireDeployConfig } from './require-deploy-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const remote = argv.includes('--remote');
if (remote === argv.includes('--local')) throw new Error('请明确指定 --local 或 --remote。');
if (remote) await requireDeployConfig();
const username = argv[argv.indexOf('--username') + 1];
if (!argv.includes('--username') || typeof username !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
  throw new Error('请使用 --username 指定 3—32 位字母、数字、下划线或短横线账号。');
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stdout.write('初始密码（隐藏输入）：');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    }
    function onData(buffer) {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') return finish(new Error('已取消。'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    }
    process.stdin.on('data', onData);
  });
}

let directory;
try {
  const password = await readPassword();
  if (password.length < 10 || password.length > 128) throw new Error('密码长度需为 10—128 个字符。');
  const passwordHash = await hashPassword(password);
  const sqlQuote = value => "'" + value.replaceAll("'", "''") + "'";
  const now = Math.floor(Date.now() / 1000);
  const fields = [randomUUID(), username, username.toLowerCase(), passwordHash, 'admin'].map(sqlQuote);
  const sql = `INSERT INTO users (id, username, username_normalized, password_hash, role, disabled, auth_version, created_at, updated_at) VALUES (${fields.join(',')}, 0, 0, ${now}, ${now});`;
  directory = await mkdtemp(path.join(tmpdir(), 'roadtrip-admin-'));
  const filename = path.join(directory, 'seed.sql');
  await writeFile(filename, sql, { mode: 0o600 });
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', remote ? '--remote' : '--local', '--file', filename, '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) throw new Error('创建失败：请核对数据库迁移、账号是否已存在，以及 Cloudflare 登录状态。现有账号不会被覆盖。');
  console.log(`已创建${remote ? '远程' : '本地'}管理员 ${username}。凭据未写入源码或版本库。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
