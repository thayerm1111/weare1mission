/**
 * SHOPIFY STOREFRONT  —  reads products from your Shopify store for the
 * public /collection (merch) and /experiences (events & retreats) pages.
 *
 * SETUP (one time):
 *   1. In Shopify admin → Settings → Apps and sales channels → Develop apps →
 *      create an app → Storefront API → install → copy the Storefront API
 *      access token.
 *   2. In Vercel → your project → Settings → Environment Variables, add:
 *        SHOPIFY_STORE_DOMAIN     = 1-mission-2.myshopify.com
 *        SHOPIFY_STOREFRONT_TOKEN = <the token from step 1>
 *      Redeploy.
 *   3. Make sure the products are set to Active and published to the Online
 *      Store sales channel, and that a payment provider is set up in Shopify.
 *
 * Until those are set, the pages show a tasteful "coming soon" state.
 */

const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

export const isShopifyConfigured = Boolean(DOMAIN && TOKEN);
export const shopifyDomain = DOMAIN ?? "";

// Store domain used to build secure checkout links (works without the
// Storefront token). Update if you move checkout to a custom domain.
export const checkoutDomain = DOMAIN || "1-mission-2.myshopify.com";

export interface ShopVariant {
  id: string;
  title: string;
  availableForSale: boolean;
  price: string;
  currency: string;
}
export interface ShopProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  imageUrl: string | null;
  imageAlt: string | null;
  minPrice: string;
  currency: string;
  variants: ShopVariant[];
  hasOptions: boolean;
}
export interface ShopCollection {
  title: string;
  description: string;
  products: ShopProduct[];
}

const QUERY = /* GraphQL */ `
  query CollectionProducts($handle: String!) {
    collection(handle: $handle) {
      title
      description
      products(first: 50) {
        nodes {
          id
          title
          handle
          description
          featuredImage { url altText }
          options { name }
          priceRange { minVariantPrice { amount currencyCode } }
          variants(first: 50) {
            nodes {
              id
              title
              availableForSale
              price { amount currencyCode }
            }
          }
        }
      }
    }
  }
`;

function fmt(amount: string, currency: string) {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
  } catch {
    return `$${amount}`;
  }
}

export async function getShopCollection(handle: string): Promise<ShopCollection | null> {
  if (!isShopifyConfigured) return null;
  try {
    const res = await fetch(`https://${DOMAIN}/api/2024-07/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": TOKEN as string,
      },
      body: JSON.stringify({ query: QUERY, variables: { handle } }),
      next: { revalidate: 300 },
    });
    const json = await res.json();
    const c = json?.data?.collection;
    if (!c) return null;
    const products: ShopProduct[] = (c.products?.nodes ?? []).map((p: any) => {
      const variants: ShopVariant[] = (p.variants?.nodes ?? []).map((v: any) => ({
        id: v.id,
        title: v.title,
        availableForSale: v.availableForSale,
        price: fmt(v.price.amount, v.price.currencyCode),
        currency: v.price.currencyCode,
      }));
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        description: p.description ?? "",
        imageUrl: p.featuredImage?.url ?? null,
        imageAlt: p.featuredImage?.altText ?? p.title,
        minPrice: fmt(p.priceRange.minVariantPrice.amount, p.priceRange.minVariantPrice.currencyCode),
        currency: p.priceRange.minVariantPrice.currencyCode,
        variants,
        hasOptions: (p.options ?? []).length > 1 || variants.length > 1,
      };
    });
    return { title: c.title, description: c.description ?? "", products };
  } catch {
    return null;
  }
}

/** Direct-to-checkout cart permalink for a variant. */
export function checkoutUrl(variantId: string, qty = 1) {
  const numeric = variantId.split("/").pop();
  return `https://${DOMAIN}/cart/${numeric}:${qty}`;
}
