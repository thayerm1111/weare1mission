import { StorePage } from "@/components/shop/StorePage";
import { buildMetadata } from "@/lib/metadata";

export const metadata = buildMetadata({
  title: "The Collection",
  description: "Official 1 Mission apparel and merch — clothing, hats, and everyday pieces for the movement.",
  path: "/collection",
  image: "https://cdn.shopify.com/s/files/1/1016/0406/5559/files/de097b0879004619bffa107cb62305fa.png?v=1783880822",
});

// Fetch fresh product data periodically.
export const revalidate = 300;

export default function CollectionPage() {
  return (
    <StorePage
      handle="the-collection"
      eyebrow="The Collection"
      title="Wear the movement"
      description="Official 1 Mission apparel and merch. Clothing, hats, and everyday pieces — checkout is fast and secure."
    />
  );
}
