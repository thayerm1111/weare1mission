/**
 * BROKER RELAY (owner 09-18: "spread the fan-out across multiple servers").
 *
 * TradeLocker's edge rate-limits by IP (Cloudflare 1015). One server fanning 170+ members out through one IP
 * hits that ceiling on every signal: slow fills, slipped entries, failed position lookups. This is a tiny
 * forwarder — deployed several times, each instance in its own Railway region with its own outbound IP — so the
 * fleet's broker calls are spread over several IP budgets instead of one.
 *
 * It is deliberately dumb: it holds no credentials, no database, no state. It accepts ONE call shape from our
 * own worker/web app (shared-secret authenticated), forwards it verbatim to a TradeLocker host, and returns the
 * status and body. It will only ever talk to demo.tradelocker.com / live.tradelocker.com.
 *
 * Env: RELAY_SECRET (required, must match BROKER_RELAY_SECRET on the caller), PORT (Railway sets it).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const SECRET = (process.env.RELAY_SECRET ?? "").trim();
const PORT = Number(process.env.PORT || 8080);
const TIMEOUT_MS = 20_000;
const ALLOWED = new Set(["https://demo.tradelocker.com/backend-api", "https://live.tradelocker.com/backend-api"]);
const MAX_BODY = 512 * 1024;

type RelayReq = { host?: string; path?: string; method?: string; headers?: Record<string, string>; body?: string };

function send(res: ServerResponse, status: number, obj: unknown): void {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body_too_large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url || "/", "http://relay");
      if (url.pathname === "/health") return send(res, 200, { ok: true, at: new Date().toISOString() });
      if (url.pathname !== "/tl" || req.method !== "POST") return send(res, 404, { error: "not_found" });
      if (!SECRET) return send(res, 503, { error: "relay_not_configured" });
      if (String(req.headers["x-relay-secret"] || "") !== SECRET) return send(res, 401, { error: "unauthorized" });

      const raw = await readBody(req);
      let body: RelayReq;
      try { body = JSON.parse(raw) as RelayReq; } catch { return send(res, 400, { error: "bad_json" }); }
      const host = String(body.host || "");
      const path = String(body.path || "");
      if (!ALLOWED.has(host)) return send(res, 400, { error: "host_not_allowed" });
      if (!path.startsWith("/")) return send(res, 400, { error: "bad_path" });

      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const r = await fetch(`${host}${path}`, {
          method: String(body.method || "GET").toUpperCase(),
          headers: { "content-type": "application/json", accept: "application/json", ...(body.headers || {}) },
          body: body.body != null && body.method && body.method.toUpperCase() !== "GET" ? body.body : undefined,
          cache: "no-store",
          signal: ctrl.signal,
        });
        const text = await r.text();
        return send(res, 200, { status: r.status, text });
      } catch (e) {
        return send(res, 502, { error: "upstream_failed", detail: e instanceof Error ? e.message : "error" });
      } finally { clearTimeout(to); }
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : "error" });
    }
  })();
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[relay] listening on ${PORT} — secret ${SECRET ? "set" : "MISSING"}`);
});
