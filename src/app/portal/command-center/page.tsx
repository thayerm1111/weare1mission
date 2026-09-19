import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The Command Center moved out of the portal frame and onto its own full screen. */
export default function PortalCommandCenterRedirect() {
  redirect("/command-center");
}
