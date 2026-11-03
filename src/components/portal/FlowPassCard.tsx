"use client";

/**
 * THE FLOW PASS — $99/mo: unlimited GENX, GEN FX, OM AI Plays and FLOW (owner 09-23, widened 11-02).
 *
 * This is the hero offer on the Credits page and the plan card on the Account page. It leads with the
 * arithmetic (a pack lasts about a week of FLOW) and says plainly what the Pass covers and what still
 * costs credits — ATLAS and the other tools — so nobody buys it expecting something it does not do.
 *
 * MANAGING IT (owner 11-02: "add a cancel button or a pause button for customers. Also add the date they
 * will get charged"). A member with a Pass always sees, in one line, what happens next: the date and amount
 * of the next charge, or the date it ends, or that billing is paused. Three actions, each confirmed in place
 * before anything is sent:
 *   - Cancel: runs to the end of the paid month, never renews. "Keep my Pass" undoes it.
 *   - Pause: runs to the end of the paid month, then no charges and no Pass until they resume.
 *   - Resume: inside the paid month billing simply carries on; after it, a new month starts now.
 * States: OFFER (no Pass), ACTIVE, ENDING (cancelled), PAUSED (still paid / paid month over),
 * PAYMENT ISSUE (Stripe could not take the renewal), UPGRADE (legacy $39 Suite member).
 */
import { useCallback, useEffect, useState } from "react";
import { Infinity as InfinityIcon, Check, Loader2, AlertTriangle, ArrowUpRight, CalendarClock, PauseCircle, PlayCircle } from "lucide-react";

type PassView = {
  active: boolean;
  price: number;
  credits: number;
  label: string;
  canUpgrade: boolean;
  mine?: boolean;
};
type SubResp = {
  ok?: boolean;
  pass?: PassView;
  plan?: string | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
  paused?: boolean;
  paidThrough?: string | null;
  nextChargeAt?: string | null;
  nextChargeAmount?: number | null;
  endsAt?: string | null;
  paymentIssue?: boolean;
};
type Confirm = null | "cancel" | "pause";

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** What the Pass includes — the same list on the offer and on an active Pass, so members always know. */
export function PassBenefits({ credits }: { credits: number }) {
  return (
    <ul className="mt-4 space-y-1.5 text-sm text-white/85">
      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> <span><b>Unlimited GENX and GEN FX</b> — every read, every setup, no credits</span></li>
      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> <span><b>Unlimited OM AI Plays</b> — generate plays and open their full breakdown, no credits</span></li>
      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> <span><b>FLOW runs all month</b> — every trade on every account you connect, never paused for credits</span></li>
      <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> <span><b>{credits} credits a month</b> for everything else — ATLAS, OM AI chat, Market Pulse, MFXGHOST and the other tools still use credits</span></li>
    </ul>
  );
}

