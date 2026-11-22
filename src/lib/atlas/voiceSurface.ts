import { createHmac, timingSafeEqual } from "node:crypto";

/** Bound to the existing opaque DB token. Changing a forwarded surface cannot change the server's mode. */
export function signAppVoiceSurface(token: string, secret = process.env.CC_VOICE_LLM_SECRET ?? ""): string | null {
  if (!token || !secret) return null;
  return `app.${createHmac("sha256", secret).update(`atlas-app-voice-v1\n${token}`).digest("base64url")}`;
}

export function isAppVoiceSurface(token: string, claim: unknown, secret = process.env.CC_VOICE_LLM_SECRET ?? ""): boolean {
  const expected = signAppVoiceSurface(token, secret);
  if (!expected || typeof claim !== "string" || claim.length !== expected.length) return false;
  const given = Buffer.from(claim), wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
