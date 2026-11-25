import type { PreparableAccount } from "../../../../../rapid/exec/prepare";
import { prepareNitrousAccount } from "@/lib/nitrous/prepare";
import { hasFreshWorkerReadiness, readinessBlockers, validateSettingsChange } from "@/lib/nitrous/policy";
import { readinessContext } from "@/lib/nitrous/server";
import { bodyOf, json, requireAccount, requireUser, requireNitrousAddon, unavailable } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if ("error" in auth) return auth.error;
    const body = await bodyOf(req);
    if (!body) return json({ error: "bad_request" }, 400);
    const accountId = String(body.accountId ?? "");
    const owned = await requireAccount(auth.admin, auth.user.id, accountId);
    if ("error" in owned) return owned.error;
    const change = validateSettingsChange(owned.account, body, auth.active);
    if (!change.ok) return json({ error: change.error }, change.status);
    // Pausing and managing an existing position remain possible after an add-on expires.
    if (change.arming || body.mode !== undefined || body.riskPct !== undefined) {
      const access = await requireNitrousAddon(auth.admin, auth.user.id);
      if ("error" in access) return access.error;
    }

    if (change.arming) {
      // The dedicated worker has the same broker connection and polls it continuously.
      // Avoid a second burst of TradeLocker reads from the web host when recent verified
      // evidence already exists. Stale or absent evidence still requires fresh preparation.
      let context = await readinessContext(auth.admin, auth.user.id, { ...owned.account, ...change.patch });
      if (!hasFreshWorkerReadiness(context)) {
        await prepareNitrousAccount(owned.account as PreparableAccount);
        const refreshed = await requireAccount(auth.admin, auth.user.id, accountId);
        if ("error" in refreshed) return refreshed.error;
        context = await readinessContext(auth.admin, auth.user.id, { ...refreshed.account, ...change.patch });
      }
      const blockers = readinessBlockers(context);
      if (blockers.length) return json({ error: "not_ready", blockers }, 409);
    }

    // Ownership, version update, consent, and audit append commit together. The worker rechecks the
    // resulting version immediately before any later submission. No account is armed on connect.
    const result = await auth.admin.rpc("nitrous_apply_settings", {
      p_user: auth.user.id, p_account: accountId,
      p_expected_version: Number(owned.account.automation_version ?? 0), p_patch: change.patch,
    });
    if (result.error) return unavailable();
    const applied = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!applied?.applied) return json({ error: "settings_changed", detail: "The account changed while saving. Refresh before trying again." }, 409);
    return json({ ok: true, accountId, automationEnabled: applied.automation_enabled, version: applied.automation_version });
  } catch { return unavailable(); }
}
