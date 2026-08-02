// Daily 1 Mission Live trading calls (Zoom). Times are CST with the EST equivalent.
export const LIVE_URL = "https://1missionlive.com";
export type LiveCall = { t: string; zone: string; label: string; hot?: boolean };
export const CALLS: LiveCall[] = [
  { t: "3:00 PM", zone: "CST · 4 PM EST", label: "Trading Overview" },
  { t: "6:00 PM", zone: "CST · 7 PM EST", label: "Trading Overview" },
  { t: "9:00 PM", zone: "CST · 10 PM EST", label: "Overview + Live Session", hot: true },
];
