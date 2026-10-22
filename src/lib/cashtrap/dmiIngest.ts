import { M5 } from "./candles";
import { isCashtrapSymbol, type CashtrapSymbol } from "./symbols";

/**
 * THE DMI EVENT ADAPTER — the contract for timestamped DMI-Stochastic B/S events from outside
 * (e.g. TradingView alerts on the owner's own indicator, which cannot add headers, so the secret
 * travels in the URL or the body):
 *
 *   POST /api/cashtrap/dmi?key=<CASHTRAP_DMI_FEED_SECRET>
 *   { "symbol": "EURUSD" | "FX:EURUSD" | "EUR/USD", "signal": "B" | "S", "time": "<the 5-minute candle's OPEN time>",
 *     "source": "tradingview-alert", "version": "<indicator version>" }
 *
 * `time` is ISO-8601 or epoch milliseconds (TradingView's {{time}} is the bar's open time, UTC). It
 * must fall on a 5-minute boundary. Events are stored with the time they were received; the engine
 * uses an event only once it was known (and only in "event-feed" mode, once the feed is verified).
 */
export type IngestEvent = { symbol: CashtrapSymbol; candleT: number; type: "B" | "S"; source: string; sourceVersion: string | null };

export function normalizeSymbol(raw: unknown): CashtrapSymbol | null {
  const s = String(raw ?? "").toUpperCase().trim().replace(/^[A-Z0-9_]+:/, "").replace(/[^A-Z]/g, "");
  return isCashtrapSymbol(s) ? s : null;
}

export function parseDmiEvent(body: unknown): { ok: true; event: IngestEvent } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const symbol = normalizeSymbol(b.symbol ?? b.ticker);
  if (!symbol) return { ok: false, error: "symbol: USDJPY, EURUSD, XAUUSD or GBPJPY (an exchange prefix like FX: is fine)" };
  const sig = String(b.signal ?? b.type ?? "").toUpperCase().trim();
  const type = sig === "B" || sig === "BUY" ? "B" : sig === "S" || sig === "SELL" ? "S" : null;
  if (!type) return { ok: false, error: "signal: B or S" };
  const rawT = b.time ?? b.candleTime;
  const t = typeof rawT === "number" ? rawT : /^\d{12,14}$/.test(String(rawT)) ? Number(rawT) : Date.parse(String(rawT ?? ""));
  if (!Number.isFinite(t)) return { ok: false, error: "time: the candle's open time (ISO-8601 or epoch ms)" };
  if (t % M5 !== 0) return { ok: false, error: "time must be a 5-minute candle's open time" };
  return { ok: true, event: { symbol, candleT: t, type, source: String(b.source ?? "external").slice(0, 60), sourceVersion: b.version != null ? String(b.version).slice(0, 60) : null } };
}

/** Constant-time comparison of a presented secret with the configured one (false when none is configured). */
export function secretMatches(presented: string | null | undefined, configured: string | undefined): boolean {
  if (!configured || !presented) return false;
  const a = Buffer.from(presented), b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
