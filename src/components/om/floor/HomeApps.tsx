"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import Link from "next/link";
import { ProductIcon } from "../ProductIcon";

const apps = [
  { name: "Atlas", purpose: "Ask your AI", icon: "atlas", href: "/command-center" },
  { name: "GenX", purpose: "Find gold setups", icon: "genx", href: "/portal/genx" },
  { name: "GenX FX", purpose: "Find currency setups", icon: "genx", href: "/portal/genx?market=fx" },
  { name: "Strata", purpose: "Read price action", icon: "strata", href: "/portal/strata" },
  { name: "OM AI Plays", purpose: "Generate a signal", icon: "plays", href: "/portal/signals" },
  { name: "Pulse", purpose: "Scan markets", icon: "pulse", href: "/portal/trading?view=pulse" },
  { name: "Flow", purpose: "Connect accounts", icon: "flow", href: "/portal/trading?view=flow" },
  { name: "Nitrous", purpose: "Automate gold trades", icon: "nitrous", href: "/portal/nitrous" },
] as const;

export function HomeApps() {
  const [guide, setGuide] = useState(false);
  return <nav className="om-home-apps" id="om-home-apps" tabIndex={-1} aria-label="One Mission tools">
    <header><h2>Apps</h2><button type="button" aria-label="App guide" aria-expanded={guide} aria-controls="om-app-grid"
      title="What each app does" onClick={() => setGuide(open => !open)}><Info size={18} aria-hidden="true"/></button></header>
    <div className="om-home-app-grid" id="om-app-grid" data-guide={guide || undefined}>{apps.map(app => {
      const content = <><ProductIcon kind={app.icon}/><span><b>{app.name}</b>{guide && <small>{app.purpose}</small>}</span></>;
      return app.icon === "atlas" ? <a key={app.name} href={app.href} aria-label={app.name + ", " + app.purpose}>{content}</a> :
        <Link key={app.name} href={app.href} aria-label={app.name + ", " + app.purpose} className={app.name === "GenX FX" ? "om-app-fx" : undefined}>{content}</Link>;
    })}</div>
  </nav>;
}
