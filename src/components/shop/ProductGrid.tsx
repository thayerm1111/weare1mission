"use client";

import { useState } from "react";
import { ImageOff, ArrowRight } from "lucide-react";
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

function Card({ product, domain }: { product: ShopProduct; domain: string }) {
  const buyable = product.variants.filter((v) => v.availableForSale);
  const [variantId, setVariantId] = useState(buyable[0]?.id ?? product.variants[0]?.id ?? "");

  function buy() {
    if (!variantId) return;
    const numeric = variantId.split("/").pop();
    window.location.href = `https://${domain}/cart/${numeric}:1`;
  }

  const soldOut = buyable.length === 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[#E4DCCB] bg-cream shadow-card">
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-offwhite/60">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.imageUrl} alt={product.imageAlt ?? product.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-medium">
            <ImageOff className="h-8 w-8" aria-hidden="true" />
            <span className="text-xs">Add a product image in Shopify</span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5">
        <h3 className="font-serif text-lg font-bold text-navy">{product.title}</h3>
        <p className="mt-1 text-sm font-semibold text-gold">
          {product.hasOptions ? "From " : ""}{product.minPrice}
        </p>
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
          <button
            onClick={buy}
            disabled={soldOut}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3 text-sm font-bold uppercase tracking-wider text-cream transition-transform hover:-translate-y-0.5 disabled:opacity-50"
          >
            {soldOut ? "Sold out" : <>Checkout <ArrowRight className="h-4 w-4" /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
