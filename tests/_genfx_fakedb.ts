/**
 * A small in-memory stand-in for the database client, for the GEN FX tests.
 *
 * It answers the same chained calls the code makes (`from(t).select().eq().in()…`, `insert`, `update`,
 * `delete`, `rpc`) and, like the real client, RETURNS its errors instead of throwing them. Three things
 * a test can turn on: a unique key per table (a second insert is error 23505, as Postgres says it), a
 * `fail` rule that makes chosen calls return an error, and a `before` hook that runs just ahead of a
 * call — which is how "another process wrote the same row in between" is staged. A unique key may be
 * partial (`{ cols, when }`), as the two that GEN FX leans on are.
 *
 * The two reservation functions GEN FX calls are implemented from their SQL (the definitions were read
 * from the live database on 2026-10-02) so the lock behaves here as it does there.
 */
export type Row = Record<string, unknown>;
export type Op = { table: string; kind: "select" | "insert" | "update" | "delete" | "rpc"; payload?: unknown };
/** A unique key: its columns, and (for a partial index) which rows it covers. */
export type UniqueKey = string[] | { cols: string[]; when: (r: Row) => boolean };
export type FakeOpts = {
  unique?: Record<string, UniqueKey[]>;
  fail?: (op: Op) => boolean;
  before?: (op: Op, db: FakeDb) => void;
};
export type FakeDb = {
  tables: Record<string, Row[]>;
  ops: Op[];
  opts: FakeOpts;
  from: (table: string) => Query;
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  /** Insert rows directly, bypassing hooks (test setup, or "another writer" inside a `before` hook). */
  put: (table: string, ...rows: Row[]) => Row[];
};

/**
 * Column defaults the code under test relies on, as the live tables have them (read 2026-10-03): a row
 * inserted without these columns has them all the same — and a conditional write that names one
 * (`.eq("checks", 0)`) matches a fresh row in the database, so it must here.
 */
const COLUMN_DEFAULTS: Record<string, Row> = {
  genfx_fills: { status: "reserved", checks: 0, clean: 0, protect_tries: 0 },
};

