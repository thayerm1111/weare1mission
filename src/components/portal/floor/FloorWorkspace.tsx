"use client";

import { useState } from "react";
import {
  Radio,
  Bell,
  ScanLine,
  Copy,
  Users,
  Star,
  Clipboard,
  ChevronRight,
  Link2,
  Lock,
  PlayCircle,
} from "lucide-react";
import { TradingViewChart } from "./TradingViewChart";

/* ------------------------------------------------------------------ */
/*  Sample data — Phase 1 is the UI. Phase 2 wires these to Supabase.  */
/* ------------------------------------------------------------------ */

type Alert = {
  id: string;
  pair: string;
  side: "Buy Market" | "Sell Market";
  ep: string;
  sl: string;
  tps: string[];
  strength: number;
  createdAt: string;
  orderType: string;
  caller: string;
  note?: string;
  active: boolean;
};

const SAMPLE_ALERTS: Alert[] = [
  {
    id: "a1",
    pair: "XAU/USD",
    side: "Sell Market",
    ep: "4127",
    sl: "4135",
    tps: ["4125", "4123", "4121", "4115", "4110"],
    strength: 4,
    createdAt: "07/09/2026 09:20 PM",
    orderType: "Scalp",
    caller: "Arabella Angeles",
    note: "Clean rejection off the level — trail after TP2.",
    active: true,
  },
  {
    id: "a2",
    pair: "XAU/USD",
    side: "Sell Market",
    ep: "4032",
    sl: "4040",
    tps: ["4030", "4028", "4026", "4020", "4010"],
    strength: 5,
    createdAt: "07/09/2026 01:09 PM",
    orderType: "Scalp",
    caller: "Arabella Angeles",
    active: true,
  },
];

const SCANNER_TEMPLATES = [
  { id: "trend", label: "Trend Suite", studies: ["STD;EMA", "STD;MACD"] },
  { id: "momentum", label: "Momentum", studies: ["STD;RSI", "STD;Stochastic_RSI"] },
  { id: "bands", label: "Volatility Bands", studies: ["STD;Bollinger_Bands", "STD;ATR"] },
  { id: "vwap", label: "VWAP + Volume", studies: ["STD;VWAP", "STD;Volume"] },
  { id: "clean", label: "Clean Price", studies: [] as string[] },
];

const SYMBOLS = ["OANDA:XAUUSD", "OANDA:EURUSD", "OANDA:GBPUSD", "BINANCE:BTCUSDT", "NASDAQ:NDX"];

/* ------------------------------------------------------------------ */

const TABS = [
  { id: "live", label: "Live Session", icon: Radio },
  { id: "alerts", label: "Trade Alerts", icon: Bell },
  { id: "scanner", label: "Scanner", icon: ScanLine },
  { id: "copy", label: "Copy Trader", icon: Copy },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function FloorWorkspace({
  isCaller = false,
  followerCount = 0,
}: {
  isCaller?: boolean;
  followerCount?: number;
}) {
  const [tab, setTab] = useState<TabId>("live");

  return (
    <div className="rounded-3xl border border-[#0c0c0c] bg-[#0a0a0a] p-3 text-white shadow-card sm:p-4">
      {/* Tab bar */}
      <div className="flex flex-wrap gap-1.5 rounded-2xl bg-[#141414] p-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors ${
                active
                  ? "bg-white text-black"
                  : "text-white/60 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {tab === "live" && <LiveSessionTab />}
        {tab === "alerts" && <TradeAlertsTab isCaller={isCaller} followerCount={followerCount} />}
        {tab === "scanner" && <ScannerTab />}
        {tab === "copy" && <CopyTraderTab />}
      </div>
    </div>
  );
}

/* --------------------------- Live Session --------------------------- */

function LiveSessionTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-70" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
            <span className="text-sm font-semibold uppercase tracking-wide text-white">
              Live now · Gold session
            </span>
          </div>
          <span className="text-xs text-white/40">Hosted by the trading desk</span>
        </div>
        <TradingViewChart symbol="OANDA:XAUUSD" interval="15" height={480} />
      </div>

      {/* Live stream / session side panel */}
      <div className="flex flex-col rounded-2xl border border-white/10 bg-[#111] p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/50">Session stream</p>
        <div className="mt-3 flex aspect-video items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/40 text-center">
          <div className="px-4">
            <PlayCircle className="mx-auto h-8 w-8 text-white/40" aria-hidden="true" />
            <p className="mt-2 text-sm text-white/60">
              Live video embeds here when a session is running.
            </p>
          </div>
        </div>
        <button className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black transition-opacity hover:opacity-90">
          Join the live room <ChevronRight className="h-4 w-4" />
        </button>
        <p className="mt-4 text-xs leading-relaxed text-white/40">
          Sessions, replays and the room link are managed from the desk. Times show under
          What&apos;s On.
        </p>
      </div>
    </div>
  );
}

