import { handleVoiceLlm } from "../../../../../../command-center/brain/voiceLlm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The base path. Kept because it is what a person reaches for when testing the endpoint by hand. */
export async function POST(req: Request) {
  return handleVoiceLlm(req);
}