let seq = 0;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const like = (v: unknown, pat: string, wild = "%"): boolean => {
  const re = new RegExp("^" + String(pat).split(wild).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return v != null && re.test(String(v));
};
const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a ?? ""), y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
};
const same = (a: unknown, b: unknown): boolean => (a == null || b == null ? a === b : typeof a === "boolean" || typeof b === "boolean" ? a === b : String(a) === String(b));

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: ((r: Row) => boolean)[] = [];
  private orders: [string, boolean][] = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private kind: Op["kind"] = "select";
  private payload: unknown = null;
  private returning = false;
  private one: "maybe" | "single" | null = null;
  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string) { if (this.kind !== "select") this.returning = true; return this; }
  insert(rows: Row | Row[]) { this.kind = "insert"; this.payload = rows; return this; }
  update(patch: Row) { this.kind = "update"; this.payload = patch; return this; }
  delete() { this.kind = "delete"; return this; }

  eq(c: string, v: unknown) { this.filters.push((r) => same(r[c], v)); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => !same(r[c], v)); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.some((v) => same(r[c], v))); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this; }
  gt(c: string, v: unknown) { this.filters.push((r) => r[c] != null && cmp(r[c], v) > 0); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => r[c] != null && cmp(r[c], v) <= 0); return this; }
  lt(c: string, v: unknown) { this.filters.push((r) => r[c] != null && cmp(r[c], v) < 0); return this; }
  like(c: string, pat: string) { this.filters.push((r) => like(r[c], pat)); return this; }
  not(c: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.filters.push((r) => r[c] != null);
    else if (op === "like") this.filters.push((r) => !like(r[c], String(v)));
    else throw new Error(`fake db: not(${op}) is not implemented`);
    return this;
  }
  /** "a.eq.true,b.eq.true" · "reason.ilike.*x*,reason.ilike.*y*" · "reason.is.null,reason.not.like.genfx*" */
  or(expr: string) {
    const tests = expr.split(",").map((part) => {
      const [col, ...rest] = part.split(".");
      const neg = rest[0] === "not";
      const [op, ...vs] = neg ? rest.slice(1) : rest;
      const val = vs.join(".");
      const t = (r: Row): boolean =>
        op === "eq" ? same(r[col], val === "true" ? true : val === "false" ? false : val)
          : op === "is" ? (val === "null" ? r[col] == null : same(r[col], val))
            : op === "like" || op === "ilike" ? like(r[col], val, "*")
              : (() => { throw new Error(`fake db: or(${op}) is not implemented`); })();
      return (r: Row) => (neg ? !t(r) : t(r));
    });
    this.filters.push((r) => tests.some((t) => t(r)));
    return this;
  }
  order(c: string, o: { ascending?: boolean } = {}) { this.orders.push([c, o.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.rng = [a, b]; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  single() { this.one = "single"; return this; }

  private run(): { data: unknown; error: unknown } {
    const op: Op = { table: this.table, kind: this.kind, payload: this.payload };
    this.db.opts.before?.(op, this.db);
    this.db.ops.push(op);
    if (this.db.opts.fail?.(op)) return { data: null, error: { message: "fake db: failed on purpose" } };
    const t = (this.db.tables[this.table] ??= []);
    const hit = (r: Row) => this.filters.every((f) => f(r));
    let out: Row[] = [];
    if (this.kind === "insert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const key of this.db.opts.unique?.[this.table] ?? []) {
        const cols = Array.isArray(key) ? key : key.cols;
        const covers = (r: Row) => Array.isArray(key) || key.when(r);
        for (const row of rows) if (covers(row) && t.some((x) => covers(x) && cols.every((c) => same(x[c], row[c])))) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      out = this.db.put(this.table, ...rows);
    } else if (this.kind === "update") {
      out = t.filter(hit);
      // A partial unique index is checked on update too: a row may not be moved INTO a key another row holds.
      for (const key of this.db.opts.unique?.[this.table] ?? []) {
        if (Array.isArray(key)) continue;
        for (const r of out) {
          const after = { ...r, ...(this.payload as Row) };
          if (key.when(after) && t.some((x) => x !== r && key.when(x) && key.cols.every((c) => same(x[c], after[c])))) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
      }
      for (const r of out) Object.assign(r, this.payload as Row);
    } else if (this.kind === "delete") {
      out = t.filter(hit);
      this.db.tables[this.table] = t.filter((r) => !hit(r));
    } else {
      out = t.filter(hit);
      for (const [c, asc] of [...this.orders].reverse()) out = [...out].sort((a, b) => (asc ? cmp(a[c], b[c]) : cmp(b[c], a[c])));
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) out = out.slice(0, this.lim);
    }
    const copies = out.map((r) => ({ ...r }));
    if (this.kind !== "select" && !this.returning) return { data: null, error: null };
    if (this.one) {
      if (copies.length > 1 || (this.one === "single" && copies.length !== 1)) return { data: null, error: { message: "fake db: expected one row" } };
      return { data: copies[0] ?? null, error: null };
    }
    return { data: copies, error: null };
  }
  then<A = { data: unknown; error: unknown }, B = never>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    let res: { data: unknown; error: unknown };
    try { res = this.run(); } catch (e) { return Promise.reject(e).then(ok, bad); }
    return Promise.resolve(res).then(ok, bad);
  }
}

export function fakeDb(seed: Record<string, Row[]> = {}, opts: FakeOpts = {}): FakeDb {
  const db: FakeDb = {
    tables: {}, ops: [], opts,
    from: (table) => new Query(db, table),
    put: (table, ...rows) => {
      const t = (db.tables[table] ??= []);
      const made = rows.map((r) => ({ id: `id-${String(++seq).padStart(6, "0")}`, created_at: iso(), updated_at: iso(), ...(COLUMN_DEFAULTS[table] ?? {}), ...r }));
      t.push(...made);
      return made;
    },
    rpc: async (name, args = {}) => {
      const op: Op = { table: name, kind: "rpc", payload: args };
      opts.before?.(op, db);
      db.ops.push(op);
      if (opts.fail?.(op)) return { data: null, error: { message: "fake db: failed on purpose" } };
      const resv = (db.tables.flow_account_reservations ??= []);
      const account = String(args.p_account_id ?? "");
      if (name === "genx_reserve_gold_side") {
        const base = String(args.p_symbol ?? "").toUpperCase(), side = String(args.p_side ?? "").toUpperCase();
        if (!account || !base || (side !== "BUY" && side !== "SELL")) return { data: { reserved: false, reason: "bad_args", state: null }, error: null };
        const key = `${base}:${side}`;
        const open = (db.tables.flow_managed_positions ?? []).some((p) => p.account_id === account && String(p.symbol).toUpperCase() === base && p.status === "open" && String(p.side).toUpperCase() === side);
        if (open) return { data: { reserved: false, reason: "open_position", state: "filled" }, error: null };
        const ttl = Math.max(Number(args.p_ttl_secs ?? 60), 5) * 1000;
        const have = resv.find((r) => r.account_id === account && r.symbol === key);
        if (have) {
          if (have.state === "filled" || have.state === "unknown" || (have.state === "active" && Date.parse(String(have.expires_at)) > Date.now())) return { data: { reserved: false, reason: `reserved:${String(have.state)}`, state: have.state }, error: null };
          Object.assign(have, { state: "active", signal_key: args.p_signal_key, order_id: null, position_id: null, reserved_at: iso(), expires_at: iso(Date.now() + ttl), updated_at: iso() });
          return { data: { reserved: true, reason: "reclaimed", state: "active" }, error: null };
        }
        resv.push({ account_id: account, symbol: key, state: "active", signal_key: args.p_signal_key, order_id: null, position_id: null, reserved_at: iso(), expires_at: iso(Date.now() + ttl), updated_at: iso() });
        return { data: { reserved: true, reason: "new", state: "active" }, error: null };
      }
      if (name === "genx_reservation_mark") {
        const row = resv.find((r) => r.account_id === account && r.symbol === String(args.p_symbol ?? "").toUpperCase());
        if (!row || !["active", "filled", "unknown", "released"].includes(String(args.p_state))) return { data: false, error: null };
        Object.assign(row, { state: args.p_state, order_id: args.p_order_id ?? row.order_id, position_id: args.p_position_id ?? row.position_id, updated_at: iso(), ...(args.p_state === "active" ? { expires_at: iso(Date.now() + 60_000) } : {}) });
        return { data: true, error: null };
      }
      return { data: null, error: { message: `fake db: rpc ${name} is not implemented` } };
    },
  };
  for (const [table, rows] of Object.entries(seed)) db.put(table, ...rows);
  return db;
}
export type { Query };
