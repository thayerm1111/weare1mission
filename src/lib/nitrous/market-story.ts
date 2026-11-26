import { displayableSetup, selectWatchLevels } from "./dashboard";
import type { NitrousAnalyze, NitrousMode, NitrousScenario, NitrousWatchLevel } from "./types";

export type MarketTone = "positive" | "negative" | "neutral";
export type MarketOpportunity = {
  kind: "setup" | "watch" | "none" | "stale";
  title: string;
  status: string;
  detail: string;
  range: { low: number; high: number } | null;
  distance: number | null;
  distanceText: string;
  boundary: number | null;
  boundaryText: string;
  boundaryDistance: number | null;
  trigger: string;
  invalidationText: string | null;
  target: number | null;
  stop: number | null;
  plan: NitrousScenario | null;
  zone: NitrousWatchLevel | null;
};
export type MarketStory = {
  headline: string;
  summary: string;
  tone: MarketTone;
  /** Age of the last completed one-minute reference close, NOT a broker tick. */
  quoteAgeMs: number | null;
  /** Age of the engine's market read, independent of the reference close. */
  analysisAgeMs: number | null;
  opportunity: MarketOpportunity;
  zones: NitrousWatchLevel[];
};
type Direction = "up" | "down" | "range" | "unknown";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const formatPrice = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeframes: Record<string, string> = { D1: "D", H4: "4H", H1: "1H", M30: "30M", M15: "15M", M5: "5M" };
const timeframe = (v: string) => timeframes[v.toUpperCase()] ?? v.toUpperCase();
const timeframeWords = (v: string) => ({ D: "daily", "4H": "4-hour", "1H": "1-hour", "30M": "30-minute", "15M": "15-minute", "5M": "5-minute" } as Record<string, string>)[timeframe(v)] ?? "";
const family = (v: string) => ({ trend_pullback: "pullback", break_retest: "break & retest", range_reaction: "range reaction" } as Record<string, string>)[v] ?? "setup";
const distanceTo = (low: number, high: number, price: number) => Math.max(low - price, price - high, 0);
const direction = (data: NitrousAnalyze | null, tf: string): Direction => {
  const value = data?.flow.find(v => typeof v?.timeframe === "string" && timeframe(v.timeframe) === tf)?.direction;
  return value === "up" || value === "down" || value === "range" ? value : "unknown";
};

/** Returns null for a missing timestamp or a clock discrepancy beyond the API's five-second tolerance. */
export function marketAge(at: string | null | undefined, now: number): number | null {
  const stamp = Date.parse(at ?? "");
  return finite(now) && now > 0 && finite(stamp) && now - stamp >= -5_000 ? Math.max(0, now - stamp) : null;
}
function currentRead(data: NitrousAnalyze | null, now: number, fresh: boolean): boolean {
  const referenceAge = marketAge(data?.asOf, now), scanAge = marketAge(data?.generatedAt, now);
  return !!data && fresh && data.available && !data.stale && data.health.state === "ok"
    && data.health.reasons.length === 0 && positive(data.price)
    && referenceAge !== null && referenceAge <= 120_000 && scanAge !== null && scanAge <= 45_000;
}

/** A display filter only. It never creates, rearms, or submits an engine setup. */
function coherentPlan(s: NitrousScenario, reference: number | null, now: number, fresh: boolean): boolean {
  if (!s || !displayableSetup(s, reference, now, fresh) || !s.setupId
    || !["trend_pullback", "break_retest", "range_reaction"].includes(s.family)
    || s.refEntry < s.entryBandLow || s.refEntry > s.entryBandHigh) return false;
  return s.side === "buy"
    ? s.stop < s.entryBandLow && s.target > s.entryBandHigh && s.stop <= s.invalidation && s.invalidation < s.target
    : s.stop > s.entryBandHigh && s.target < s.entryBandLow && s.stop >= s.invalidation && s.invalidation > s.target;
}

/** Nearest valid entry band first; equal distances prefer an observed reference trigger. */
export function rankedSetups(scenarios: NitrousScenario[], reference: number | null, now: number,
  fresh: boolean, mode: NitrousMode): NitrousScenario[] {
  if (!positive(reference) || !finite(now)) return [];
  const priority: Record<string, number> = { triggered: 0, armed: 1, approaching: 2, watching: 3 };
  return scenarios.filter(s => s && (mode === "nitrous" || s.profile !== "nitrous") && coherentPlan(s, reference, now, fresh))
    .sort((a, b) => distanceTo(a.entryBandLow, a.entryBandHigh, reference) - distanceTo(b.entryBandLow, b.entryBandHigh, reference)
      || priority[a.state] - priority[b.state] || a.expiresAt - b.expiresAt || a.setupId.localeCompare(b.setupId));
}

