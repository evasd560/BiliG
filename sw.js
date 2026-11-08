// BiliG service worker: lets the app install and open offline.
//   The page itself: network first, so a new version shows as soon as you're online; the saved copy is the offline fallback.
//   Libraries and fonts from CDNs: cache first (their addresses carry a version, so they never change).
//   Our own pictures and icons: show the saved copy, refresh it in the background.
//   Supabase (phrases, sign-in, feedback): never cached, always live.
// Bump VERSION when the list below changes; old caches are cleared on activate.
const VERSION = "bilig-v1";
const CORE = [
  "./", "index.html", "manifest.json", "logo.png", "favicon.png",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "img/city.svg", "img/garden.svg",
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js",
];
const CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener("install", e => {
  // One missing file shouldn't stop the install, so each is saved on its own.
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const save = (req, res) => { if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; };

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.hostname.endsWith("supabase.co")) return;          // live data: leave it alone

  if (req.mode === "navigate") {                                                       // the app page
    e.respondWith(fetch(req).then(res => save("index.html", res)).catch(() => caches.match("index.html").then(r => r || caches.match("./"))));
    return;
  }
  if (CDN.test(req.url)) {                                                             // versioned libraries, fonts, emoji pictures
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => save(req, res))));
    return;
  }
  if (url.origin === self.location.origin) {                                          // our own files
    e.respondWith(caches.match(req).then(hit => {
      const fresh = fetch(req).then(res => save(req, res)).catch(() => hit);
      return hit || fresh;
    }));
  }
});
