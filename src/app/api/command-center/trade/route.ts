import { requireConsent } from "../../../../../command-center/engines/consent";
import { createClient } from "@/lib/supabase/server";
import { latestWithBars } from "../../../../../command-center/adapters/db";
import { prepare, execute, reconcile, manage, newIdempotencyKey } from "../../../../../command-center/engines/executor";
import { adopt, setAiManagement, tradeState } from "../../../../../command-center/engines/tradeLive";
import { selectedAccount } from "../../../../../command-center/engines/broker";
import { styleOf } from "../../../../../command-center/core/style";
import { RISK_CHOICES, MAX_RISK_PCT } from "../../../../../command-center/engines/validator";
import { marketOpen } from "../../../../../command-center/core/sessions";
import { takeSetup, passSetup } from "../../../../../command-center/engines/callTrade";
import { getProfile, saveProfile } from "../../../../../command-center/engines/profile";
import { loadRolling } from "../../../../../command-center/adapters/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE TRADING ROUTE.
 *
 * Every path here goes through the deterministic engines: nothing reaches a broker without the validator
 * approving it, and nothing is ever sent twice. ATLAS can propose a trade; only this route, invoked
 * by an authenticated member (or by automation they explicitly enabled), can act on one.
 *
 * `prepare` and `execute` are deliberately separate calls. The preview a member confirms is a real,
 * recorded intent — not a number rendered in a browser and trusted later.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const snapshotNow = async () => (await latestWithBars())?.snapshot ?? null;

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const snap = await snapshotNow();
  const [trade, account, profile] = await Promise.all([
    tradeState(user.id, snap), selectedAccount(user.id), getProfile(user.id),
  ]);
  return json({
    ok: true,
    trade,
    profile,
    marketOpen: marketOpen(Date.now()),
    riskChoices: RISK_CHOICES,
    maxRiskPct: MAX_RISK_PCT,
    account: account ? { id: account.id, isLive: account.is_live, liveAuthorized: !!account.live_authorized_at, equity: account.equity, currency: account.currency } : null,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function POST(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(body.action ?? "");
  const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  /*
   * EVERY ACTION THAT CAN REACH THE BROKER.
   *
   * An allow-list of the harmless ones rather than a block-list of the dangerous ones: a new action
   * added later defaults to REQUIRING consent, which is the safe direction to be wrong in. Reading
   * state, passing on a setup and editing your own risk profile need no signature; everything that
   * can open, change or close a position does.
   */
  const UNGATED = new Set(["prepare", "reconcile", "pass_setup", "profile", "adopt"]);
  if (!UNGATED.has(action)) {
    const gate = await requireConsent(user.id);
    if (!gate.ok) return json({ ok: false, message: gate.reason, needsConsent: true }, 403);
  }

  switch (action) {
    case "prepare": {
      const account = await selectedAccount(user.id);
      const accountRowId = String(body.accountRowId ?? account?.id ?? "");
      if (!accountRowId) return json({ ok: false, reason: "Connect a TradeLocker account first.", hard: true, warnings: [] }, 400);
      const stop = num(body.stop);
      if (stop == null) return json({ ok: false, reason: "A stop is required.", hard: true, warnings: [] }, 400);
      const r = await prepare(user.id, {
        accountRowId,
        side: body.side === "sell" ? "sell" : "buy",
        style: styleOf(String(body.style ?? "")),
        entry: num(body.entry),
        stop,
        takeProfit: num(body.takeProfit),
        riskPct: num(body.riskPct) ?? 0.5,
        origin: body.origin === "brain" ? "brain" : "member",
        snapshot: await snapshotNow(),
        thesis: (body.thesis as Record<string, unknown>) ?? null,
        evidence: Array.isArray(body.evidence) ? (body.evidence as string[]).slice(0, 8).map(String) : [],
      });
      return json(r, r.ok ? 200 : 400);
    }

    /**
     * The only place an order is sent. The idempotency key comes from the client and MUST be the one it
     * was given when the confirmation was rendered — that is what makes a double-click harmless.
     */
    case "execute": {
      const intentId = String(body.intentId ?? "");
      const key = String(body.idempotencyKey ?? "");
      if (!intentId || !key) return json({ ok: false, message: "Missing the intent or its idempotency key." }, 400);
      if (body.confirm !== true) return json({ ok: false, message: "Execution must be confirmed." }, 400);
      const r = await execute(user.id, intentId, key, await snapshotNow());
      return json(r, r.ok ? 200 : 200);      // a refusal is information, not an HTTP failure
    }

    case "reconcile": {
      const r = await reconcile(user.id, String(body.executionId ?? ""));
      return json(r);
    }

    case "close":
      return json(await manage(user.id, String(body.positionId ?? ""), { kind: "close" }, "member"));

    case "partial": {
      const f = num(body.fraction) ?? 0.5;
      return json(await manage(user.id, String(body.positionId ?? ""), { kind: "partial", fraction: f }, "member"));
    }

    case "break_even":
      return json(await manage(user.id, String(body.positionId ?? ""), { kind: "break_even", offsetPips: num(body.offsetPips) ?? 0 }, "member"));

    case "move_stop": {
      const price = num(body.price);
      if (price == null) return json({ ok: false, message: "A price is required." }, 400);
      return json(await manage(user.id, String(body.positionId ?? ""), { kind: "move_stop", price }, "member"));
    }

    case "take_profit":
      return json(await manage(user.id, String(body.positionId ?? ""), { kind: "take_profit", price: num(body.price) }, "member"));

    /** Protect = move the stop to wherever ATLAS currently says it should be, with its reason shown. */
    case "protect": {
      const snap = await snapshotNow();
      const t = await tradeState(user.id, snap);
      if (!t.active || !t.positionId || !t.protection) return json({ ok: false, message: "No open position to protect." }, 400);
      const p = t.protection;
      if (p.action === "close") return json(await manage(user.id, t.positionId, { kind: "close" }, "member"));
      if (p.action === "partial") return json(await manage(user.id, t.positionId, { kind: "partial", fraction: p.fraction ?? 0.5 }, "member"));
      if (p.price == null) return json({ ok: false, message: p.say });
      return json(await manage(user.id, t.positionId, { kind: "move_stop", price: p.price }, "member"));
    }

    /**
     * TAKE THIS TRADE — the primary action of the whole product.
     *
     * The body carries what the member was LOOKING at, not what to execute. The server recomputes THE
     * BRAIN's setup from the current market and refuses if the two have drifted apart, because a card
     * that has been on screen for four minutes is a screenshot, not an instruction.
     */
    case "take_setup": {
      const key = String(body.idempotencyKey ?? "");
      if (!key) return json({ ok: false, message: "Missing the idempotency key that was issued with this trade." }, 400);
      if (body.confirm !== true) return json({ ok: false, message: "This has to be confirmed." }, 400);
      const approved = (body.approved ?? {}) as Record<string, unknown>;
      const stop = num(approved.stop);
      if (stop == null || (approved.side !== "buy" && approved.side !== "sell")) {
        return json({ ok: false, message: "That approval is incomplete — reload the trade and try again." }, 400);
      }
      const rolling = await loadRolling();
      const openThesis = [...rolling.theses].reverse().find((t) => !t.endedAt) ?? null;
      const r = await takeSetup(
        user.id,
        { side: approved.side, style: String(approved.style ?? ""), stop, invalidationPrice: num(approved.invalidationPrice) },
        key,
        await snapshotNow(),
        marketOpen(Date.now()),
        { bias: openThesis?.bias ?? null, confidence: openThesis?.confidence ?? null },
      );
      return json(r);
    }

    /** Passing on a trade is recorded too — it is worth as much to the learning system as a fill. */
    case "pass_setup":
      return json(await passSetup(user.id, await snapshotNow(), marketOpen(Date.now()), String(body.reason ?? "")));

    /** The boundaries ATLAS works inside. Every value is clamped server-side. */
    case "profile": {
      const p = (body.profile ?? {}) as Record<string, unknown>;
      const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
      const current = await getProfile(user.id);
      const saved = await saveProfile(user.id, {
        riskPct: num(p.riskPct) ?? current.riskPct,
        allowQuick: bool(p.allowQuick, current.allowQuick),
        allowHold: bool(p.allowHold, current.allowHold),
        allowSwing: bool(p.allowSwing, current.allowSwing),
        minConfidence: num(p.minConfidence) ?? current.minConfidence,
        allowBreakEven: bool(p.allowBreakEven, current.allowBreakEven),
        allowPartials: bool(p.allowPartials, current.allowPartials),
        allowProfitProtection: bool(p.allowProfitProtection, current.allowProfitProtection),
        allowFullClose: bool(p.allowFullClose, current.allowFullClose),
        autoManagement: bool(p.autoManagement, current.autoManagement),
        autoEntry: bool(p.autoEntry, current.autoEntry),
        maxDailyLossPct: num(p.maxDailyLossPct) ?? current.maxDailyLossPct,
        maxConsecutiveLosses: num(p.maxConsecutiveLosses) ?? current.maxConsecutiveLosses,
        maxOpenRiskPct: num(p.maxOpenRiskPct) ?? current.maxOpenRiskPct,
        newsLockoutMinutes: num(p.newsLockoutMinutes) ?? current.newsLockoutMinutes,
      });
      return json({ ok: true, profile: saved });
    }

    case "adopt":
      return json(await adopt(user.id, String(body.brokerPositionId ?? ""), styleOf(String(body.style ?? ""))));

    case "ai_management": {
      const ok = await setAiManagement(
        user.id, String(body.positionId ?? ""), body.on === true,
        (body.permissions as Record<string, boolean>) ?? undefined,
      );
      return json({ ok });
    }

    default:
      return json({ error: "unknown_action" }, 400);
  }
}