function marketContext(data: NitrousAnalyze): Pick<MarketStory, "headline" | "summary" | "tone"> {
  const five = direction(data, "5M"), hourly = direction(data, "1H"), four = direction(data, "4H"), daily = direction(data, "D");
  const broader = daily === four && (four === "up" || four === "down") ? four : null;
  let headline = "The timeframes are not aligned";
  if (five === "up" && broader === "down") headline = "Short-term rally, broader downtrend";
  else if (five === "down" && broader === "up") headline = "Short-term pullback, broader uptrend";
  else if (five === "up" && hourly === "up") headline = "Near-term trends point higher";
  else if (five === "down" && hourly === "down") headline = "Near-term trends point lower";
  else if (five === "up" && hourly === "range") headline = "Gold is rising inside an hourly range";
  else if (five === "down" && hourly === "range") headline = "Gold is falling inside an hourly range";
  else if (five === "range") headline = "Gold is consolidating on the 5-minute chart";
  else if (five === "up") headline = "The 5-minute trend points higher";
  else if (five === "down") headline = "The 5-minute trend points lower";
  else if (five === "unknown" && hourly === "unknown") headline = "Market structure is incomplete";

  const short = five === "up" ? "The 5-minute structure points up" : five === "down" ? "The 5-minute structure points down"
    : five === "range" ? "The 5-minute chart is range-bound" : "The 5-minute trend is unavailable";
  const hour = hourly === "range" ? "the 1-hour chart remains range-bound"
    : hourly === "up" ? "the 1-hour trend points up" : hourly === "down" ? "the 1-hour trend points down" : "the hourly trend is unavailable";
  const higher = broader ? `Daily and 4-hour structure still point ${broader === "up" ? "higher" : "lower"}.`
    : daily !== "unknown" && four !== "unknown" ? "Daily and 4-hour structure do not share a directional trend."
      : "Higher-timeframe context is incomplete.";
  return { headline, summary: `${short}; ${hour}. ${higher}`,
    tone: five === "up" && hourly === "up" ? "positive" : five === "down" && hourly === "down" ? "negative" : "neutral" };
}

