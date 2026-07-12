/**
 * STATIC SHOPIFY PRODUCTS  —  a snapshot of the products shown on the site.
 * ---------------------------------------------------------------------------
 * Lets The Collection / 1M Experiences show real products WITHOUT a Storefront
 * API token. Checkout still goes to Shopify (secure). `images` holds every
 * photo (front, back, …); the card shows a thumbnail switcher.
 *
 * When you add or change products in Shopify, just ask and this gets refreshed.
 */
import type { ShopCollection } from "@/lib/shopify";

const IMG = "https://cdn.shopify.com/s/files/1/1016/0406/5559/files";
const I = (file: string, v: string) => `${IMG}/${file}.png?v=${v}`;
const V = (id: string, title: string, price: string) => ({
  id, title, availableForSale: true, price, currency: "USD",
});

// image sets (front, back, …)
const TEE_GRAY = [I("6a419caa7fa84857a36e2717d11f77a5", "1783828206"), I("d945183324074a89bf570d49905c708d", "1783828206"), I("8ea10820931e4e0e8827568d14c09a31", "1783828205")];
const TEE_WHITE = [I("fb7ba97c4c4b40a4ab57639eaec2f9a9", "1783826972"), I("d9ae9da4faa04acd8f612b497bafc4c4", "1783826972")];
const TEE_BLACK = [I("e4617dab33ec47bab3387365cfb4e1f3", "1783826613"), I("a128ec1a07094d3d82f282b7fb82a9ef", "1783826612")];
const HOOD_WHITE = [I("464b039a16944e11b9cc513eb8eb2c03", "1783828355"), I("dece42914561460382f9c7ddf4d134f4", "1783828355")];
const HOOD_BLACK = [I("e298ea4c3fac42b99a2486b5e28f81e2", "1783828340"), I("81a55a69c16e40648412e1a55992dda0", "1783828340")];
const HOOD_CHARCOAL = [I("3b425ec1f4d04bfabd52b1eb1b300ace", "1783828340"), I("d01900bff2944a9995885855714bd08d", "1783828340")];

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
        imageUrl: TEE_GRAY[0], imageAlt: "One Mission Tee Gray", images: TEE_GRAY,
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
        imageUrl: TEE_WHITE[0], imageAlt: "One Mission Tee White", images: TEE_WHITE,
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
        imageUrl: TEE_BLACK[0], imageAlt: "One Mission Tee Black", images: TEE_BLACK,
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
        imageUrl: HOOD_WHITE[0], imageAlt: "One Mission Hoodie White", images: HOOD_WHITE,
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
        id: "gid://shopify/Product/10409783132439-black",
        title: "One Mission Heavyweight Hoodie — Black",
        handle: "one-mission-heavyweight-hoodie",
        description: "Heavyweight 460gsm fleece hoodie. Unisex, loose fit, 85% cotton.",
        imageUrl: HOOD_BLACK[0], imageAlt: "One Mission Hoodie Black", images: HOOD_BLACK,
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
        ],
      },
      {
        id: "gid://shopify/Product/10409783132439-charcoal",
        title: "One Mission Heavyweight Hoodie — Charcoal",
        handle: "one-mission-heavyweight-hoodie",
        description: "Heavyweight 460gsm fleece hoodie. Unisex, loose fit, 85% cotton.",
        imageUrl: HOOD_CHARCOAL[0], imageAlt: "One Mission Hoodie Charcoal", images: HOOD_CHARCOAL,
        minPrice: "$100", currency: "USD", hasOptions: true,
        variants: [
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
    products: [
      {
        id: "gid://shopify/Product/10409806725399",
        title: "Miami Retreat — 3 Days / 2 Nights",
        handle: "miami-retreat-3-days-2-nights",
        description: "An exclusive 1M Experience in Miami this September. 3 days, 2 nights.",
        imageUrl: "/images/1M%20experience%20miami.png",
        imageAlt: "1M Miami Retreat",
        images: ["/images/1M%20experience%20miami.png"],
        // Landscape image shown large at the top of the details popup.
        detailImage: "/images/1m%20experience%20big.png",
        minPrice: "$4,999.99", currency: "USD", hasOptions: false,
        when: "September 2026",
        spots: 15,
        soldOut: false,
        longDescription:
          "Three days and two nights in Miami — luxury, connection, and growth with the 1M community. Spots are limited and reserved on a first-come basis.",
        details: [
          "Luxury stay (2 nights)",
          "Private chef for 2 days",
          "A full day on a yacht",
          "A full day of personal development",
          "DJ party",
          "Gift bag",
          "Airport transfers",
        ],
        variants: [
          V("gid://shopify/ProductVariant/53663820480791", "Reserve your spot", "$4,999.99"),
        ],
      },
    ],
  },
};
