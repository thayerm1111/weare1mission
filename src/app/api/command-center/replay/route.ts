import { replay } from "../../../../../command-center/engines/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE REPLAY ENDPOINT — real recorded gold, real engine, no live market.
 *
 * It exists so the experience can be built and reviewed when gold is shut, which is most of the weekend.
 * It is deliberately, loudly not live: `live` is false and `replay` is true, and the screen renders a
 * banner saying so. It never touches the live tables.
 */
export async function GET() {
  try {
    const r = replay(46);
    return new Response(JSON.stringify({ ...r.state, replay: true, replaySteps: r.steps }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "replay_failed", detail: e instanceof Error ? e.message : "unknown" }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}
