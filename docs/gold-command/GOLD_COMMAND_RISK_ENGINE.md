# RISK ENGINE

The Risk Engine sits above AI discretion. The BRAIN can ask for anything; the Risk Engine decides what is
permitted. **No model output can raise a limit.** Limits are lowered by the member, never by the machine.

## Position sizing

Size is derived, never chosen:

```
riskAmount = equity × riskPct
stopDistance = |entry − stop|                     (in price)
rawLots = riskAmount / (stopDistance × pointValue)
lots = floor(rawLots / lotStep) × lotStep         (rounded DOWN, never up)
```

Rejected if `lots < minLot`, if `lots > maxLot`, or if the broker's contract specification is unknown.
A fixed lot size is never treated as fixed risk. The instrument specification comes from the broker's own
instrument list, not from a constant.

## Per-trade limits

| Limit | Default | Notes |
| --- | --- | --- |
| Risk per trade | 0.5% | Member-selectable within system bounds |
| Max stop distance | 100 pips (gold) | A wider structural stop shrinks size instead |
| Min reward | 1:1 at the worst allowed fill | Measured at the zone edge, not the midpoint |
| Max spread | mode-dependent | Scalp tightest, swing loosest |

## Account-level hard limits

Configurable, and once breached they cannot be overridden in-session:

max total open risk · max daily loss · max daily drawdown · max weekly loss · max consecutive losses ·
max trades per session · max simultaneous gold positions · trade cooldown · news lockout ·
volatility lockout · minimum account equity

Each limit stores **who set it, when, and the value before**. A limit loosened mid-session is itself an
audited event.

## Prop-firm constraints

Prop accounts get a constraint object, not a guess: daily drawdown, overall drawdown, max size, restricted
news windows, overnight and weekend holding rules. When configured, these are hard constraints evaluated
before the account's own limits. Nothing assumes every firm shares one rulebook.

## What is forbidden, permanently

- **No martingale.** Risk never increases because the last trade lost.
- **No averaging into a loser.** Scale-in exists only as a separately authorised, bounded strategy.
- **No widening a published stop.** A stop may only move toward the trade's favour.
- **No risk increase through stop modification.** Exposure may fall, never rise beyond the original.
- **No re-entry of a position the member closed by hand** just because the signal still stands.

## The desk breaker

Three real stop-outs inside six hours pauses new entries for four hours from the last loss, then resumes on
its own. Open trades are untouched. Disabled with `GENX_DESK_BREAKER=off` — the owner's call, recorded here
because the trade-off is real: it prevents chop bleed and it will occasionally sit out a good session.

## Failure posture

A risk **system** fault (database unreachable, equity unreadable) blocks new entries. It never blocks the
protection of an open position: moving a stop to safety must work when everything else is broken.
