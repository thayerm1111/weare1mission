import { replay } from "../../../../../command-center/engines/replay";
import { replayEndOf, replayFollow, replayIdea } from "../../../../../command-center/engines/ideaReplay";
import { ideaText } from "../../../../../command-center/engines/idea";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE REPLAY ENDPOINT — real recorded gold, real engine, no live market.
 *
 * It exists so the experience can be built and reviewed when gold is shut, which is most of the weekend.
 * It is deliberately, loudly not live: `live` is false and `replay` is true, and the screen renders a
 * banner saying so. It never touches the live tables.
 */
export async function GET(req: Request) {
  try {
    // ?trade=1 attaches a position built from the recorded bars, so Trade Intelligence Mode can be
    // reviewed while the market is shut. It is still a replay and the banner still says so.
    const q = new URL(req.url).searchParams;
    const withTrade = q.get("trade") === "1";
    // ?end=N stands the replay N five-minute candles before the end of the recording, so a moment with a
    // trade in it can be reviewed — and followed on the recorded candles that came after it.
    const end = replayEndOf(q.get("end"));
    const r = replay(46, withTrade, end);
    return new Response(JSON.stringify({ ...r.state, replay: true, replaySteps: r.steps, replayEnd: end }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "replay_failed", detail: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}

/**
 * GENERATE WITH ATLAS, on the replay: the idea the engine would have given at the replayed moment, and how
 * it did on the recorded candles after it. Nothing is stored and nothing can be executed or watched.
 */
export async function POST(req: Request) {
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  try {
    const end = replayEndOf(new URL(req.url).searchParams.get("end"));
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "generate");
    if (action === "generate") {
      const idea = replayIdea(body.options, end);
      return json({ ok: true, replay: true, saved: false, idea, copy: ideaText(idea) });
    }
    if (action === "follow") {
      const r = replayFollow(String(body.id ?? ""));
      if (!r) return json({ ok: false, message: "That replayed idea could not be found." }, 404);
      return json({
        ok: true, replay: true, idea: r.idea, copy: ideaText(r.idea),
        update: { follow: r.follow, now: { price: null, lean: null, leanLabel: null, score: null, engine: null }, verdict: `REPLAY — ${r.follow.text}` },
      });
    }
    return json({ ok: false, message: "Not available in the replay." }, 400);
  } catch (e) {
    return json({ ok: false, error: "replay_failed", detail: e instanceof Error ? e.message : "unknown" }, 500);
  }
}
