import type { BrokerPosition } from "../rapid/exec/port";
import type { NitrousActivationEvent } from "../src/lib/nitrous-telegram";

type Observation = {
  environment: "demo" | "live";
  setupId: string;
  positionId: string;
  strategyId: string;
  side: "buy" | "sell";
  observedAt: number;
  row: BrokerPosition | undefined;
};

export function createLiveActivationNotifier(
  publish: (event: NitrousActivationEvent) => Promise<{ ok: boolean; state: string }>,
  clock: () => number = Date.now,
) {
  const pending = new Set<string>();
  // The database claim survives restarts. This cache just avoids a claim on every poll.
  const delivered = new Set<string>();
  return async (obs: Observation) => {
    const age = clock() - obs.observedAt;
    const row = obs.row;
    if (obs.environment !== "live" || !row || !obs.positionId || !obs.strategyId.startsWith("NITROUS:") ||
        !/^nitrous:[a-f0-9]{32}$/.test(obs.setupId) || !Number.isFinite(age) || age < 0 || age > 30_000 ||
        row.positionId !== obs.positionId || row.strategyId !== obs.strategyId || row.side !== obs.side ||
        row.qty == null || !Number.isFinite(row.qty) || row.qty <= 0 ||
        row.entry == null || !Number.isFinite(row.entry) || row.entry <= 0 ||
        pending.has(obs.setupId) || delivered.has(obs.setupId)) return;
    pending.add(obs.setupId);
    try {
      const result = await publish({ kind: "activated", setupId: obs.setupId, side: obs.side, occurredAt: new Date(obs.observedAt).toISOString() });
      if (result.ok || result.state === "duplicate") {
        if (delivered.size >= 512) delivered.delete(delivered.values().next().value!);
        delivered.add(obs.setupId);
      }
    } catch { /* A future broker observation can retry before a durable delivery claim. */ }
    finally { pending.delete(obs.setupId); }
  };
}
