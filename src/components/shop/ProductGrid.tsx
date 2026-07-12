"use client";

import { useEffect, useState } from "react";
import { ImageOff, ArrowRight, Check, X, CalendarDays } from "lucide-react";
import type { ShopProduct } from "@/lib/shopify";

export function ProductGrid({ products, domain }: { products: ShopProduct[]; domain: string }) {
  if (products.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-10 text-center text-charcoal/60">
        Nothing here yet — check back soon.
      </div>
    );
  }
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((p) => <Card key={p.id} product={p} domain={domain} />)}
    </div>
  );
}

function checkout(domain: string, variantId: string) {
  if (!variantId) return;
  const numeric = variantId.split("/").pop();
  window.location.href = `https://${domain}/cart/${numeric}:1`;
}

function Card({ product, domain }: { product: ShopProduct; domain: string }) {
  const buyable = product.variants.filter((v) => v.availableForSale);
  const [variantId, setVariantId] = useState(buyable[0]?.id ?? product.variants[0]?.id ?? "");
  const imgs = product.images?.length ? product.images : product.imageUrl ? [product.imageUrl] : [];
  const [img, setImg] = useState<string | null>(imgs[0] ?? null);
  const [open, setOpen] = useState(false);
  // Hover-to-zoom: track the cursor position over the image (as %) and whether hovering.
  const [zoom, setZoom] = useState<{ x: number; y: number; on: boolean }>({ x: 50, y: 50, on: false });

  const soldOut = Boolean(product.soldOut) || buyable.length === 0;
  const hasDetails = Boolean(product.details?.length || product.longDescription);

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
      <button
        type="button"
        onClick={() => hasDetails && setOpen(true)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setZoom({
            x: ((e.clientX - r.left) / r.width) * 100,
            y: ((e.clientY - r.top) / r.height) * 100,
            on: true,
          });
        }}
        onMouseLeave={() => setZoom((z) => ({ ...z, on: false }))}
        className={`relative flex aspect-square items-center justify-center overflow-hidden bg-offwhite/60 ${hasDetails ? "cursor-pointer" : "cursor-zoom-in"}`}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={product.imageAlt ?? product.title}
            className="h-full w-full object-cover transition-transform duration-200 ease-out will-change-transform"
            style={{ transform: zoom.on ? "scale(2)" : "scale(1)", transformOrigin: `${zoom.x}% ${zoom.y}%` }}
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-medium">
            <ImageOff className="h-8 w-8" aria-hidden="true" />
            <span className="text-xs">Add a product image in Shopify</span>
          </div>
        )}
        {product.when && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-navy/85 px-2.5 py-1 text-xs font-semibold text-cream backdrop-blur">
            <CalendarDays className="h-3 w-3" /> {product.when}
          </span>
        )}
        {soldOut ? (
          <span className="absolute right-3 top-3 rounded-full bg-red-600/90 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-white backdrop-blur">
            Sold out
          </span>
        ) : product.spots ? (
          <span className="absolute right-3 top-3 rounded-full bg-gold/90 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-cream backdrop-blur">
            Only {product.spots} spots
          </span>
        ) : null}
      </button>
      {imgs.length > 1 && (
        <div className="flex gap-2 px-5 pt-4">
          {imgs.map((u, i) => (
            <button
              key={i}
              onClick={() => setImg(u)}
              aria-label={`View photo ${i + 1}`}
              className={`h-14 w-14 overflow-hidden rounded-lg border transition-colors ${img === u ? "border-gold ring-1 ring-gold" : "border-[#E4DCCB] hover:border-gold/60"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-1 flex-col p-5">
        <h3 className="font-serif text-lg font-bold text-navy">{product.title}</h3>
        <p className="mt-1 text-sm font-semibold text-gold">
          {product.hasOptions ? "From " : ""}{product.minPrice}
        </p>
        {product.spots && !soldOut && (
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-gold-deep">Limited to {product.spots} spots</p>
        )}
        {product.description && (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-charcoal/65">{product.description}</p>
        )}

        <div className="mt-auto pt-4">
          {product.variants.length > 1 && (
            <select
              value={variantId}
              onChange={(e) => setVariantId(e.target.value)}
              className="mb-3 w-full rounded-xl border border-[#E4DCCB] bg-cream px-3 py-2.5 text-sm outline-none focus:border-gold"
            >
              {product.variants.map((v) => (
                <option key={v.id} value={v.id} disabled={!v.availableForSale}>
                  {v.title}{v.availableForSale ? "" : " — sold out"} · {v.price}
                </option>
              ))}
            </select>
          )}
          {hasDetails && (
            <button
              onClick={() => setOpen(true)}
              className="mb-2 inline-flex w-full items-center justify-center gap-2 rounded-full border border-navy/25 px-6 py-3 text-sm font-bold uppercase tracking-wider text-navy transition-colors hover:bg-navy/5"
            >
              View details
            </button>
          )}
          <button
            onClick={() => checkout(domain, variantId)}
            disabled={soldOut}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3 text-sm font-bold uppercase tracking-wider text-cream transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {soldOut ? "Sold out" : <>{product.details?.length ? "Reserve" : "Checkout"} <ArrowRight className="h-4 w-4" /></>}
          </button>
        </div>
      </div>

      {open && (
        <DetailsModal
          product={product}
          image={img}
          onClose={() => setOpen(false)}
          onReserve={() => checkout(domain, variantId)}
          soldOut={soldOut}
        />
      )}
    </div>
  );
}

function DetailsModal({
  product,
  image,
  onClose,
  onReserve,
  soldOut,
}: {
  product: ShopProduct;
  image: string | null;
  onClose: () => void;
  onReserve: () => void;
  soldOut: boolean;
}) {
  // lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const heroImage = product.detailImage ?? image;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-navy/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-[#E4DCCB] bg-cream shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 rounded-full bg-cream/90 p-2 text-navy shadow-card transition-colors hover:bg-white"
        >
          <X className="h-5 w-5" />
        </button>

        {heroImage && (
          <div className="aspect-video w-full overflow-hidden bg-offwhite/60">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={heroImage} alt={product.imageAlt ?? product.title} className="h-full w-full object-cover" />
          </div>
        )}

        <div className="p-6 sm:p-8">
          {product.when && (
            <span className="inline-flex items-center gap-1 rounded-full bg-navy/10 px-3 py-1 text-xs font-bold uppercase tracking-label text-navy">
              <CalendarDays className="h-3.5 w-3.5" /> {product.when}
            </span>
          )}
          <h2 className="mt-3 font-serif text-3xl font-black tracking-tight text-navy">{product.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="text-lg font-bold text-gold">{product.minPrice}</p>
            {soldOut ? (
              <span className="rounded-full bg-red-600/90 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white">Sold out</span>
            ) : product.spots ? (
              <span className="rounded-full bg-gold/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-gold-deep">Only {product.spots} spots</span>
            ) : null}
          </div>

          {product.longDescription && (
            <p className="mt-4 leading-relaxed text-charcoal/75">{product.longDescription}</p>
          )}

          {product.details?.length ? (
            <>
              <p className="mt-6 text-xs font-bold uppercase tracking-label text-navy/60">What&apos;s included</p>
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
            </>
          ) : null}

          <button
            onClick={onReserve}
            disabled={soldOut}
            className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-bold uppercase tracking-wider text-cream transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {soldOut ? "Sold out" : <>Reserve your spot — {product.minPrice} <ArrowRight className="h-4 w-4" /></>}
          </button>
          <p className="mt-3 text-center text-xs text-charcoal/50">Secure checkout via Shopify.</p>
        </div>
      </div>
    </div>
  );
}
