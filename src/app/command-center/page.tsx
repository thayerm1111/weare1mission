import CommandCenterHud from "@/components/command-center/hud/CommandCenterHud";
import { PassGate } from "@/components/command-center/hud/PassGate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Command Center XAUUSD" };

export default function Page() {
  return (
    <PassGate>
      <CommandCenterHud />
    </PassGate>
  );
}
