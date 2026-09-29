import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connect } from '../upload/github.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.pages-site');
export async function buildPagesSite({ token, directory = output, verify = connect } = {}) {
  if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,240}$/.test(token.trim())) {
    throw new Error('请先在仓库 Actions secrets 中配置 PHOTO_UPLOAD_TOKEN，使用仅授权照片库的 Fine-grained token。');
  }
  let client;
  try { client = await verify(token.trim()); }
  catch { throw new Error('照片库令牌校验未通过，旧站保持不变。请检查令牌有效期和照片库 Contents 读写权限。'); }
  finally { client?.disconnect(); }
  await rm(directory, { recursive: true, force: true });
  await mkdir(path.join(directory, 'upload'), { recursive: true });
  await mkdir(path.join(directory, 'account-ui'), { recursive: true });
  // Publish only reviewed static resources. No repository, backend, database or source secret file.
  for (const name of ['index.html', 'interactive-itinerary.html', 'detailed-itinerary.html', 'detailed-itinerary.md',
    'LEAFLET-LICENSE.txt', 'D3-LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(root, name), path.join(directory, name));
  }
  for (const name of ['index.html', 'style.css', 'app.mjs', 'github.mjs', 'image.mjs']) {
    await cp(path.join(root, 'upload', name), path.join(directory, 'upload', name));
  }
  await cp(path.join(root, 'account-ui/auth.css'), path.join(directory, 'account-ui/auth.css'));
  // User explicitly selected a public no-login upload capability. This value is
  // intentionally readable in the deployed page; repository secrets only keep it out of Git history.
  await writeFile(path.join(directory, 'upload/credential-config.mjs'),
    `export const embeddedToken = ${JSON.stringify(token.trim())};\n`);
  await writeFile(path.join(directory, '.nojekyll'), '');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildPagesSite({ token: process.env.PHOTO_UPLOAD_TOKEN });
    console.log('Pages 发布包已生成，专用令牌仅写入网页产物。');
  } catch (error) {
    // Only fixed application errors; never log the token or a network response.
    console.error(error.message);
    process.exitCode = 1;
  }
}