/* --------------------------- Trade Alerts --------------------------- */

function TradeAlertsTab({
  isCaller,
  followerCount,
}: {
  isCaller: boolean;
  followerCount: number;
}) {
  return (
    <div className="space-y-4">
      {isCaller && (
        <div className="flex flex-col gap-3 rounded-2xl border border-gold/40 bg-gold/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex items-center gap-2.5">
            <Users className="h-5 w-5 text-gold-light" aria-hidden="true" />
            <p className="text-sm text-white">
              <span className="font-bold text-white">{followerCount.toLocaleString()}</span>{" "}
              <span className="text-white/60">people are following your calls</span>
            </p>
          </div>
          <button
            title="Posting goes live in the next phase"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black transition-opacity hover:opacity-90"
          >
            <Bell className="h-4 w-4" /> Post a trade alert
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-white">Trade Alerts</p>
        <span className="text-xs text-white/40">Live feed · subscribe to a caller for alerts</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {SAMPLE_ALERTS.map((a) => (
          <AlertCard key={a.id} alert={a} />
        ))}
      </div>

      <p className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center text-xs text-white/40">
        Preview data. Once posting is live, subscribers get a text, email or Telegram message the
        moment a caller they follow posts.
      </p>
    </div>
  );
}

function AlertCard({ alert }: { alert: Alert }) {
  const buy = alert.side === "Buy Market";
  return (
    <article className="rounded-2xl border border-white/10 bg-[#0f0f0f] p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="inline-flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${alert.active ? "bg-emerald-400" : "bg-white/30"}`}
            />
            <span
              className={`text-xs font-semibold ${alert.active ? "text-emerald-400" : "text-white/40"}`}
            >
              {alert.active ? "Active" : "Closed"}
            </span>
          </div>
          <h3 className="mt-1 text-lg font-extrabold tracking-tight text-white">{alert.pair}</h3>
        </div>
        <span
          className={`rounded-lg px-3 py-1.5 text-sm font-bold ${
            buy ? "bg-emerald-500/15 text-emerald-300" : "bg-gold/15 text-gold-light"
          }`}
        >
          {alert.side}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Field label="EP" value={alert.ep} />
        <Field label="SL" value={alert.sl} />
        {alert.tps.map((tp, i) => (
          <Field key={i} label={`TP${i + 1}`} value={tp} />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-white/50">Strength</span>
        <span className="inline-flex">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={`h-3.5 w-3.5 ${
                i < alert.strength ? "fill-gold-light text-gold-light" : "text-white/20"
              }`}
            />
          ))}
        </span>
      </div>

      <div className="mt-2 space-y-1 text-sm">
        <Row label="Created At" value={alert.createdAt} />
        <Row label="Order Type" value={alert.orderType} />
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gold/30 text-xs font-bold text-gold-light">
          {alert.caller
            .split(" ")
            .map((n) => n[0])
            .join("")}
        </div>
        <span className="text-sm font-semibold text-white">{alert.caller}</span>
      </div>

      {alert.note && (
        <p className="mt-2 text-sm">
          <span className="font-semibold text-gold-light">Note: </span>
          <span className="text-white/70">{alert.note}</span>
        </p>
      )}
    </article>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2">
      <span className="text-sm text-white/50">{label}</span>
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-white">
        {value}
        <Clipboard className="h-3.5 w-3.5 text-white/30" />
      </span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/50">{label}</span>
      <span className="font-medium text-white/90">{value}</span>
    </div>
  );
}

/* ----------------------------- Scanner ----------------------------- */

function ScannerTab() {
  const [tpl, setTpl] = useState(SCANNER_TEMPLATES[0]);
  const [symbol, setSymbol] = useState(SYMBOLS[0]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-white/50">
          Templates
        </span>
        {SCANNER_TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTpl(t)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              tpl.id === t.id ? "bg-white text-black" : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            {t.label}
          </button>
        ))}
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="ml-auto rounded-lg border border-white/10 bg-[#141414] px-3 py-1.5 text-sm text-white focus:outline-none"
        >
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s.split(":")[1] ?? s}
            </option>
          ))}
        </select>
      </div>

      <TradingViewChart symbol={symbol} interval="60" studies={tpl.studies} height={520} />

      <p className="text-xs text-white/40">
        Load a saved indicator template, then scan any market. Add your own studies right on the
        chart with the indicators button.
      </p>
    </div>
  );
}

/* --------------------------- Copy Trader --------------------------- */

function CopyTraderTab() {
  const [connected, setConnected] = useState(false);
  const [side, setSide] = useState<"Buy" | "Sell">("Sell");

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      {/* Connection / explainer */}
      <div className="space-y-4">
        <div className="rounded-2xl border border-white/10 bg-[#111] p-5">
          <div className="inline-flex items-center gap-2">
            <Link2 className="h-5 w-5 text-gold-light" />
            <h3 className="text-base font-bold text-white">Copy an approved trader</h3>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-white/60">
            Connect your TradeLocker account to a trader we&apos;ve approved. When they take a trade,
            you get asked to approve it — and you choose your own lot size or risk %. Nothing runs
            without your OK.
          </p>

          {!connected ? (
            <button
              onClick={() => setConnected(true)}
              className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black transition-opacity hover:opacity-90"
            >
              <Link2 className="h-4 w-4" /> Connect TradeLocker account
            </button>
          ) : (
            <div className="mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400" /> Connected · following the desk
            </div>
          )}
        </div>

        <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <Lock className="mt-0.5 h-4 w-4 text-white/40" />
          <p className="text-xs leading-relaxed text-white/50">
            Live account linking and order approval come online in a later phase and require
            TradeLocker API access. This panel shows how the approval will look.
          </p>
        </div>
      </div>

      {/* Approve-trade ticket (mock of your screenshot) */}
      <div className="rounded-2xl border border-white/10 bg-[#0d0d0d] p-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <span className="text-base font-extrabold tracking-tight text-white">EURUSD</span>
          <div className="text-right">
            <p className="text-[11px] text-white/40">Account Balance</p>
            <p className="text-sm font-bold text-emerald-400">$0.00</p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => setSide("Buy")}
            className={`rounded-lg py-2.5 text-sm font-bold ${
              side === "Buy" ? "bg-emerald-500 text-black" : "bg-white/[0.04] text-emerald-400"
            }`}
          >
            Buy
          </button>
          <button
            onClick={() => setSide("Sell")}
            className={`rounded-lg py-2.5 text-sm font-bold ${
              side === "Sell" ? "bg-red-500 text-white" : "bg-white/[0.04] text-red-400"
            }`}
          >
            Sell
          </button>
        </div>

        <div className="mt-3 space-y-2">
          <TicketRow label="Entry Price" value="1.14267" />
          <TicketRow label="Stop Loss" value="1.14418" />
          <TicketRow label="Take Profit" value="1.13977" />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <LabeledInput label="LOT" placeholder="0" />
          <LabeledInput label="Risk %" placeholder="0.1" />
        </div>

        <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 py-3 text-center">
          <span className="text-lg font-extrabold text-red-400">00</span>
          <span className="text-sm text-white/50"> min </span>
          <span className="text-white/30">|</span>
          <span className="ml-1 text-lg font-extrabold text-red-400">00</span>
          <span className="text-sm text-white/50"> sec</span>
        </div>

        <button className="mt-3 w-full rounded-xl bg-gradient-to-r from-[#8a6d2f] via-[#d9b45a] to-[#8a6d2f] py-3 text-sm font-bold text-black">
          Approve
        </button>

        <div className="mt-4 border-t border-white/10 pt-3">
          <p className="text-xs font-semibold text-white/60">Risk percentage preset</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <LabeledInput label="Risk %" placeholder="" />
            <button className="rounded-lg bg-gradient-to-r from-[#8a6d2f] via-[#d9b45a] to-[#8a6d2f] text-sm font-bold text-black">
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TicketRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2.5">
      <span className="text-sm text-white/50">{label}</span>
      <span className="text-sm font-semibold text-white">{value}</span>
    </div>
  );
}

function LabeledInput({ label, placeholder }: { label: string; placeholder: string }) {
  return (
    <label className="flex items-center justify-between rounded-lg border border-white/10 bg-black/40 px-3 py-2.5">
      <span className="text-sm text-white/50">{label}</span>
      <input
        type="text"
        placeholder={placeholder}
        className="w-14 bg-transparent text-right text-sm font-semibold text-white placeholder:text-white/30 focus:outline-none"
      />
    </label>
  );
}
