-- ADVERSE EXCURSION (owner 09-25: "the stops, do they need to be that large? Can they maybe be smaller?")
--
-- flow_managed_positions has always recorded best_price — the best the trade ever got — which is what
-- made the take-profit question answerable: a target is reachable if price demonstrably traded through
-- it. The stop question is the mirror image and we had no mirror. Whether a 110-pip stop can become 70
-- depends on how deep a WINNING trade dips before it turns, and nothing recorded that.
--
-- Without it, any backtest of a tighter stop counts every loser it would have cut smaller and none of
-- the winners it would have cut out — the shape of analysis that looks wonderful and loses money live.
alter table public.flow_managed_positions
  add column if not exists worst_price numeric;

comment on column public.flow_managed_positions.worst_price is
  'Maximum ADVERSE excursion: the worst price the trade reached while open. Mirror of best_price. Added 2026-09-25 so the stop-distance question can be answered from real fills.';
