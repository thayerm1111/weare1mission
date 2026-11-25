"use client";

import { useEffect, useState } from "react";
import { GenxDesk } from "@/components/portal/floor/GenxDesk";
import { GenFxDesk } from "@/components/portal/floor/GenFxDesk";
import type { PairKey } from "@/lib/genfx/pairs";
import "./genx-workspace.css";

/** One GENX destination; each market keeps its own existing state and handlers. */
export function GenxWorkspace({ initialMarket = "gold", initialPair }: {
  initialMarket?: "gold" | "fx"; initialPair?: PairKey;
}) {
  const [market, setMarket] = useState(initialMarket);
  const [visited, setVisited] = useState({ gold: initialMarket === "gold", fx: initialMarket === "fx" });
  useEffect(() => {
    setMarket(initialMarket);
    setVisited((value) => ({ ...value, [initialMarket]: true }));
  }, [initialMarket, initialPair]);
  const select = (next: "gold" | "fx") => {
    setVisited((value) => ({ ...value, [next]: true }));
    setMarket(next);
  };
  return <div className="om-genx-workspace">
    <div className="om-genx-market-switch" role="group" aria-label="GENX market">
      <button type="button" aria-pressed={market === "gold"} aria-controls="genx-gold-workspace" onClick={() => select("gold")}>
        <span className="om-genx-market-mark" aria-hidden="true">Au</span><span>Gold<small>XAU / USD</small></span>
      </button>
      <button type="button" aria-pressed={market === "fx"} aria-controls="genx-fx-workspace" onClick={() => select("fx")}>
        <span className="om-genx-market-mark" aria-hidden="true">FX</span><span>GenX FX<small>Currency pairs</small></span>
      </button>
    </div>
    {/* Visited workspaces stay mounted so changing this view cannot discard a paid or saved read. */}
    <div id="genx-gold-workspace" hidden={market !== "gold"}>{visited.gold && <GenxDesk/>}</div>
    <div id="genx-fx-workspace" hidden={market !== "fx"}>{visited.fx && <GenFxDesk initialPair={initialPair}/>}</div>
  </div>;
}
