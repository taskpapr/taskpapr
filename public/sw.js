// taskpapr service worker — makes the app installable and lets the app shell
// open with no connection. It never caches board data.
//
// Served by server.js at /sw.js (before auth, so installation works for
// logged-out visitors), with __TASKPAPR_VERSION__ replaced by the package.json
// version. Each deploy therefore ships a byte-different worker, which
// installs a new versioned cache and deletes the old one.
//
// Strategy: network-first for the shell, nothing else touched.
//   - Online, every request goes to the network exactly as it would without
//     a service worker, so a deploy, a logout or a login redirect is never
//     masked by a cached copy (DESIGN.md tenet 5).
//   - The cached copy is used only when the network fails, so the shell can
//     open and tell the user honestly that they're offline (tenet 15).
//   - /api/*, the SSE stream, auth routes, non-GET and cross-origin requests
//     are never intercepted. Board data is always live or absent, never stale.
//   - Only plain same-origin 200 responses that weren't redirected are cached,
//     so a "you're logged out, go to /login" response is never stored.
//
// The cached shell holds no user data (the board is fetched from /api after
// the page loads), so it is safe to keep across sign-outs and accounts.

'use strict';

const VERSION = '__TASKPAPR_VERSION__';
const CACHE   = `taskpapr-shell-${VERSION}`;

const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/purify.min.js',
  '/marked.min.js',
  '/favicon.svg',
  '/icons/mark.svg',
  '/manifest.webmanifest',
  '/icons/icon_128.png',
  '/icons/icon_256.png',
  '/icons/icon_512.png',
  '/icons/maskable_192.png',
  '/icons/maskable_512.png',
];
const SHELL_PATHS = new Set(SHELL);

function cacheable(res) {
  return res && res.ok && res.type === 'basic' && !res.redirected;
}

self.addEventListener('install', event => {
  // Best effort: a logged-out install gets redirected to /login for '/' and
  // the app files, and those responses are skipped rather than failing the
  // install. They're cached on the next successful online visit instead.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async url => {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (cacheable(res)) await cache.put(url, res);
      } catch (_) { /* offline during install: nothing to cache yet */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('taskpapr-shell-') && k !== CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The board page, with or without a query string (e.g. the "Add task"
  // shortcut's /?capture=1), is cached under '/'.
  const isBoard = req.mode === 'navigate' && url.pathname === '/';
  const key     = isBoard ? '/' : url.pathname;
  if (!isBoard && !(SHELL_PATHS.has(key) && !url.search)) return;   // not part of the shell: hands off

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (cacheable(res)) {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)));
      }
      return res;
    } catch (err) {
      const cached = await caches.match(key, { cacheName: CACHE });
      if (cached) return cached;
      throw err;
    }
  })());
});
