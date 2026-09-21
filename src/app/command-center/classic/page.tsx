import CommandCenterLive from "@/components/command-center/CommandCenterLive";
import { PassGate } from "@/components/command-center/hud/PassGate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Command Center XAUUSD — classic" };

/** The previous Command Center layout, kept reachable while the HUD beds in. Same data, same engine. */
export default function Page() {
  return <PassGate><CommandCenterLive /></PassGate>;
}
