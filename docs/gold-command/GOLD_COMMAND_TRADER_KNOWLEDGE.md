# TRADER KNOWLEDGE — TEACH MODE

The owner is an experienced gold trader. The system's job is to absorb that experience as structured,
testable rules — not to average it away.

## What a lesson is

A lesson keeps the original words forever, alongside a structured interpretation:

```json
{
  "original": "Don't move to BE this quickly on an intraday setup",
  "structured": { "target": "break_even", "mode": "intraday", "effect": "delay", "threshold": "1.0R" },
  "scope": { "modes": ["intraday"], "strategies": ["*"], "regimes": ["*"], "sessions": ["*"] },
  "priority": 7, "active": true, "expires_at": null, "version": 1
}
```

The original text is never discarded or rewritten. If the structured interpretation turns out to be wrong,
the interpretation is versioned — the sentence stays.

## Kinds of knowledge

- **Definitions** — "this is a breakout", "this is a fake breakout".
- **Management preferences** — "protect profit faster when this happens".
- **Level knowledge** — "4375 is major support today" (already supported via `genx_owner_levels`).
- **Restrictions** — "no shorts until New York", "do not trade CPI".
- **Setup teaching** — "this is a setup I trade", with examples and counterexamples.

## Temporary overrides

Session-scoped rules expire automatically and show their remaining life in the UI. "Manage profits
aggressively for the rest of this session" is a rule with an end time, not a permanent behaviour change.

## Disagreement is recorded, not smoothed over

When the owner and The BRAIN disagree, both positions are shown and stored:

```
MATTHEW:  Breakout confirmed.
BRAIN:    Breakout attempted. I do not classify acceptance yet — the 5M close returned inside the prior range.
```

Afterwards the outcome is attached to the disagreement. Over time this produces something more valuable than
either view alone: a measured record of when the trader's read beats the model and when it does not. The
system must never quietly adopt the owner's view to avoid friction — an honest model that is sometimes wrong
is worth more than an agreeable one.

## The owner's own calls

Manual calls are stored like any signal — entry, direction, reason, snapshot, the BRAIN's opinion at that
moment, and the outcome — and evaluated with the same yardstick as automated trades.
