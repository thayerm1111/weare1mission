-- MEMBERS READ THEIR OWN ACTIVITY ONLY THROUGH THE SITE (owner 10-14: "Fix whatever you gotta fix").
--
-- flow_auto_events and genfx_fills each carried an own-row read policy, so a signed-in member could read
-- their own lines straight from the database with the site's public key — around the site, which is where
-- the credit lock is applied (setupLock.lockActivity). A member who is out of credits or paused still gets
-- a "skipped" line, with the trade's side, the moment a GENX setup triggers (10-11 to 10-14: 93 members
-- out of credits, 63 paused), so the side of a locked setup was one request away.
--
-- Nothing reads either table from the browser: every read is on the server with the service role, which
-- row security does not apply to (tests/member-activity-reads.test.ts keeps it that way). With the two
-- policies gone, row security stays on and grants members nothing, so these lines reach a member only
-- through the site's own routes.
drop policy if exists flow_auto_events_own on public.flow_auto_events;
drop policy if exists genfx_fills_select_own on public.genfx_fills;
