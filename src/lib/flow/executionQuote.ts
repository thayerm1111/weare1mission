/** Select the executable side. Missing/crossed quotes cannot authorize an action. */
export function executablePrice(quote: { bid: number | null; ask: number | null }, side: 'buy' | 'sell', phase: 'entry' | 'exit'): number | null {
  const { bid, ask } = quote;
  if (bid != null && ask != null && ask < bid) return null;
  const useAsk = phase === 'entry' ? side === 'buy' : side === 'sell';
  const price = useAsk ? ask : bid;
  return price != null && Number.isFinite(price) && price > 0 ? price : null;
}
export function bracketStillValid(side: 'buy' | 'sell', price: number, stop: number, target?: number | null): boolean {
  if (![price, stop].every(n => Number.isFinite(n) && n > 0)) return false;
  return side === 'buy' ? stop < price && (target == null || target > price) : stop > price && (target == null || target < price);
}
