/**
 * THE HUD'S SMALL DECISIONS, AS PURE FUNCTIONS (ATLAS integration).
 *
 * Everything here is display logic the screen used to decide inline: which word the orb says, which scenario
 * card is the base case, what an older [[UI: …]] marker means for the chart's timeframe, how honest the
 * automation label is allowed to be, and what the talk panel's status line may claim. Pure — no React, no DOM,
 * no clock — so tests/cc-atlas-hud.test.ts can hold the screen to it.
 */
import {
  CHART_TFS, LEAN_LABEL,
  type ChartTf, type FeedStatus, type Lean, type Scenario, type ScenarioRole, type ScenarioStatus,
} from "../../../../command-center/core/atlasContract";
import { ACTIVITY_LABEL, type LineActivity } from "../voiceLine";

/* ── the ATLAS core (BrainOrb) from the voice line's precise state ─────────────────────────────────── */

export type OrbVoice = "connecting" | "listening" | "speaking" | "thinking" | "muted";

/**
 * The orb's voice ring from `vb.activity` — the precise line state, not the legacy bus status (which folds a
 * closed microphone into "listening" and thinking into "speaking"). A muted microphone or an idle push-to-talk
 * is MUTED: the ring stops and turns amber, because nothing is being heard.
 */
export function orbVoiceOf(a: LineActivity): OrbVoice | null {
  switch (a) {
    case "speaking": return "speaking";
    case "thinking": return "thinking";
    case "listening": case "user_speaking": return "listening";
    case "connecting": case "awaiting_mic": return "connecting";
    case "mic_muted": case "ptt_idle": return "muted";
    default: return null;
  }
}

/** The words under the orb while a call is open — the line's own label, in capitals. */
export const orbLabelOf = (a: LineActivity): string => ACTIVITY_LABEL[a].toUpperCase();

/* ── the talk panel's status line — never a hard-coded "Online" ────────────────────────────────────── */

export type TalkState = { label: string; tone: "live" | "busy" | "idle" | "warn" | "off" };

/**
 * What the TALK WITH ATLAS header may say, from what is true: the voice line's activity while a call is open,
 * the chat's own request while it is thinking, the pass/session when the server refused, and otherwise that
 * chat is available and voice is not connected. "Online" is never claimed for a line that is not open.
 */
export function talkStateOf(o: {
  activity: LineActivity;
  lineOpen: boolean;
  chatBusy: boolean;
  replay: boolean;
  /** The /live route answered 401/402: the session or the window has ended. */
  accessEnded: boolean;
}): TalkState {
  if (o.accessEnded) return { label: "Window ended", tone: "warn" };
  if (o.lineOpen) {
    const live = o.activity === "listening" || o.activity === "user_speaking" || o.activity === "speaking";
    return { label: `Voice · ${ACTIVITY_LABEL[o.activity]}`, tone: live ? "live" : o.activity === "mic_muted" || o.activity === "ptt_idle" ? "warn" : "busy" };
  }
  if (o.chatBusy) return { label: "Chat · thinking", tone: "busy" };
  if (o.replay) return { label: "Replay · chat only", tone: "idle" };
  if (o.activity === "locked") return { label: "Chat ready · voice locked", tone: "idle" };
  if (o.activity === "error" || o.activity === "disconnected") return { label: `Chat ready · voice ${ACTIVITY_LABEL[o.activity]}`, tone: "warn" };
  return { label: "Chat ready · voice off", tone: "idle" };
}

/* ── automation — what the screen may claim about auto-entry ───────────────────────────────────────── */

export type AutomationView = { word: string; detail: string; tone: "green" | "gold" | "text" | "mut" };

/**
 * The automation chip. The member's profile says what they ASKED for; whether the worker's autopilot
 * (CC_AUTOPILOT) is live, shadow or off is a server setting. When the payload reports that mode, say it
 * plainly; when it does not, "ARMED" would be a claim this screen cannot back, so the chip says the request.
 * Display only: nothing here changes what the server does.
 */
export function automationOf(o: {
  tradeActive: boolean;
  tradeSide?: string | null;
  autoEntry: boolean;
  autoManagement: boolean;
  /** CC_AUTOPILOT as the server reports it; null/undefined = not reported to this screen. */
  serverMode?: "off" | "shadow" | "live" | null;
}): AutomationView {
  if (o.tradeActive) return { word: "MANAGING", detail: `${(o.tradeSide ?? "").toUpperCase() || "Position"} open`, tone: "green" };
  if (o.autoEntry) {
    if (o.serverMode === "live") return { word: "ARMED", detail: "Auto-entry on · server autopilot live", tone: "gold" };
    if (o.serverMode === "shadow" || o.serverMode === "off") {
      return { word: `ARMED — ${o.serverMode.toUpperCase()} ON SERVER`, detail: "Server autopilot is not live: it sends no orders by itself", tone: "gold" };
    }
    return { word: "AUTO-ENTRY REQUESTED", detail: "Server autopilot state not reported here", tone: "gold" };
  }
  if (o.autoManagement) return { word: "MANAGE ONLY", detail: "Manages trades you take", tone: "text" };
  return { word: "STANDBY", detail: "No auto-entry", tone: "mut" };
}

