import { createClient } from "@/lib/supabase/server";
import { PortalNotConfigured } from "@/components/portal/PortalNotConfigured";
import { InnerCircleClient } from "@/components/portal/InnerCircleClient";

export const metadata = { title: "The Inner Circle", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function InnerCirclePage() {
  const supabase = createClient();
  if (!supabase) return <PortalNotConfigured />;

  const { data: { user } } = await supabase.auth.getUser();
  let me = { id: "", name: null as string | null, isCreator: false };
  if (user) {
    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, is_creator")
      .eq("id", user.id)
      .single();
    me = {
      id: user.id,
      name: (data?.full_name as string) ?? null,
      isCreator: Boolean(data?.is_creator),
    };
  }

  return <InnerCircleClient me={me} />;
}
