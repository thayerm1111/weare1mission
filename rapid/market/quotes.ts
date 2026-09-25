import type { Quote, QuoteSource } from "../core/types";

/**
 * Quote intake.
 *
 * Three rules, each of which has burned somebody before:
 *  - Two different quotes can share a timestamp. Identity is (source, seq) when a sequence exists,
 *    and (source, bid, ask, timestamp) otherwise. Deduplicating on timestamp alone DROPS REAL TICKS.
 *  - A late event may be recorded but must not retroactively change a signal that has been issued.
 *  - A quote is only comparable to another quote from the same source.
 */
export class QuoteStream {
  private last: Quote | null = null;
  private seen = new Set<string>();
  private order: string[] = [];
  private lateCount = 0;
  private dupCount = 0;

  constructor(
    readonly source: QuoteSource,
    private readonly reorderWindowMs: number,
    private readonly memory = 4096,
  ) {}

  private identity(q: Quote): string {
    if (q.seq) return `${q.seq}`;
    return `${q.providerTs ?? "n"}|${q.bid}|${q.ask}`;
  }

  /**
   * Returns how the quote was treated. `accepted` means it is now the current quote; `late` means it
   * was outside the reorder window and is recorded only; `duplicate` means it was already seen.
   */
  accept(q: Quote): { status: "accepted" | "late" | "duplicate" | "invalid"; reason?: string } {
    if (!(q.bid > 0) || !(q.ask > 0)) return { status: "invalid", reason: "non-positive price" };
    if (q.ask < q.bid) return { status: "invalid", reason: "crossed book" };

    const id = this.identity(q);
    if (this.seen.has(id)) {
      this.dupCount++;
      return { status: "duplicate" };
    }
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.memory) {
      const drop = this.order.shift();
      if (drop) this.seen.delete(drop);
    }

    const prevEvent = this.last ? eventTime(this.last) : -Infinity;
    const thisEvent = eventTime(q);
    if (this.last && thisEvent < prevEvent - this.reorderWindowMs) {
      this.lateCount++;
      return { status: "late", reason: `event ${prevEvent - thisEvent}ms behind the current quote` };
    }
    if (!this.last || thisEvent >= prevEvent) this.last = q;
    return { status: "accepted" };
  }

  current(): Quote | null {
    return this.last;
  }

  /**
   * Age of the current quote. Measured from the provider's event time when it supplied one, and from
   * server receipt otherwise — TradeLocker's /quotes supplies none, so its age is receipt age and is
   * labelled as such.
   */
  ageMs(now: number): number | null {
    if (!this.last) return null;
    return Math.max(0, now - eventTime(this.last));
  }

  stats() {
    return { late: this.lateCount, duplicates: this.dupCount, tracked: this.order.length };
  }
}

export function eventTime(q: Quote): number {
  return q.providerTs ?? q.receivedAt;
}

/**
 * Rolling price basis between a reference feed and the broker feed, measured on timestamp-aligned
 * mids. Reported with its own uncertainty so the caller can refuse to execute when the relationship
 * between two sources is not stable enough to translate a level across them.
 */
export class BasisTracker {
  private samples: number[] = [];

  constructor(private readonly window = 120) {}

  /** Both mids must be from quotes received within `toleranceMs` of each other. */
  add(brokerMid: number, referenceMid: number, brokerAt: number, referenceAt: number, toleranceMs = 2000): boolean {
    if (Math.abs(brokerAt - referenceAt) > toleranceMs) return false;
    if (!Number.isFinite(brokerMid) || !Number.isFinite(referenceMid)) return false;
    this.samples.push(brokerMid - referenceMid);
    if (this.samples.length > this.window) this.samples.shift();
    return true;
  }

  /** Median basis and a robust spread estimate. `null` when there is not enough evidence. */
  state(minSamples = 20): { median: number; mad: number; n: number } | null {
    if (this.samples.length < minSamples) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    const median = s[Math.floor(s.length / 2)];
    const devs = s.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
    const mad = devs[Math.floor(devs.length / 2)];
    return { median, mad, n: s.length };
  }

  /** Translate a reference-feed price onto the broker's basis. Null when the basis is not measurable. */
  translate(referencePrice: number, minSamples = 20): number | null {
    const st = this.state(minSamples);
    if (!st) return null;
    return referencePrice + st.median;
  }
}
