/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Placeholder images are served locally from /public. When you add remote
  // image hosts (e.g. a CDN or Supabase storage), whitelist them here:
  // images: { remotePatterns: [{ protocol: 'https', hostname: 'your-cdn.com' }] },
  // The installable PWA lives at /app. Serve its shell + service worker with
  // must-revalidate so a new deploy reaches installed apps immediately instead
  // of being pinned to a stale cached copy.
  async headers() {
    return [
      {
        source: "/app/sw.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        source: "/app/index.html",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        source: "/app/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        // Preview build of the new unified trade-card app (separate from live /app).
        source: "/app-next/index.html",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
