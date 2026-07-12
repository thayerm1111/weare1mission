import { Hero } from "@/components/Hero";
import { ProductGrid } from "@/components/shop/ProductGrid";
import { getShopCollection, isShopifyConfigured, shopifyDomain } from "@/lib/shopify";

/**
 * Renders a Shopify collection as a storefront page (used by /collection and
 * /experiences). Falls back to a "coming soon" state until Shopify is set up.
 */
export async function StorePage({
  handle, eyebrow, title, description,
}: {
  handle: string; eyebrow: string; title: string; description: string;
}) {
  const collection = isShopifyConfigured ? await getShopCollection(handle) : null;

  return (
    <>
      <Hero eyebrow={eyebrow} title={title} description={description} />
      <section className="section bg-cream">
        <div className="container-1m">
          {!isShopifyConfigured ? (
            <ComingSoon reason="connect" />
          ) : !collection ? (
            <ComingSoon reason="empty" />
          ) : (
            <ProductGrid products={collection.products} domain={shopifyDomain} />
          )}
        </div>
      </section>
    </>
  );
}

function ComingSoon({ reason }: { reason: "connect" | "empty" }) {
  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-10 text-center">
      <h2 className="font-serif text-2xl font-bold text-navy">Coming soon</h2>
      <p className="mt-3 text-sm leading-relaxed text-charcoal/65">
        {reason === "connect"
          ? "This store is being connected to Shopify. Products and secure checkout will appear here shortly."
          : "No products are published yet. They'll show up here as soon as they go live in Shopify."}
      </p>
    </div>
  );
}
