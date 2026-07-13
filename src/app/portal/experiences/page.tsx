import { StorePage } from "@/components/shop/StorePage";

export const metadata = { title: "1M Experiences", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function PortalExperiencesPage() {
  return (
    <StorePage
      handle="1m-experiences"
      eyebrow="1M Experiences"
      title="Where the movement gathers"
      description="Live events, retreats, and experiences with the 1 Mission community. Reserve your spot and pay securely."
    />
  );
}
