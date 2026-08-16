/**
 * Sports data provider abstraction.
 *
 * The ENTIRE feature reads through this interface, so the concrete provider is
 * swappable (odds today, add an injuries/stats/props provider later without
 * touching the UI or API routes). The cardinal rule: a provider returns REAL
 * data or it returns an "unavailable" marker — it NEVER invents games, scores,
 * odds, injuries, pitchers, QBs, lineups, lines, stats, or live info.
 *
 * When no provider key is configured, getProvider() returns a NullProvider that
 * reports DATA UNAVAILABLE for every call, so the app degrades gracefully and
 * the admin sees exactly what to connect.
 */

export type League = "NFL" | "NBA" | "MLB";

export const LEAGUE_KEYS: Record<League, string> = {
  NFL: "americanfootball_nfl",
  NBA: "basketball_nba",
  MLB: "baseball_mlb",
};

export type ProviderResult<T> =
  | { ok: true; data: T; source: string; fetchedAt: string; stale?: boolean }
  | { ok: false; reason: "unavailable" | "error" | "not_configured"; message: string; source: string };

export type Game = {
  id: string;
  league: League;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string | null; // ISO
  status: "scheduled" | "live" | "final" | "postponed" | "unknown";
  homeScore: number | null;
  awayScore: number | null;
  period: string | null;
  clock: string | null;
};

export type OddsOutcome = { name: string; priceAmerican: number | null; point: number | null };
export type OddsMarket = { key: "h2h" | "spreads" | "totals"; outcomes: OddsOutcome[] };
export type BookOdds = { book: string; markets: OddsMarket[] };
export type GameOdds = {
  gameId: string;
  league: League;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string | null;
  books: BookOdds[];
};

export type Injury = { team: string; player: string; status: string; note?: string };
export type TeamStat = { team: string; metrics: Record<string, number | string | null> };
export type PlayerStat = { player: string; team?: string; metrics: Record<string, number | string | null> };
export type LineMovement = { market: string; outcome: string; open: number | null; current: number | null };

export interface SportsDataProvider {
  readonly name: string;
  getGames(league: League): Promise<ProviderResult<Game[]>>;
  getLiveGames(league: League): Promise<ProviderResult<Game[]>>;
  getOdds(league: League): Promise<ProviderResult<GameOdds[]>>;
  getInjuries(league: League): Promise<ProviderResult<Injury[]>>;
  getTeamStats(league: League): Promise<ProviderResult<TeamStat[]>>;
  getPlayerStats(league: League): Promise<ProviderResult<PlayerStat[]>>;
  getLineMovement(league: League, gameId: string): Promise<ProviderResult<LineMovement[]>>;
  getGameDetails(league: League, gameId: string): Promise<ProviderResult<Game & { odds?: GameOdds }>>;
}

const now = () => new Date().toISOString();

function unavailable<T>(source: string, message: string): ProviderResult<T> {
  return { ok: false, reason: "unavailable", message, source };
}

/* ─────────────────────────── NullProvider ─────────────────────────────── */
/** Returned when nothing is configured. Every call = DATA UNAVAILABLE. */
export class NullProvider implements SportsDataProvider {
  readonly name = "none";
  private msg = "DATA UNAVAILABLE — no sports-data provider is connected. Add a provider key in Settings.";
  async getGames(): Promise<ProviderResult<Game[]>> { return { ok: false, reason: "not_configured", message: this.msg, source: this.name }; }
  async getLiveGames() { return this.getGames(); }
  async getOdds(): Promise<ProviderResult<GameOdds[]>> { return { ok: false, reason: "not_configured", message: this.msg, source: this.name }; }
  async getInjuries(): Promise<ProviderResult<Injury[]>> { return { ok: false, reason: "not_configured", message: this.msg, source: this.name }; }
  async getTeamStats(): Promise<ProviderResult<TeamStat[]>> { return { ok: false, reason: "not_configured", message: this.msg, source: this.name }; }
  async getPlayerStats(): Promise<ProviderResult<PlayerStat[]>> { return { ok: false, reason: "not_configured", message: this.msg, source: this.name }; }
  async getLineMovement(): Promise<ProviderResult<LineMovement[]>> { return { ok: false, reason: "not_configured", message: this.msg, source: this.name }; }
  async getGameDetails(): Promise<ProviderResult<Game & { odds?: GameOdds }>> { return { ok: false, reason: "not_configured", message: this.msg, source: this.name }; }
}

