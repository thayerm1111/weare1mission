export type WaitingDecision = {
  accountId: string;
  userId?: string;
  setupId?: string;
  snapshotId?: string;
  stage: string;
  code: string;
  decision: "wait" | "skip";
  reason: string;
  evidence?: Record<string, string | number | boolean | null | readonly string[]>;
};

/** Best-effort observations only. The caller never waits for this writer before trading. */
export function createWaitingDiagnostics(write: (row: WaitingDecision) => Promise<void>, capacity = 2048) {
  const recent = new Map<string, { signature: string; result: Promise<boolean> }>();
  const limit = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 2048;
  return (row: WaitingDecision): Promise<boolean> => {
    const scope = JSON.stringify([row.accountId, row.stage, row.setupId ?? null]);
    const signature = JSON.stringify([row.code, row.decision, row.reason]);
    const previous = recent.get(scope);
    if (previous?.signature === signature) return previous.result;

    const entry = { signature, result: Promise.resolve(false) };
    // Start on a microtask so synchronous writer failures are contained as well.
    entry.result = Promise.resolve().then(() => write(row)).then(() => true).catch(() => {
      // A failed older write must not erase a newer successful observation.
      if (recent.get(scope) === entry) recent.delete(scope);
      return false;
    });
    recent.delete(scope);
    recent.set(scope, entry);
    if (recent.size > limit) recent.delete(recent.keys().next().value!);
    return entry.result;
  };
}
