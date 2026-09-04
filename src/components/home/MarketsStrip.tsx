/** Subtle markets band under the hero. No fake prices — names only. */
const MARKETS = ["XAU/USD", "NAS100", "US30", "EUR/USD", "GBP/USD", "USD/JPY", "USOIL"];

export function MarketsStrip() {
  return (
    <section className="border-y border-[#E8EFF5] bg-white">
      <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 py-5">
        <span className="text-[10.5px] font-semibold uppercase tracking-label text-[#8A99A8]">Markets we watch</span>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          {MARKETS.map((m) => (
            <span key={m} className="flex items-center gap-2 text-[13px] font-semibold text-[#3C4E5F]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#5B9BD5]" aria-hidden="true" />{m}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
