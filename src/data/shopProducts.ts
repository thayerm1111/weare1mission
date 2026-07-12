/**
 * STATIC SHOPIFY PRODUCTS  —  a snapshot of the products shown on the site.
 * ---------------------------------------------------------------------------
 * Lets The Collection / 1M Experiences show real products WITHOUT a Storefront
 * API token. Checkout still goes to Shopify (secure). `images` holds every
 * photo (front, back, …); the card shows a thumbnail switcher.
 *
 * When you add or change products in Shopify, just ask and this gets refreshed.
 */
import type { ShopCollection, ShopProduct } from "@/lib/shopify";

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
        id: "gid://shopify/Product/10410168287511",
        title: "One Mission Statement Hoodie",
        handle: "one-mission-statement-hoodie",
        description: "Our boldest hoodie yet — a heavyweight statement piece in six colors: Dark Green, Mild Apricot, Lake Blue, Royal Blue, Light Gray, and Black.",
        imageUrl: I("2128897d801b418b955435b13a588528", "1783882713"), imageAlt: "One Mission Statement Hoodie",
        images: [I("2128897d801b418b955435b13a588528", "1783882713"), I("b33898df1248414cad49616278c14a02", "1783882713"), I("b7d8740a95e6452fa10a926f52aed80f", "1783882713"), I("5a969afbcedc4459a0231a48451b197a", "1783882713"), I("ba844c2c993a4650b666ad4fb5a3496d", "1783882713"), I("366b2fdb17934ba39978734f2acf7dec", "1783882713"), I("a0f354975e8a45f1b5a3a87efbb8016e", "1783882713"), I("d5da18a2481d493fb5edff8bc513db0a", "1783882713"), I("0685e5493af843439950bc8bf0a74fcf", "1783882713"), I("1e41a2814156463c9a10e0b5c088661d", "1783882713"), I("8adde8d2926b49d596b63657527e2f19", "1783882713"), I("be7f8446edde44da91a5139da4ffa175", "1783882713")],
        minPrice: "$125", currency: "USD", hasOptions: true,
        badge: "🔥 Hottest Item",
        colorImages: {
          "Dark Green": I("ba844c2c993a4650b666ad4fb5a3496d", "1783882713"),
          "Mild Apricot": I("8adde8d2926b49d596b63657527e2f19", "1783882713"),
          "Lake Blue": I("a0f354975e8a45f1b5a3a87efbb8016e", "1783882713"),
          "Royal Blue": I("b7d8740a95e6452fa10a926f52aed80f", "1783882713"),
          "Light Gray": I("0685e5493af843439950bc8bf0a74fcf", "1783882713"),
          "Black": I("2128897d801b418b955435b13a588528", "1783882713"),
        },
        variants: [
          V("gid://shopify/ProductVariant/53664876069143", "Dark Green / S", "$125"),
          V("gid://shopify/ProductVariant/53664876101911", "Dark Green / M", "$125"),
          V("gid://shopify/ProductVariant/53664876134679", "Dark Green / L", "$125"),
          V("gid://shopify/ProductVariant/53664876167447", "Dark Green / XL", "$125"),
          V("gid://shopify/ProductVariant/53664876200215", "Dark Green / 2XL", "$125"),
          V("gid://shopify/ProductVariant/53664876232983", "Mild Apricot / S", "$125"),
          V("gid://shopify/ProductVariant/53664876265751", "Mild Apricot / M", "$125"),
          V("gid://shopify/ProductVariant/53664876298519", "Mild Apricot / L", "$125"),
          V("gid://shopify/ProductVariant/53664876331287", "Mild Apricot / XL", "$125"),
          V("gid://shopify/ProductVariant/53664876364055", "Mild Apricot / 2XL", "$125"),
          V("gid://shopify/ProductVariant/53664876396823", "Lake Blue / S", "$125"),
          V("gid://shopify/ProductVariant/53664876429591", "Lake Blue / M", "$125"),
          V("gid://shopify/ProductVariant/53664876462359", "Lake Blue / L", "$125"),
          V("gid://shopify/ProductVariant/53664876495127", "Lake Blue / XL", "$125"),
          V("gid://shopify/ProductVariant/53664876527895", "Lake Blue / 2XL", "$125"),
          V("gid://shopify/ProductVariant/53664876560663", "Royal Blue / S", "$125"),
          V("gid://shopify/ProductVariant/53664876593431", "Royal Blue / M", "$125"),
          V("gid://shopify/ProductVariant/53664876626199", "Royal Blue / L", "$125"),
          V("gid://shopify/ProductVariant/53664876658967", "Royal Blue / XL", "$125"),
          V("gid://shopify/ProductVariant/53664876691735", "Royal Blue / 2XL", "$125"),
          V("gid://shopify/ProductVariant/53664876724503", "Light Gray / S", "$125"),
          V("gid://shopify/ProductVariant/53664876757271", "Light Gray / M", "$125"),
          V("gid://shopify/ProductVariant/53664876790039", "Light Gray / L", "$125"),
          V("gid://shopify/ProductVariant/53664876822807", "Light Gray / XL", "$125"),
          V("gid://shopify/ProductVariant/53664876855575", "Light Gray / 2XL", "$125"),
          V("gid://shopify/ProductVariant/53664876888343", "Black / S", "$125"),
          V("gid://shopify/ProductVariant/53664876921111", "Black / M", "$125"),
          V("gid://shopify/ProductVariant/53664876953879", "Black / L", "$125"),
          V("gid://shopify/ProductVariant/53664876986647", "Black / XL", "$125"),
          V("gid://shopify/ProductVariant/53664877019415", "Black / 2XL", "$125"),
        ],
      },
      {
        id: "gid://shopify/Product/10410152689943",
        title: "OM x One Mission — Black",
        handle: "om-x-one-mission",
        description: "OM x One Mission collaboration piece in Black.",
        imageUrl: I("a06753c0c0434740971495a4a13f52ed", "1783880628"), imageAlt: "OM x One Mission Black",
        images: [I("a06753c0c0434740971495a4a13f52ed", "1783880628"), I("bf6083f56628472bb2b4ac88501b7260", "1783880628")],
        minPrice: "$125", currency: "USD", hasOptions: true,
        badge: "🔥 Hottest Item",
        variants: [
          V("gid://shopify/ProductVariant/53664767639831", "Black / S", "$125"),
          V("gid://shopify/ProductVariant/53664767672599", "Black / M", "$125"),
          V("gid://shopify/ProductVariant/53664767705367", "Black / L", "$125"),
          V("gid://shopify/ProductVariant/53664767738135", "Black / XL", "$125"),
          V("gid://shopify/ProductVariant/53664767770903", "Black / 2XL", "$125"),
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
      {
        id: "gid://shopify/Product/10410153083159",
        title: "OM Heavyweight Hoodie — Black",
        handle: "om-hoodie",
        description: "Premium heavyweight OM hoodie in Black Beauty.",
        imageUrl: I("de097b0879004619bffa107cb62305fa", "1783880822"), imageAlt: "OM Hoodie Black",
        images: [I("de097b0879004619bffa107cb62305fa", "1783880822"), I("616fe1fbf05445bab5514271a2c2a0f2", "1783880823")],
        minPrice: "$125", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664768819479", "Black / S", "$125"),
          V("gid://shopify/ProductVariant/53664768852247", "Black / M", "$125"),
          V("gid://shopify/ProductVariant/53664768885015", "Black / L", "$125"),
          V("gid://shopify/ProductVariant/53664768917783", "Black / XL", "$125"),
          V("gid://shopify/ProductVariant/53664768950551", "Black / 2XL", "$125"),
          V("gid://shopify/ProductVariant/53664768983319", "Black / 3XL", "$125"),
        ],
      },
      {
        id: "gid://shopify/Product/10410150035735",
        title: "One Mission Heavyweight Crewneck Sweatshirt",
        handle: "one-mission-heavyweight-crewneck-sweatshirt",
        description: "Heavyweight crewneck sweatshirt in Dark Blue, Black, Dark Gray, and Coffee.",
        imageUrl: I("649262c686604ca3a7bbbe62993c1108", "1783879713"), imageAlt: "One Mission Crewneck Sweatshirt",
        images: [I("649262c686604ca3a7bbbe62993c1108", "1783879713"), I("f473fbdc5ae64fbc84ce0650aecaa9be", "1783879713"), I("7e750ad3c43a4da0bf340cea1ecbc958", "1783879713"), I("7b5b8c07f0bf4d799d030e5b98872158", "1783879713"), I("ca411e78dd2648bea84d15b2c01c475b", "1783879713"), I("8a6083a2f78143679b3eadeaf7fd6745", "1783879713"), I("0e065bc5b58142ceb35ca95a393f7f29", "1783879713"), I("5473d671397e458da57b43e425294d2a", "1783879713")],
        colorImages: {
          "Dark Blue": I("0e065bc5b58142ceb35ca95a393f7f29", "1783879713"),
          "Black": I("649262c686604ca3a7bbbe62993c1108", "1783879713"),
          "Dark Gray": I("ca411e78dd2648bea84d15b2c01c475b", "1783879713"),
          "Coffee": I("7e750ad3c43a4da0bf340cea1ecbc958", "1783879713"),
        },
        minPrice: "$80.06", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664758169879", "Dark Blue / XS", "$80.06"),
          V("gid://shopify/ProductVariant/53664758202647", "Dark Blue / S", "$80.06"),
          V("gid://shopify/ProductVariant/53664758235415", "Dark Blue / M", "$80.06"),
          V("gid://shopify/ProductVariant/53664758268183", "Dark Blue / L", "$80.06"),
          V("gid://shopify/ProductVariant/53664758300951", "Dark Blue / XL", "$80.06"),
          V("gid://shopify/ProductVariant/53664758333719", "Dark Blue / 2XL", "$80.06"),
          V("gid://shopify/ProductVariant/53664758366487", "Black / XS", "$80.06"),
          V("gid://shopify/ProductVariant/53664758399255", "Black / S", "$80.06"),
          V("gid://shopify/ProductVariant/53664758432023", "Black / M", "$80.06"),
          V("gid://shopify/ProductVariant/53664758464791", "Black / L", "$80.06"),
          V("gid://shopify/ProductVariant/53664758497559", "Black / XL", "$80.06"),
          V("gid://shopify/ProductVariant/53664758530327", "Black / 2XL", "$80.06"),
          V("gid://shopify/ProductVariant/53664758563095", "Dark Gray / XS", "$80.06"),
          V("gid://shopify/ProductVariant/53664758595863", "Dark Gray / S", "$80.06"),
          V("gid://shopify/ProductVariant/53664758628631", "Dark Gray / M", "$80.06"),
          V("gid://shopify/ProductVariant/53664758661399", "Dark Gray / L", "$80.06"),
          V("gid://shopify/ProductVariant/53664758694167", "Dark Gray / XL", "$80.06"),
          V("gid://shopify/ProductVariant/53664758726935", "Dark Gray / 2XL", "$80.06"),
          V("gid://shopify/ProductVariant/53664758759703", "Coffee / XS", "$80.06"),
          V("gid://shopify/ProductVariant/53664758792471", "Coffee / S", "$80.06"),
          V("gid://shopify/ProductVariant/53664758825239", "Coffee / M", "$80.06"),
          V("gid://shopify/ProductVariant/53664758858007", "Coffee / L", "$80.06"),
          V("gid://shopify/ProductVariant/53664758890775", "Coffee / XL", "$80.06"),
          V("gid://shopify/ProductVariant/53664758923543", "Coffee / 2XL", "$80.06"),
        ],
      },
      {
        id: "gid://shopify/Product/10410155737367",
        title: "One Mission Sweatpants",
        handle: "one-mission-sweats",
        description: "Heavyweight sweatpants in Black and Dark Gray. The perfect match for your hoodie.",
        imageUrl: I("0da5ec9b86f2486caf34e0b5054d0ce0", "1783881933"), imageAlt: "One Mission Sweatpants",
        images: [I("0da5ec9b86f2486caf34e0b5054d0ce0", "1783881933"), I("557d2cba2a404fd388614d382cdd50d7", "1783881932"), I("bccd0fbe6fb7400191d2ca412cc53094", "1783881932"), I("8c8351a084424fd9a541b1e206a067aa", "1783881933")],
        colorImages: {
          "Black": I("bccd0fbe6fb7400191d2ca412cc53094", "1783881932"),
          "Dark Gray": I("0da5ec9b86f2486caf34e0b5054d0ce0", "1783881933"),
        },
        minPrice: "$99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664778420503", "Black / S", "$99"),
          V("gid://shopify/ProductVariant/53664778453271", "Black / M", "$99"),
          V("gid://shopify/ProductVariant/53664778486039", "Black / L", "$99"),
          V("gid://shopify/ProductVariant/53664778518807", "Black / XL", "$99"),
          V("gid://shopify/ProductVariant/53664778551575", "Black / 2XL", "$99"),
          V("gid://shopify/ProductVariant/53664778584343", "Dark Gray / S", "$99"),
          V("gid://shopify/ProductVariant/53664778617111", "Dark Gray / M", "$99"),
          V("gid://shopify/ProductVariant/53664778649879", "Dark Gray / L", "$99"),
          V("gid://shopify/ProductVariant/53664778682647", "Dark Gray / XL", "$99"),
          V("gid://shopify/ProductVariant/53664778715415", "Dark Gray / 2XL", "$99"),
        ],
      },
      {
        id: "gid://shopify/Product/10410155868439",
        title: "One Mission Sweat Shorts",
        handle: "one-mission-workout-short",
        description: "Athletic sweat shorts in Royal Blue and Black. Pairs with any hoodie.",
        imageUrl: I("1d94c0bf1f084291b9e69e054c7c97ed", "1783882007"), imageAlt: "One Mission Sweat Shorts",
        images: [I("1d94c0bf1f084291b9e69e054c7c97ed", "1783882007"), I("33dc2130855248f9a7ee20b2786f0528", "1783882008"), I("3f8d63b236ae47f99a16955e322f2036", "1783882008"), I("09a562d320f84ae19a8c54f62f0419e5", "1783882008")],
        colorImages: {
          "Royal Blue": I("3f8d63b236ae47f99a16955e322f2036", "1783882008"),
          "Black": I("1d94c0bf1f084291b9e69e054c7c97ed", "1783882007"),
        },
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664779043095", "Royal Blue / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664779075863", "Royal Blue / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664779108631", "Royal Blue / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664779141399", "Royal Blue / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664779174167", "Royal Blue / 2XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664779206935", "Black / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664779239703", "Black / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664779272471", "Black / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664779305239", "Black / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664779338007", "Black / 2XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10410155442455",
        title: "One Mission Lounge Pants",
        handle: "one-mission-lounge",
        description: "Relaxed lounge pants in six colors: Brown, Navy, Gray Green, Sand, Black, and Carbon Gray.",
        imageUrl: I("499d15ba1ede4a6783e0115d2a3d8a4d", "1783881768"), imageAlt: "One Mission Lounge Pants",
        images: [I("499d15ba1ede4a6783e0115d2a3d8a4d", "1783881768"), I("c8554ab8b9174994aaf737b08ce452ec", "1783881768"), I("402ed1785eb7408391e81f24feb4b582", "1783881768"), I("952e55c347514a569161862889aa9386", "1783881768"), I("49efd00dd9ca49e5a6d96034768a5405", "1783881768"), I("796bdb1d38aa476dbd4cd2871de88ef0", "1783881768"), I("5223c9c8802d425f8f2a9466bd5afeb5", "1783881768"), I("03a6ba92e4384b99864c0d6f51dab553", "1783881768"), I("c52ee30e5bdb4a5f9ae20ba3711f2a46", "1783881768"), I("197908a4d6e74ddcbec74fe74d52ce46", "1783881768")],
        colorImages: {
          "Brown": I("d535c76a6d434faeb80dc1836328b7c1", "1783881768"),
          "Navy": I("5223c9c8802d425f8f2a9466bd5afeb5", "1783881768"),
          "Gray Green": I("49efd00dd9ca49e5a6d96034768a5405", "1783881768"),
          "Sand": I("402ed1785eb7408391e81f24feb4b582", "1783881768"),
          "Black": I("499d15ba1ede4a6783e0115d2a3d8a4d", "1783881768"),
          "Carbon Gray": I("c52ee30e5bdb4a5f9ae20ba3711f2a46", "1783881768"),
        },
        minPrice: "$89", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664776618263", "Brown / XS", "$89"),
          V("gid://shopify/ProductVariant/53664776651031", "Brown / S", "$89"),
          V("gid://shopify/ProductVariant/53664776683799", "Brown / M", "$89"),
          V("gid://shopify/ProductVariant/53664776716567", "Brown / L", "$89"),
          V("gid://shopify/ProductVariant/53664776749335", "Brown / XL", "$89"),
          V("gid://shopify/ProductVariant/53664776782103", "Brown / 2XL", "$89"),
          V("gid://shopify/ProductVariant/53664776814871", "Navy / XS", "$89"),
          V("gid://shopify/ProductVariant/53664776847639", "Navy / S", "$89"),
          V("gid://shopify/ProductVariant/53664776880407", "Navy / M", "$89"),
          V("gid://shopify/ProductVariant/53664776913175", "Navy / L", "$89"),
          V("gid://shopify/ProductVariant/53664776945943", "Navy / XL", "$89"),
          V("gid://shopify/ProductVariant/53664776978711", "Navy / 2XL", "$89"),
          V("gid://shopify/ProductVariant/53664777011479", "Gray Green / XS", "$89"),
          V("gid://shopify/ProductVariant/53664777044247", "Gray Green / S", "$89"),
          V("gid://shopify/ProductVariant/53664777077015", "Gray Green / M", "$89"),
          V("gid://shopify/ProductVariant/53664777109783", "Gray Green / L", "$89"),
          V("gid://shopify/ProductVariant/53664777142551", "Gray Green / XL", "$89"),
          V("gid://shopify/ProductVariant/53664777175319", "Gray Green / 2XL", "$89"),
          V("gid://shopify/ProductVariant/53664777208087", "Sand / XS", "$89"),
          V("gid://shopify/ProductVariant/53664777240855", "Sand / S", "$89"),
          V("gid://shopify/ProductVariant/53664777273623", "Sand / M", "$89"),
          V("gid://shopify/ProductVariant/53664777306391", "Sand / L", "$89"),
          V("gid://shopify/ProductVariant/53664777339159", "Sand / XL", "$89"),
          V("gid://shopify/ProductVariant/53664777371927", "Sand / 2XL", "$89"),
          V("gid://shopify/ProductVariant/53664777404695", "Black / XS", "$89"),
          V("gid://shopify/ProductVariant/53664777437463", "Black / S", "$89"),
          V("gid://shopify/ProductVariant/53664777470231", "Black / M", "$89"),
          V("gid://shopify/ProductVariant/53664777502999", "Black / L", "$89"),
          V("gid://shopify/ProductVariant/53664777535767", "Black / XL", "$89"),
          V("gid://shopify/ProductVariant/53664777568535", "Black / 2XL", "$89"),
          V("gid://shopify/ProductVariant/53664777601303", "Carbon Gray / XS", "$89"),
          V("gid://shopify/ProductVariant/53664777634071", "Carbon Gray / S", "$89"),
          V("gid://shopify/ProductVariant/53664777666839", "Carbon Gray / M", "$89"),
          V("gid://shopify/ProductVariant/53664777699607", "Carbon Gray / L", "$89"),
          V("gid://shopify/ProductVariant/53664777732375", "Carbon Gray / XL", "$89"),
          V("gid://shopify/ProductVariant/53664777765143", "Carbon Gray / 2XL", "$89"),
        ],
      },
      {
        id: "gid://shopify/Product/10410154852631",
        title: "One Mission Lounge Shorts",
        handle: "one-mission-lounge-short",
        description: "Relaxed lounge shorts in Black.",
        imageUrl: I("8c00e76b482b4044b1c13b7923827aa5", "1783881573"), imageAlt: "One Mission Lounge Shorts",
        images: [I("8c00e76b482b4044b1c13b7923827aa5", "1783881573"), I("20b669ac9fbc4111b6a7663ae7f7b40e", "1783881573")],
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664773865751", "Black / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664773898519", "Black / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664773931287", "Black / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664773964055", "Black / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664773996823", "Black / 2XL", "$49.99"),
        ],
      },
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
        id: "gid://shopify/Product/10410149249303",
        title: "One Mission Long-Sleeve Tee",
        handle: "one-mission-long-sleeve-t-shirt-1",
        description: "Long-sleeve tee in Navy Blue, Coffee, and Dark Gray.",
        imageUrl: I("cc82e923070b47c88dda45bdcbd426f5", "1783879412"), imageAlt: "One Mission Long-Sleeve Tee",
        images: [I("cc82e923070b47c88dda45bdcbd426f5", "1783879412"), I("d89e723370a34ee38748484483f64a5b", "1783879413"), I("3b7063793a464ff3b2fa28bc5fc8c799", "1783879413"), I("9f9aaf42be254454a473b8fe096feca7", "1783879413"), I("6e6102e3b5fa40fbb07d71e297afcd90", "1783879413"), I("dd720e12890649908a15f14780895ca5", "1783879413")],
        colorImages: {
          "Navy Blue": I("6e6102e3b5fa40fbb07d71e297afcd90", "1783879413"),
          "Coffee": I("3b7063793a464ff3b2fa28bc5fc8c799", "1783879413"),
          "Dark Gray": I("cc82e923070b47c88dda45bdcbd426f5", "1783879412"),
        },
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664750502167", "Navy Blue / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664750534935", "Navy Blue / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664750567703", "Navy Blue / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664750600471", "Navy Blue / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664750633239", "Navy Blue / 2XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664750666007", "Coffee / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664750698775", "Coffee / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664750731543", "Coffee / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664750764311", "Coffee / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664750797079", "Coffee / 2XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664750829847", "Dark Gray / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664750862615", "Dark Gray / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664750895383", "Dark Gray / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664750928151", "Dark Gray / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664750960919", "Dark Gray / 2XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10410148954391",
        title: "One Mission Long-Sleeve Tee — Black",
        handle: "one-mission-long-sleeve-t-shirt",
        description: "Long-sleeve tee in Black.",
        imageUrl: I("428f4684d0354418a9b5529e13e93461", "1783879293"), imageAlt: "One Mission Long-Sleeve Tee Black",
        images: [I("428f4684d0354418a9b5529e13e93461", "1783879293"), I("8067e2325e134b3098428baff1a9194a", "1783879293")],
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664749715735", "Black / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664749748503", "Black / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664749781271", "Black / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664749814039", "Black / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664749846807", "Black / 2XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10410150330647",
        title: "One Mission Tank Top — White",
        handle: "one-mission-tank-top-1",
        description: "Lightweight tank top in White.",
        imageUrl: I("34323b8425c94294ae580b4bdc158d5d", "1783879817"), imageAlt: "One Mission Tank Top White",
        images: [I("34323b8425c94294ae580b4bdc158d5d", "1783879817"), I("806aec4bdabe4c97a626cb2d07bec42f", "1783879818")],
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664759644439", "White / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664759677207", "White / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664759709975", "White / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664759742743", "White / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664759775511", "White / 2XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10410150199575",
        title: "One Mission Tank Top — Black",
        handle: "one-mission-tank-top",
        description: "Lightweight tank top in Black.",
        imageUrl: I("637bfc738b044a538be5d2261bfd1cfc", "1783879773"), imageAlt: "One Mission Tank Top Black",
        images: [I("637bfc738b044a538be5d2261bfd1cfc", "1783879773"), I("ff9542f89a6d452090e640f0cea484eb", "1783879772")],
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664759185687", "Black / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664759218455", "Black / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664759251223", "Black / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664759283991", "Black / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664759316759", "Black / 2XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10410184114455",
        title: "Women's High-Waisted Biker Shorts",
        handle: "one-mission-women-s-high-waisted-biker-shorts",
        description: "Women's high-waisted biker shorts in Purple, Black, Dark Gray, and Gray Blue.",
        imageUrl: I("b968bbe932554cd6b4e7af65961740bb", "1783885338"), imageAlt: "Women's Biker Shorts",
        images: [I("b968bbe932554cd6b4e7af65961740bb", "1783885338"), I("304563efdd3b4c9ba95c25e5371759da", "1783885337"), I("df1c89274e0d4a809795156787eb6497", "1783885337"), I("b1bdb2b78c5846f181778b3d3a574494", "1783885337"), I("abec110615fd4f46bdb3b78fd96d4d14", "1783885338"), I("591f8045beed44fa909088a60b8cecd2", "1783885337"), I("2255430bf6464b68b335986e26696105", "1783885337"), I("917edfdcd1e647208acc35f01f5d52f0", "1783885337")],
        colorImages: {
          "Purple": I("b968bbe932554cd6b4e7af65961740bb", "1783885338"),
          "Black": I("304563efdd3b4c9ba95c25e5371759da", "1783885337"),
          "Dark Gray": I("df1c89274e0d4a809795156787eb6497", "1783885337"),
          "Gray Blue": I("b1bdb2b78c5846f181778b3d3a574494", "1783885337"),
        },
        minPrice: "$49.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664915423511", "Purple / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664915456279", "Purple / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664915489047", "Purple / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664915521815", "Purple / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664915554583", "Black / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664915587351", "Black / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664915620119", "Black / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664915652887", "Black / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664915685655", "Dark Gray / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664915718423", "Dark Gray / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664915751191", "Dark Gray / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664915783959", "Dark Gray / XL", "$49.99"),
          V("gid://shopify/ProductVariant/53664915816727", "Gray Blue / S", "$49.99"),
          V("gid://shopify/ProductVariant/53664915849495", "Gray Blue / M", "$49.99"),
          V("gid://shopify/ProductVariant/53664915882263", "Gray Blue / L", "$49.99"),
          V("gid://shopify/ProductVariant/53664915915031", "Gray Blue / XL", "$49.99"),
        ],
      },
      {
        id: "gid://shopify/Product/10410180837655",
        title: "Women's Crop Tank Top",
        handle: "one-mission-women-s-tight-crewneck-crop-tank-top",
        description: "Women's tight crewneck crop tank top in Black.",
        imageUrl: I("9911ca517b0f4be78f63e78ca68bc2a4", "1783884303"), imageAlt: "Women's Crop Tank Top",
        images: [I("9911ca517b0f4be78f63e78ca68bc2a4", "1783884303"), I("1bcf8e00f3014cf7ba76a06748e400ec", "1783884303")],
        minPrice: "$29.99", currency: "USD", hasOptions: true,
        variants: [
          V("gid://shopify/ProductVariant/53664905363735", "Black / S", "$29.99"),
          V("gid://shopify/ProductVariant/53664905396503", "Black / M", "$29.99"),
          V("gid://shopify/ProductVariant/53664905429271", "Black / L", "$29.99"),
          V("gid://shopify/ProductVariant/53664905462039", "Black / XL", "$29.99"),
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

// Pair each hoodie / sweatshirt with the matching sweatpants + sweat shorts,
// shown as a "Complete the set" option on the product page.
const SET_PAIR_IDS = [
  "gid://shopify/Product/10410155737367", // One Mission Sweatpants
  "gid://shopify/Product/10410155868439", // One Mission Sweat Shorts
];
for (const p of staticCollections["the-collection"].products) {
  if (/hoodie|sweatshirt/i.test(p.title)) p.pairsWith = SET_PAIR_IDS;
}

/** Short, URL-safe id used in product page routes: /product/{pid}. */
export function productPid(id: string): string {
  return id.split("/").pop() as string;
}

/** Every product across all collections, tagged with its collection handle. */
export function allProducts(): (ShopProduct & { collectionHandle: string })[] {
  return Object.entries(staticCollections).flatMap(([handle, c]) =>
    c.products.map((p) => ({ ...p, collectionHandle: handle }))
  );
}

/** Find a product by its short pid (from productPid). */
export function getProductByPid(pid: string): (ShopProduct & { collectionHandle: string }) | null {
  return allProducts().find((p) => productPid(p.id) === pid) ?? null;
}

/** Resolve a product's paired items to full product objects. */
export function pairedProducts(product: ShopProduct): ShopProduct[] {
  if (!product.pairsWith?.length) return [];
  const all = allProducts();
  return product.pairsWith
    .map((id) => all.find((p) => p.id === id))
    .filter((p): p is ShopProduct & { collectionHandle: string } => Boolean(p));
}
