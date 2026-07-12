"use client";

import { useState } from "react";
import Link from "next/link";
import { ImageOff, CalendarDays, ArrowRight } from "lucide-react";
import type { ShopProduct } from "@/lib/shopify";
import { productPid } from "@/data/shopProducts";

export function ProductGrid({ products }: { products: ShopProduct[]; domain?: string }) {
  if (products.length === 0) {
    return (
      <div className="rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-10 text-center text-charcoal/60">
        Nothing here yet — check back soon.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-3">
      {products.map((p) => <Card key={p.id} product={p} />)}
    </div>
  );
}

function Card({ product }: { product: ShopProduct }) {
  const imgs = product.images?.length ? product.images : product.imageUrl ? [product.imageUrl] : [];
  const [img, setImg] = useState<string | null>(imgs[0] ?? null);
  const [zoom, setZoom] = useState({ x: 50, y: 50, on: false });
  const href = `/product/${productPid(product.id)}`;
  const soldOut = Boolean(product.soldOut);

  return (
    <div className={`flex flex-col overflow-hidden rounded-2xl border bg-cream shadow-card ${product.badge ? "border-gold ring-2 ring-gold/60" : "border-[#E4DCCB]"}`}>
      <Link
        href={href}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setZoom({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, on: true });
        }}
        onMouseLeave={() => setZoom((z) => ({ ...z, on: false }))}
        className="relative flex aspect-square cursor-zoom-in items-center justify-center overflow-hidden bg-offwhite/60"
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
            <span className="text-xs">No image</span>
          </div>
        )}
        {product.when && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-navy/85 px-2.5 py-1 text-xs font-semibold text-cream backdrop-blur">
            <CalendarDays className="h-3 w-3" /> {product.when}
          </span>
        )}
        {product.badge && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-gold px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-cream shadow">
            {product.badge}
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
      </Link>

      {imgs.length > 1 && (
        <div className="flex gap-2 px-4 pt-3 sm:px-5 sm:pt-4">
          {imgs.slice(0, 4).map((u, i) => (
            <button
              key={i}
              onClick={() => setImg(u)}
              aria-label={`View photo ${i + 1}`}
              className={`h-11 w-11 overflow-hidden rounded-lg border transition-colors sm:h-14 sm:w-14 ${img === u ? "border-gold ring-1 ring-gold" : "border-[#E4DCCB] hover:border-gold/60"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-1 flex-col p-4 sm:p-5">
        <Link href={href} className="font-serif text-base font-bold text-navy transition-colors hover:text-primary sm:text-lg">
          {product.title}
        </Link>
        <p className="mt-1 text-sm font-semibold text-gold">
          {product.hasOptions ? "From " : ""}{product.minPrice}
        </p>
        {product.description && (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-charcoal/65">{product.description}</p>
        )}
        <div className="mt-auto pt-4">
          <Link
            href={href}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3 text-sm font-bold uppercase tracking-wider text-cream transition-transform hover:-translate-y-0.5"
          >
            {product.details?.length ? "View details" : "View"} <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
