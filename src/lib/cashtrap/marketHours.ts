/**
 * CASHTRAP TRADING HOURS — when a 5-minute candle is expected to exist, so that a missing candle can
 * be told apart from a closed market. Implementation assumption (configurable in code, documented):
 *
 *   fx    (USD/JPY, EUR/USD, GBP/JPY): closed from Friday 17:00 to Sunday 17:00 New York time.
 *         17:00–17:10 New York on weekdays is the daily rollover; a candle missing there is tolerated.
 *   metal (XAU/USD): closed from Friday 17:00 to Sunday 18:00 New York time, and 17:00–18:00 New York
 *         Monday to Thursday (the daily break).
 *
 * New York time is computed with the IANA zone, so daylight saving is handled.
 */
const NY = "America/New_York";
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Day of week (0 = Sunday) and minutes after midnight, New York time. */
export function nyClock(ms: number): { dow: number; min: number } {
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const h = Number(get("hour")) % 24;            // some ICU builds report midnight as "24"
  return { dow: DOW[get("weekday")] ?? 0, min: h * 60 + Number(get("minute")) };
}

const H17 = 17 * 60, H18 = 18 * 60;

/** Is the market open at this instant? */
export function isOpen(hours: "fx" | "metal", ms: number): boolean {
  const { dow, min } = nyClock(ms);
  if (dow === 6) return false;                                   // Saturday
  if (dow === 5 && min >= H17) return false;                     // Friday from 17:00
  if (hours === "fx") {
    if (dow === 0 && min < H17) return false;                    // Sunday before 17:00
    return true;
  }
  if (dow === 0 && min < H18) return false;                      // Sunday before 18:00
  if (dow >= 1 && dow <= 4 && min >= H17 && min < H18) return false; // daily break
  return true;
}

/** A candle starting here may be missing without it being a data problem (the fx daily rollover). */
export function tolerated(hours: "fx" | "metal", candleT: number): boolean {
  if (hours !== "fx") return false;
  const { dow, min } = nyClock(candleT);
  return dow >= 0 && dow <= 4 && min >= H17 && min < H17 + 10;
}

/** Is a 5-minute candle starting at `candleT` expected to exist? (Open at its start, and not a tolerated gap.) */
export function candleExpected(hours: "fx" | "metal", candleT: number): boolean {
  return isOpen(hours, candleT) && !tolerated(hours, candleT);
}
