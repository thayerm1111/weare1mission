/** Live-feeling platform strip. No fake prices, no invented activity — names
 *  and true, standing platform facts only. */
const MARKETS = ["XAU/USD", "NAS100", "US30", "EUR/USD", "GBP/USD", "USD/JPY", "USOIL"];
const ACTIVITY = ["Gold desk active", "OM reading structure", "Flow management running", "Live sessions weekly"];

export function MarketsStrip() {
  return (
    <section className="border-y border-[#E8EFF5] bg-white">
      <div className="mx-auto max-w-content px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          <span className="text-[10.5px] font-semibold uppercase tracking-label text-[#8A99A8]">Markets we watch</span>
          <div className="flex flex-wrap items-center gap-x-7 gap-y-2">
            {MARKETS.map((m) => (
              <span key={m} className="flex items-center gap-2 text-[13px] font-semibold text-[#3C4E5F]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#5B9BD5]" aria-hidden="true" />{m}
              </span>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-[#F1F5F9] pt-3">
          {ACTIVITY.map((a) => (
            <span key={a} className="flex items-center gap-2 text-[11.5px] font-medium text-[#8A99A8]">
              <span className="h-1 w-1 rounded-full bg-[#199868]" aria-hidden="true" />{a}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