export function FlowPassCard() {
  const [sub, setSub] = useState<SubResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/subscription", { cache: "no-store" });
      const d = (await r.json()) as SubResp;
      if (d?.ok) setSub(d);
    } catch { /* offline — the card just stays quiet */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/subscription", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "subscribe_pass" }),
      });
      const d = await r.json();
      if (d?.url) { window.location.href = d.url as string; return; }
      if (d?.error === "stripe_not_configured") setMsg("Payments aren't switched on yet — check back soon.");
      else if (d?.error === "already_active") { setMsg("Your Pass is already running."); await load(); }
      else setMsg("Couldn't start checkout — try again shortly.");
    } catch { setMsg("Couldn't start checkout — try again shortly."); }
    setBusy(false);
  }

  async function act(action: "cancel" | "resume" | "pause" | "unpause") {
    setBusy(true); setMsg(""); setConfirm(null);
    try {
      const r = await fetch("/api/subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const d = await r.json().catch(() => ({}));
      if (d?.error === "card_declined") setMsg(String(d.detail || "Your card was declined — nothing was changed."));
      else if (d?.error) setMsg("Couldn't update your Pass just now — please try again.");
      await load();
    } catch { setMsg("Network error — please try again."); }
    setBusy(false);
  }

  const pass = sub?.pass;
  if (!pass) return null;
  const price = pass.price;
  const credits = pass.credits;
  const mine = !!pass.mine;
  const paused = mine && !!sub?.paused;
  const stillPaid = paused && pass.active;          // paused, inside the month they paid for
  const ending = mine && pass.active && !paused && !!sub?.cancelAtPeriodEnd;
  const running = pass.active && !paused && !ending;
  const issue = mine && !pass.active && !!sub?.paymentIssue;

  const badge = running ? { text: "Active", cls: "bg-emerald-500/20 text-emerald-300" }
    : ending ? { text: "Ends " + fmt(sub?.endsAt ?? sub?.currentPeriodEnd), cls: "bg-amber-400/15 text-amber-200" }
    : paused ? { text: "Paused", cls: "bg-sky-400/15 text-sky-200" }
    : issue ? { text: "Payment issue", cls: "bg-red-500/20 text-red-200" }
    : { text: `$${price}/mo`, cls: "bg-amber-400/15 text-amber-200" };

  const btnGhost = "inline-flex items-center gap-2 rounded-xl border border-white/25 px-4 py-2 text-sm font-semibold text-white/85 hover:bg-white/10 disabled:opacity-60";
  const btnSolid = "inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-[#20160a] disabled:opacity-60";

  return (
    <section className="rounded-2xl border border-[#E4DCCB] bg-gradient-to-br from-navy to-[#12294b] p-6 text-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <InfinityIcon className="h-4 w-4 text-amber-300" aria-hidden="true" /> {pass.label}
        </h2>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${badge.cls}`}>{badge.text}</span>
      </div>

      {(pass.active || paused) ? (
        <div className="mt-1">
          {/* What happens next — always one clear line. */}
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            {running ? (
              <span>Next charge: <b>${sub?.nextChargeAmount ?? price}</b> on <b>{fmt(sub?.nextChargeAt ?? sub?.currentPeriodEnd)}</b>. Cancel or pause any time before then.</span>
            ) : ending ? (
              <span>Your Pass ends on <b>{fmt(sub?.endsAt ?? sub?.currentPeriodEnd)}</b> — you won&apos;t be charged again. Everything keeps working until then.</span>
            ) : stillPaid ? (
              <span>Billing is paused. Your Pass keeps working until <b>{fmt(sub?.paidThrough ?? sub?.endsAt)}</b>; after that there are no charges and no Pass until you resume.</span>
            ) : (
              <span>Your Pass is paused — no charges. Resume to start a new month today (${price}).</span>
            )}
          </div>

          <PassBenefits credits={credits} />

          {confirm === "cancel" && (
            <div className="mt-4 rounded-xl border border-amber-300/30 bg-amber-400/10 p-3 text-sm">
              <p>Cancel your FLOW Pass? {stillPaid || running ? <>It keeps working until <b>{fmt(sub?.paidThrough ?? sub?.currentPeriodEnd)}</b> and won&apos;t renew.</> : <>It ends now; you won&apos;t be charged.</>}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => void act("cancel")} disabled={busy} className={btnSolid}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Yes, cancel</button>
                <button onClick={() => setConfirm(null)} disabled={busy} className={btnGhost}>Keep it</button>
              </div>
            </div>
          )}
          {confirm === "pause" && (
            <div className="mt-4 rounded-xl border border-sky-300/30 bg-sky-400/10 p-3 text-sm">
              <p>Pause billing? Your Pass keeps working until <b>{fmt(sub?.currentPeriodEnd)}</b>. After that there are no charges and no Pass until you tap Resume.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => void act("pause")} disabled={busy} className={btnSolid}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Pause billing</button>
                <button onClick={() => setConfirm(null)} disabled={busy} className={btnGhost}>Never mind</button>
              </div>
            </div>
          )}

          {!confirm && (
            <div className="mt-4 flex flex-wrap gap-2">
              {running && (
                <>
                  <button onClick={() => setConfirm("pause")} disabled={busy} className={btnGhost}><PauseCircle className="h-4 w-4" /> Pause billing</button>
                  <button onClick={() => setConfirm("cancel")} disabled={busy} className={btnGhost}>Cancel Pass</button>
                </>
              )}
              {ending && (
                <button onClick={() => void act("resume")} disabled={busy} className={btnSolid}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Keep my Pass</button>
              )}
              {paused && (
                <>
                  <button onClick={() => void act("unpause")} disabled={busy} className={btnSolid}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                    {stillPaid ? "Resume billing" : `Resume — $${price} today`}
                  </button>
                  <button onClick={() => setConfirm("cancel")} disabled={busy} className={btnGhost}>Cancel instead</button>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-1">
          {issue && (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Your last Pass payment didn&apos;t go through, so the Pass is on hold. Stripe retries the card automatically; it comes back the moment a payment succeeds.
            </p>
          )}
          <p className="mt-3 text-sm text-white/80">
            {pass.canUpgrade
              ? "You're on the old $39 plan, which still meters FLOW by the credit. The Pass takes the meter off entirely — we'll cancel the $39 automatically so you're never billed twice."
              : "Running FLOW costs most members more than a pack a week. The Pass takes the meter off: one price, and GENX, GEN FX, OM AI Plays and FLOW just run."}
          </p>
          <PassBenefits credits={credits} />
          {!issue && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button onClick={() => void start()} disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-300 to-amber-500 px-5 py-2.5 text-sm font-extrabold text-[#20160a] disabled:opacity-60">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
                {pass.canUpgrade ? `Upgrade to $${price}/mo` : `Get the Pass — $${price}/mo`}
              </button>
              <span className="text-xs text-white/55">Cancel or pause anytime, right here.</span>
            </div>
          )}
        </div>
      )}
      {msg && (
        <p className="mt-3 flex items-center gap-2 text-xs text-amber-200"><AlertTriangle className="h-3.5 w-3.5" /> {msg}</p>
      )}
    </section>
  );
}
