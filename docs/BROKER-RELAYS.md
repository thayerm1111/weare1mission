# Broker relays — spreading the fan-out across several IPs

**Why.** TradeLocker's edge (Cloudflare) rate-limits by **IP address**, not by account or API key. One server
placing trades for 170+ members shares one budget, so a big fan-out hits 1015 blocks: fills stretch from
seconds to minutes, entries slip past the zone, and the post-order position lookup fails (which is what left
75 of 76 trades unmanaged on 09-18 02:43 UTC).

**What this is.** `relay/server.ts` is a tiny forwarder with no credentials, no database and no state. Deployed
several times — each instance in its own Railway region, each with its own outbound IP — it gives the fleet
several IP budgets instead of one.

```
worker / web app ──► relay (region A, IP A) ──► TradeLocker
                 ├─► relay (region B, IP B) ──► TradeLocker
                 └─► direct (this server's IP) ─► TradeLocker
```

## How calls are routed

* Every broker call picks an exit from the pool: this server plus every relay.
* The pick is **hashed from the broker account** (`env:accNum`), so one account's calls always leave from the
  same IP — token and session consistency are preserved — while different accounts spread across the pool.
* Each exit keeps its **own rate budget** in the scheduler (`relay → host`), so a 1015 on one IP slows only
  that IP. Priorities are unchanged: orders and stop moves first, then logins, then reads, then background.
* If a relay is unreachable or misconfigured, that call is sent **directly** instead — a member's order is
  never dropped because a relay is down.
* With `BROKER_RELAYS` unset, behavior is exactly as before (single IP).

## Environment

On the worker (Railway) and the web app (Vercel):

| Variable | Value |
| --- | --- |
| `BROKER_RELAYS` | comma-separated relay base URLs, e.g. `https://relay-eu.up.railway.app,https://relay-sg.up.railway.app` |
| `BROKER_RELAY_SECRET` | the shared secret; must equal each relay's `RELAY_SECRET` |

On each relay service:

| Variable | Value |
| --- | --- |
| `RELAY_SECRET` | the same shared secret |
| `PORT` | set by Railway |

Start command: `npm run relay`. Health check: `GET /health`.

## Adding a relay

1. New Railway service in this project, same GitHub repo, **a region we are not already using**
   (regions are what give a different IP — two services in one region can share an address).
2. Start command `npm run relay`, variable `RELAY_SECRET` = the shared secret.
3. Generate a domain, confirm `GET /health` returns `{"ok":true}`.
4. Append the domain to `BROKER_RELAYS` on the worker and on Vercel. No redeploy of the worker code is needed —
   only the variable, which restarts the service.

## Safety

* The relay only forwards to `demo.tradelocker.com` / `live.tradelocker.com`; anything else is refused.
* Requests without the shared secret are refused.
* Broker credentials are never stored on a relay; the Authorization header passes through in flight, over HTTPS.
* The relay cannot decide anything about a trade — it has no idea what it is carrying.

## The other fix

The TradeLocker **Developer Program key** (`TL_DEVELOPER_API_KEY`) raises the limit on a single IP. The two
approaches stack: with the key AND the relays, each exit gets the higher limit. Getting the key is the cheaper
win; the relays are what keep the desk working while it is pending, and when the member count outgrows even the
raised limit.
