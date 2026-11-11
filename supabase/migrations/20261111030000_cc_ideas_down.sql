-- Undo of 20261111030000_cc_ideas: removes the table of generated ATLAS trade ideas (and its data).
-- No other table is touched. The idea route fails soft without it: ideas are still generated, they are
-- simply not kept, so "Get update", "Check result" and the record are unavailable.
drop index if exists public.cc_ideas_user_created_idx;
drop table if exists public.cc_ideas;
