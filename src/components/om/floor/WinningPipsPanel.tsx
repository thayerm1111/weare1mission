"use client";

import { useEffect, useRef, useState } from "react";
import { BarChart3, Info, RefreshCw, TrendingUp } from "lucide-react";
import { ProductIcon } from "@/components/om/ProductIcon";
import type { FloorAccount } from "@/lib/floor/overview";
import { WINNING_PERIODS, type WinningPipsResponse, type WinningPipsResult,
  type WinningPeriod } from "@/lib/floor/winningPips";
import "./winning-pips.css";

type Props = {
  account: FloorAccount | null;
  accountsKnown: boolean;
  switching: boolean;
  hideAccountPips: boolean;
  sample?: boolean;
};
type Reading = { key: string; data: WinningPipsResponse | null; failed: boolean; loading: boolean };
const POLL_MS = 60_000;
const keyOf = (account: { id: string; environment: string } | null) =>
  account ? account.environment + ":" + account.id : "none";
const fmt = (pips: number) => pips.toLocaleString("en-US", { maximumFractionDigits: 2 });
const time = (iso: string | null | undefined) =>
  iso && Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

function SourceCard({ source, metrics, period, loading, stale, hidden, account, sample }: {
  source: "genx" | "flow"; metrics?: WinningPipsResult; period: WinningPeriod;
  loading: boolean; stale: boolean; hidden: boolean; account: FloorAccount | null; sample: boolean;
}) {
  const isFlow = source === "flow";
  const ready = !sample && metrics?.state === "ready";
  const row = ready ? metrics?.totals[period] : null;
  const pips = typeof row?.pips === "number" && Number.isFinite(row.pips) ? row.pips : null;
  const wins = typeof row?.wins === "number" && Number.isInteger(row.wins) ? row.wins : null;
  const noAccount = isFlow && !account;
  const title = isFlow ? "FLOW" : "GENX";
  const earliest = ready && period === "all" ? time(metrics?.firstRecordedAt) : null;
  const status = sample ? "Sample preview" : loading && !metrics ? "Reading completed trades…"
    : noAccount ? "Connect an account to view your trades"
    : metrics?.state === "unavailable" ? "Verified results unavailable" : "";
  return (
    <article className={"om-wpip-card om-wpip-" + source} aria-label={title + " positive winning pips"}
      data-ready={ready&&!stale} aria-busy={loading&&!metrics}>
      <div className="om-wpip-source"><div className="om-wpip-brand">
        <ProductIcon kind={source} size="sm" />
        <div><b>{title}</b><span>{isFlow ? "Your selected account" : "Community callouts"}</span></div>
      </div><span className="om-wpip-source-tag">WINS ONLY</span></div>
      <div className="om-wpip-number" data-no-i18n translate="no"
        aria-label={hidden&&pips!=null ? "Winning pips hidden" : undefined}>
        {pips == null ? "—" : hidden ? "••••" : "+" + fmt(pips)}
        <span>{!hidden&&pips!=null ? " PIPS" : ""}</span>
      </div>
      <div className="om-wpip-subcount">
        <span><TrendingUp size={15} aria-hidden="true"/>
          {wins == null ? "—" : wins.toLocaleString("en-US")} verified winning {wins===1?"trade":"trades"}</span>
        <span>{period==="today" ? "TODAY" : period==="week" ? "THIS WEEK" :
          period==="month" ? "THIS MONTH" : period==="year" ? "THIS YEAR" : "ALL RECORDED"}</span>
      </div>
      {status && <p className="om-wpip-status" role="status">{status}</p>}
      {stale && metrics && <p className="om-wpip-status">Last verified reading · refresh unavailable</p>}
      {earliest && <p className="om-wpip-foot">Retained outcomes since {earliest}</p>}
      {!!metrics?.unverified && ready && <p className="om-wpip-foot om-wpip-card-note">
        Unverified or incomplete outcomes excluded.
      </p>}
      {isFlow && account && <p className="om-wpip-foot om-wpip-card-note">Account: {account.name} · {account.environment.toUpperCase()}</p>}
    </article>
  );
}

