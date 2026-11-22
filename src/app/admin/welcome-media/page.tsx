import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import NarrationExport from "./NarrationExport";

export const dynamic = "force-dynamic";
export default async function WelcomeMediaPage() {
  const db = createClient();
  if (!db) notFound();
  const { data: { user } } = await db.auth.getUser();
  if (!user) notFound();
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (error || profile?.role !== "admin") notFound();
  return <NarrationExport />;
}
