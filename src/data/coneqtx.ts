/**
 * ConeqtX comp plan — the compensation structure 1 Mission builders operate inside.
 * 1 Mission is a team INSIDE ConeqtX (ConectivGlobal), so these are the official
 * ConeqtX ranks, memberships, and bonuses — not a 1 Mission-specific plan.
 *
 * Source: official ConeqtX Bonus Table, Membership Options, Referral Program,
 * and Prepay Bonus Details slides (provided by the founder).
 * Binary comp plan: volume is tracked on a Left and Right leg.
 */

export type Rank = {
  position: number;
  name: string;
  abbr?: string;
  /** Total group volume required to hold the rank (display string). */
  totalVolume: string;
  /** Volume required per side / leg (display string). */
  perSide: string;
  /** Max % of the requirement that can come from a single enrollment line. */
  fromOneLine: string;
  weeklyPay: number;
  monthlyTotal: number;
  /** Active / leg-depth requirement, e.g. "2L 2R". */
  activeReq: string;
  /** Generational override bonus at this rank ("—" if none). */
  override: string;
};

export const RANKS: Rank[] = [
  { position: 1,  name: "Consultant",                    totalVolume: "4 Personally Enrolled", perSide: "—",        fromOneLine: "—",    weeklyPay: 45,     monthlyTotal: 179,     activeReq: "4 Core Members (Left or Right)", override: "—" },
  { position: 2,  name: "Senior Consultant",             totalVolume: "1,200",     perSide: "600",       fromOneLine: "100%", weeklyPay: 150,    monthlyTotal: 600,     activeReq: "4 Core Members (Left or Right)", override: "—" },
  { position: 3,  name: "Executive Consultant",          totalVolume: "3,000",     perSide: "1,500",     fromOneLine: "65%",  weeklyPay: 250,    monthlyTotal: 1000,    activeReq: "2L 2R", override: "—" },
  { position: 4,  name: "Marketing Director",            totalVolume: "7,000",     perSide: "3,500",     fromOneLine: "50%",  weeklyPay: 500,    monthlyTotal: 2000,    activeReq: "2L 2R", override: "—" },
  { position: 5,  name: "Regional Marketing Director",   abbr: "RMD", totalVolume: "20,000",    perSide: "10,000",    fromOneLine: "50%",  weeklyPay: 925,    monthlyTotal: 3700,    activeReq: "2L 2R", override: "5.00%" },
  { position: 6,  name: "National Marketing Director",   abbr: "NMD", totalVolume: "50,000",    perSide: "25,000",    fromOneLine: "50%",  weeklyPay: 2250,   monthlyTotal: 9000,    activeReq: "2L 2R", override: "5.00%" },
  { position: 7,  name: "International Marketing Director", abbr: "IMD", totalVolume: "100,000",   perSide: "50,000",    fromOneLine: "50%",  weeklyPay: 4375,   monthlyTotal: 17500,   activeReq: "3L 3R", override: "4.00%" },
  { position: 8,  name: "Vice President",                abbr: "VP",  totalVolume: "200,000",   perSide: "100,000",   fromOneLine: "50%",  weeklyPay: 8750,   monthlyTotal: 35000,   activeReq: "3L 3R", override: "4.00%" },
  { position: 9,  name: "Executive Vice President",      abbr: "EVP", totalVolume: "250,000",   perSide: "125,000",   fromOneLine: "50%",  weeklyPay: 10625,  monthlyTotal: 42500,   activeReq: "3L 3R", override: "3.00%" },
  { position: 10, name: "Senior Vice President",         abbr: "SVP", totalVolume: "500,000",   perSide: "250,000",   fromOneLine: "50%",  weeklyPay: 21250,  monthlyTotal: 85000,   activeReq: "3L 3R", override: "3.00%" },
  { position: 11, name: "Visionary",                     totalVolume: "1,000,000", perSide: "500,000",   fromOneLine: "50%",  weeklyPay: 43750,  monthlyTotal: 175000,  activeReq: "3L 3R", override: "2.00%" },
  { position: 12, name: "Icon",                          totalVolume: "2,500,000", perSide: "1,250,000", fromOneLine: "50%",  weeklyPay: 100000, monthlyTotal: 400000,  activeReq: "3L 3R", override: "1.00%" },
  { position: 13, name: "Elite",                         totalVolume: "5,000,000", perSide: "2,500,000", fromOneLine: "50%",  weeklyPay: 187500, monthlyTotal: 750000,  activeReq: "3L 3R", override: "0.50%" },
  { position: 14, name: "Legend",                        totalVolume: "7,500,000", perSide: "3,750,000", fromOneLine: "50%",  weeklyPay: 250000, monthlyTotal: 1000000, activeReq: "3L 3R", override: "0.25%" },
];

export type MembershipFeature = { label: string; desc: string; core: boolean; pro: boolean };

