import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { WELCOME_TUTORIAL } from "@/lib/onboarding/welcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Temporary production media export. Removed once the static tutorial is published.
// Only this fixed, public tutorial script can be narrated; no arbitrary input or key export.
const exportsInFlight = new Map<string, Promise<Response>>();
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("origin") !== req.nextUrl.origin) return json({ error: "Invalid origin." }, 403);
  const db = createClient();
  if (!db) return json({ error: "Service unavailable." }, 503);
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return json({ error: "Sign in required." }, 401);
  const { data: profile, error: roleError } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (roleError || profile?.role !== "admin") return json({ error: "Not found." }, 404);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return json({ error: "Narration provider is not configured." }, 503);
  const prior = exportsInFlight.get(user.id);
  if (prior) return (await prior).clone();

  const generation = (async () => {
    const chapters = WELCOME_TUTORIAL.chapters.map(chapter => ({
      id: chapter.id,
      narration: chapter.narration,
      spokenText: chapter.narration.replaceAll("OM AI", "O M AI").replaceAll("GENX", "Gen X").replaceAll("FLOW", "Flow").replaceAll("BUY", "Buy").replaceAll("SELL", "Sell"),
    }));
    const text = chapters.map(chapter => chapter.spokenText).join("\n\n");
    const voice = process.env.CC_VOICE_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: process.env.CC_VOICE_TTS_MODEL || "eleven_turbo_v2",
          voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: 0.94 },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) return json({ error: `Narration provider returned ${response.status}. No automatic retry was made.` }, 502);
      const media = await response.json();
      if (typeof media.audio_base64 !== "string" || !media.alignment) return json({ error: "Narration was returned without usable timing." }, 502);
      return json({ version: WELCOME_TUTORIAL.key, scriptHash: createHash("sha256").update(text).digest("hex"), text, chapters, audio_base64: media.audio_base64, alignment: media.alignment, normalized_alignment: media.normalized_alignment });
    } catch {
      return json({ error: "Narration export did not finish. No automatic retry was made." }, 502);
    }
  })();
  exportsInFlight.set(user.id, generation);
  return (await generation).clone();
}
