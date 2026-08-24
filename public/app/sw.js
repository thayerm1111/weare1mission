const CACHE = "om-app-v14";
const SHELL = ["/app/index.html", "/app/manifest.webmanifest", "/app/icon-192.png", "/app/icon-512.png"];
// Precache the shell FRESH (bypass the HTTP cache) so a new deploy is captured on install.
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: "no-store" }).then((r) => { if (r && r.ok) return c.put(u, r); }).catch(() => {})))).then(() => self.skipWaiting())); });
// On activate, delete EVERY older cache (any name !== CACHE), then take control.
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api") || url.origin.includes("supabase.co") || url.origin.includes("twelvedata")) return;
  if (!url.pathname.startsWith("/app/")) return;
  // The app is a single index.html — always pull the freshest copy from the network on a
  // navigation (bypassing the HTTP cache), refresh the cached fallback, and only use the
  // cache when offline. This guarantees a new deploy shows up on the next launch.
  if (req.mode === "navigate" || url.pathname === "/app/" || url.pathname === "/app/index.html") {
    e.respondWith(
      fetch("/app/index.html", { cache: "no-store" }).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put("/app/index.html", c)).catch(() => {}); return r; })
        .catch(() => caches.match("/app/index.html"))
    );
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
