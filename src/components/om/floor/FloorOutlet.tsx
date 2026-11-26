"use client";

import { useSearchParams } from "next/navigation";
import { FloorWorkspace } from "@/components/portal/floor/FloorWorkspace";
import { Floor } from "./Floor";

/** Home, Pulse and FLOW share one route. Read the same current query as the dock and workspace. */
export function FloorOutlet({ isCaller }: { isCaller: boolean }) {
  const views = useSearchParams().getAll("view");
  const view = views.length === 1 ? views[0] : "";
  if (!view || view === "home") return <Floor />;
  return <FloorWorkspace isCaller={isCaller} followerCount={128} bare />;
}
