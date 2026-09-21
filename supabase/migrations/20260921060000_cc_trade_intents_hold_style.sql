-- ATLAS NORMAL trades never went out (owner 09-21: "ATLAS will not enter a trade, it just keeps saying
-- forming"). The setup engine's styles are quick / hold / swing, but cc_trade_intents only allowed
-- quick / intraday / swing, so every NORMAL ("hold") intent insert failed the check constraint and the
-- autopilot logged "Could not record the trade intent." and stopped — before any order was sent.
-- Additive only: 'hold' joins the allowed set; nothing existing changes.
alter table public.cc_trade_intents drop constraint if exists cc_trade_intents_style_check;
alter table public.cc_trade_intents add constraint cc_trade_intents_style_check
  check (style = any (array['quick'::text, 'hold'::text, 'intraday'::text, 'swing'::text]));
