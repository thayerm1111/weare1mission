/**
 * STATIC SHOPIFY PRODUCTS  —  a snapshot of the products shown on the site.
 * ---------------------------------------------------------------------------
 * This lets The Collection / 1M Experiences pages show real products WITHOUT
 * needing a Storefront API token. Checkout still goes to Shopify (secure).
 *
 * When you add or change products in Shopify, just ask and this snapshot gets
 * refreshed. (If you later add the Storefront API env vars, the site switches
 * to live product data automatically and this file becomes the fallback.)
 *
 * Store domain used for checkout permalinks:
 */
import type { ShopCollection } from "@/lib/shopify";

const IMG = "https://cdn.shopify.com/s/files/1/1016/0406/5559/files";

export const staticCollections: Record<string, ShopCollection> = {
  "the-collection": {
    title: "The Collection",
    description: "Official 1 Mission apparel and merch.",
    products: [
      {
        id: "gid://shopify/Product/10409780904215",
        title: "Heavyweight One Mission Grey Tee",
        handle: "heavy-weight-one-mission-grey-tee",
        description: "Heavyweight 305gsm 100% cotton tee. Unisex regular fit with the One Mission print.",
        imageUrl: `${IMG}/6a419caa7fa84857a36e2717d11f77a5.png?v=1783827197`,
        imageAlt: "One Mission Grey Tee",
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          { id: "gid://shopify/ProductVariant/53663632523543", title: "Carbon Gray / XS", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663632556311", title: "Carbon Gray / S", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663632589079", title: "Carbon Gray / M", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663632621847", title: "Carbon Gray / L", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663632654615", title: "Carbon Gray / XL", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663632687383", title: "Carbon Gray / XXL", availableForSale: true, price: "$49.99", currency: "USD" },
        ],
      },
      {
        id: "gid://shopify/Product/10409780543767",
        title: "One Mission Heavyweight Tee — White",
        handle: "one-mission-heavyweight-tee-1",
        description: "Heavyweight 300gsm 100% cotton tee. Unisex, soft and durable.",
        imageUrl: `${IMG}/fb7ba97c4c4b40a4ab57639eaec2f9a9.png?v=1783826972`,
        imageAlt: "One Mission Heavyweight Tee White",
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          { id: "gid://shopify/ProductVariant/53663629312279", title: "White / S", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663629345047", title: "White / M", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663629377815", title: "White / L", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663629410583", title: "White / XL", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663629443351", title: "White / 2XL", availableForSale: true, price: "$49.99", currency: "USD" },
        ],
      },
      {
        id: "gid://shopify/Product/10409776873751",
        title: "One Mission Heavyweight Tee — Black",
        handle: "one-mission-heavyweight-tee",
        description: "Heavyweight 300gsm 100% cotton tee. Unisex, soft and durable.",
        imageUrl: `${IMG}/e4617dab33ec47bab3387365cfb4e1f3.png?v=1783826613`,
        imageAlt: "One Mission Heavyweight Tee Black",
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          { id: "gid://shopify/ProductVariant/53663623708951", title: "Black / S", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663623741719", title: "Black / M", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663623774487", title: "Black / L", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663623807255", title: "Black / XL", availableForSale: true, price: "$49.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663623840023", title: "Black / 2XL", availableForSale: true, price: "$49.99", currency: "USD" },
        ],
      },
      {
        id: "gid://shopify/Product/10409781166359",
        title: "Hidden Pocket Fleece Hoodie — Black",
        handle: "heavyweight-hidden-pocket-fleece-hoodie-black",
        description: "Heavyweight 460gsm fleece hoodie with a hidden pocket. Unisex, oversized fit, 85% cotton.",
        imageUrl: `${IMG}/029f2e407b8644c39b9881c0bc148b92.png?v=1783827498`,
        imageAlt: "Fleece Hoodie Black",
        minPrice: "$79.99", currency: "USD", hasOptions: true,
        variants: [
          { id: "gid://shopify/ProductVariant/53663633572119", title: "Black / XS", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633604887", title: "Black / S", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633637655", title: "Black / M", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633670423", title: "Black / L", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633703191", title: "Black / XL", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633735959", title: "Black / 2XL", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633768727", title: "Black / 3XL", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633801495", title: "Black / 4XL", availableForSale: true, price: "$79.99", currency: "USD" },
        ],
      },
      {
        id: "gid://shopify/Product/10409780969751",
        title: "Hidden Pocket Fleece Hoodie — White",
        handle: "heavyweight-hidden-pocket-fleece-hoodie-white",
        description: "Heavyweight 460gsm fleece hoodie with a hidden pocket. Unisex, oversized fit, 85% cotton.",
        imageUrl: `${IMG}/024dd6e2555341749960c5dae2d42b41.png?v=1783827333`,
        imageAlt: "Fleece Hoodie White",
        minPrice: "$79.99", currency: "USD", hasOptions: true,
        variants: [
          { id: "gid://shopify/ProductVariant/53663632916759", title: "White / XS", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663632949527", title: "White / S", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663632982295", title: "White / M", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633015063", title: "White / L", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633047831", title: "White / XL", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633080599", title: "White / 2XL", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633113367", title: "White / 3XL", availableForSale: true, price: "$79.99", currency: "USD" },
          { id: "gid://shopify/ProductVariant/53663633146135", title: "White / 4XL", availableForSale: true, price: "$79.99", currency: "USD" },
        ],
      },
    ],
  },
  // No live experiences yet — this stays empty until event/retreat products
  // are published in Shopify.
  "1m-experiences": {
    title: "1M Experiences",
    description: "Live events, retreats, and gatherings.",
    products: [],
  },
};