export const MEMBERSHIP_FEATURES: MembershipFeature[] = [
  { label: "Academy",      desc: "Videos and eBooks on personal finance and investing", core: true,  pro: true },
  { label: "Live Streams", desc: "Live sessions with market insights and analysis",     core: true,  pro: true },
  { label: "Trading Tools",desc: "Trading calendars, journals, and daily technical analysis", core: true, pro: true },
  { label: "Tap to Trade", desc: "Tap-to-trade technology for precise entries",         core: true,  pro: true },
  { label: "Alerts",       desc: "Choose your markets and get real-time trade ideas",   core: true,  pro: true },
  { label: "Scanners",     desc: "Identify market opportunities with real-time scanners", core: false, pro: true },
  { label: "Getaways",     desc: "Choose from 50 global destinations for two",          core: false, pro: true },
  { label: "Travel",       desc: "Savings on hotels, flights, cars, parks, and events", core: false, pro: true },
];

export type Membership = {
  name: "Core" | "Pro";
  oneTime: number;
  monthly: number;
  /** Standard monthly referral bonuses. */
  referral: { l1: number; l2: number; bv: number };
};

export const MEMBERSHIPS: Membership[] = [
  { name: "Core", oneTime: 249, monthly: 179, referral: { l1: 40, l2: 10, bv: 100 } },
  { name: "Pro",  oneTime: 499, monthly: 179, referral: { l1: 80, l2: 20, bv: 200 } },
];

export type Prepay = {
  plan: "Core" | "Pro";
  term: string;
  days: number;
  l1: number;
  l2: number;
  upfrontCv: number;
  monthlyCv: number;
  renewalBonus: number;
};

export const PREPAY: Prepay[] = [
  { plan: "Core", term: "3 Month", days: 84,  l1: 50,  l2: 15, upfrontCv: 200, monthlyCv: 50, renewalBonus: 10 },
  { plan: "Core", term: "6 Month", days: 168, l1: 60,  l2: 15, upfrontCv: 350, monthlyCv: 50, renewalBonus: 10 },
  { plan: "Core", term: "1 Year",  days: 365, l1: 200, l2: 65, upfrontCv: 650, monthlyCv: 50, renewalBonus: 10 },
  { plan: "Pro",  term: "3 Month", days: 84,  l1: 85,  l2: 30, upfrontCv: 300, monthlyCv: 50, renewalBonus: 10 },
  { plan: "Pro",  term: "6 Month", days: 168, l1: 100, l2: 25, upfrontCv: 450, monthlyCv: 50, renewalBonus: 10 },
  { plan: "Pro",  term: "1 Year",  days: 365, l1: 235, l2: 85, upfrontCv: 750, monthlyCv: 50, renewalBonus: 10 },
];

/** Rank names only, lowest → highest — for progress ladders elsewhere. */
export const RANK_NAMES = RANKS.map((r) => r.name);

/** Parse a display string like "10,000" → 10000; "—" / "4 Personally Enrolled" → 0. */
export function parseNum(s: string): number {
  if (!s || /[a-z]/i.test(s)) return 0; // words (Consultant row) → no numeric volume gate
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Minimum personally-enrolled members to be active (Consultant entry). */
export const REQUIRED_PERSONALS = 4;

export type BuilderStats = { personals: number; leftVol: number; rightVol: number };

export type RankProgress = {
  current: Rank | null;
  next: Rank | null;
  /** Weaker (pay) leg volume — the binding side in a binary plan. */
  weakerLeg: number;
  active: boolean;
  /** 0–1 progress toward `next`. */
  progress: number;
  /** Human-readable gap to the next rank. */
  gapLabel: string;
};

/**
 * Compute a builder's ConeqtX rank from their numbers. Qualification model:
 * you must be active (≥4 personally enrolled) and hold the required per-side
 * volume on your weaker leg. This mirrors the Bonus Table's per-side column;
 * the live ConeqtX feed will be authoritative once connected.
 */
export function computeRank(stats: BuilderStats): RankProgress {
  const weakerLeg = Math.max(0, Math.min(stats.leftVol, stats.rightVol));
  const active = stats.personals >= REQUIRED_PERSONALS;

  let current: Rank | null = null;
  for (const r of RANKS) {
    const qualifies = active && weakerLeg >= parseNum(r.perSide);
    if (qualifies) current = r;
    else break; // per-side requirement is monotonic — first miss ends the climb
  }

  const idx = current ? RANKS.findIndex((r) => r.position === current!.position) : -1;
  const next = RANKS[idx + 1] ?? null;

  let progress = 1;
  let gapLabel = "You've reached the top rank — Legend.";
  if (!current) {
    // Goal is Consultant: enroll 4 core members.
    const need = Math.max(0, REQUIRED_PERSONALS - stats.personals);
    progress = Math.min(1, stats.personals / REQUIRED_PERSONALS);
    gapLabel = need > 0 ? `Enroll ${need} more core member${need === 1 ? "" : "s"} to reach Consultant` : "";
  } else if (next) {
    const target = parseNum(next.perSide);
    const gap = Math.max(0, target - weakerLeg);
    progress = target > 0 ? Math.min(1, weakerLeg / target) : 1;
    gapLabel = gap > 0
      ? `${gap.toLocaleString()} more volume on your weaker leg to reach ${next.name}`
      : `You qualify for ${next.name} — update to lock it in`;
  }

  return { current, next, weakerLeg, active, progress, gapLabel };
}
