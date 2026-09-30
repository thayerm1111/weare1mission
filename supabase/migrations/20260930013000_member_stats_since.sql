-- A member's own results reset point (owner 09-29: "reset these stats — I need to reconnect new
-- accounts and I want fresh stats"). FLOOR_STATS_SINCE is the community clock; this is the member's.
-- Null = no personal reset. Read by /api/floor/live-trade and /api/admin/my-results only.
alter table public.flow_trade_prefs add column if not exists stats_since timestamptz;
