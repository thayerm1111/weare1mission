/**
 * STATIC SHOPIFY PRODUCTS  —  a snapshot of the products shown on the site.
 * ---------------------------------------------------------------------------
 * This lets The Collection / 1M Experiences pages show real products WITHOUT
 * needing a Storefront API token. Checkout still goes to Shopify (secure).
 *
 * When you add or change products in Shopify, just ask and this snapshot gets
 * refreshed. (If you later add the Storefront API env vars, the site switches
 * to live product data automatically and this file becomes the fallback.)
 */
import type { ShopCollection } from "@/lib/shopify";

const IMG = "https://cdn.shopify.com/s/files/1/1016/0406/5559/files";
const V = (id: string, title: string, price: string) => ({
  id, title, availableForSale: true, price, currency: "USD",
});

export const staticCollections: Record<string, ShopCollection> = {
  "the-collection": {
    title: "The Collection",
    description: "Official 1 Mission apparel and merch.",
    products: [
      {
        id: "gid://shopify/Product/10409780904215",
        title: "One Mission Heavyweight Tee — Gray",
        handle: "heavy-weight-one-mission-grey-tee",
        description: "Heavyweight 305gsm 100% cotton tee. Unisex regular fit with the One Mission print.",
        imageUrl: `${IMG}/6a419caa7fa84857a36e2717d11f77a5.png?v=1783828206`,
        imageAlt: "One Mission Tee Gray",
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53663632523543", "Gray / XS", "$49.99"),
          V("gid://shopify/ProductVariant/53663632556311", "Gray / S", "$49.99"),
          V("gid://shopify/ProductVariant/53663632589079", "Gray / M", "$49.99"),
          V("gid://shopify/ProductVariant/53663632621847", "Gray / L", "$49.99"),
          V("gid://shopify/ProductVariant/53663632654615", "Gray / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53663632687383", "Gray / XXL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10409780543767",
        title: "One Mission Heavyweight Tee — White",
        handle: "one-mission-heavyweight-tee-1",
        description: "Heavyweight 300gsm 100% cotton tee. Unisex, soft and durable.",
        imageUrl: `${IMG}/fb7ba97c4c4b40a4ab57639eaec2f9a9.png?v=1783826972`,
        imageAlt: "One Mission Tee White",
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53663629312279", "White / S", "$49.99"),
          V("gid://shopify/ProductVariant/53663629345047", "White / M", "$49.99"),
          V("gid://shopify/ProductVariant/53663629377815", "White / L", "$49.99"),
          V("gid://shopify/ProductVariant/53663629410583", "White / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53663629443351", "White / 2XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10409776873751",
        title: "One Mission Heavyweight Tee — Black",
        handle: "one-mission-heavyweight-tee",
        description: "Heavyweight 300gsm 100% cotton tee. Unisex, soft and durable.",
        imageUrl: `${IMG}/e4617dab33ec47bab3387365cfb4e1f3.png?v=1783826613`,
        imageAlt: "One Mission Tee Black",
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53663623708951", "Black / S", "$49.99"),
          V("gid://shopify/ProductVariant/53663623741719", "Black / M", "$49.99"),
          V("gid://shopify/ProductVariant/53663623774487", "Black / L", "$49.99"),
          V("gid://shopify/ProductVariant/53663623807255", "Black / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53663623840023", "Black / 2XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10409785065751",
        title: "One Mission Heavyweight Hoodie — White",
        handle: "one-mission-heavyweight-hoodie-1",
        description: "Heavyweight 460gsm fleece hoodie. Unisex, loose fit, 85% cotton.",
        imageUrl: `${IMG}/464b039a16944e11b9cc513eb8eb2c03.png?v=1783828355`,
        imageAlt: "One Mission Hoodie White",
        minPrice: "$100", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53663648416023", "White / XS", "$100"),
          V("gid://shopify/ProductVariant/53663648448791", "White / S", "$100"),
          V("gid://shopify/ProductVariant/53663648481559", "White / M", "$100"),
          V("gid://shopify/ProductVariant/53663648514327", "White / L", "$100"),
          V("gid://shopify/ProductVariant/53663648547095", "White / XL", "$100"),
          V("gid://shopify/ProductVariant/53663648579863", "White / 2XL", "$100"),
          V("gid://shopify/ProductVariant/53663648612631", "White / 3XL", "$100"),
          V("gid://shopify/ProductVariant/53663648645399", "White / 4XL", "$100"),
        ],
      },
      {
        id: "gid://shopify/Product/10409783132439",
        title: "One Mission Heavyweight Hoodie — Black",
        handle: "one-mission-heavyweight-hoodie",
        description: "Heavyweight 460gsm fleece hoodie in Black or Charcoal. Unisex, loose fit, 85% cotton.",
        imageUrl: `${IMG}/e298ea4c3fac42b99a2486b5e28f81e2.png?v=1783828340`,
        imageAlt: "One Mission Hoodie Black",
        minPrice: "$100", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53663641829655", "Black / XS", "$100"),
          V("gid://shopify/ProductVariant/53663641862423", "Black / S", "$100"),
          V("gid://shopify/ProductVariant/53663641895191", "Black / M", "$100"),
          V("gid://shopify/ProductVariant/53663641927959", "Black / L", "$100"),
          V("gid://shopify/ProductVariant/53663641960727", "Black / XL", "$100"),
          V("gid://shopify/ProductVariant/53663641993495", "Black / 2XL", "$100"),
          V("gid://shopify/ProductVariant/53663642026263", "Black / 3XL", "$100"),
          V("gid://shopify/ProductVariant/53663642059031", "Black / 4XL", "$100"),
          V("gid://shopify/ProductVariant/53663642091799", "Charcoal / XS", "$100"),
          V("gid://shopify/ProductVariant/53663642124567", "Charcoal / S", "$100"),
          V("gid://shopify/ProductVariant/53663642157335", "Charcoal / M", "$100"),
          V("gid://shopify/ProductVariant/53663642190103", "Charcoal / L", "$100"),
          V("gid://shopify/ProductVariant/53663642222871", "Charcoal / XL", "$100"),
          V("gid://shopify/ProductVariant/53663642255639", "Charcoal / 2XL", "$100"),
          V("gid://shopify/ProductVariant/53663642288407", "Charcoal / 3XL", "$100"),
          V("gid://shopify/ProductVariant/53663642321175", "Charcoal / 4XL", "$100"),
        ],
      },
    ],
  },
  "1m-experiences": {
    title: "1M Experiences",
    description: "Live events, retreats, and gatherings.",
    products: [],
  },
};
