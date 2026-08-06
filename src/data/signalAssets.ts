/**
 * Markets and assets for the OM AI Signal Generator.
 * `td` is the Twelve Data symbol used to fetch the live quote + candles.
 */
export type Asset = { symbol: string; name: string; td: string; quote?: string };
export type Market = {
  id: "crypto" | "metal" | "stock" | "forex" | "index";
  name: string;
  desc: string;
  assets: Asset[];
};

export const MARKETS: Market[] = [
  {
    id: "crypto",
    name: "Crypto",
    desc: "Bitcoin, Ethereum & more",
    assets: [
      { symbol: "BTC/USD", name: "Bitcoin", td: "BTC/USD" },
      { symbol: "ETH/USD", name: "Ethereum", td: "ETH/USD" },
      { symbol: "SOL/USD", name: "Solana", td: "SOL/USD" },
      { symbol: "XRP/USD", name: "XRP", td: "XRP/USD" },
      { symbol: "DOGE/USD", name: "Dogecoin", td: "DOGE/USD" },
    ],
  },
  {
    id: "metal",
    name: "Metal",
    desc: "Gold, Silver & Commodities",
    assets: [
      { symbol: "XAU/USD", name: "Gold Spot", td: "XAU/USD" },
      { symbol: "XAG/USD", name: "Silver Spot", td: "XAG/USD" },
      { symbol: "XPT/USD", name: "Platinum Spot", td: "XPT/USD" },
      { symbol: "WTI/USD", name: "Crude Oil (WTI)", td: "WTI/USD" },
    ],
  },
  {
    id: "stock",
    name: "Stock",
    desc: "Equities & ETFs",
    assets: [
      { symbol: "AAPL", name: "Apple Inc.", td: "AAPL" },
      { symbol: "NVDA", name: "NVIDIA Corp.", td: "NVDA" },
      { symbol: "TSLA", name: "Tesla Inc.", td: "TSLA" },
      { symbol: "MSFT", name: "Microsoft Corp.", td: "MSFT" },
      { symbol: "AMZN", name: "Amazon.com Inc.", td: "AMZN" },
    ],
  },
  {
    id: "forex",
    name: "Forex",
    desc: "Currency Pairs",
    assets: [
      { symbol: "EUR/USD", name: "Euro / US Dollar", td: "EUR/USD" },
      { symbol: "GBP/USD", name: "British Pound / US Dollar", td: "GBP/USD" },
      { symbol: "USD/JPY", name: "US Dollar / Japanese Yen", td: "USD/JPY" },
      { symbol: "AUD/USD", name: "Aussie / US Dollar", td: "AUD/USD" },
      { symbol: "USD/CAD", name: "US Dollar / Canadian Dollar", td: "USD/CAD" },
      { symbol: "NZD/USD", name: "Kiwi / US Dollar", td: "NZD/USD" },
      { symbol: "USD/CHF", name: "US Dollar / Swiss Franc", td: "USD/CHF" },
      { symbol: "EUR/JPY", name: "Euro / Japanese Yen", td: "EUR/JPY" },
      { symbol: "GBP/JPY", name: "British Pound / Japanese Yen", td: "GBP/JPY" },
      { symbol: "AUD/JPY", name: "Aussie / Japanese Yen", td: "AUD/JPY" },
      { symbol: "EUR/GBP", name: "Euro / British Pound", td: "EUR/GBP" },
      { symbol: "EUR/AUD", name: "Euro / Aussie", td: "EUR/AUD" },
      { symbol: "GBP/AUD", name: "British Pound / Aussie", td: "GBP/AUD" },
    ],
  },
  {
    id: "index",
    name: "Index",
    desc: "S&P 500, Nasdaq & Dow (real-time ETFs)",
    assets: [
      // S&P and Dow use real-time ETF proxies (Twelve Data serves no clean index
      // level on this plan). NAS100 is presented at the true index level via the
      // QQQ→index scaling in lib/marketData (resolveTd/scaleRows).
      { symbol: "SPY", name: "S&P 500 · SPY", td: "SPY" },
      { symbol: "NAS100", name: "Nasdaq 100 · NAS100", td: "NAS100" },
      { symbol: "DIA", name: "Dow Jones · DIA", td: "DIA" },
    ],
  },
];

export function findAsset(td: string): { market: Market; asset: Asset } | null {
  for (const m of MARKETS) {
    const a = m.assets.find((x) => x.td === td);
    if (a) return { market: m, asset: a };
  }
  return null;
}
