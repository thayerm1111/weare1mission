/** Rolling latency histogram with p50/p95/p99. "unavailable" is reported when a stage has no samples. */
export class Latency {
  private samples: number[] = [];
  constructor(private max = 2000) {}
  add(ms: number) { if (Number.isFinite(ms) && ms >= 0) { this.samples.push(ms); if (this.samples.length > this.max) this.samples.shift(); } }
  get count() { return this.samples.length; }
  stats(): { p50: number; p95: number; p99: number; n: number; max: number } | { unavailable: true; n: 0 } {
    if (!this.samples.length) return { unavailable: true, n: 0 };
    const s = [...this.samples].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    return { p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), n: s.length, max: +s[s.length - 1].toFixed(2) };
  }
}

export type LatencyReport = Record<string, ReturnType<Latency["stats"]>>;
export class LatencySet {
  private m = new Map<string, Latency>();
  add(stage: string, ms: number) { let l = this.m.get(stage); if (!l) { l = new Latency(); this.m.set(stage, l); } l.add(ms); }
  report(stages: string[]): LatencyReport { const out: LatencyReport = {}; for (const s of stages) out[s] = this.m.get(s)?.stats() ?? { unavailable: true, n: 0 }; return out; }
}
