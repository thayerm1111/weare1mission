# APP_PARITY_AUDIT

_Source of truth: the weare1mission website (Next.js on Vercel). The installed
app is a thin PWA shell that renders the REAL website pages — not a copy._

## Current app architecture
- **Type:** Installable PWA served from the existing Vercel project at
  `https://weare1mission.vercel.app/app/` (files live in the repo at `public/app/`).
  It is NOT a separate codebase or a second Vercel project.
- **Shell:** a single self-contained `index.html` (Vite + React, `vite-plugin-singlefile`)
  providing the native chrome only: top bar, bottom tab bar (Floor · Tools · Live ·
  Credits · Account), sign-in, and a language toggle (EN/ES, auto-detects device).
- **Tools = the real website.** Each AI tool opens the **actual** `/portal/<tool>`
  page inside a same-origin `<iframe>` with `?embed=1`. Embed mode (added to
  `src/app/portal/layout.tsx`) hides the site's own header + side nav and forces
  dark, so only the tool renders — with 100% of the website's features, because it
  IS the website page. Nothing is re-implemented.
- **Auth:** the app signs in with `@supabase/ssr` `createBrowserClient`
  (same Supabase project, same cookies the website uses). The iframe therefore
  loads the portal pages already authenticated — same account, credits, permissions.
- **API:** the app makes no duplicate backend. Tool pages call their existing
  `/api/*` routes from inside the iframe (cookies), identical to the website.

## PWA configuration (verified in repo, `public/app/`)
- **manifest.webmanifest:** name "One Mission", standalone, portrait,
  theme/background `#0a0b10`, `start_url` and `scope` `/app/`, 192 + 512 (+maskable) icons.
- **Service worker (`sw.js`, cache `om-app-v3`):** navigations are **network-first**
  (fetch the fresh `index.html`, fall back to cache offline) — this is the fix that
  prevents stale versions after a Vercel deploy. `skipWaiting` + `clients.claim`
  so updates take over quickly. API / Supabase / market-data requests are never cached.
- **Icons:** `icon-192/512/180.png` present. **Splash:** iOS uses icon + theme color
  (no bespoke splash images yet — minor polish item).
- **Safe areas:** `viewport-fit=cover` + `env(safe-area-inset-*)` used in the shell
  top bar and bottom tabs.

## Backend / security (unchanged, verified)
- Supabase auth + RLS, credit RPCs, all `/api/*` routes, AI prompts, trading logic
  and calculations are **untouched**. The app reuses them as-is.
- `src/middleware.ts` refreshes the Supabase session, protects `/portal`, and adds
  CORS only for native-app origins — merged carefully so the website is unaffected.
- Only the public Supabase anon key is shipped in the client (by design; RLS
  protects data). No service-role or server secrets are exposed.

## What was completed
1. Installable PWA on the user's domain (manifest, SW, icons) — DONE.
2. Same-account cookie login shared with the website — DONE.
3. Redirect-safe service worker (no stale versions, no blank screen on update) — DONE.
4. **Embed mode** so every `/portal` tool renders inside the app with full parity — DONE.
5. English/Spanish localisation of the app shell — DONE.

## Known gaps / follow-ups
- **The Floor hub itself** is currently a native summary screen; it can be switched to
  embed the real `/portal/trading` floor for 100% parity (planned next).
- **Credits tab** is a native display; can embed real `/portal/credits` for the live
  purchase flow.
- **Login inside iframe** (only if a session expires) currently shows the public
  `/login` chrome; add embed handling to `/login` for polish.
- No bespoke iOS splash images yet.
- Full workflow testing must be done signed-in on the phone (the automation browser
  is a separate, unauthenticated session).