function distanceText(low: number, high: number, reference: number): string {
  if (reference >= low && reference <= high) return "Reference price is inside the zone";
  return reference > high ? `$${formatPrice(reference - high)} below current reference` : `$${formatPrice(low - reference)} above current reference`;
}
function emptyOpportunity(kind: MarketOpportunity["kind"], title: string, status: string, detail: string, trigger: string): MarketOpportunity {
  return { kind, title, status, detail, trigger, range: null, distance: null, distanceText: "", invalidationText: null,
    target: null, stop: null, plan: null, zone: null, boundary: null, boundaryText: "", boundaryDistance: null };
}
function planOpportunity(plan: NitrousScenario, reference: number): MarketOpportunity {
  const triggered = plan.state === "triggered", confirmed = triggered || plan.state === "armed";
  const tf = timeframe(plan.timeframe).toLowerCase();
  // These requirements come from nitrous/logic.ts, not assumptions from the chart's candle shape.
  const pending = Array.isArray(plan.conditionsPending) ? plan.conditionsPending.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
  const firstPending = pending.find(v => !/broker|margin|affordable|risk must qualify/i.test(v)) ?? pending[0];
  const trigger = triggered ? "The reference trigger and entry-zone visit were observed. Broker execution still needs its own confirmation."
    : confirmed ? "The reference trigger is confirmed. Broker price must enter the band and pass size, spread, margin and risk checks."
      : firstPending ? `${firstPending.replace(/[.!?]+$/, "")}.`
        : plan.family === "break_retest" ? "A completed break and return to the entry band must be confirmed, followed by broker risk checks."
          : `A completed ${tf} candle must reject the zone, followed by broker price and risk checks.`;
  const chartName = timeframeWords(plan.timeframe);
  const detail = plan.family === "break_retest" ? `The ${chartName || "entry"} chart has recorded a break ${plan.side === "buy" ? "above" : "below"} the zone. This ${plan.side} plan watches the retest.`
    : plan.family === "range_reaction" ? `This ${plan.side} setup watches the ${plan.side === "buy" ? "lower" : "upper"} boundary of an established ${chartName ? `${chartName} ` : ""}range.`
      : `This ${plan.side} plan follows a ${chartName ? `${chartName} ` : ""}pullback into ${plan.side === "buy" ? "support" : "resistance"}. The entry area is shown above.`;
  return {
    kind: "setup", title: triggered ? `${plan.side === "buy" ? "Buy" : "Sell"} trigger observed` : `${plan.side === "buy" ? "Buy" : "Sell"} ${family(plan.family)}`,
    status: triggered ? "Reference trigger · not a broker fill" : confirmed ? "Confirmation observed · waiting for entry" : "Conditional setup · waiting for confirmation",
    detail, range: { low: plan.entryBandLow, high: plan.entryBandHigh },
    distance: distanceTo(plan.entryBandLow, plan.entryBandHigh, reference), distanceText: distanceText(plan.entryBandLow, plan.entryBandHigh, reference),
    trigger, invalidationText: `This idea is invalid if reference price reaches ${formatPrice(plan.invalidation)} or ${plan.side === "buy" ? "lower" : "higher"}.`,
    target: plan.target, stop: plan.stop, plan, zone: null, boundary: null, boundaryText: "", boundaryDistance: null,
  };
}
/** The relevant boundary is not an entry trigger. Inside a wide zone, show its structural outer edge. */
export function watchBoundary(zone: NitrousWatchLevel, reference: number): number {
  const inside = reference >= zone.low && reference <= zone.high;
  return zone.role === "support" ? inside ? zone.low : zone.high : inside ? zone.high : zone.low;
}
function watchOpportunity(zone: NitrousWatchLevel, reference: number, hourly: Direction): MarketOpportunity {
  const inside = reference >= zone.low && reference <= zone.high;
  const name = zone.role === "support" ? "demand" : "supply";
  const boundary = watchBoundary(zone, reference);
  const boundaryDistance = Math.abs(reference - boundary);
  const edge = inside ? zone.role === "support" ? "Lower demand boundary" : "Upper supply boundary" : `Nearest ${name} edge`;
  const boundaryText = `${edge} · ${boundaryDistance < 0.005 ? "at reference price" : `$${formatPrice(boundaryDistance)} ${boundary > reference ? "above" : "below"} reference`}`;
  const tf = zone.origin ? timeframeWords(zone.origin) : "";
  const location = inside ? "inside" : reference > zone.high ? "above" : "below";
  const area = `${tf ? `${tf} ` : ""}${name} area`;
  const trigger = hourly === "range" ? "The hourly chart needs a directional trend before a setup can qualify. Then wait for an entry pattern and broker checks."
    : hourly === "unknown" ? "Wait for the hourly trend and a qualifying entry pattern to be available. A zone touch alone is not an entry."
      : "Wait for Nitrous to confirm an entry pattern here. A zone touch alone is not an entry.";
  return {
    kind: "watch", title: inside ? `Inside ${name} zone` : `${zone.role === "support" ? "Demand below" : "Supply above"} price`,
    status: "Area to watch · no entry signal", detail: `Gold is ${location} a ${area}. No entry is confirmed here.`,
    range: { low: zone.low, high: zone.high }, distance: distanceTo(zone.low, zone.high, reference), distanceText: distanceText(zone.low, zone.high, reference),
    trigger, invalidationText: null, target: null, stop: null, plan: null, zone, boundary, boundaryText, boundaryDistance,
  };
}

/** Deterministic narration of reported structure. No predicted path, probability, or invented trade levels. */
export function buildMarketStory(data: NitrousAnalyze | null,
  { fresh, now, plan = null }: { fresh: boolean; now: number; plan?: NitrousScenario | null }): MarketStory {
  const quoteAgeMs = marketAge(data?.asOf, now), analysisAgeMs = marketAge(data?.generatedAt, now);
  if (!data || !currentRead(data, now, fresh)) {
    const detail = data?.health.reasons.find(v => typeof v === "string" && v.trim()) ?? data?.reason ?? "Waiting for the next fresh market read.";
    return { headline: "Waiting for fresh market data", summary: "The last snapshot is not a current setup signal. Market context and entry areas will return when the feed refreshes.",
      tone: "neutral", quoteAgeMs, analysisAgeMs, zones: [],
      opportunity: emptyOpportunity("stale", "Waiting for fresh market data", "Market read unavailable", detail, "A fresh reference close and a healthy analysis read are required.") };
  }
  const reference = data.price!;
  const at = Date.parse(data.generatedAt!);
  const zones = selectWatchLevels(data.diagnostics?.watchLevels, reference, at)
    .sort((a, b) => Math.abs(watchBoundary(a, reference) - reference) - Math.abs(watchBoundary(b, reference) - reference)
      || (a.high - a.low) - (b.high - b.low) || b.knownAt - a.knownAt);
  const hourly = direction(data, "1H");
  const selected = plan ? data.scenarios.find(s => s.setupId === plan.setupId) ?? null : null;
  const opportunity = selected && coherentPlan(selected, reference, now, true) ? planOpportunity(selected, reference)
    : zones[0] ? watchOpportunity(zones[0], reference, hourly)
      : emptyOpportunity("none", "No nearby setup identified", "No entry signal", "The current read has no qualifying entry plan or nearby validated watch area.",
        hourly === "range" ? "The hourly chart needs a directional trend, then a nearby entry pattern with a structural stop and target."
          : "Wait for a nearby structural plan with a confirmed entry pattern, stop and target.");
  return { ...marketContext(data), quoteAgeMs, analysisAgeMs, zones, opportunity };
}

