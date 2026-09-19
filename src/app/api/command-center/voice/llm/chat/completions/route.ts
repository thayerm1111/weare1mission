import { handleVoiceLlm } from "../../../../../../../../command-center/brain/voiceLlm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE PATH THE PROVIDER ACTUALLY CALLS.
 *
 * A custom-LLM url is an OpenAI BASE url: the provider appends `/chat/completions` to it. Ours was
 * configured at the handler's own address, so every turn landed on a 404 and the agent answered with
 * silence — no error, no close, nothing to see from the browser at all.
 */
export async function POST(req: Request) {
  return handleVoiceLlm(req);
}
