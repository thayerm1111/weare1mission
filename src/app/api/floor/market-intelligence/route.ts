import { createClient } from "@/lib/supabase/server";
import { series } from "@/lib/marketData";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { createAtlasSnapshotFeed } from "@/lib/floor/marketSnapshotFeed";
import type { AtlasMarketSymbol } from "@/lib/floor/marketIntelligence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const SYMBOLS: AtlasMarketSymbol[]=["XAUUSD","EURUSD","GBPJPY","USDJPY"];
const feed=createAtlasSnapshotFeed((symbol,interval,count,timezone) =>
  series(symbol,interval,count,process.env.TWELVEDATA_API_KEY ?? "",false,timezone),
  Date.now,Number(process.env.MD_CACHE_TTL || 30)*1_000);
const json=(body: unknown,status=200) => new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json","cache-control":"private, no-store"},
});

/** Authenticated, read-only OHLC context. No paid plan fields, strategy gates,
 * credit deductions or order routes are touched by this endpoint. */
export async function GET(req: Request) {
  const supabase=createClient();
  if (!supabase) return json({error:"not_configured"},503);
  const {data:{user},error}=await supabase.auth.getUser();
  if (error || !user) return json({error:"unauthorized"},401);
  const symbol=new URL(req.url).searchParams.get("symbol") ?? "XAUUSD";
  if (!SYMBOLS.includes(symbol as AtlasMarketSymbol)) return json({error:"unsupported_market"},400);
  if (!process.env.TWELVEDATA_API_KEY) return json({error:"marketdata_not_configured"},503);
  const market=symbol as AtlasMarketSymbol;
  const snapshot=await feed.get(market,isOpen(market === "XAUUSD"?"metal":"fx",Date.now()));
  // Partial failures remain six explicit statuses. A failed daily pull is not
  // filled with shorter candles, and successful frames remain usable.
  return json(snapshot);
}
