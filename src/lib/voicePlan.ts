/**
 * THE COMMAND CENTER VOICE PLAN — pricing in one place, server and browser.
 *
 * This is the ONLY product on the site that is not paid for in credits, and the separation is
 * deliberate. Credits buy automated TRADING: FLOW, GENX, the Brain's autopilot, OM AI plays. This buys
 * TALKING to the Command Center. A member out of credits can still ask what gold is doing; a member out
 * of minutes still has every trade they paid for. Neither balance can be spent on the other, because
 * they are different tables with different writers.
 *
 * ON THE MARGIN, HONESTLY.
 *
 * Speech is metered by the minute by the provider, so the cost of this product is set by the minute
 * allowance, not by the price. At the working estimate of roughly eight cents a minute, a member who
 * uses every included minute costs about eighty dollars in speech, plus the model's own reasoning on
 * each turn of the conversation. The allowance is what keeps that bounded, which is why it is enforced
 * before a line opens rather than reconciled afterwards on an invoice.
 *
 * That per-minute figure is an ESTIMATE and has never been checked against a real invoice. Anyone
 * changing the price or the allowance should read one first.
 */

export type VoicePlan = {
  id: string;
  label: string;
  priceUsd: number;
  includedMinutes: number;
  blurb: string;
};

export const VOICE_PLAN: VoicePlan = {
  id: "cc_voice_1000",
  label: "Command Center Voice",
  priceUsd: 190,
  includedMinutes: 1000,
  blurb: "1,000 minutes a month talking to the Command Center about XAUUSD.",
};

export type VoiceTopup = {
  id: string;
  label: string;
  minutes: number;
  priceUsd: number;
};

/**
 * Extra minutes for the CURRENT billing period.
 *
 * Priced above the included rate on purpose — the allowance is the deal, a top-up is convenience — and
 * still comfortably above cost at the working per-minute estimate, so a heavy month cannot quietly
 * invert the margin.
 */
export const VOICE_TOPUPS: VoiceTopup[] = [
  { id: "voice_topup_250", label: "250 minutes", minutes: 250, priceUsd: 59 },
  { id: "voice_topup_500", label: "500 minutes", minutes: 500, priceUsd: 99 },
  { id: "voice_topup_1000", label: "1,000 minutes", minutes: 1000, priceUsd: 179 },
];

export const topupById = (id: string): VoiceTopup | null =>
  VOICE_TOPUPS.find((t) => t.id === id) ?? null;

/** Stripe metadata marker. The webhook branches on this — see the note in the webhook. */
export const VOICE_PRODUCT_TAG = "cc_voice";