/* ─────────────────────────── The Odds API ─────────────────────────────── */
/**
 * First real provider. Covers real schedules, scores, and odds (h2h/spreads/
 * totals) for NFL/NBA/MLB across many books. It does NOT expose injuries /
 * team stats / player stats / line-movement history — those methods return
 * "unavailable" (honest) until a provider that has them is added. That is by
 * design: the UI shows LOW data quality and refuses to fabricate.
 *
 * Docs: https://the-odds-api.com/  base: https://api.the-odds-api.com/v4
 */
export class TheOddsApiProvider implements SportsDataProvider {
  readonly name = "the-odds-api";
  private base = "https://api.the-odds-api.com/v4";
  constructor(private apiKey: string) {}

  private async call<T>(path: string, params: Record<string, string>): Promise<ProviderResult<T>> {
    const usp = new URLSearchParams({ apiKey: this.apiKey, ...params });
    const url = `${this.base}${path}?${usp.toString()}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 401 || r.status === 403) return { ok: false, reason: "not_configured", message: "Provider rejected the API key (401/403). Check the key in Settings.", source: this.name };
      if (r.status === 429) return { ok: false, reason: "error", message: "Provider rate limit reached (429). Try again later.", source: this.name };
      if (!r.ok) return { ok: false, reason: "error", message: `Provider HTTP ${r.status}.`, source: this.name };
      const data = (await r.json()) as T;
      return { ok: true, data, source: this.name, fetchedAt: now() };
    } catch (e) {
      return { ok: false, reason: "error", message: `Provider request failed: ${String(e).slice(0, 140)}`, source: this.name };
    }
  }

  async getGames(league: League): Promise<ProviderResult<Game[]>> {
    // /scores gives live + recently-completed + upcoming (daysFrom for finals).
    // 3 days back so the learning loop can grade calls from the last few days.
    const res = await this.call<Array<Record<string, unknown>>>(`/sports/${LEAGUE_KEYS[league]}/scores`, { daysFrom: "3" });
    if (!res.ok) return res;
    return { ...res, data: res.data.map((g) => mapScore(g, league)) };
  }

  async getLiveGames(league: League): Promise<ProviderResult<Game[]>> {
    const res = await this.getGames(league);
    if (!res.ok) return res;
    return { ...res, data: res.data.filter((g) => g.status === "live") };
  }

  async getOdds(league: League): Promise<ProviderResult<GameOdds[]>> {
    const res = await this.call<Array<Record<string, unknown>>>(`/sports/${LEAGUE_KEYS[league]}/odds`, {
      regions: "us",
      markets: "h2h,spreads,totals",
      oddsFormat: "american",
    });
    if (!res.ok) return res;
    return { ...res, data: res.data.map((g) => mapOdds(g, league)) };
  }

  // Not supported by this provider — honest "unavailable" (LOW data quality).
  async getInjuries(league: League): Promise<ProviderResult<Injury[]>> {
    return unavailable(this.name, `Injuries not available from ${this.name} for ${league}. Connect an injuries provider.`);
  }
  async getTeamStats(league: League): Promise<ProviderResult<TeamStat[]>> {
    return unavailable(this.name, `Team stats not available from ${this.name} for ${league}.`);
  }
  async getPlayerStats(league: League): Promise<ProviderResult<PlayerStat[]>> {
    return unavailable(this.name, `Player stats not available from ${this.name} for ${league}.`);
  }
  async getLineMovement(league: League): Promise<ProviderResult<LineMovement[]>> {
    // We reconstruct movement from our own captured snapshots in the DB, not the
    // provider. From the provider alone, movement history is unavailable.
    return unavailable(this.name, `Line-movement history is reconstructed from stored snapshots, not ${this.name}.`);
  }

  async getGameDetails(league: League, gameId: string): Promise<ProviderResult<Game & { odds?: GameOdds }>> {
    const games = await this.getGames(league);
    if (!games.ok) return games;
    const g = games.data.find((x) => x.id === gameId);
    if (!g) return unavailable(this.name, `Game ${gameId} not found in current ${league} feed.`);
    const odds = await this.getOdds(league);
    const match = odds.ok ? odds.data.find((o) => o.gameId === gameId) : undefined;
    return { ok: true, data: { ...g, odds: match }, source: this.name, fetchedAt: now() };
  }
}

/* ─────────────────────────── mappers ─────────────────────────────────── */
function mapScore(g: Record<string, unknown>, league: League): Game {
  const scores = (g.scores as Array<{ name?: string; score?: string }> | null) ?? null;
  const home = String(g.home_team ?? "");
  const away = String(g.away_team ?? "");
  const findScore = (team: string) => {
    if (!scores) return null;
    const s = scores.find((x) => x?.name === team);
    const n = s?.score != null ? Number(s.score) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const completed = g.completed === true;
  const hasScores = Array.isArray(scores) && scores.length > 0;
  const status: Game["status"] = completed ? "final" : hasScores ? "live" : "scheduled";
  return {
    id: String(g.id ?? ""),
    league,
    homeTeam: home,
    awayTeam: away,
    commenceTime: g.commence_time ? String(g.commence_time) : null,
    status,
    homeScore: findScore(home),
    awayScore: findScore(away),
    period: null,
    clock: null,
  };
}

function mapOdds(g: Record<string, unknown>, league: League): GameOdds {
  const books = ((g.bookmakers as Array<Record<string, unknown>> | null) ?? []).map((bk) => {
    const markets = ((bk.markets as Array<Record<string, unknown>> | null) ?? []).map((m) => ({
      key: String(m.key) as OddsMarket["key"],
      outcomes: ((m.outcomes as Array<Record<string, unknown>> | null) ?? []).map((o) => ({
        name: String(o.name ?? ""),
        priceAmerican: o.price != null && Number.isFinite(Number(o.price)) ? Number(o.price) : null,
        point: o.point != null && Number.isFinite(Number(o.point)) ? Number(o.point) : null,
      })),
    }));
    return { book: String(bk.key ?? bk.title ?? "book"), markets };
  });
  return {
    gameId: String(g.id ?? ""),
    league,
    homeTeam: String(g.home_team ?? ""),
    awayTeam: String(g.away_team ?? ""),
    commenceTime: g.commence_time ? String(g.commence_time) : null,
    books,
  };
}

/* ─────────────────────────── resolver ─────────────────────────────────── */
/**
 * Resolve the active provider. Order:
 *   1) ODDS_API_KEY env var (preferred — keeps the key server-side in Vercel).
 *   2) A key stored in sports_admin_settings (the connect-a-key fallback UI).
 *   3) NullProvider -> everything reports DATA UNAVAILABLE.
 * The settings key is read server-side only, via a value the caller supplies
 * (it fetches from the service-role client on the gated route).
 */
export function getProvider(settingsKey?: string | null): { provider: SportsDataProvider; configured: boolean; via: string } {
  const envKey = process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || "";
  if (envKey) return { provider: new TheOddsApiProvider(envKey), configured: true, via: "env" };
  if (settingsKey) return { provider: new TheOddsApiProvider(settingsKey), configured: true, via: "settings" };
  return { provider: new NullProvider(), configured: false, via: "none" };
}
