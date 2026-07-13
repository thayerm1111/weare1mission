import { StorePage } from "@/components/shop/StorePage";

export const metadata = { title: "The Collection", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function PortalCollectionPage() {
  return (
    <StorePage
      handle="the-collection"
      eyebrow="The Collection"
      title="Wear the movement"
      description="Official 1 Mission apparel and merch. Clothing, hats, and everyday pieces — checkout is fast and secure."
    />
  );
}
