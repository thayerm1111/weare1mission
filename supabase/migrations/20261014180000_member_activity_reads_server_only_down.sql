-- Undo of 20261014180000_member_activity_reads_server_only: members may read their own lines directly again.
drop policy if exists flow_auto_events_own on public.flow_auto_events;
create policy flow_auto_events_own on public.flow_auto_events for select using (auth.uid() = user_id);
drop policy if exists genfx_fills_select_own on public.genfx_fills;
create policy genfx_fills_select_own on public.genfx_fills for select using (auth.uid() = user_id);
