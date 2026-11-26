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
  return <nav className="om-home-apps" aria-label="One Mission tools">
    <h2>One Mission apps</h2>
    <div className="om-home-app-grid">{apps.map(app => {
      const content = <><ProductIcon kind={app.icon}/><span><b>{app.name}</b><small>{app.purpose}</small></span></>;
      return app.icon === "atlas" ? <a key={app.name} href={app.href}>{content}</a> :
        <Link key={app.name} href={app.href} className={app.name === "GenX FX" ? "om-app-fx" : undefined}>{content}</Link>;
    })}</div>
  </nav>;
}
