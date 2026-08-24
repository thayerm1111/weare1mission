/**
 * Real game-context enrichment from FREE public sources — NO fabrication.
 *
 *  - ESPN public JSON (no key): team records (overall/home/road), probable
 *    starting pitchers with W-L + ERA (MLB), venue + indoor flag, and injuries.
 *  - Open-Meteo (no key): game-time weather for OUTDOOR games (temp, wind,
 *    precip), gated by ESPN's `indoor` flag so we never invent weather for a
 *    domed/roofed game.
 *
 * Everything returned here is real data pulled at request time. When a field
 * isn't available (e.g. a team we can't match, an indoor game, a sport ESPN
 * doesn't give pitchers for), we return null/empty and the caller marks it
 * "not available" — the AImust never fill the gap with a guess.
 */
import type { League } from "./provider";

const SPORT_PATH: Record<League, string> = {
  NFL: "football/nfl",
  NBA: "basketball/nba",
  MLB: "baseball/mlb",
};

export type TeamContext = {
  name: string;
  overall: string | null;   // e.g. "68-52"
  home: string | null;      // home record
  road: string | null;      // road record
  probablePitcher: string | null; // "Zack Wheeler — 12-6, 2.85" (MLB)
};

export type Weather = {
  tempF: number | null;
  windMph: number | null;
  windDir: string | null;
  precipPct: number | null;
  conditions: string | null;
  source: string;
} | null;

export type Injury = { team: string; player: string; status: string; note: string };

export type GameContext = {
  matched: boolean;
  home: TeamContext | null;
  away: TeamContext | null;
  venue: string | null;
  indoor: boolean | null;
  date: string | null;
  weather: Weather;
  injuriesHome: Injury[];
  injuriesAway: Injury[];
  notes: string[]; // honest notes about what was/wasn't available
};

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function nickname(s: string): string {
  const parts = (s || "").trim().split(/\s+/);
  return norm(parts[parts.length - 1] || s);
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ─── ESPN scoreboard → per-game context ─────────────────────────────────── */
type AnyObj = Record<string, unknown>;
const arr = (x: unknown): AnyObj[] => (Array.isArray(x) ? (x as AnyObj[]) : []);
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);

function pickRecord(records: AnyObj[], kind: "overall" | "home" | "road"): string | null {
  for (const r of records) {
    const t = `${(r.type as string) || ""} ${(r.name as string) || ""}`.toLowerCase();
    if (kind === "overall" && (t.includes("total") || t.includes("overall"))) return str(r.summary);
    if (kind === "home" && t.includes("home")) return str(r.summary);
    if (kind === "road" && (t.includes("road") || t.includes("away"))) return str(r.summary);
  }
  // Fallback to positional (ESPN commonly returns [overall, home, road]).
  const idx = kind === "overall" ? 0 : kind === "home" ? 1 : 2;
  return records[idx] ? str(records[idx].summary) : null;
}

function teamFromCompetitor(c: AnyObj): TeamContext {
  const team = (c.team as AnyObj) || {};
  const records = arr(c.records);
  const probs = arr(c.probables);
  let probablePitcher: string | null = null;
  if (probs.length) {
    const p = probs[0];
    const ath = (p.athlete as AnyObj) || {};
    const nm = str(ath.fullName) || str(ath.displayName);
    const rec = str(p.record); // often "7-1, 1.71" (W-L, ERA)
    if (nm) probablePitcher = rec ? `${nm} — ${rec}` : nm;
  }
  return {
    name: str(team.displayName) || str(team.name) || "",
    overall: pickRecord(records, "overall"),
    home: pickRecord(records, "home"),
    road: pickRecord(records, "road"),
    probablePitcher,
  };
}

// Short-lived promise cache so a batch of per-game context lookups (each of
// which needs the league scoreboard + injury feed) triggers ONE ESPN fetch per
// league, not one per game. We cache the in-flight Promise itself, so even
// concurrent calls that start before the first resolves share a single request.
const FEED_TTL_MS = 30_000;
type CacheEntry<T> = { at: number; p: Promise<T> };
const scoreboardCache = new Map<League, CacheEntry<AnyObj[]>>();
const injuriesCache = new Map<League, CacheEntry<Map<string, Injury[]>>>();

async function espnScoreboard(league: League): Promise<AnyObj[]> {
  const hit = scoreboardCache.get(league);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.p;
  const p = espnScoreboardUncached(league);
  scoreboardCache.set(league, { at: Date.now(), p });
  try {
    return await p;
  } catch (e) {
    scoreboardCache.delete(league); // don't pin a failed fetch for the whole TTL
    throw e;
  }
}

