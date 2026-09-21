import CommandCenterHud from "@/components/command-center/hud/CommandCenterHud";

export const dynamic = "force-dynamic";
export const metadata = { title: "Command Center XAUUSD — replay" };

/**
 * Recorded gold through the live engine, so the screen can be built and reviewed when the market is shut.
 * `?trade=1` additionally attaches a position derived from those same recorded bars.
 */
export default function Page({ searchParams }: { searchParams?: { trade?: string } }) {
  const withTrade = searchParams?.trade === "1";
  return <CommandCenterHud endpoint={`/api/command-center/replay${withTrade ? "?trade=1" : ""}`} />;
}
