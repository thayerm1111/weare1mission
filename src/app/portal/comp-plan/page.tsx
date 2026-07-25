import { Check, X, Layers, TrendingUp, Wallet, BadgeCheck } from "lucide-react";
import { RANKS, MEMBERSHIPS, MEMBERSHIP_FEATURES, PREPAY } from "@/data/coneqtx";
import { PersonalRankTracker } from "@/components/portal/PersonalRankTracker";

export const metadata = { title: "The Comp Plan" };

const money = (n: number) => "$" + n.toLocaleString();

export default function CompPlanPage() {
  return (
    <div className="space-y-12">
      {/* Header */}
      <header className="overflow-hidden rounded-2xl bg-navy p-8 sm:p-10">
        <span className="eyebrow text-gold-light">The Comp Plan · ConeqtX</span>
        <h1 className="mt-4 font-serif text-3xl font-semibold uppercase leading-[1.05] tracking-[0.02em] text-white sm:text-4xl">
          Know your ranks.
        </h1>
        <p className="mt-4 max-w-2xl text-light/80">
          1 Mission builds <span className="text-gold-light">inside ConeqtX</span>. This is the exact ladder every builder
          climbs — each rank, what it takes to earn it, and what it pays. It&apos;s a binary plan: your volume builds on a
          Left and a Right leg.
        </p>
      </header>

      {/* Personal rank tracker */}
      <PersonalRankTracker />

      {/* Rank ladder */}
      <section>
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="eyebrow">The Rank Ladder</span>
        </div>
        <h2 className="mt-2 font-serif text-2xl font-semibold uppercase tracking-[0.01em] text-navy">14 Ranks. One Path Up.</h2>

        <div className="mt-5 overflow-x-auto rounded-2xl border border-[#E7E4DD]">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="bg-navy text-left text-[11px] uppercase tracking-[0.1em] text-light/80">
                <th className="px-4 py-3.5 font-semibold">Rank</th>
                <th className="px-4 py-3.5 font-semibold">Total Volume</th>
                <th className="px-4 py-3.5 font-semibold">Per Side</th>
                <th className="px-4 py-3.5 font-semibold">Max % / Line</th>
                <th className="px-4 py-3.5 text-right font-semibold">Weekly Pay</th>
                <th className="px-4 py-3.5 text-right font-semibold">Monthly Total</th>
                <th className="px-4 py-3.5 font-semibold">Active Req.</th>
                <th className="px-4 py-3.5 text-right font-semibold">Override</th>
              </tr>
            </thead>
            <tbody>
              {RANKS.map((r) => {
                const elite = r.position >= 11; // Visionary and above
                return (
                  <tr key={r.position} className="border-t border-[#EEEDE8] bg-white transition-colors hover:bg-offwhite/70">
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                            elite ? "bg-primary text-white" : "bg-ice text-navy"
                          }`}
                        >
                          {r.position}
                        </span>
                        <span className="font-semibold text-navy">
                          {r.name}
                          {r.abbr && <span className="ml-1 text-medium">({r.abbr})</span>}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 tabular-nums text-charcoal/80">{r.totalVolume}</td>
                    <td className="px-4 py-3.5 tabular-nums text-charcoal/70">{r.perSide}</td>
                    <td className="px-4 py-3.5 tabular-nums text-charcoal/70">{r.fromOneLine}</td>
                    <td className="px-4 py-3.5 text-right font-semibold tabular-nums text-navy">{money(r.weeklyPay)}</td>
                    <td className="px-4 py-3.5 text-right font-bold tabular-nums text-navy">{money(r.monthlyTotal)}</td>
                    <td className="px-4 py-3.5 text-charcoal/70">{r.activeReq}</td>
                    <td className="px-4 py-3.5 text-right tabular-nums text-charcoal/70">{r.override}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-medium">
          Weekly Pay is the max rank bonus per week; Monthly Total is the max per month. Override is the generational
          bonus paid on your organization once you reach that rank.
        </p>
      </section>

      {/* Membership options */}
      <section>
        <div className="flex items-center gap-2">
          <BadgeCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="eyebrow">Membership Options</span>
        </div>
        <h2 className="mt-2 font-serif text-2xl font-semibold uppercase tracking-[0.01em] text-navy">Core &amp; Pro</h2>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {MEMBERSHIPS.map((m) => {
            const isPro = m.name === "Pro";
            return (
              <div
                key={m.name}
                className={`flex flex-col rounded-2xl border p-6 sm:p-7 ${
                  isPro ? "border-navy bg-navy text-white" : "border-[#E7E4DD] bg-white"
                }`}
              >
                <div className="flex items-end justify-between">
                  <div>
                    <p className={`font-serif text-xl font-semibold uppercase tracking-[0.06em] ${isPro ? "text-white" : "text-navy"}`}>
                      {m.name}
                    </p>
                    <p className={`mt-1 text-sm ${isPro ? "text-light/70" : "text-charcoal/60"}`}>
                      {money(m.monthly)}/mo after
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`font-serif text-3xl font-bold tabular-nums ${isPro ? "text-gold-light" : "text-navy"}`}>{money(m.oneTime)}</p>
                    <p className={`text-[11px] uppercase tracking-[0.1em] ${isPro ? "text-light/60" : "text-medium"}`}>One-time</p>
                  </div>
                </div>

                <ul className={`mt-5 space-y-2 border-t pt-5 ${isPro ? "border-white/15" : "border-[#EEEDE8]"}`}>
                  {MEMBERSHIP_FEATURES.map((f) => {
                    const included = isPro ? f.pro : f.core;
                    return (
                      <li key={f.label} className="flex items-start gap-2.5 text-sm">
                        <span
                          className={`mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full ${
                            included
                              ? isPro ? "bg-white/15 text-gold-light" : "bg-primary/10 text-primary"
                              : isPro ? "bg-white/5 text-light/30" : "bg-ice text-medium"
                          }`}
                          aria-hidden="true"
                        >
                          {included ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                        </span>
                        <span className={included ? (isPro ? "text-white" : "text-navy") : (isPro ? "text-light/40 line-through" : "text-medium line-through")}>
                          <span className="font-semibold">{f.label}</span>
                          <span className={isPro ? "text-light/60" : "text-charcoal/55"}> — {f.desc}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <div className={`mt-5 flex flex-wrap gap-x-6 gap-y-1 border-t pt-4 text-sm ${isPro ? "border-white/15" : "border-[#EEEDE8]"}`}>
                  <span className={isPro ? "text-light/70" : "text-charcoal/60"}>
                    Referral <span className={`font-semibold ${isPro ? "text-white" : "text-navy"}`}>L1 {money(m.referral.l1)}</span>
                  </span>
                  <span className={isPro ? "text-light/70" : "text-charcoal/60"}>
                    <span className={`font-semibold ${isPro ? "text-white" : "text-navy"}`}>L2 {money(m.referral.l2)}</span>
                  </span>
                  <span className={isPro ? "text-light/70" : "text-charcoal/60"}>
                    <span className={`font-semibold ${isPro ? "text-white" : "text-navy"}`}>{m.referral.bv} BV</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Prepay bonuses */}
      <section>
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="eyebrow">Prepay Bonus Details</span>
        </div>
        <h2 className="mt-2 font-serif text-2xl font-semibold uppercase tracking-[0.01em] text-navy">Bigger Terms, Bigger Bonuses</h2>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PREPAY.map((p) => (
            <div key={`${p.plan}-${p.term}`} className="rounded-2xl border border-[#E7E4DD] bg-white p-5">
              <div className="flex items-center justify-between">
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] ${p.plan === "Pro" ? "bg-navy text-white" : "bg-ice text-navy"}`}>
                  {p.plan}
                </span>
                <span className="text-xs text-medium">{p.days} days</span>
              </div>
              <p className="mt-3 font-serif text-lg font-semibold uppercase tracking-[0.04em] text-navy">{p.term} Prepay</p>
              <dl className="mt-3 space-y-1.5 text-sm">
                {[
                  ["Referral L1", money(p.l1)],
                  ["Referral L2", money(p.l2)],
                  ["Upfront CV", p.upfrontCv.toString()],
                  ["Monthly CV", p.monthlyCv.toString()],
                  ["Renewal Bonus", money(p.renewalBonus)],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between border-b border-[#F0EFEA] pb-1.5 last:border-0">
                    <dt className="text-charcoal/60">{k}</dt>
                    <dd className="font-semibold tabular-nums text-navy">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-start gap-2.5 rounded-2xl border border-[#E7E4DD] bg-offwhite/60 p-5">
        <TrendingUp className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
        <p className="text-sm text-charcoal/70">
          Figures are from the official ConeqtX Bonus Plan. Always defer to ConeqtX&apos;s official plan and policies for
          exact qualification and payout details.
        </p>
      </div>
    </div>
  );
}