async function espnScoreboardUncached(league: League): Promise<AnyObj[]> {
  const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${SPORT_PATH[league]}/scoreboard`);
  return j ? arr(j.events) : [];
}

async function espnInjuries(league: League): Promise<Map<string, Injury[]>> {
  const hit = injuriesCache.get(league);
  if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.p;
  const p = espnInjuriesUncached(league);
  injuriesCache.set(league, { at: Date.now(), p });
  try {
    return await p;
  } catch (e) {
    injuriesCache.delete(league);
    throw e;
  }
}

async function espnInjuriesUncached(league: League): Promise<Map<string, Injury[]>> {
  const map = new Map<string, Injury[]>();
  const j = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${SPORT_PATH[league]}/injuries`);
  if (!j) return map;
  for (const teamBlock of arr(j.injuries)) {
    const teamName = str(teamBlock.displayName) || "";
    const list: Injury[] = [];
    for (const inj of arr(teamBlock.injuries)) {
      const ath = (inj.athlete as AnyObj) || {};
      const type = (inj.type as AnyObj) || {};
      const player = str(ath.displayName) || str(ath.fullName);
      if (!player) continue;
      list.push({
        team: teamName,
        player,
        status: str(type.description) || str(inj.status) || "—",
        note: (str(inj.shortComment) || "").slice(0, 200),
      });
    }
    if (teamName) map.set(norm(teamName), list);
  }
  return map;
}

/* ─── MLB park coordinates (metro-level) for Open-Meteo weather ───────────── */
// Keyed by team nickname. Metro-level is enough for game-time temp/wind/precip.
// Weather is only fetched when ESPN reports the venue is NOT indoor.
const MLB_COORDS: Record<string, [number, number]> = {
  diamondbacks: [33.45, -112.07], braves: [33.89, -84.47], orioles: [39.28, -76.62],
  redsox: [42.35, -71.10], red_sox: [42.35, -71.10], cubs: [41.95, -87.66],
  whitesox: [41.83, -87.63], white_sox: [41.83, -87.63], reds: [39.10, -84.51],
  guardians: [41.50, -81.69], rockies: [39.76, -104.99], tigers: [42.34, -83.05],
  astros: [29.76, -95.36], royals: [39.05, -94.48], angels: [33.80, -117.88],
  dodgers: [34.07, -118.24], marlins: [25.78, -80.22], brewers: [43.03, -87.97],
  twins: [44.98, -93.28], mets: [40.76, -73.85], yankees: [40.83, -73.93],
  athletics: [38.58, -121.51], phillies: [39.91, -75.17], pirates: [40.45, -80.01],
  padres: [32.71, -117.16], giants: [37.78, -122.39], mariners: [47.59, -122.33],
  cardinals: [38.62, -90.19], rays: [27.98, -82.51], rangers: [32.75, -97.08],
  bluejays: [43.64, -79.39], blue_jays: [43.64, -79.39], nationals: [38.87, -77.01],
};