/** One factual event per changed source read. Repeated polls and mere timestamp changes produce no event. */
export function marketUpdate(previous: NitrousAnalyze | null, current: NitrousAnalyze | null, now: number, mode: NitrousMode = "nitrous"): string | null {
  if (!previous || !current || !currentRead(current, now, true) || previous.generatedAt === current.generatedAt
    || !previous.available || previous.stale || previous.health.state !== "ok") return null;
  const previousAt = Date.parse(previous.generatedAt ?? ""), currentAt = Date.parse(current.generatedAt ?? "");
  if (!finite(previousAt) || !finite(currentAt) || currentAt <= previousAt) return null;
  const plans = rankedSetups(current.scenarios, current.price, now, true, mode);
  // A replacement is more useful than a retirement message when both occur in the same read.
  for (const plan of plans) {
    if (!previous.scenarios.some(s => s.setupId === plan.setupId))
      return `New ${plan.side} ${family(plan.family)} identified at ${formatPrice(plan.entryBandLow)}–${formatPrice(plan.entryBandHigh)}.`;
  }
  // Evaluate the prior offer at its own read time so an expiry now does not erase its history.
  const priorPlans = rankedSetups(previous.scenarios, previous.price, previousAt, true, mode);
  for (const prior of priorPlans) {
    if (plans.some(s => s.setupId === prior.setupId)) continue;
    const present = current.scenarios.find(s => s.setupId === prior.setupId);
    const name = `${prior.side} ${family(prior.family)}`;
    if (prior.expiresAt <= now || present?.state === "expired")
      return `The previous ${name} setup has expired. It is no longer an available entry.`;
    if (present?.state === "invalidated")
      return `The previous ${name} setup is marked invalidated in the current read.`;
    if (positive(current.price) && (prior.side === "buy" ? current.price <= prior.invalidation : current.price >= prior.invalidation))
      return `Reference price reached or crossed the previous ${name} invalidation at ${formatPrice(prior.invalidation)}. That setup is no longer available.`;
    if (positive(current.price) && (prior.side === "buy" ? current.price >= prior.target : current.price <= prior.target))
      return `Reference price reached or passed the previous ${name} target at ${formatPrice(prior.target)}. It is no longer shown as a new entry.`;
    return present ? `The previous ${name} is no longer displayed as an available setup.`
      : `The previous ${name} setup is no longer in the current read.`;
  }
  for (const plan of plans) {
    const before = previous.scenarios.find(s => s.setupId === plan.setupId)!;
    if (before.state !== plan.state && (plan.state === "armed" || plan.state === "triggered"))
      return plan.state === "triggered" ? "A reference trigger and entry-zone visit were observed. Broker fill is not confirmed."
        : "A closed reference trigger is confirmed; price still needs to reach the entry band.";
    if (positive(previous.price) && distanceTo(plan.entryBandLow, plan.entryBandHigh, previous.price) > 0
      && distanceTo(plan.entryBandLow, plan.entryBandHigh, current.price!) === 0)
      return `Reference price reached the ${plan.side} entry band. Confirmation checks still apply.`;
  }
  for (const tf of ["1H", "5M", "4H", "D"]) {
    const before = direction(previous, tf), after = direction(current, tf);
    if (before !== "unknown" && after !== "unknown" && before !== after)
      return `${tf} structure changed from ${before === "range" ? "range-bound" : before} to ${after === "range" ? "range-bound" : after}.`;
  }
  if (positive(previous.price) && positive(current.price)) {
    const zones = selectWatchLevels(current.diagnostics?.watchLevels, current.price, currentAt);
    for (const zone of zones) {
      const existed = previous.diagnostics?.watchLevels.some(z => z.role === zone.role && z.low === zone.low && z.high === zone.high && z.knownAt === zone.knownAt);
      if (existed && distanceTo(zone.low, zone.high, previous.price) > 0 && distanceTo(zone.low, zone.high, current.price) === 0)
        return `Reference price entered the ${zone.role === "support" ? "demand" : "supply"} zone at ${formatPrice(zone.low)}–${formatPrice(zone.high)}. No entry is confirmed by the touch alone.`;
    }
  }
  return null;
}
