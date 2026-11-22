/** The app assistant proposes these actions. Only a member's tap runs a tool. */
export type AtlasStyle = "scalp" | "intraday" | "swing";
export type AtlasDestination = "floor" | "plays" | "genx" | "pulse" | "flow" | "credits" | "tools" | "command-center";
export type AtlasAction =
  | { type: "plays"; td?: string; style?: AtlasStyle }
  | { type: "genx"; mode?: "quick" | "intraday" | "swing" }
  | { type: "pulse" }
  | { type: "navigate"; destination: AtlasDestination };

export type AtlasMessage = { role: "user" | "assistant"; content: string };
export type AtlasContext = {
  screen?: string;
  account?: { id: string; environment?: string };
  /** An existing result being discussed, not an instruction or a new live read. */
  result?: { kind: "plays" | "genx" | "pulse" | "floor"; data: unknown };
};
export type AtlasReply = { reply: string; actions: AtlasAction[] };

export const ATLAS_DESTINATIONS: readonly AtlasDestination[] = ["floor", "plays", "genx", "pulse", "flow", "credits", "tools", "command-center"];
