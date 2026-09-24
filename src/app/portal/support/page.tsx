import { LifeBuoy } from "lucide-react";
import { SupportChat } from "@/components/portal/SupportChat";

export const metadata = { title: "Support" };

/**
 * SUPPORT — one way in (owner 09-24: "Take both these off, only have the new support you made").
 *
 * This page used to offer three doors: an AI assistant, a mailto link, and then the member thread.
 * Three doors to the same problem is worse than one, because the member has to guess which one gets
 * a real answer — and two of them didn't. The assistant could only ever speak in generalities, and
 * the mailto landed in an inbox with nothing attached to the member's account. The thread below
 * reaches the desk, is read against that member's own credits, FLOW settings and broker accounts,
 * and is answered by a person.
 *
 * The AI assistant's route (/api/support) is left in place and simply unreferenced from here; the
 * page no longer needs client state of its own, so it is a plain server component.
 */
export default function SupportPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <p className="eyebrow">Help</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-extrabold tracking-tight text-navy">
          <LifeBuoy className="h-7 w-7 text-primary" aria-hidden="true" /> Support
        </h1>
        <p className="mt-2 text-charcoal/70">
          Message the team about anything — credits, FLOW, GENX, your broker connection, billing. We can
          see your account from here, so tell us what&rsquo;s happening and we&rsquo;ll look at it ourselves.
        </p>
      </header>

      <SupportChat />
    </div>
  );
}
