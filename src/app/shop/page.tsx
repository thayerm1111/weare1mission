import { redirect } from "next/navigation";

// The Shop has moved to The Collection (Shopify-powered merch).
export default function ShopRedirect() {
  redirect("/collection");
}
