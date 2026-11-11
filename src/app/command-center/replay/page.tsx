import CommandCenterHud from "@/components/command-center/hud/CommandCenterHud";

export const dynamic = "force-dynamic";
export const metadata = { title: "Command Center XAUUSD — replay" };

/**
 * Recorded gold through the live engine, so the screen can be built and reviewed when the market is shut.
 * `?trade=1` additionally attaches a position derived from those same recorded bars.
 * `?end=N` stands the replay N five-minute candles before the end of the recording.
 */
export default function Page({ searchParams }: { searchParams?: { trade?: string; end?: string } }) {
  const q = new URLSearchParams();
  if (searchParams?.trade === "1") q.set("trade", "1");
  const end = Math.floor(Number(searchParams?.end));
  if (Number.isFinite(end) && end > 0) q.set("end", String(Math.min(100, end)));
  const qs = q.toString();
  return <CommandCenterHud endpoint={`/api/command-center/replay${qs ? `?${qs}` : ""}`} />;
}
