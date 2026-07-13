"use client";

import { useState } from "react";
import {
  TrendingUp,
  Gauge,
  Waves,
  BarChart3,
  Layers,
  Crosshair,
} from "lucide-react";
import { TradingViewChart } from "./TradingViewChart";

const SCANNERS = [
  { id: "trend", label: "Trend Suite", icon: TrendingUp, studies: ["STD;EMA", "STD;MACD"] },
  { id: "momentum", label: "Momentum", icon: Gauge, studies: ["STD;RSI", "STD;Stochastic_RSI"] },
  { id: "volatility", label: "Volatility", icon: Waves, studies: ["STD;Bollinger_Bands", "STD;ATR"] },
  { id: "volume", label: "VWAP + Volume", icon: BarChart3, studies: ["STD;VWAP", "STD;Volume"] },
  { id: "liquidity", label: "Liquidity", icon: Layers, studies: ["STD;Pivot_Points_Standard"] },
  { id: "clean", label: "Clean Price", icon: Crosshair, studies: [] as string[] },
];

const SYMBOLS = ["OANDA:XAUUSD", "OANDA:EURUSD", "OANDA:GBPUSD", "BINANCE:BTCUSDT", "NASDAQ:NDX"];

export function MarketPulse() {
  const [scanner, setScanner] = useState(SCANNERS[0]);
  const [symbol, setSymbol] = useState(SYMBOLS[0]);

  return (
    <div className="space-y-3">
      {/* Scanner tiles */}
      <div className="flex flex-wrap items-center gap-2">
        {SCANNERS.map((s) => {
          const Icon = s.icon;
          const active = s.id === scanner.id;
          return (
            <button
              key={s.id}
              onClick={() => setScanner(s)}
              className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-colors ${
                active
                  ? "border-gold bg-gold/15 text-gold-light"
                  : "border-white/10 bg-[#111] text-white/70 hover:border-white/25 hover:text-white"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                  active ? "bg-gold/25 text-gold-light" : "bg-white/5 text-white/60"
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
              {s.label}
            </button>
          );
        })}
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="ml-auto rounded-xl border border-white/10 bg-[#141414] px-3 py-2.5 text-sm text-white focus:outline-none"
        >
          {SYMBOLS.map((s) => (
            <option key={s} value={s}>
              {s.split(":")[1] ?? s}
            </option>
          ))}
        </select>
      </div>

      {/* Near full-height chart */}
      <TradingViewChart symbol={symbol} interval="60" studies={scanner.studies} height="86vh" />
    </div>
  );
}
