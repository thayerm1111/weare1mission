"use client";

/**
 * LowBalanceFlyer — a premium "flyer" upsell modal that appears when a member's
 * credit balance drops below the threshold (default: fewer than 2 credits left).
 * It leads with how the GENX Gold engine has ACTUALLY performed (via the
 * member-safe `/api/genx-stats` aggregate — straight from the immutable
 * genx_signals outcome ledger) to motivate a top-up, then routes into Stripe
 * checkout for a credit pack.
 *
 * HONESTY: every number here is a real recorded GENX outcome. Nothing is
 * invented. Win rate is over decided calls (wins vs losses); if too few have
 * resolved to headline a percentage, we show the raw count of winning calls
 * instead — never a fabricated rate. Educational decision-support, not financial
 * advice and not a promise of future results.
 *
 * Triggers:
 *  • On mount, if the live balance is below the threshold (unless snoozed this
 *    browser session).
 *  • Whenever a tool is blocked for insufficient credits and dispatches the
 *    `open-credits-flyer` window event (this overrides the session snooze).
 *  • Manually with `?flyer=1` in the URL (owner/preview — ignores balance).
 * It re-checks the balance on every `credits-updated` event and closes itself
 * automatically once the member is back above the threshold.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Zap, TrendingUp, ArrowUp, ArrowDown, Loader2, ShieldCheck, Flame } from "lucide-react";

const THRESHOLD = 2; // show when total credits are BELOW this many
const MIN_CONFIDENT = 10; // below this many decided GENX calls, show a count, not a headline %
const SNOOZE_KEY = "om-lowbal-snooze"; // session-scoped: don't re-pop on every nav after a manual dismiss

const GOLD = "#ffc24b";
const BULL = "#2ee88f";
const BEAR = "#ff5d6c";

type Balance = { dailyLeft: number; purchased: number; dailyAllowance: number };
type Pack = { id: string; label: string; credits: number; priceUsd: number; blurb: string; best?: boolean };
type GenxWin = { mode: string | null; direction: string; tp: number | null; pips: number | null; at: string };
type GenxStats = {
  generated: number; resolved: number; wins: number; losses: number; other: number; decided: number;
  winRate: number | null; avgRr: number | null; netPips: number; recent: GenxWin[];
};

const MODE_LABEL: Record<string, string> = { quick: "Quick", intraday: "Intraday", swing: "Swing" };

function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function LowBalanceFlyer() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [genx, setGenx] = useState<GenxStats | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => { setMounted(true); }, []);

  const forced = useMemo(() => {
    if (typeof window === "undefined") return false;
    try { return new URLSearchParams(window.location.search).get("flyer") === "1"; } catch { return false; }
  }, []);

  // Balance — recomputed on demand and on every credits-updated event.
  const loadBalance = useCallback(async (): Promise<number | null> => {
    try {
      const r = await fetch("/api/credits", { cache: "no-store" });
      const d = await r.json();
      if (Array.isArray(d.packs)) setPacks(d.packs);
      if (d.balance) {
        const t = (d.balance.dailyLeft || 0) + (d.balance.purchased || 0);
        setTotal(t);
        return t;
      }
    } catch { /* ignore */ }
    return null;
  }, []);

  // Real GENX track record (member-safe, anonymized aggregate).
  const loadStats = useCallback(async () => {
    try {
      const r = await fetch("/api/genx-stats", { cache: "no-store" });
      const d = await r.json();
      if (d && !d.error) setGenx(d as GenxStats);
    } catch { /* ignore */ }
  }, []);

  // First load + wiring.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await loadBalance();
      if (cancelled) return;
      const snoozed = (() => { try { return sessionStorage.getItem(SNOOZE_KEY) === "1"; } catch { return false; } })();
      if (forced || (t != null && t < THRESHOLD && !snoozed)) {
        setOpen(true);
        void loadStats();
      }
    })();

    // Fired by tools when a metered action is blocked → force the flyer open.
    const onForce = () => {
      try { sessionStorage.removeItem(SNOOZE_KEY); } catch { /* ignore */ }
      setOpen(true);
      void loadBalance();
      void loadStats();
    };
    // Balance changed somewhere → refresh; auto-close if they're topped up.
    const onUpdated = async () => {
      const t = await loadBalance();
      if (t != null && t >= THRESHOLD) setOpen(false);
    };
    window.addEventListener("open-credits-flyer", onForce);
    window.addEventListener("credits-updated", onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("open-credits-flyer", onForce);
      window.removeEventListener("credits-updated", onUpdated);
    };
  }, [forced, loadBalance, loadStats]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  function dismiss() {
    try { sessionStorage.setItem(SNOOZE_KEY, "1"); } catch { /* ignore */ }
    setOpen(false);
  }

  async function buy(packId: string) {
    setBuying(packId); setMsg("");
    try {
      const r = await fetch("/api/stripe/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId }) });
      const d = await r.json();
      if (d.url) { window.location.href = d.url; return; }
      if (d.error === "stripe_not_configured") setMsg("Payments aren't switched on yet — check back soon.");
      else setMsg("Couldn't start checkout — try again shortly.");
    } catch { setMsg("Couldn't start checkout — try again shortly."); }
    finally { setBuying(null); }
  }

  if (!mounted || !open) return null;

  // ── Honest GENX headline from real data ────────────────────────────────────
  const decided = genx?.decided ?? 0;
  const winRate = genx?.winRate ?? null;
  const confident = decided >= MIN_CONFIDENT && winRate != null;
  const recentWins = genx?.recent || [];
  const netPips = genx?.netPips ?? 0;
  const avgRr = genx?.avgRr ?? null;

  const balText = total == null ? "low" : total <= 0 ? "0 credits" : total === 1 ? "1 credit" : `${total.toLocaleString()} credits`;

  const flyer = (
    <div
      className="fixed inset-0 z-[95] flex items-end justify-center overflow-y-auto bg-black/75 p-0 backdrop-blur-md sm:items-center sm:p-4"
      role="dialog" aria-modal="true" aria-label="Get more credits"
      onClick={dismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg overflow-hidden rounded-t-3xl border shadow-2xl sm:rounded-3xl"
        style={{
          background: "linear-gradient(165deg,#111319 0%,#0b0c10 46%,#14110a 100%)",
          borderColor: "rgba(255,194,75,0.28)",
        }}
      >
        {/* soft gold glow */}
        <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full opacity-40 blur-3xl" style={{ background: "radial-gradient(circle,#ffc24b55,transparent 70%)" }} />

        <button onClick={dismiss} aria-label="Close"
          className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-white/55 transition hover:bg-white/10 hover:text-white">
          <X className="h-4 w-4" />
        </button>

        <div className="relative px-6 pt-7 sm:px-8">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: GOLD }}>
            <Flame className="h-3.5 w-3.5" /> One Mission · Live Desk
          </div>
          <h2 className="mt-3 font-serif text-[26px] font-extrabold leading-tight text-white sm:text-[30px]">
            You&apos;re down to <span style={{ color: GOLD }}>{balText}</span>.
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-white/60">
            Every play, chart read and GENX call spends credits. Top up now so you don&apos;t miss the next setup the desk calls.
          </p>
        </div>

        {/* GENX track record — real, logged outcomes */}
        <div className="relative mt-5 px-6 sm:px-8">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/45">
              <TrendingUp className="h-3.5 w-3.5" style={{ color: BULL }} /> GENX · how the Gold engine is performing
            </div>

            {/* headline stats */}
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              <Tile
                value={confident ? `${winRate}%` : (genx && genx.wins > 0 ? String(genx.wins) : "—")}
                label={confident ? "GENX win rate" : "GENX wins"}
                sub={confident ? `of ${decided} decided calls` : (decided > 0 ? `${decided} decided` : "logged on Gold")}
                accent={BULL}
              />
              <Tile
                value={genx ? `${netPips >= 0 ? "+" : ""}${netPips.toLocaleString()}` : "—"}
                label="Net pips"
                sub="banked on Gold"
                accent={netPips >= 0 ? BULL : BEAR}
              />
              <Tile value={avgRr ? `1:${avgRr}` : "—"} label="Avg reward:risk" sub="planned" accent={GOLD} />
            </div>

            {/* recent GENX winning calls */}
            {recentWins.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                {recentWins.slice(0, 5).map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full" style={{ background: "rgba(46,232,143,0.14)", color: BULL }}>
                        {r.direction === "short" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
                      </span>
                      <span className="truncate text-[13px] font-semibold text-white">Gold</span>
                      <span className="hidden text-[11px] text-white/35 sm:inline">{r.mode ? (MODE_LABEL[r.mode] ?? r.mode) : "GENX"}</span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      {r.pips != null && (
                        <span className="text-[12px] font-semibold tabular-nums" style={{ color: BULL }}>+{r.pips}p</span>
                      )}
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "rgba(46,232,143,0.14)", color: BULL }}>
                        {r.tp ? `TP${r.tp} hit` : "Win"}
                      </span>
                      <span className="hidden text-[10px] text-white/30 sm:inline">{ago(r.at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-center text-[12px] text-white/45">
                GENX is live and calling Gold right now — winning results post here the moment they close.
              </p>
            )}
            <p className="mt-2 text-[10px] leading-relaxed text-white/30">
              Real, logged GENX outcomes — not a prediction or a promise. Every trade carries risk. Educational decision-support only.
            </p>
          </div>
        </div>

        {/* Buy CTAs */}
        <div className="relative mt-5 px-6 pb-7 sm:px-8">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-white/45">
            <Zap className="h-3.5 w-3.5" style={{ color: GOLD }} /> Reload your credits
          </div>
          {msg && <div className="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200">{msg}</div>}

          <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
            {packs.map((p) => (
              <button
                key={p.id}
                onClick={() => void buy(p.id)}
                disabled={buying != null}
                className="group relative flex flex-col items-center rounded-2xl border px-3 py-3.5 text-center transition disabled:opacity-60"
                style={p.best
                  ? { borderColor: "rgba(255,194,75,0.55)", background: "linear-gradient(180deg,rgba(255,194,75,0.12),rgba(255,194,75,0.02))" }
                  : { borderColor: "rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.02)" }}
              >
                {p.best && (
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-black" style={{ background: GOLD }}>
                    Best value
                  </span>
                )}
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/60">{p.label}</span>
                <span className="mt-1 font-serif text-2xl font-extrabold text-white">{p.credits.toLocaleString()}</span>
                <span className="text-[10px] text-white/40">credits</span>
                <span className="mt-1.5 flex items-center gap-1 text-[13px] font-bold" style={{ color: p.best ? GOLD : "#fff" }}>
                  {buying === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `$${p.priceUsd}`}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-white/40">
            <ShieldCheck className="h-3.5 w-3.5" style={{ color: BULL }} />
            Purchased credits never expire · secure checkout by Stripe
          </div>
          <button onClick={dismiss} className="mx-auto mt-3 block text-[12px] font-medium text-white/40 transition hover:text-white/70">
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(flyer, document.body);
}

function Tile({ value, label, sub, accent }: { value: string; label: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-2.5 py-2.5 text-center">
      <p className="font-serif text-xl font-extrabold tabular-nums" style={{ color: accent || "#fff" }}>{value}</p>
      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/45">{label}</p>
      {sub && <p className="text-[9px] text-white/30">{sub}</p>}
    </div>
  );
}
