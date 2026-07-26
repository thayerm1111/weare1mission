"use client";

/**
 * TradeJournal — a simple, private trade log for members.
 *
 * Saves on this device (localStorage) so it works before any server table
 * exists. Shows live stats (trades, win rate, average R, total R) so members
 * can see their edge emerge. No advice, no fabricated data — just the member's
 * own trades.
 */
import { useEffect, useMemo, useState } from "react";
import {
  NotebookPen, Plus, Trash2, TrendingUp, TrendingDown, Minus, X, Info,
} from "lucide-react";

const STORAGE_KEY = "1m_trade_journal_v1";

type Outcome = "win" | "loss" | "be";
type Direction = "long" | "short";

interface Trade {
  id: string;
  date: string;
  instrument: string;
  direction: Direction;
  setup: string;
  outcome: Outcome;
  r: string; // R multiple as string (signed), e.g. "2", "-1", "0"
  notes: string;
}

const EMPTY: Omit<Trade, "id"> = {
  date: "",
  instrument: "",
  direction: "long",
  setup: "",
  outcome: "win",
  r: "",
  notes: "",
};

function load(): Trade[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Trade[];
  } catch {
    /* ignore */
  }
  return [];
}

function save(trades: Trade[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  } catch {
    /* storage unavailable — fail silently */
  }
}