/** Side-by-side numbers are deliberately NOT added: FLOW can execute GENX callouts. */
export function WinningPipsPanel({ account, accountsKnown, switching, hideAccountPips, sample=false }: Props) {
  const key = keyOf(account);
  const current = useRef({key,accountsKnown,switching,sample});
  current.current = {key,accountsKnown,switching,sample};
  const [period,setPeriod] = useState<WinningPeriod>("today");
  const [reading,setReading] = useState<Reading>({key,data:null,failed:false,loading:!sample});
  const reload = useRef<()=>void>(()=>{});
  useEffect(()=>{
    let active=true,sequence=0;
    let controller:AbortController|null=null;
    setReading({key,data:null,failed:false,loading:!sample});
    if(sample || !accountsKnown || switching){reload.current=()=>{};return;}
    const allowed=()=>active && current.current.key===key &&
      current.current.accountsKnown && !current.current.switching && !current.current.sample;
    const fetchData=async()=>{
      if(!allowed())return;
      const id=++sequence;
      controller?.abort();
      const request=new AbortController();
      controller=request;
      const deadline=setTimeout(()=>request.abort(),25_000);
      setReading(previous=>({...previous,loading:true}));
      const headers:Record<string,string>={};
      if(account){headers["x-floor-account"]=account.id;headers["x-floor-env"]=account.environment;}
      try {
        headers["x-floor-time-zone"]=Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";
      } catch {headers["x-floor-time-zone"]="UTC";}
      try {
        const response=await fetch("/api/floor/winning-pips",{cache:"no-store",headers,signal:request.signal});
        const data=await response.json().catch(()=>null) as (WinningPipsResponse & {error?:string})|null;
        if(!allowed() || id!==sequence)return;
        if(!response.ok || !data || data.error || !data.genx || !data.flow ||
          keyOf(data.account)!==key)throw new Error("winning_pips_unavailable");
        setReading({key,data,failed:false,loading:false});
      } catch {
        if(allowed() && id===sequence)
          setReading(previous=>({...previous,failed:true,loading:false}));
      } finally {
        clearTimeout(deadline);
        if(controller===request)controller=null;
      }
    };
    const refresh=()=>{if(document.visibilityState==="visible")void fetchData();};
    reload.current=()=>void fetchData();
    void fetchData();
    const interval=setInterval(refresh,POLL_MS);
    document.addEventListener("visibilitychange",refresh);
    window.addEventListener("om:flow-trades-changed",refresh);
    return ()=>{
      active=false;sequence++;controller?.abort();clearInterval(interval);
      document.removeEventListener("visibilitychange",refresh);
      window.removeEventListener("om:flow-trades-changed",refresh);
      reload.current=()=>{};
    };
  },[key,accountsKnown,switching,sample]);

  const currentData=reading.key===key&&!switching&&!sample?reading.data:null;
  const loading=!sample && (!accountsKnown||switching||reading.loading);
  const failed=reading.key===key&&reading.failed;
  const zone=currentData?.timeZone?.replaceAll("_"," ")??"your local time zone";
  return (
    <section className="om-winning-pips" aria-labelledby="om-winning-pips-title">
      <div className="om-wpip-title">
        <div><span className="om-wpip-eyebrow"><BarChart3 size={14} aria-hidden="true"/>ONE MISSION · WINNING PERFORMANCE</span>
          <h2 id="om-winning-pips-title">Winning Pips</h2>
        </div>
        <div className="om-wpip-tools">
          {failed&&<span role="status">Last reading</span>}
          <button type="button" onClick={()=>reload.current()} disabled={sample||loading||!accountsKnown||switching}
            aria-label="Refresh winning pips"><RefreshCw aria-hidden="true"/></button>
        </div>
      </div>
      <div className="om-wpip-periods" role="group" aria-label="Winning pips period">
        {WINNING_PERIODS.map(p=><button type="button" key={p.id}
          aria-pressed={period===p.id} onClick={()=>setPeriod(p.id)}
          title={p.note}>{p.label}</button>)}
      </div>
      <div className="om-wpip-grid">
        <SourceCard source="genx" metrics={currentData?.genx} period={period}
          loading={loading} stale={failed} hidden={false} account={account} sample={sample}/>
        <SourceCard source="flow" metrics={currentData?.flow} period={period}
          loading={loading} stale={failed} hidden={hideAccountPips} account={account} sample={sample}/>
      </div>
      <details className="om-wpip-explain">
        <summary><Info size={14} aria-hidden="true"/>How winning pips are counted</summary>
        <div className="om-wpip-bottom">
          <span>GENX = opportunities from graded community calls · FLOW = your recorded account executions.</span>
          {currentData&&<span>Updated {time(currentData.asOf)} · {zone}</span>}
        </div>
        <div className="om-wpip-desktop-notes">
          {account&&<p>FLOW account: {account.name} · {account.environment.toUpperCase()}</p>}
          {currentData?.genx.state==="ready"&&!!currentData.genx.unverified&&
            <p>GENX: Unverified or incomplete outcomes excluded.</p>}
          {currentData?.flow.state==="ready"&&!!currentData.flow.unverified&&
            <p>FLOW: Unverified or incomplete outcomes excluded.</p>}
        </div>
        <p>Today, week (Monday onward), month and year follow your device’s time zone. All Time includes every retained completed outcome in the ledger. We count each closed FLOW position once using its final recorded result, including partial-exit weighting. GENX counts each real, entered, graded callout once—not its followers. Positive results add pips and one win; losses and flat outcomes add nothing to the winning totals. Open, ungraded and incomplete records are excluded. These are gross winning pips, not net profitability. The two sources are never summed because FLOW may follow GENX and that could count the same idea twice.</p>
      </details>
    </section>
  );
}
