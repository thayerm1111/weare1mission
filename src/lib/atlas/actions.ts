import { findAsset } from "@/data/signalAssets";
import { marketIn, styleIn } from "../../../command-center/brain/platform";
import { ATLAS_DESTINATIONS, type AtlasAction, type AtlasDestination, type AtlasMessage } from "./types";

/** Rebuild, rather than spread, untrusted proposals. No URL, request body, order or account mutation is accepted. */
export function normalizeAtlasActions(raw: unknown): AtlasAction[] {
  if (!Array.isArray(raw)) return [];
  const out: AtlasAction[] = [];
  for (const value of raw.slice(0, 8)) {
    if (!value || typeof value !== "object") continue;
    const a = value as Record<string, unknown>;
    let action: AtlasAction | null = null;
    if (a.type === "plays") {
      if (a.td != null && (typeof a.td !== "string" || !findAsset(a.td))) continue;
      if (a.style != null && !["scalp", "intraday", "swing"].includes(String(a.style))) continue;
      action = { type: "plays", ...(typeof a.td === "string" ? { td: a.td } : {}), ...(a.style ? { style: a.style as "scalp" | "intraday" | "swing" } : {}) };
    } else if (a.type === "genx") {
      if (a.mode != null && !["quick", "intraday", "swing"].includes(String(a.mode))) continue;
      action = { type: "genx", ...(a.mode ? { mode: a.mode as "quick" | "intraday" | "swing" } : {}) };
    } else if (a.type === "pulse") action = { type: "pulse" };
    else if (a.type === "navigate" && ATLAS_DESTINATIONS.includes(a.destination as AtlasDestination)) action = { type: "navigate", destination: a.destination as AtlasDestination };
    if (action && !out.some((x) => JSON.stringify(x) === JSON.stringify(action))) out.push(action);
    if (out.length === 4) break;
  }
  return out;
}

const RUN = /\b(generate|make|create|build|analy[sz]e|run|scan|find me|get me|give me)\b/i;
const PLAYS = /\b(om\s*ai\s*plays?|ai\s*plays?|play|signal generator)\b/i;
const GENX = /\bgen\s*x\b/i;
const PULSE = /\b(market pulse|pulse|scan (the )?markets?)\b/i;
const OPEN = /\b(open|show|take me|go to|switch to|bring up)\b/i;

function direct(message: string): AtlasAction[] {
  const s = message.trim();
  if (/^(?:please\s+)?(?:don't|do not|never|cancel)\b/i.test(s)) return [];
  const td = marketIn(s) ?? undefined, style = styleIn(s) ?? undefined;
  const actions: AtlasAction[] = [];
  if (RUN.test(s)) {
    if (PLAYS.test(s) || (!GENX.test(s) && td !== "XAU/USD" && /\b(signal|setup|trade|analy[sz]e)\b/i.test(s))) actions.push({ type: "plays", td, style });
    if (GENX.test(s) || (!PLAYS.test(s) && /\b(gold|xau\/?usd)\b/i.test(s) && /\b(analy[sz]e|read|setup|signal|trade)\b/i.test(s))) actions.push({ type: "genx", mode: /\bquick\b|\bscalp/i.test(s) ? "quick" : style === "intraday" || style === "swing" ? style : undefined });
    if (PULSE.test(s)) actions.push({ type: "pulse" });
  }
  if (actions.length) return normalizeAtlasActions(actions);
  if (OPEN.test(s)) {
    const choices: [RegExp, AtlasDestination][] = [
      [/\bcommand cent(?:er|re)\b/i, "command-center"], [PLAYS, "plays"], [GENX, "genx"], [PULSE, "pulse"],
      [/\b(flow|broker|accounts?)\b/i, "flow"], [/\bcredits?\b/i, "credits"], [/\btools?\b/i, "tools"], [/\b(floor|home)\b/i, "floor"],
    ];
    const destination = choices.find(([re]) => re.test(s))?.[1];
    if (destination) return [{ type: "navigate", destination }];
  }
  return [];
}

/** The same proposal planner for typed answers and final voice transcripts. It performs no work or billing. */
export function planAtlasActions(message: string, history: AtlasMessage[] = []): AtlasAction[] {
  const current = direct(message);
  const s = message.trim(), td = marketIn(s) ?? undefined, style = styleIn(s) ?? undefined;
  const shortReply = s.length <= 100 && (td || style || /^(?:yes|please|do it|go ahead|quick)[.!]?$/i.test(s));
  if ((!current.length && !shortReply) || /\b(don't|do not|cancel|stop|no)\b/i.test(s)) return current;
  const previous = [...history].reverse().filter((m) => m.role === "user").slice(0, 6);
  let priorTd: string | undefined, priorStyle: "scalp" | "intraday" | "swing" | undefined, quick = false;
  for (const turn of previous) {
    if (turn.content.length <= 160) {
      priorTd ??= marketIn(turn.content) ?? undefined;
      priorStyle ??= styleIn(turn.content) ?? undefined;
      if (!priorStyle && /\bquick\b/i.test(turn.content)) quick = true;
    }
    const action = direct(turn.content).find((a) => a.type === "plays" || a.type === "genx");
    if (!action) continue;
    const chosen = current.length ? current[0] : action;
    if (chosen.type !== action.type || current.length > 1) return current;
    if (chosen.type === "plays" && action.type === "plays") return normalizeAtlasActions([{ ...chosen, td: td ?? chosen.td ?? priorTd ?? action.td, style: style ?? chosen.style ?? priorStyle ?? action.style }]);
    if (chosen.type === "genx" && action.type === "genx" && !td) return normalizeAtlasActions([{ ...chosen, mode: /\bquick\b|\bscalp/i.test(s) ? "quick" : style === "intraday" || style === "swing" ? style : chosen.mode ?? (quick || priorStyle === "scalp" ? "quick" : priorStyle) ?? action.mode }]);
    return current;
  }
  return current;
}

export function atlasMessages(raw: unknown): AtlasMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is AtlasMessage => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 3000) }));
}