const outcomeMeta: Record<Outcome, { label: string; cls: string; Icon: typeof TrendingUp }> = {
  win: { label: "Win", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", Icon: TrendingUp },
  loss: { label: "Loss", cls: "bg-red-50 text-red-600 ring-red-200", Icon: TrendingDown },
  be: { label: "Break-even", cls: "bg-ice text-charcoal/70 ring-[#E7E4DD]", Icon: Minus },
};

export function TradeJournal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Omit<Trade, "id">>(EMPTY);
  const [confirmClearId, setConfirmClearId] = useState<string | null>(null);

  useEffect(() => {
    setTrades(load());
    setHydrated(true);
  }, []);

  const persist = (next: Trade[]) => {
    setTrades(next);
    save(next);
  };

  const addTrade = () => {
    if (!draft.instrument.trim()) return;
    const id = `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const entry: Trade = { ...draft, id, instrument: draft.instrument.trim() };
    persist([entry, ...trades]);
    setDraft(EMPTY);
    setShowForm(false);
  };

  const removeTrade = (id: string) => {
    persist(trades.filter((t) => t.id !== id));
    setConfirmClearId(null);
  };

  const stats = useMemo(() => {
    const total = trades.length;
    const wins = trades.filter((t) => t.outcome === "win").length;
    const losses = trades.filter((t) => t.outcome === "loss").length;
    const decided = wins + losses;
    const winRate = decided > 0 ? Math.round((wins / decided) * 100) : 0;
    const rValues = trades
      .map((t) => parseFloat(t.r))
      .filter((n) => !Number.isNaN(n));
    const totalR = rValues.reduce((a, b) => a + b, 0);
    const avgR = rValues.length > 0 ? totalR / rValues.length : 0;
    return { total, wins, losses, winRate, totalR, avgR, hasR: rValues.length > 0 };
  }, [trades]);

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Trades logged" value={hydrated ? String(stats.total) : "—"} />
        <StatCard
          label="Win rate"
          value={hydrated && stats.wins + stats.losses > 0 ? `${stats.winRate}%` : "—"}
          hint={hydrated && stats.wins + stats.losses > 0 ? `${stats.wins}W · ${stats.losses}L` : undefined}
        />
        <StatCard
          label="Avg R"
          value={hydrated && stats.hasR ? `${stats.avgR >= 0 ? "+" : ""}${stats.avgR.toFixed(2)}R` : "—"}
          tone={stats.avgR > 0 ? "pos" : stats.avgR < 0 ? "neg" : "neutral"}
        />
        <StatCard
          label="Total R"
          value={hydrated && stats.hasR ? `${stats.totalR >= 0 ? "+" : ""}${stats.totalR.toFixed(1)}R` : "—"}
          tone={stats.totalR > 0 ? "pos" : stats.totalR < 0 ? "neg" : "neutral"}
        />
      </div>

      {/* Add button */}
      {!showForm && (
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-cream transition-colors hover:bg-navy focus-ring"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Log a trade
        </button>
      )}

      {/* Add form */}
      {showForm && (
        <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-bold text-navy">
              <NotebookPen className="h-4 w-4 text-primary" aria-hidden="true" /> New trade
            </h3>
            <button
              onClick={() => { setShowForm(false); setDraft(EMPTY); }}
              className="rounded-full p-1.5 text-charcoal/50 hover:bg-offwhite hover:text-charcoal focus-ring"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Instrument">
              <input
                value={draft.instrument}
                onChange={(e) => setDraft({ ...draft, instrument: e.target.value })}
                placeholder="e.g. XAUUSD, EURUSD, BTCUSD"
                className="input-1m"
              />
            </Field>
            <Field label="Date">
              <input
                type="date"
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                className="input-1m"
              />
            </Field>
            <Field label="Direction">
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-ice p-1">
                {(["long", "short"] as Direction[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDraft({ ...draft, direction: d })}
                    className={`rounded-lg py-2 text-sm font-semibold capitalize transition-colors ${
                      draft.direction === d ? "bg-primary text-cream" : "text-charcoal/60 hover:text-charcoal"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Outcome">
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-ice p-1">
                {(["win", "loss", "be"] as Outcome[]).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setDraft({ ...draft, outcome: o })}
                    className={`rounded-lg py-2 text-xs font-semibold transition-colors ${
                      draft.outcome === o ? "bg-primary text-cream" : "text-charcoal/60 hover:text-charcoal"
                    }`}
                  >
                    {outcomeMeta[o].label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Setup / reason">
              <input
                value={draft.setup}
                onChange={(e) => setDraft({ ...draft, setup: e.target.value })}
                placeholder="e.g. London session, break of structure"
                className="input-1m"
              />
            </Field>
            <Field label="Result in R (e.g. 2 or -1)">
              <input
                value={draft.r}
                onChange={(e) => setDraft({ ...draft, r: e.target.value })}
                inputMode="decimal"
                placeholder="2"
                className="input-1m"
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes — what went well, what you'd change">
                <textarea
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                  rows={2}
                  placeholder="Followed my plan, good entry, took profit too early…"
                  className="input-1m resize-none"
                />
              </Field>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              onClick={() => { setShowForm(false); setDraft(EMPTY); }}
              className="rounded-full px-4 py-2 text-sm font-semibold text-navy hover:bg-offwhite focus-ring"
            >
              Cancel
            </button>
            <button
              onClick={addTrade}
              disabled={!draft.instrument.trim()}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-cream transition-colors hover:bg-navy focus-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> Save trade
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {hydrated && trades.length === 0 && !showForm && (
        <div className="rounded-2xl border border-dashed border-[#E7E4DD] bg-offwhite/60 px-6 py-12 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-primary shadow-card" aria-hidden="true">
            <NotebookPen className="h-6 w-6" />
          </span>
          <p className="mt-4 text-sm font-semibold text-navy">No trades logged yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-charcoal/60">
            Log your trades — even practice ones — to start seeing your win rate and average R build up over time.
          </p>
        </div>
      )}

      {/* Trade list */}
      {trades.length > 0 && (
        <ul className="space-y-3">
          {trades.map((t) => {
            const meta = outcomeMeta[t.outcome];
            const OIcon = meta.Icon;
            const rNum = parseFloat(t.r);
            return (
              <li key={t.id} className="rounded-2xl border border-ice bg-white p-4 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold uppercase tracking-wide text-navy">{t.instrument}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${
                        t.direction === "long" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
                      }`}>
                        {t.direction === "long" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {t.direction}
                      </span>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${meta.cls}`}>
                        <OIcon className="h-3 w-3" /> {meta.label}
                      </span>
                      {!Number.isNaN(rNum) && t.r !== "" && (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          rNum > 0 ? "bg-emerald-500 text-white" : rNum < 0 ? "bg-red-500 text-white" : "bg-ice text-charcoal/70"
                        }`}>
                          {rNum >= 0 ? "+" : ""}{rNum}R
                        </span>
                      )}
                    </div>
                    {(t.setup || t.date) && (
                      <p className="mt-1.5 text-xs text-charcoal/55">
                        {t.date && <span>{t.date}</span>}
                        {t.date && t.setup && <span> · </span>}
                        {t.setup && <span>{t.setup}</span>}
                      </p>
                    )}
                    {t.notes && <p className="mt-2 text-sm text-charcoal/75">{t.notes}</p>}
                  </div>

                  {confirmClearId === t.id ? (
                    <div className="flex flex-shrink-0 items-center gap-1">
                      <button
                        onClick={() => removeTrade(t.id)}
                        className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-600 focus-ring"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmClearId(null)}
                        className="rounded-full px-2 py-1 text-xs font-semibold text-charcoal/60 hover:bg-offwhite focus-ring"
                      >
                        Keep
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClearId(t.id)}
                      className="flex-shrink-0 rounded-full p-1.5 text-charcoal/40 hover:bg-red-50 hover:text-red-500 focus-ring"
                      aria-label={`Delete ${t.instrument} trade`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Privacy note */}
      <p className="flex items-start gap-2 text-xs text-charcoal/50">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        Your journal is private and saved on this device only. Clearing your browser data or switching
        devices will reset it. This is a learning tool, not financial advice.
      </p>
    </div>
  );
}

function StatCard({
  label, value, hint, tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "pos" | "neg" | "neutral";
}) {
  const toneCls = tone === "pos" ? "text-emerald-600" : tone === "neg" ? "text-red-600" : "text-navy";
  return (
    <div className="rounded-2xl border border-ice bg-white p-4 shadow-card">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-charcoal/50">{label}</div>
      <div className={`mt-1 text-2xl font-black ${toneCls}`}>{value}</div>
      {hint && <div className="text-[11px] text-charcoal/45">{hint}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-charcoal/70">{label}</span>
      {children}
    </label>
  );
}
