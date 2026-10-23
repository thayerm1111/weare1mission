import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Cashtrap lives on The Floor as a tab (owner 10-23); this address takes you there. */
export default function CashtrapPage() {
  redirect("/portal/trading?view=cashtrap");
}
