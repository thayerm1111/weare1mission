/** Browser-safe Nitrous add-on price and access rules. Billing records are server-owned. */
export const NITROUS_ADDON_PRODUCT = "om_nitrous_addon";
export const NITROUS_ADDON_PRICE_CENTS = 1999;
export const NITROUS_ADDON_PRICE_USD = 19.99 as const;

export type NitrousAddonAccess = {
  entitled: boolean;
  source: "admin" | "subscription" | null;
  adminGranted: boolean;
  priceUsd: 19.99;
  interval: "month";
  subscription: { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null } | null;
  verificationUnavailable?: boolean;
};

export type NitrousAddonSubscriptionRow = {
  stripe_subscription_id: string;
  user_id: string;
  stripe_customer_id: string | null;
  status: string;
  current_period_end: string | null;
  paid_through: string | null;
  cancel_at_period_end: boolean;
  billing_paused: boolean;
  checked_at: string;
};

export const isNitrousAddonProduct = (metadata?: Record<string, string> | null) => metadata?.product === NITROUS_ADDON_PRODUCT;

export function hasPaidNitrousAccess(row: Partial<NitrousAddonSubscriptionRow>, now = Date.now()): boolean {
  const end = typeof row.paid_through === "string" ? Date.parse(row.paid_through) : NaN;
  return row.status === "active" && row.billing_paused === false && Number.isFinite(end) && end > now;
}

export function nitrousAddonAccess(granted: boolean, rows: NitrousAddonSubscriptionRow[], now = Date.now()): NitrousAddonAccess {
  const paid = rows.filter((r) => hasPaidNitrousAccess(r, now));
  const latest = [...(paid.length ? paid : rows)].sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0];
  return {
    entitled: granted || paid.length > 0,
    source: granted ? "admin" : paid.length ? "subscription" : null,
    adminGranted: granted,
    priceUsd: NITROUS_ADDON_PRICE_USD,
    interval: "month",
    subscription: latest ? { status: latest.status, cancelAtPeriodEnd: latest.cancel_at_period_end,
      currentPeriodEnd: latest.current_period_end } : null,
  };
}

export type NitrousStripeSubscription = {
  id: string; status: string; customer?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  current_period_end?: number | null;
  items?: { data?: Array<{ id?: string; quantity?: number | null; current_period_end?: number | null;
    price?: { id?: string; currency?: string; unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } | null } }> };
  cancel_at_period_end?: boolean;
  pause_collection?: unknown;
  latest_invoice?: string | NitrousStripeInvoice | null;
};
export type NitrousStripeInvoice = {
  id?: string; status?: string | null; currency?: string | null;
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  lines?: { data?: Array<{ subscription?: string | { id: string } | null; subscription_item?: string | null;
    parent?: { subscription_item_details?: { subscription?: string | { id: string } | null; subscription_item?: string | null; proration?: boolean } | null } | null;
    proration?: boolean; period?: { start?: number; end?: number }; price?: { id?: string } | null;
    pricing?: { price_details?: { price?: string | { id: string } } | null } | null }> };
};
const objectId = (v: unknown): string | null => typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

/** Metadata alone cannot turn another plan into the $19.99/month add-on. */
export function validNitrousSubscription(s: NitrousStripeSubscription, userId?: string): boolean {
  const items = s.items?.data ?? [];
  const p = items[0]?.price;
  return isNitrousAddonProduct(s.metadata) && !!s.metadata?.user_id && (!userId || s.metadata.user_id === userId)
    && items.length === 1 && items[0].quantity === 1
    && p?.currency === "usd" && p.unit_amount === NITROUS_ADDON_PRICE_CENTS
    && p.recurring?.interval === "month" && p.recurring.interval_count === 1;
}

export function nitrousPeriodEnd(s: NitrousStripeSubscription): number | null {
  const value = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Advance entitlement only to a paid, non-proration line belonging to this exact subscription. */
export function nitrousPaidThrough(s: NitrousStripeSubscription, invoice: NitrousStripeInvoice | null): string | null {
  if (!validNitrousSubscription(s) || !invoice || invoice.status !== "paid" || invoice.currency !== "usd") return null;
  const owner = objectId(invoice.subscription) || objectId(invoice.parent?.subscription_details?.subscription);
  if (owner !== s.id) return null;
  const item = s.items!.data![0];
  const periodEnd = nitrousPeriodEnd(s);
  if (periodEnd === null) return null;
  const ends = (invoice.lines?.data ?? []).flatMap((line) => {
    const detail = line.parent?.subscription_item_details;
    if (line.proration || detail?.proration) return [];
    const lineSub = objectId(line.subscription) || objectId(detail?.subscription);
    const itemId = line.subscription_item || detail?.subscription_item;
    const priceId = line.price?.id || objectId(line.pricing?.price_details?.price);
    if (lineSub && lineSub !== s.id) return [];
    if (itemId && itemId !== item.id) return [];
    if (priceId && priceId !== item.price?.id) return [];
    if (!itemId && !lineSub) return [];
    const end = line.period?.end;
    return typeof end === "number" && Number.isFinite(end) && end > 0 && end <= periodEnd ? [end] : [];
  });
  return ends.length ? new Date(Math.max(...ends) * 1000).toISOString() : null;
}
