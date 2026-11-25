"use client";

import { actionWords } from "@/lib/genx/words";

const price = (value: number | null | undefined, dec: number) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : "—";

export function SimpleGenxRead({ market, action, bias, quote, dec, snapshot, summary, headline }: {
  market: string; action?: string; bias?: string; quote: number | null; dec: number; snapshot: boolean; summary?: string; headline?: string;
}) {
  const read = action ? actionWords(action) : null;
  const direction = /bull|buy|long/i.test(bias ?? "") ? "Price is leaning up" : /bear|sell|short/i.test(bias ?? "")
    ? "Price is leaning down" : /range|sideway/i.test(bias ?? "") ? "Price is moving sideways" : "No clear direction yet";
  return <section className="om-simple-heading om-genx-simple-read" aria-label={market + " simple market read"}>
    <div className="om-simple-status">
      <span className="om-label">{market} · {snapshot ? "Price when analyzed" : "Last market reading"}</span>
      <strong className="om-num" data-no-i18n translate="no">{price(quote, dec)}</strong>
      <p>{direction}.</p>
    </div>
    <h2>{headline ?? (read ? read.waiting || !read.side ? "Wait for a clear entry" : read.side === "buy" ? "Buy setup found" : "Sell setup found" : "Start with a market read")}</h2>
    <p>{summary || (read ? read.waiting ? "The direction is a possibility. The entry condition still needs to happen." :
      "Review the entry, protection stop and target before deciding what to do." : "Analyze this market to see whether there is an entry to consider or a reason to wait.")}</p>
  </section>;
}

export function SimpleGenxLevels({ entry, stop, target, dec, reference }: {
  entry: number | null | undefined; stop: number | null | undefined; target: number | null | undefined; dec: number; reference: boolean;
}) {
  return <div>
    <dl className="om-genx-simple-levels" aria-label="Entry, protection stop and first target" data-no-i18n translate="no">
      <div data-kind="entry"><dt>Entry price</dt><dd>{price(entry, dec)}</dd></div>
      <div data-kind="stop"><dt>Protection stop</dt><dd>{price(stop, dec)}</dd></div>
      <div data-kind="target"><dt>First target</dt><dd>{price(target, dec)}</dd></div>
    </dl>
    {reference && <p className="om-genfx-read-note">These are reference prices. Wait for the entry condition to confirm.</p>}
  </div>;
}
