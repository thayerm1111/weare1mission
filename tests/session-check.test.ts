import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * "Signed out" is not the same as "could not tell" (10-07). One network route between the middleware
 * and the sign-in service timed out for several minutes; the check came back empty, empty was read as
 * signed out, and members who had just signed in were sent back to the login page again and again.
 * These hold the rule: only a definite answer sends a member to /login from the middleware; when the
 * check could not be made, the page — which checks the sign-in itself on the server — decides.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
// Next sets this in its own bootstrap; its request classes will not load without it.
(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;

const code = (p: string): string => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const USER = { id: "11111111-1111-4111-8111-000000000001", aud: "authenticated", role: "authenticated", email: "member@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
/** The cookie a signed-in browser carries, as @supabase/ssr writes it. */
function sessionCookie(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const access_token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: USER.id, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const session = { access_token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "refresh", user: USER };
  return `sb-supabase-auth-token=base64-${b64(session)}`;
}

test("the rule: a definite answer is signed-in or signed-out; anything else is 'could not tell'", async () => {
  const { sessionCheckOf, SESSION_CHECK_MS } = await import("../src/lib/supabase/middleware");
  assert.equal(sessionCheckOf({ data: { user: USER }, error: null }), "signed-in");
  // The sign-in service's own "no": no session, a bad or expired token, a session that was revoked.
  for (const error of [null, undefined, { name: "AuthSessionMissingError", status: 400 }, { name: "AuthApiError", status: 401 }, { name: "AuthApiError", status: 403 }, { name: "AuthApiError", status: 422 }]) {
    assert.equal(sessionCheckOf({ data: { user: null }, error }), "signed-out", JSON.stringify(error));
  }
  // No answer we can trust: it timed out, the network failed (status 0), a gateway timed out or the
  // service erred (5xx), or the reply was not the service's at all (a gateway's error page has no status here).
  assert.equal(sessionCheckOf("timeout"), "unknown");
  for (const error of [{ name: "AuthRetryableFetchError", status: 0 }, { name: "AuthRetryableFetchError", status: 502 }, { name: "AuthRetryableFetchError", status: 504 }, { name: "AuthApiError", status: 500 }, { name: "AuthApiError", status: 522 }, { name: "AuthUnknownError" }, { name: "AuthUnknownError", status: undefined }, { message: "fetch failed" }, new Error("boom")]) {
    assert.equal(sessionCheckOf({ data: { user: null }, error }), "unknown", JSON.stringify(error));
  }
  for (const nothing of [null, undefined]) assert.equal(sessionCheckOf(nothing), "unknown");
  // A user wins over any error that came with it.
  assert.equal(sessionCheckOf({ data: { user: USER }, error: { status: 500 } }), "signed-in");
  assert.ok(SESSION_CHECK_MS >= 1000 && SESSION_CHECK_MS <= 5000, "long enough for a slow day (normally ~30 ms), short enough not to hang a page");
});

test("the middleware itself: a member is sent to /login only when the sign-in service says so", async () => {
  const { updateSession, SESSION_CHECK_MS } = await import("../src/lib/supabase/middleware");
  const { NextRequest } = await import("next/server");
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  let answer: () => Response | Promise<Response> = () => json(USER);
  (globalThis as { fetch: unknown }).fetch = async (input: unknown) => { const u = new URL(typeof input === "string" ? input : (input as { url: string }).url); asked.push(u.pathname); return answer(); };
  const go = (path: string, cookie?: string) => updateSession(new NextRequest(`https://weare1mission.com${path}`, { headers: cookie ? { cookie } : {} }));
  const where = (r: Response) => (r.headers.get("location") ? `-> ${new URL(r.headers.get("location")!).pathname}${new URL(r.headers.get("location")!).search}` : r.headers.get("x-middleware-next") === "1" ? "page" : `? ${r.status}`);
  try {
    // No cookie at all: nothing to check, and no network call is made.
    assert.equal(where(await go("/portal/floor")), "-> /login?redirect=%2Fportal%2Ffloor");
    assert.equal(where(await go("/")), "page");
    assert.deepEqual(asked, []);
    // Signed in: through.
    assert.equal(where(await go("/portal/floor", sessionCookie())), "page");
    assert.deepEqual(asked, ["/auth/v1/user"]);
    // The service says the session is no good: to the login page, as before.
    answer = () => json({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }, 401);
    assert.equal(where(await go("/portal/floor", sessionCookie())), "-> /login?redirect=%2Fportal%2Ffloor");
    answer = () => json({ code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }, 403);
    assert.equal(where(await go("/portal", sessionCookie())), "-> /login?redirect=%2Fportal");
    // A cookie that is not a session at all is not "could not tell".
    assert.equal(where(await go("/portal", "sb-supabase-auth-token=garbage")), "-> /login?redirect=%2Fportal");
    // THE CASE THIS IS FOR. The route to the service is down: a gateway's timeout page (522), a 502/504,
    // a 500, a dropped connection. The member is NOT sent to the login page; the page checks for itself.
    for (const down of [
      () => new Response("<html>error code: 522</html>", { status: 522, headers: { "content-type": "text/html" } }),
      () => new Response("bad gateway", { status: 502 }), () => new Response("gateway timeout", { status: 504 }),
      () => json({ code: 500, msg: "unexpected failure" }, 500),
      () => { throw new TypeError("fetch failed"); },
    ]) {
      answer = down;
      assert.equal(where(await go("/portal/floor", sessionCookie())), "page");
    }
    // It never answers: the middleware waits its few seconds and lets the request go on — it does not hang, and does not bounce.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      answer = () => new Promise<Response>(() => {});
      const pending = go("/portal/floor", sessionCookie());
      let done = false; void pending.then(() => { done = true; });
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.equal(done, false, "still waiting inside its limit");
      mock.timers.tick(SESSION_CHECK_MS + 1);
      assert.equal(where(await pending), "page");
    } finally { mock.timers.reset(); }
    // A public page is never held hostage to any of it.
    answer = () => new Response("down", { status: 522 });
    assert.equal(where(await go("/", sessionCookie())), "page");
  } finally { (globalThis as { fetch: unknown }).fetch = realFetch; }
});

test("every guarded page checks the sign-in itself, so 'could not tell' opens nothing; and the middleware claims no region it does not run in", () => {
  // The two places the middleware guards — /portal/* and the Floor's own site — each redirect to /login without a user, on the server.
  const portal = code("src/app/portal/layout.tsx");
  assert.ok(portal.includes("const profile = configured ? await getProfile() : null;") && portal.includes('if (configured && !profile) redirect("/login");'));
  const floor = code("src/app/floor-app/page.tsx");
  assert.ok(floor.includes("const { data: { user } } = await supabase!.auth.getUser();") && floor.includes('if (!user) redirect("/login");'));
  const lib = code("src/lib/supabase/middleware.ts");
  assert.ok(lib.includes('const guarded = path.startsWith("/portal") || opts?.protect === true;'));
  assert.ok(lib.includes('if (guarded && check === "signed-out") return toLogin();'));
  assert.ok(!/if \(guarded && !user\)/.test(lib), "the old rule — empty means signed out — is gone");
  // A `regions` pin was tried on 10-07 and Vercel ran the middleware at the visitor's nearest location
  // regardless (request logs after the deploy). The setting is gone rather than left to claim otherwise.
  const mw = code("src/middleware.ts").replace(/\/\/.*$/gm, "");
  assert.match(mw, /export const config = \{\s*matcher: \[[\s\S]*?\],\s*\};/);
  assert.ok(!/regions\s*:/.test(mw));
});
