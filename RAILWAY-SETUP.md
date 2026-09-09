# Always-On Execution Worker — Railway Setup (10 minutes)

This runs the trade manager (break-even / partials / trail / TP self-heal) every **~0.8 s**
and the GENX entry watch every **~1.5 s**, around the clock, instead of the once-a-minute
Vercel cron loops. The Vercel crons stay on as automatic backup: if this worker ever dies,
they take back over within about a minute, on their own. Nothing can double-fire — a
database lock guarantees exactly one manager and one watcher at any moment.

## 1. Create the Railway project

1. Go to **railway.app** → sign up / log in **with your GitHub account** (thayerm1111).
2. Click **New Project → Deploy from GitHub repo → `thayerm1111/weare1mission`**.
3. Railway reads `railway.json` from the repo automatically — build is instant (it skips
   the website build; this service only runs the worker).

## 2. Paste the environment variables

In the Railway service → **Variables** tab → **Raw Editor**, add these six, with the SAME
values they have in Vercel (Vercel → weare1mission → Settings → Environment Variables —
open each one there and copy it):

```
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
FLOW_ENC_KEY=
TWELVEDATA_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
```

Optional tuning knobs (skip these unless we decide to change speed later):

```
WORKER_MANAGE_MS=800    # trade-manager tick; can go as low as 300
WORKER_WATCH_MS=1500    # entry-watch tick; can go as low as 750
```

## 3. Deploy

Click **Deploy**. Within ~1 minute the service log should show:

```
🚀 We Are 1 Mission worker starting as worker-... (manage 800ms · watch 1500ms)
manage: lock acquired as worker-... — ticking every 800ms
watch: lock acquired as worker-... — ticking every 1500ms
```

(The two "lock acquired" lines can take up to ~2 minutes to appear the first time —
the worker politely waits for the current Vercel cron pass to finish before taking over.)

## 4. Verify the hand-off

Hit `https://weare1mission.com/api/cron/flow-manage?key=...` (or just wait a minute and
check Vercel's function logs): the cron should now answer `"skipped": "locked"` — that is
the proof the worker owns trade management. The genx watch cron will likewise answer
`"skipped": "locked (worker active)"`.

## Costs & housekeeping

- Railway Hobby plan: **$5/mo** includes enough usage for this worker (it is one small
  Node process). Set a usage limit in Railway → Settings if you want a hard cap.
- **Auto-deploys:** Railway redeploys the worker automatically on every push to `main`,
  so worker code stays in sync with the site with zero extra steps.
- **If the worker is ever misbehaving:** just delete/pause the Railway service. The
  Vercel crons take back over automatically within a minute. No other action needed.
