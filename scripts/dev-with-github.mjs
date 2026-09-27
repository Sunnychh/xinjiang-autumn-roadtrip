import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the loopback development server receives the existing CLI credential.
// No token is written to disk, process arguments, client assets, or command output.
let token;
try {
  token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch {
  console.error('请先执行 gh auth login，再启动照片上传页。');
  process.exit(1);
}
if (!token || /\s/.test(token)) {
  console.error('GitHub 登录凭据不可用，请重新登录。');
  process.exit(1);
}
try {
  const response = await fetch('https://api.github.com/repos/Sunnychh/xinjiang-trip-memories', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'xinjiang-local-upload' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const repo = response.ok ? await response.json() : null;
  if (!repo?.private || !repo.permissions?.push || repo.default_branch !== 'main') throw new Error();
} catch {
  console.error('无法确认私有照片仓库的写入权限。请检查 GitHub 登录和网络。');
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const child = spawn(process.execPath, [cli, 'dev', '--ip', '127.0.0.1', '--port', '8787', '--var', 'ENVIRONMENT:development'], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, GITHUB_TOKEN: token, WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || '/tmp/xinjiang-photo-dev.log' },
});
token = undefined;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('无法启动本地上传服务。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
