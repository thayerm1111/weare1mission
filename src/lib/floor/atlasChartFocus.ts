import type { AtlasPositionedZone } from "./marketIntelligence";
import type { TimedBar } from "../chart/candleTime";
import type { StructureZone } from "../chart/structure";
import type { ChartLevel } from "./chart";

export function zoneRole(zone: AtlasPositionedZone): StructureZone["kind"] {
  if (zone.role !== "testing") return zone.role;
  if (!zone.roleReversed) return zone.origin;
  return zone.origin === "support" ? "resistance" : "support";
}

/** The price marker is positioned only when the quote is actually inside an observed band. */
export function atlasChartFocus(active: AtlasPositionedZone | null, nearby: (AtlasPositionedZone | null)[],
  price: number | null, bars: TimedBar[], current: boolean) {
  const levels: ChartLevel[] = [];
  const zones: StructureZone[] = [];
  let meter: { low: number; high: number; role: StructureZone["kind"]; percent: number } | null = null;
  if (!current || price == null || !Number.isFinite(price) || price <= 0) return { levels, zones, meter };

  const usable = (z: AtlasPositionedZone | null): z is AtlasPositionedZone => z != null &&
    [z.low, z.high, z.price].every(v => Number.isFinite(v) && v > 0) && z.low <= z.price && z.price <= z.high;
  const inside = usable(active) && price >= active.low && price <= active.high ? active : null;
  const distance = (z: AtlasPositionedZone) => Math.max(z.low - price, price - z.high, 0);
  const recent = bars.slice(-20);
  const span = recent.length ? Math.max(...recent.map(b => b.h)) - Math.min(...recent.map(b => b.l)) : 0;
  const candidates = nearby.filter(usable).filter(z => z.id !== inside?.id && distance(z) <= span)
    .sort((a, b) => distance(a) - distance(b));
  const chosen = inside ? [inside, ...candidates.filter(z => zoneRole(z) !== zoneRole(inside)).slice(0, 1)] : candidates.slice(0, 2);
  for (const z of chosen) {
    const kind = zoneRole(z);
    const band = z === inside && z.high > z.low;
    const name = kind === "support" ? "Support" : "Resistance";
    const label = name + (band ? " band" : "");
    // Keep the other side as one quiet boundary, leaving the tested band in focus.
    const boundary = kind === "support" ? z.high : z.low;
    levels.push({ kind, price: z === inside ? z.price : boundary, label });
    if (band) {
      zones.push({ low: z.low, high: z.high, kind, label });
      meter = { low: z.low, high: z.high, role: kind, percent: (price - z.low) / (z.high - z.low) * 100 };
    }
  }
  return { levels, zones, meter };
}
