"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, CalendarDays, ChevronLeft } from "lucide-react";
import type { ShopProduct } from "@/lib/shopify";
import { checkoutDomain } from "@/lib/shopify";
import { productPid } from "@/data/shopProducts";

const numeric = (id: string) => id.split("/").pop();
const cartUrl = (ids: string[]) =>
  `https://${checkoutDomain}/cart/${ids.map((i) => `${numeric(i)}:1`).join(",")}`;

type ParsedVariant = ShopProduct["variants"][number] & { color: string | null; size: string | null };
function parse(v: ShopProduct["variants"][number]): ParsedVariant {
  const parts = v.title.split(" / ");
  return { ...v, color: parts.length > 1 ? parts[0] : null, size: parts.length > 1 ? parts[1] : parts[0] };
}

export function ProductDetail({
  product,
  pairs = [],
  collectionHandle = "the-collection",
}: {
  product: ShopProduct;
  pairs?: ShopProduct[];
  collectionHandle?: string;
}) {
  const imgs = product.images?.length ? product.images : product.imageUrl ? [product.imageUrl] : [];
  const [zoom, setZoom] = useState({ x: 50, y: 50, on: false });

  const parsed = useMemo(() => product.variants.map(parse), [product]);
  const colors = useMemo(() => [...new Set(parsed.map((v) => v.color).filter(Boolean))] as string[], [parsed]);
  const sizes = useMemo(() => [...new Set(parsed.map((v) => v.size).filter(Boolean))] as string[], [parsed]);
  const single = product.variants.length <= 1;

  const [color, setColor] = useState<string | null>(colors[0] ?? null);
  const [size, setSize] = useState<string | null>(null);

  // When colors have their own photos, the gallery pairs each color's front + back and
  // we track which color each photo belongs to (so clicking a photo also picks the color).
  const colorImgMap = product.colorImages ?? {};
  const hasColorImgs = Object.keys(colorImgMap).length > 0;
  const gallery = useMemo(() => {
    if (!hasColorImgs) return { list: imgs, colorOf: {} as Record<string, string> };
    const fronts = Object.values(colorImgMap);
    const list: string[] = [];
    const colorOf: Record<string, string> = {};
    const used = new Set<string>();
    for (const c of colors) {
      const front = colorImgMap[c];
      if (!front || used.has(front)) continue;
      list.push(front); used.add(front); colorOf[front] = c;
      const idx = imgs.indexOf(front);
      const back = idx >= 0 ? imgs[idx + 1] : undefined;
      if (back && !fronts.includes(back) && !used.has(back)) {
        list.push(back); used.add(back); colorOf[back] = c;
      }
    }
    for (const u of imgs) if (!used.has(u)) { list.push(u); used.add(u); }
    return { list, colorOf };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product]);
  const galleryImgs = gallery.list;
  const colorOf = gallery.colorOf;
  const [img, setImg] = useState<string | null>((color && colorImgMap[color]) || galleryImgs[0] || null);

  // Picking a color shows that color's front photo.
  function pickColor(c: string) {
    setColor(c);
    if (colorImgMap[c]) setImg(colorImgMap[c]);
  }
  // Clicking a photo shows it and selects the matching color on the right.
  function pickImg(u: string) {
    setImg(u);
    const c = colorOf[u];
    if (c) setColor(c);
  }

  const selected = single
    ? product.variants[0]
    : parsed.find((v) => (colors.length ? v.color === color : true) && v.size === size) ?? null;

  const soldOut = Boolean(product.soldOut);
  const isExperience = collectionHandle === "1m-experiences";
  const backHref = isExperience ? "/experiences" : "/collection";
  const backLabel = isExperience ? "1M Experiences" : "The Collection";

  function addToBag() {
    if (soldOut || !selected) return;
    window.location.href = cartUrl([selected.id]);
  }

  return (
    <div className="container-1m py-8 sm:py-12">
      <Link href={backHref} className="mb-6 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:text-medium">
        <ChevronLeft className="h-4 w-4" /> {backLabel}
      </Link>

      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        {/* Gallery */}
        <div>
          <div
            className="relative aspect-square w-full overflow-hidden rounded-2xl border border-[#E4DCCB] bg-offwhite/60 cursor-zoom-in"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setZoom({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, on: true });
            }}
            onMouseLeave={() => setZoom((z) => ({ ...z, on: false }))}
          >
            {img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={img}
                alt={product.imageAlt ?? product.title}
                className="h-full w-full object-cover transition-transform duration-200 ease-out will-change-transform"
                style={{ transform: zoom.on ? "scale(2)" : "scale(1)", transformOrigin: `${zoom.x}% ${zoom.y}%` }}
              />
            ) : null}
            {product.when && (
              <span className="absolute left-4 top-4 inline-flex items-center gap-1 rounded-full bg-navy/85 px-3 py-1 text-xs font-semibold text-cream backdrop-blur">
                <CalendarDays className="h-3.5 w-3.5" /> {product.when}
              </span>
            )}
          </div>
          {galleryImgs.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {galleryImgs.map((u, i) => (
                <button
                  key={i}
                  onClick={() => pickImg(u)}
                  aria-label={`Photo ${i + 1}`}
                  className={`h-16 w-16 overflow-hidden rounded-lg border transition-colors ${img === u ? "border-gold ring-1 ring-gold" : "border-[#E4DCCB] hover:border-gold/60"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Details */}
        <div>
          <h1 className="font-serif text-3xl font-black tracking-tight text-navy sm:text-4xl">{product.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="text-xl font-bold text-gold">{product.hasOptions ? "From " : ""}{product.minPrice}</p>
            {soldOut ? (
              <span className="rounded-full bg-red-600/90 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white">Sold out</span>
            ) : product.spots ? (
              <span className="rounded-full bg-gold/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-gold-deep">Only {product.spots} spots</span>
            ) : null}
          </div>

          {/* Color */}
          {!single && colors.length > 0 && (
            <div className="mt-6">
              <p className="text-xs font-bold uppercase tracking-label text-navy/60">Color: <span className="text-navy">{color}</span></p>
              <div className="mt-2 flex flex-wrap gap-2">
                {colors.map((c) => (
                  <button
                    key={c}
                    onClick={() => pickColor(c)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors ${color === c ? "border-primary bg-primary text-cream" : "border-[#E4DCCB] text-navy hover:border-primary"}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Size */}
          {!single && sizes.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-bold uppercase tracking-label text-navy/60">Size</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sizes.map((s) => {
                  const exists = parsed.some((v) => v.size === s && (colors.length ? v.color === color : true) && v.availableForSale);
                  return (
                    <button
                      key={s}
                      disabled={!exists}
                      onClick={() => setSize(s)}
                      className={`min-w-[3rem] rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${size === s ? "border-primary bg-primary text-cream" : "border-[#E4DCCB] text-navy hover:border-primary"}`}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <button
            onClick={addToBag}
            disabled={soldOut || (!single && !selected)}
            className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-4 text-sm font-bold uppercase tracking-wider text-cream transition-transform hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {soldOut ? "Sold out" : !single && !selected ? "Select a size" : <>{isExperience ? "Reserve" : "Add to bag"} <ArrowRight className="h-4 w-4" /></>}
          </button>
          <p className="mt-3 text-center text-xs text-charcoal/50">Secure checkout via Shopify.</p>

          {/* Description */}
          {(product.longDescription || product.description) && (
            <div className="mt-8 border-t border-[#E4DCCB] pt-6">
              <p className="text-xs font-bold uppercase tracking-label text-navy/60">Description</p>
              <p className="mt-3 whitespace-pre-line leading-relaxed text-charcoal/75">
                {product.longDescription || product.description}
              </p>
            </div>
          )}

          {/* What's included (experiences) */}
          {product.details?.length ? (
            <div className="mt-6">
              <p className="text-xs font-bold uppercase tracking-label text-navy/60">What&apos;s included</p>
              <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
                {product.details.map((d) => (
                  <li key={d} className="flex items-start gap-2.5 text-sm text-charcoal/80">
                    <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-gold/15 text-gold-deep">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      {/* Complete the set */}
      {pairs.length > 0 && (
        <div className="mt-14 border-t border-[#E4DCCB] pt-10">
          <h2 className="font-serif text-2xl font-black tracking-tight text-navy">Complete the set</h2>
          <p className="mt-1 text-sm text-charcoal/60">Add the matching bottoms to your {product.title.replace(/—.*$/, "").trim().toLowerCase()}.</p>
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {pairs.map((p) => (
              <PairCard key={p.id} pair={p} mainVariantId={selected?.id ?? null} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PairCard({ pair, mainVariantId }: { pair: ShopProduct; mainVariantId: string | null }) {
  const parsed = useMemo(() => pair.variants.map(parse), [pair]);
  const colors = useMemo(() => [...new Set(parsed.map((v) => v.color).filter(Boolean))] as string[], [parsed]);
  const sizes = useMemo(() => [...new Set(parsed.map((v) => v.size).filter(Boolean))] as string[], [parsed]);
  const [color, setColor] = useState<string | null>(colors[0] ?? null);
  const [size, setSize] = useState<string | null>(null);
  const selected = parsed.find((v) => (colors.length ? v.color === color : true) && v.size === size) ?? null;
  const pairImg = (color && pair.colorImages?.[color]) || pair.imageUrl;

  function addSet() {
    if (!selected) return;
    const ids = mainVariantId ? [mainVariantId, selected.id] : [selected.id];
    window.location.href = cartUrl(ids);
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
      <Link href={`/product/${productPid(pair.id)}`} className="block aspect-square overflow-hidden bg-offwhite/60">
        {pairImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pairImg} alt={pair.title} className="h-full w-full object-cover transition-transform duration-300 hover:scale-105" />
        ) : null}
      </Link>
      <div className="flex flex-1 flex-col p-4">
        <Link href={`/product/${productPid(pair.id)}`} className="font-serif text-base font-bold text-navy hover:text-primary">{pair.title}</Link>
        <p className="mt-1 text-sm font-semibold text-gold">{pair.minPrice}</p>
        {colors.length > 1 && (
          <select value={color ?? ""} onChange={(e) => setColor(e.target.value)} className="mt-3 w-full rounded-lg border border-[#E4DCCB] bg-cream px-2.5 py-2 text-sm outline-none focus:border-gold">
            {colors.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sizes.map((s) => {
            const exists = parsed.some((v) => v.size === s && (colors.length ? v.color === color : true));
            return (
              <button
                key={s}
                disabled={!exists}
                onClick={() => setSize(s)}
                className={`min-w-[2.5rem] rounded-md border px-2 py-1 text-xs font-semibold transition-colors disabled:opacity-30 ${size === s ? "border-primary bg-primary text-cream" : "border-[#E4DCCB] text-navy hover:border-primary"}`}
              >
                {s}
              </button>
            );
          })}
        </div>
        <button
          onClick={addSet}
          disabled={!selected}
          className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-navy/25 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-navy transition-colors hover:bg-navy/5 disabled:opacity-40"
        >
          {mainVariantId ? "Add set to bag" : "Add to bag"}
        </button>
      </div>
    </div>
  );
}
