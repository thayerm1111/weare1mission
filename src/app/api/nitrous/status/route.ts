import { getNitrousStatus } from "@/lib/nitrous/server";
import { json, requireUser, unavailable } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await requireUser();
    if ("error" in auth) return auth.error;
    return json(await getNitrousStatus(auth.admin, auth.user.id, auth.active));
  } catch { return unavailable(); }
}
