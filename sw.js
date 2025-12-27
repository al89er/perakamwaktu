/* sw.js — PerakamWaktu PWA Service Worker
   Strategy:
   - HTML navigation (index.html) = network-first (prevents “stuck on old UI”)
   - Local static assets (css/js/icons) = cache-first (fast + offline)
   - Clean up old caches on activate
*/

const CACHE_VERSION = "v3"; // <-- bump this when you deploy fixes
const CACHE_NAME = `perakamwaktu-${CACHE_VERSION}`;

// Local assets to precache (only same-origin files)
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./config.js",
  "./manifest.json",
  "./sw.js",
];

// Optional: add icons if they exist in your repo
// e.g. "./icons/icon-192.png", "./icons/icon-512.png"

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting(); // activate new SW immediately
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Delete old caches
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));

      // Take control of all clients immediately
      await self.clients.claim();
    })()
  );
});

// Helper: only handle same-origin requests (avoid caching CDNs like jsdelivr)
function isSameOrigin(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin;
  } catch {
    return false;
  }
}

// Network-first for navigation (HTML)
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    // Cache only successful, basic (same-origin) responses
    if (fresh && fresh.ok && fresh.type === "basic") {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    return cached || caches.match("./index.html");
  }
}

// Cache-first for static assets (CSS/JS/images)
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const fresh = await fetch(request);
  if (fresh && fresh.ok && fresh.type === "basic") {
    cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== "GET") return;

  // Don’t touch cross-origin requests (Supabase CDN etc.)
  if (!isSameOrigin(req)) return;

  const url = new URL(req.url);

  // Navigation requests → network-first
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }

  // For local static assets → cache-first
  // (You can expand this list if you add images/fonts)
  const isStatic =
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".jpeg") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".webp") ||
    url.pathname.endsWith(".ico");

  if (isStatic) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Default: try network, fallback to cache
  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(req)) || Response.error();
      }
    })()
  );
});