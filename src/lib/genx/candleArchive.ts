import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GOLD CANDLE ARCHIVE (owner 09-15: replay GENX changes against real past price action).
 * Keeps XAU/USD 1-minute candles in genx_candle_archive. Each run fetches ONE page
 * (max 5000 bars) — the newest gap first, then walks backwards until BACKFILL_DAYS are
 * covered — so it spends at most one TwelveData credit per monitor tick. Read-only market
 * data; never touches trading. Best-effort: any error just skips this tick.
 */
const SYMBOL = "XAU/USD";
const INTERVAL = "1min";
const BACKFILL_DAYS = 35;
const PAGE = 5000;

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
type TdRow = { datetime: string; open: string; high: string; low: string; close: string };

const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

export async function archiveGoldCandles(admin: Admin): Promise<Record<string, unknown>> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return { ran: false, reason: "no_key" };
  try {
    const q = (asc: boolean) => admin.from("genx_candle_archive").select("t").eq("symbol", SYMBOL).eq("interval", INTERVAL).order("t", { ascending: asc }).limit(1).maybeSingle();
    const [{ data: newest }, { data: oldest }] = await Promise.all([q(false), q(true)]);
    const newestT = newest ? new Date((newest as { t: string }).t).getTime() : null;
    const oldestT = oldest ? new Date((oldest as { t: string }).t).getTime() : null;
    const target = Date.now() - BACKFILL_DAYS * 86400e3;

    let endDate: Date | null = null; // null = up to now
    let mode = "latest";
    if (newestT != null && Date.now() - newestT < 30 * 60e3) {
      if (oldestT != null && oldestT <= target) return { ran: false, reason: "covered" };
      endDate = new Date(oldestT!); mode = "backfill";
    }

    // TwelveData datetimes are exchange-local unless timezone=UTC is requested.
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}&interval=${INTERVAL}&outputsize=${PAGE}&timezone=UTC&order=ASC${endDate ? `&end_date=${encodeURIComponent(fmt(endDate))}` : ""}&apikey=${key}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = (await r.json()) as { status?: string; values?: TdRow[]; message?: string };
    if (j.status === "error" || !Array.isArray(j.values)) return { ran: false, reason: "td_error", detail: String(j.message || "").slice(0, 80) };

    const rows = j.values.map((v) => ({
      symbol: SYMBOL, interval: INTERVAL, t: `${v.datetime.replace(" ", "T")}Z`,
      o: Number(v.open), h: Number(v.high), l: Number(v.low), c: Number(v.close),
    })).filter((x) => [x.o, x.h, x.l, x.c].every(Number.isFinite));
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await admin.from("genx_candle_archive").upsert(rows.slice(i, i + 1000), { onConflict: "symbol,interval,t", ignoreDuplicates: true });
      if (error) return { ran: false, reason: "db_error", detail: error.message.slice(0, 80) };
    }
    return { ran: true, mode, rows: rows.length, from: rows[0]?.t, to: rows[rows.length - 1]?.t };
  } catch (e) {
    return { ran: false, reason: "exception", detail: String(e).slice(0, 80) };
  }
}
