import { notFound } from "next/navigation";
import { AppShell } from "@/components/om/AppShell";
import { Floor } from "@/components/om/floor/Floor";
import { SHELL_CSS, SHELL_SCRIPT } from "@/lib/floor/nav";
import { floorSample, type SampleState } from "@/lib/floor/sample";
import { CREDIT_COST } from "@/lib/creditConfig";
import { SETUP_MINUTES } from "@/lib/setupLock";
import { CC_PASS_COST, CC_PASS_MS } from "@/lib/ccPass";

export const dynamic = "force-dynamic";
export const metadata = { title: "OM OS — design review", robots: { index: false, follow: false } };

const STATES: SampleState[] = ["connected", "locked", "stale", "empty", "loss"];

/**
 * THE FLOOR, ON SAMPLE DATA — for reviewing the design without a member's session or a broker.
 *
 * This address exists only where OM_FLOOR_SAMPLE=1 is set. It is not set on the live site, so there it is
 * a 404 like any address that was never built. It reads no member, no account and no market data: every
 * figure on it is invented, and a banner on the page says so. `?state=` shows the screen's other honest
 * states — locked (the play withheld), stale (an old broker reading), empty (no account), loss.
 */
export default function FloorPreviewPage({ searchParams }: { searchParams?: { state?: string | string[] } }) {
  if (process.env.OM_FLOOR_SAMPLE !== "1") notFound();
  const asked = typeof searchParams?.state === "string" ? searchParams.state : "";
  const state = (STATES as string[]).includes(asked) ? (asked as SampleState) : "connected";
  // What things cost is never part of the invention: it is read from the settings the real screens use.
  const sample = floorSample(state, { play: CREDIT_COST.genx, playMinutes: SETUP_MINUTES, atlas: CC_PASS_COST, atlasMinutes: CC_PASS_MS / 60_000 });
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: SHELL_CSS }} />
      <script dangerouslySetInnerHTML={{ __html: SHELL_SCRIPT }} />
      <AppShell member={{ name: "Sample member", email: null, admin: false }} configured={false}>
        <Floor sample={sample} />
      </AppShell>
    </>
  );
}
