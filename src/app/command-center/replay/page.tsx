import CommandCenterLive from "@/components/command-center/CommandCenterLive";

export const dynamic = "force-dynamic";
export const metadata = { title: "Command Center XAUUSD — replay" };

/** Recorded gold through the live engine, so the screen can be built and reviewed when the market is shut. */
export default function Page() {
  return <CommandCenterLive endpoint="/api/command-center/replay" />;
}
