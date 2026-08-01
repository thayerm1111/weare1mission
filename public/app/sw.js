const CACHE = "om-app-v3";
const SHELL = ["/app/index.html", "/app/manifest.webmanifest", "/app/icon-192.png", "/app/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api") || url.origin.includes("supabase.co") || url.origin.includes("twelvedata")) return;
  if (!url.pathname.startsWith("/app/")) return;
  // Navigations: fetch the explicit index file (avoids the /app/ redirect that
  // breaks a service-worker navigation response), cache it, fall back offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch("/app/index.html").then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put("/app/index.html", c)).catch(() => {}); return r; })
        .catch(() => caches.match("/app/index.html"))
    );
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
