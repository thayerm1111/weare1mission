import { StrataWorkspace } from "@/components/om/strata/StrataWorkspace";

export const metadata = { title: "STRATA · Price Action Intelligence | One Mission" };
export const dynamic = "force-dynamic";

/** Private One Mission OS tool. Existing portal auth and access rules apply. */
export default function StrataPage() {
  return <StrataWorkspace />;
}
