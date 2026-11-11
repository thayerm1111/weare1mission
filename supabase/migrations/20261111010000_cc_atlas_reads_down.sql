-- Undo of 20261111010000_cc_atlas_reads: removes ATLAS's read history table (and its data).
-- No other table is touched. The worker and the live route fail soft without it (no read history is
-- shown and the live read is computed on the fly), so nothing else needs to change first.
drop index if exists public.cc_atlas_reads_at_idx;
drop table if exists public.cc_atlas_reads;
