import { WhatsOnClient } from "@/components/portal/WhatsOnClient";

export const metadata = { title: "What's On", robots: { index: false, follow: false } };

export default function WhatsOnPage() {
  return <WhatsOnClient />;
}
