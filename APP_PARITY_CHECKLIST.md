# APP_PARITY_CHECKLIST

Status legend: ✅ complete · 🟡 works-via-embed (verify signed-in on phone) ·
🔷 native summary (embed available) · ⬜ not started

| Website Feature | On Website | In App | Approach | Status |
|---|---|---|---|---|
| Sign in / session (same account) | ✅ | ✅ | Supabase SSR cookie login | ✅ |
| Credits balance (shared) | ✅ | ✅ | /api/me | ✅ |
| **The Floor — hub** | ✅ | 🔷 | native summary; embed /portal/trading available | 🔷 |
| Floor · The Room (live) | ✅ | 🟡 | iframe /portal/trading?view=room | 🟡 |
| Floor · Market Pulse | ✅ | 🟡 | iframe /portal/trading?view=pulse | 🟡 |
| Floor · Live Plays | ✅ | 🟡 | iframe /portal/trading?view=plays | 🟡 |
| **OM Strategy Scanner** | ✅ | 🟡 | iframe /portal/strategy-scanner | 🟡 |
| **OM AI Plays (signal generator)** | ✅ | 🟡 | iframe /portal/signals | 🟡 |
| **OM AI Market Command** | ✅ | 🟡 | iframe /portal/market-command (admin gate preserved) | 🟡 |
| **MFXGHOST** | ✅ | 🟡 | iframe /portal/xaughost (all 6 pairs, full read) | 🟡 |
| **OM Charts** | ✅ | 🟡 | iframe /portal/charts (image upload) | 🟡 |
| **OM AI (chat)** | ✅ | 🟡 | iframe /portal/om-ai | 🟡 |
| Trade Chat / Ask-the-AI | ✅ | 🟡 | inside each tool page | 🟡 |
| Deep dives / saved results / journal | ✅ | 🟡 | inside tool pages (real components) | 🟡 |
| Credits purchase (Stripe) | ✅ | 🔷 | native display; embed /portal/credits available | 🔷 |
| Account / profile / password | ✅ | 🟡 | "Open web portal" + can embed /portal/account | 🟡 |
| Leaderboard / Community results | ✅ | ⬜ | embed /portal/leaderboard, /portal/community (planned) | ⬜ |
| Learning / Training / Resources | ✅ | ⬜ | embed respective /portal pages (planned) | ⬜ |
| Schedule / What's On | ✅ | ⬜ | embed /portal/schedule (planned) | ⬜ |
| The Collection / Experiences | ✅ | ⬜ | embed /portal/collection, /portal/experiences (planned) | ⬜ |
| Builders / MLM / affiliate tools | ✅ | ⬜ | embed builder pages (planned) | ⬜ |
| Admin tools | ✅ | ⬜ | embed /portal/admin (planned) | ⬜ |
| PWA install / icon / standalone | ✅ | ✅ | manifest | ✅ |
| Update after deploy (no stale) | — | ✅ | network-first SW (om-app-v3) | ✅ |
| English / Spanish | ✅ | ✅ | shell i18n + AI answers in Spanish | ✅ |

**Because tools are embedded, every in-tool feature (inputs, dropdowns, uploads,
streaming, results, copy, save, history, credit deduction, membership gates, error
+ loading states) is the website's own and is present by construction — it now
needs signed-in verification on the phone, tracked in APP_TESTING_REPORT.**
