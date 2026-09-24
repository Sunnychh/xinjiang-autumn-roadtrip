import { readFile } from 'node:fs/promises';
export async function requireDeployConfig() {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const id = config.d1_databases?.[0]?.database_id;
  if (!id || id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('请先登录 Cloudflare、创建 D1 数据库，并将返回的 database_id 填入 wrangler.jsonc。');
  }
  if (!['private', 'public'].includes(config.vars?.GUIDE_ACCESS)) throw new Error('GUIDE_ACCESS 必须为 private 或 public。');
  if (config.vars?.ENVIRONMENT !== 'production') throw new Error('远程部署必须使用 production 环境。');
  return config;
}
if (process.argv[1]?.endsWith('/require-deploy-config.mjs')) {
  requireDeployConfig().catch(error => { console.error(error.message); process.exitCode = 1; });
}
