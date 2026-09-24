import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.worker-assets');
const preparation = JSON.stringify(JSON.parse(await readFile(path.join(root, 'data/preparation-checklist.json'), 'utf8'))).replaceAll('<', '\\u003c');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Explicit allowlist: never publish the repository, credentials or database as assets.
const guides = ['index.html', 'interactive-itinerary.html', 'detailed-itinerary.html'];
for (const name of guides) {
  let html = await readFile(path.join(root, name), 'utf8');
  html = html.replace(/(<script id="preparation-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, open, close) => open + preparation + close);
  html = html.replace(/<link rel="canonical"[^>]*>/g, '');
  html = html.replaceAll('https://sunnychh.github.io/xinjiang-autumn-roadtrip/', '/');
  html = html.replace('</head>', '<link rel="stylesheet" href="/account-ui/guide-account.css"><script src="/account-ui/guide-account.js" defer></script></head>');
  await writeFile(path.join(out, name), html);
}
for (const name of ['detailed-itinerary.md', 'D3-LICENSE.txt', 'LEAFLET-LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(root, name), path.join(out, name));
}
await mkdir(path.join(out, 'account-ui'), { recursive: true });
for (const name of ['login.html', 'account.html', 'auth.css', 'auth.js', 'guide-account.css', 'guide-account.js']) {
  await cp(path.join(root, 'account-ui', name), path.join(out, 'account-ui', name));
}
await writeFile(path.join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log('已生成登录版站点；原 GitHub Pages 文件保持原样。');
