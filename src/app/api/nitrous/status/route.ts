import { getNitrousStatus } from "@/lib/nitrous/server";
import { json, requireUser, unavailable } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    if ("error" in auth) return auth.error;
    const selected = new URL(req.url).searchParams.get("entryCheckAccount");
    return json(await getNitrousStatus(auth.admin, auth.user.id, auth.active, selected ?? undefined));
  } catch { return unavailable(); }
}
