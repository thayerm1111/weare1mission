# COMMAND CENTER XAUUSD

A fresh, self-contained gold trading command center. The intelligence engine inside it is **The BRAIN**.

**Isolation is a rule, not a preference.** Nothing in `command-center/` imports from `src/lib/genx*`,
`src/lib/flow*`, or any other existing desk code, and nothing there imports from here. It owns its own
database namespace (`cc_*`), its own worker service, and its own API surface. That boundary is enforced by a
test, so it cannot rot.

```
command-center/
  core/       pure domain — no I/O, no network, no database. Every rule lives here and is unit-tested.
  adapters/   the outside world: Twelve Data, TradeLocker, Supabase. Thin, replaceable, no decisions.
  engines/    long-running logic composed from core + adapters.
  worker/     the Railway process that runs the engines.
  db/         migrations for the cc_ namespace.
```

**Why pure core matters here:** the same functions that decide a live trade also run the shadow recorder and
the replay engine. If a rule lived inside a worker loop, replay would have to re-implement it — and a
backtest that re-implements the rule is testing the re-implementation, not the system.
