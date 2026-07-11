/**
 * Platform messaging config + senders (Resend for email, Twilio for SMS).
 *
 * These features stay OFF until you add the relevant environment variables, so
 * the app builds and runs without them. Add these in Vercel → Env Variables:
 *
 *   EMAIL:  RESEND_API_KEY, RESEND_FROM   (e.g. RESEND_FROM="1 Mission <team@weare1mission.com>")
 *   SMS:    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  (your Twilio number, e.g. +18005551234)
 *
 * COMPLIANCE NOTE: you are responsible for lawful use — get consent before
 * texting (TCPA), honor opt-outs, and identify yourself in emails (CAN-SPAM).
 */
export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
export const RESEND_FROM = process.env.RESEND_FROM ?? "";
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
export const TWILIO_FROM = process.env.TWILIO_FROM ?? "";

export const isEmailConfigured = Boolean(RESEND_API_KEY && RESEND_FROM);
export const isSmsConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);

/** Send one email per recipient via Resend. Returns count sent. */
export async function sendEmails(
  recipients: string[], subject: string, text: string, replyTo?: string
): Promise<number> {
  if (!isEmailConfigured) return 0;
  const batch = recipients.map((to) => ({
    from: RESEND_FROM,
    to: [to],
    subject,
    text,
    ...(replyTo ? { reply_to: replyTo } : {}),
  }));
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
  return res.ok ? recipients.length : 0;
}

/** Send one SMS per recipient via Twilio. Returns count sent. */
export async function sendTexts(recipients: string[], body: string): Promise<number> {
  if (!isSmsConfigured) return 0;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  let sent = 0;
  for (const to of recipients) {
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (res.ok) sent++;
  }
  return sent;
}
