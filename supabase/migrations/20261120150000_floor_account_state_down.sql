-- Undo of 20261120150000_floor_account_state: removes the table The Floor's account summary keeps its
-- broker readings in (and the readings). No other table is touched, and nothing but The Floor reads it:
-- without it each reading is kept in memory only, and an account shows "not yet read" until the first one.
drop table if exists public.floor_account_state;