/* ── scenarios: which card is which ────────────────────────────────────────────────────────────────── */

export const ACTIVE_SCENARIO: readonly ScenarioStatus[] = ["watching", "developing"];
export const ROLE_ORDER: readonly ScenarioRole[] = ["base", "alternative", "view_change"];
export const ROLE_LABEL: Record<ScenarioRole, string> = {
  base: "Base case", alternative: "Alternative", view_change: "What changes the view",
};
export const STATUS_LABEL: Record<ScenarioStatus, string> = {
  watching: "Watching", developing: "Developing", confirmed: "Confirmed", invalidated: "Invalidated", expired: "Expired",
};

/**
 * The live card for each role (the engine sends live scenarios first, then the recently finished ones), and the
 * finished ones newest first. A role with no live scenario is null — the screen says so rather than promoting a
 * finished one into the slot.
 */
export function scenarioSlots(list: readonly Scenario[] | null | undefined): {
  slots: Record<ScenarioRole, Scenario | null>;
  finished: Scenario[];
} {
  const slots: Record<ScenarioRole, Scenario | null> = { base: null, alternative: null, view_change: null };
  const finished: Scenario[] = [];
  for (const s of list ?? []) {
    if (!s || typeof s !== "object") continue;
    if (ACTIVE_SCENARIO.includes(s.status)) {
      if (!slots[s.role]) slots[s.role] = s;
    } else {
      finished.push(s);
    }
  }
  finished.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { slots, finished };
}

/* ── the older [[UI: …]] markers ───────────────────────────────────────────────────────────────────── */

const TF_WORDS: Record<string, ChartTf> = {
  "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", d: "1d", "1day": "1d", daily: "1d",
  "5": "5m", "15": "15m", "60": "1h", "240": "4h", hourly: "1h", "five minute": "5m", "fifteen minute": "15m",
};

/** FOCUS_TIMEFRAME's argument as a chart timeframe, or null when it names nothing the chart shows. */
export function tfFromArg(arg: unknown): ChartTf | null {
  if (arg == null) return null;
  const k = String(arg).trim().toLowerCase();
  if ((CHART_TFS as readonly string[]).includes(k)) return k as ChartTf;
  return TF_WORDS[k] ?? null;
}

/** Two prices in a marker argument ("4380-4392", "4,380 to 4,392"), ordered, or null. */
export function rangeFromArg(arg: unknown): [number, number] | null {
  if (typeof arg !== "string") return null;
  const nums = (arg.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length < 2) return null;
  const [a, b] = nums;
  return a <= b ? [a, b] : [b, a];
}

/* ── words ─────────────────────────────────────────────────────────────────────────────────────────── */

export const FEED_TONE: Record<FeedStatus, "green" | "gold" | "red" | "mut" | "blue"> = {
  live: "green", delayed: "gold", reconnecting: "gold", stale: "red", closed: "mut", demo: "blue",
};

export const LEAN_TONE: Record<Lean, "green" | "red" | "cyan" | "gold" | "mut"> = {
  bullish_lean: "green", bearish_lean: "red", balanced: "cyan", transitioning: "gold", insufficient_data: "mut",
};

export const leanLabel = (l: Lean | string | null | undefined): string =>
  l && Object.prototype.hasOwnProperty.call(LEAN_LABEL, l) ? LEAN_LABEL[l as Lean] : "No read";

/** The evidence balance as the screen shows it: signed, or "—" when there is not enough data to weigh. */
export function balanceWords(score: number | null | undefined, lean: Lean | null | undefined): string {
  if (lean === "insufficient_data" || score == null || !Number.isFinite(score)) return "—";
  const r = Math.round(score);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}`;
}

/** An age in the screen's short words: "4 s", "41 s", "3 min", "2 h". */
export function ageShort(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const v = Math.max(0, ms);
  if (v < 60_000) return `${Math.round(v / 1000)} s`;
  if (v < 3_600_000) return `${Math.round(v / 60_000)} min`;
  if (v < 172_800_000) return `${Math.round(v / 3_600_000)} h`;
  return `${Math.round(v / 86_400_000)} d`;
}

export const SETUP_STAGE_WORD: Record<"none" | "watching" | "developing" | "ready" | "in_trade", string> = {
  none: "No setup", watching: "Watching", developing: "Developing", ready: "Ready", in_trade: "In a trade",
};
export const ENTRY_WORD: Record<"none" | "awaiting_confirmation" | "confirmed", string> = {
  none: "No entry", awaiting_confirmation: "Awaiting confirmation", confirmed: "Confirmed by the setup engine",
};
