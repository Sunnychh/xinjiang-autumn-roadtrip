import { runBackgroundUploads, UPLOAD_SYNC_TAG } from './background-runner.mjs?v=20261009-background';

// This worker never intercepts fetches or caches credentials, photos or pages.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function resume() {
  const result = await runBackgroundUploads();
  if (result.status === 'paused' && self.registration.sync) {
    await self.registration.sync.register(UPLOAD_SYNC_TAG);
  }
}

self.addEventListener('sync', event => {
  if (event.tag === UPLOAD_SYNC_TAG) event.waitUntil(resume());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'resume-uploads' || !event.source?.url) return;
  let source;
  try { source = new URL(event.source.url); } catch { return; }
  const scope = new URL(self.registration.scope);
  if (source.origin !== scope.origin || !source.pathname.startsWith(scope.pathname)) return;
  // No credential crosses postMessage; only an explicitly remembered connection
  // matching this batch may be opened by the runner.
  event.waitUntil(resume().catch(() => {}));
});
