import { CommandCenter } from "@/components/portal/CommandCenter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Command Center XAUUSD" };

export default function CommandCenterPage() {
  return (
    <main className="min-h-screen px-4 py-6 sm:px-6" style={{ background: "#070B11" }}>
      <div className="mx-auto max-w-5xl space-y-4">
        <CommandCenter />
      </div>
    </main>
  );
}