const WMO: Array<[number[], string]> = [
  [[0], "Clear"], [[1, 2], "Partly cloudy"], [[3], "Overcast"],
  [[45, 48], "Fog"], [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67], "Rain"], [[71, 73, 75, 77], "Snow"],
  [[80, 81, 82], "Rain showers"], [[85, 86], "Snow showers"],
  [[95, 96, 99], "Thunderstorm"],
];
function wmoText(code: number | null): string | null {
  if (code == null) return null;
  for (const [codes, label] of WMO) if (codes.includes(code)) return label;
  return null;
}
function degToCompass(deg: number | null): string | null {
  if (deg == null) return null;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

async function openMeteo(lat: number, lon: number, isoTime: string | null): Promise<Weather> {
  const j = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=3&timezone=UTC`
  );
  if (!j) return null;
  const hourly = (j.hourly as AnyObj) || {};
  const times = (hourly.time as string[]) || [];
  const t = (hourly.temperature_2m as number[]) || [];
  const pp = (hourly.precipitation_probability as number[]) || [];
  const ws = (hourly.wind_speed_10m as number[]) || [];
  const wd = (hourly.wind_direction_10m as number[]) || [];
  const wc = (hourly.weather_code as number[]) || [];
  if (!times.length) return null;
  // Nearest hour to game time (Open-Meteo returns UTC times like "2026-08-16T19:00").
  let idx = 0;
  if (isoTime) {
    const target = Date.parse(isoTime);
    if (Number.isFinite(target)) {
      let bestDiff = Infinity;
      times.forEach((ts, i) => {
        const d = Math.abs(Date.parse(`${ts}Z`) - target); // ts is UTC without suffix
        if (Number.isFinite(d) && d < bestDiff) { bestDiff = d; idx = i; }
      });
    }
  }
  return {
    tempF: t[idx] ?? null,
    windMph: ws[idx] ?? null,
    windDir: degToCompass(wd[idx] ?? null),
    precipPct: pp[idx] ?? null,
    conditions: wmoText(wc[idx] ?? null),
    source: "open-meteo",
  };
}

/* ─── main entry ─────────────────────────────────────────────────────────── */
export async function getGameContext(
  league: League, homeTeam: string, awayTeam: string,
): Promise<GameContext> {
  const notes: string[] = [];
  const empty: GameContext = {
    matched: false, home: null, away: null, venue: null, indoor: null,
    date: null, weather: null, injuriesHome: [], injuriesAway: [], notes,
  };

  const [events, injuryMap] = await Promise.all([espnScoreboard(league), espnInjuries(league)]);
  if (!events.length) { notes.push("ESPN schedule unavailable right now."); return empty; }

  const wantHome = norm(homeTeam), wantAway = norm(awayTeam);
  const wantHomeNick = nickname(homeTeam), wantAwayNick = nickname(awayTeam);

  let matchGame: AnyObj | null = null;
  let homeC: AnyObj | null = null, awayC: AnyObj | null = null;
  for (const ev of events) {
    const comp = arr(ev.competitions)[0];
    if (!comp) continue;
    const comps = arr(comp.competitors);
    const named = comps.map((c) => {
      const tm = (c.team as AnyObj) || {};
      const dn = str(tm.displayName) || str(tm.name) || "";
      return { c, n: norm(dn), nick: nickname(dn), homeAway: str(c.homeAway) };
    });
    const hMatch = named.find((x) => x.n === wantHome || x.nick === wantHomeNick);
    const aMatch = named.find((x) => x.n === wantAway || x.nick === wantAwayNick);
    if (hMatch && aMatch) {
      matchGame = comp; homeC = hMatch.c; awayC = aMatch.c;
      (empty as GameContext).date = str(ev.date);
      break;
    }
  }

  if (!matchGame || !homeC || !awayC) {
    notes.push("Couldn't match this game in ESPN's current feed (team-name mismatch or not scheduled today) — records/pitchers/weather unavailable.");
    // Still try injuries by name below.
  }

  const home = homeC ? teamFromCompetitor(homeC) : null;
  const away = awayC ? teamFromCompetitor(awayC) : null;
  const venueObj = matchGame ? ((matchGame.venue as AnyObj) || {}) : {};
  const venue = str(venueObj.fullName);
  const indoor = typeof venueObj.indoor === "boolean" ? (venueObj.indoor as boolean) : null;
  const date = str((empty as GameContext).date);

  // Weather.
  let weather: Weather = null;
  if (indoor === true) {
    notes.push("Indoor/roofed venue — weather is not a factor.");
  } else if (league === "NFL" && matchGame && (matchGame.weather as AnyObj)) {
    const w = (matchGame.weather as AnyObj) || {};
    const temp = typeof w.temperature === "number" ? (w.temperature as number) : null;
    const cond = str(w.displayValue) || str(w.conditionId);
    if (temp != null || cond) weather = { tempF: temp, windMph: null, windDir: null, precipPct: null, conditions: cond, source: "espn" };
  } else if (league === "MLB") {
    const coords = MLB_COORDS[nickname(homeTeam)] || MLB_COORDS[norm(homeTeam)];
    if (coords) weather = await openMeteo(coords[0], coords[1], date);
    else notes.push("No mapped ballpark for weather lookup.");
  }
  if (!weather && indoor !== true && league !== "NBA") notes.push("Live weather not available for this game.");

  const injuriesHome = home ? (injuryMap.get(norm(home.name)) || []).slice(0, 6) : [];
  const injuriesAway = away ? (injuryMap.get(norm(away.name)) || []).slice(0, 6) : [];
  if (!injuryMap.size) notes.push("ESPN injury feed unavailable right now.");

  return {
    matched: !!matchGame,
    home, away, venue, indoor, date, weather,
    injuriesHome, injuriesAway, notes,
  };
}
