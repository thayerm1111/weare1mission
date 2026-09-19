import BrainCompanion from "@/components/command-center/BrainCompanion";

export const dynamic = "force-dynamic";
export const metadata = { title: "THE BRAIN" };

/**
 * The floating companion, served from the same origin as everything else.
 *
 * The background is transparent on purpose: in the desktop shell this window has no decorations and no
 * opaque backing, so anything painted here that is not the companion itself becomes a white rectangle
 * sitting on top of the member's work.
 */
export default function Page() {
  return <BrainCompanion />;
}
