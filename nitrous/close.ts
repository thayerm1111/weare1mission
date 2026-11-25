import type { BrokerPort } from "../rapid/exec/port";

export type CloseDispatchResult = {
  state: "cancelled" | "acknowledged" | "uncertain" | "rejected";
  error: string | null;
};
export type CloseAttempt = (CloseDispatchResult & { persisted: boolean }) | { state: "skipped"; reason: string };
export type CloseRequest = {
  positionId: string;
  held(): boolean;
  /** Revalidate the exact ledger identity and broker ownership; never infer ownership from a tag alone. */
  approved?(): Promise<boolean>;
  /** Atomically persist the dispatch claim before any broker call. False means someone already claimed it. */
  claim(): Promise<boolean>;
  /** A failed finish MUST leave the durable claim intact, including after a broker timeout. */
  finish(result: CloseDispatchResult): Promise<void>;
  port: Pick<BrokerPort, "close">;
};

/** One broker close per durable claim. Acknowledgement never means the position has closed. */
export async function requestCloseOnce(input: CloseRequest): Promise<CloseAttempt> {
  const allowed = async () => {
    if (!input.held()) return false;
    try { return (input.approved ? await input.approved() : true) && input.held(); }
    catch { return false; }
  };
  if (!input.positionId || !await allowed()) return { state: "skipped", reason: "Position ownership or approval is not current." };
  try {
    if (!await input.claim()) return { state: "skipped", reason: "Close already claimed or no longer eligible." };
  } catch { return { state: "skipped", reason: "Close claim could not be persisted." }; }
  const finish = async (result: CloseDispatchResult): Promise<CloseAttempt> => {
    try { await input.finish(result); return { ...result, persisted: true }; }
    catch { return { ...result, persisted: false }; }
  };
  if (!await allowed()) {
    // Known unsent. The store may release THIS claim for the next owner; no HTTP call occurred.
    return finish({ state: "cancelled", error: "Close was not dispatched because ownership or approval changed." });
  }
  let result: CloseDispatchResult;
  try {
    const response = await input.port.close(input.positionId);
    result = response.ok
      ? { state: "acknowledged", error: null }
      : { state: response.uncertain ? "uncertain" : "rejected", error: response.error };
  } catch { result = { state: "uncertain", error: "Broker close outcome unknown; reconcile before another request." }; }
  return finish(result);
}
