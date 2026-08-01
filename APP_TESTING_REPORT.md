# APP_TESTING_REPORT

## Automated / verified in this environment
- `tsc` strict + `vite build` for the app shell: **pass** (0 errors).
- `next build` for the site with embed-mode layout + CORS middleware: **Compiled successfully**.
- App boots to sign-in with no runtime JS errors (headless render).
- PWA served on the real domain at `/app/`: manifest 200, icons 200, sw 200,
  service worker registers, `/api/*` reachable same-origin (401 without token).
- Portal embed mode deployed READY; `/portal/<tool>?embed=1` correctly requires a
  session (redirects to login when unauthenticated — security intact).

## Devices / sessions
- Desktop automation browser (Claude-in-Chrome): unauthenticated — used to verify
  build, PWA plumbing, embed security, and redirect behaviour. **Cannot** test the
  signed-in tool workflows (no access to the member password; entering it is not permitted).
- iPhone installed PWA: **user-verified** login works and tools connect to live data
  (credits shown, e.g. 592/599). Full per-tool workflow verification is the next step,
  signed in on the phone.

## Needs manual (signed-in) verification on the phone
For each Floor tool, confirm inside the installed app: opens, fits mobile, inputs +
dropdowns + uploads work, keyboard doesn't block content, submit reaches backend,
AI output matches the website in quality/format, streaming/scroll/copy/save work,
credits deduct correctly, membership gates hold, and it survives close/reopen.

## Bugs found & fixed
- Service worker returned a redirected response for `/app/` navigations → error page
  on the bare URL. **Fixed** (network-first fetch of explicit index; cache `om-app-v3`).
- MFXGHOST native clone sent wrong field name (`instrument` vs `symbol`). **Resolved**
  by the embed switch (uses the real page).

## Remaining known issues
- Floor hub + Credits are native summaries (embed versions available; planned).
- Non-Floor sections (leaderboard, training, schedule, collection, admin, affiliate)
  not yet surfaced in the app tab structure (all embeddable; planned).
- No bespoke iOS splash images.
