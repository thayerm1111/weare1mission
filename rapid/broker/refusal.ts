/**
 * SAY WHAT THE BROKER SAID (owner 09-29: "Rapid is also not working"). GenesisFX began answering
 * 403 "You are not allowed to use this API endpoint" on the owner's login on Monday 09-28; the
 * panel kept showing a stale "positions could not be read" from the last pass that wrote the row,
 * because the refusal was thrown past the write. A refusal now reads as what it is, names the fix,
 * and every other broker error is passed through unchanged.
 */
export const BROKER_API_ACCESS_OFF =
  "broker_api_access_off (403): the broker has API access switched off for this login, so Rapid cannot read or trade this account. Ask the broker to enable API access, then reconnect here.";

export function isBrokerRefusal(error: string): boolean {
  return /\(403\)|\b403\b|not allowed to use this API endpoint/i.test(error);
}

export function brokerReadProblem(error: string): string {
  return isBrokerRefusal(error) ? BROKER_API_ACCESS_OFF : error;
}
