import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductByPid, pairedProducts } from "@/data/shopProducts";
import { ProductDetail } from "@/components/shop/ProductDetail";
import { buildMetadata } from "@/lib/metadata";

export const revalidate = 300;

export function generateMetadata({ params }: { params: { pid: string } }): Metadata {
  const product = getProductByPid(params.pid);
  if (!product) return { title: "Product" };
  return buildMetadata({
    title: product.title,
    description: product.description || `${product.title} — 1 Mission`,
    path: `/product/${params.pid}`,
    image: product.imageUrl ?? undefined,
  });
}

export default function ProductPage({ params }: { params: { pid: string } }) {
  const product = getProductByPid(params.pid);
  if (!product) notFound();
  const pairs = pairedProducts(product);
  return <ProductDetail product={product} pairs={pairs} collectionHandle={product.collectionHandle} />;
}
