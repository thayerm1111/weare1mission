import Link from "next/link";
import { ChevronRight, Activity, Layers3, Sparkles } from "lucide-react";

const tools = [
  { name: "OM AI Plays", line: "Any market. A complete trade setup.", href: "/portal/signals", icon: Sparkles },
  { name: "GENX", line: "The gold engine.", href: "/portal/genx", icon: Layers3 },
  { name: "Pulse", line: "Find the markets in focus.", href: "/portal/trading?view=pulse", icon: Activity },
];

export function ToolsHome() {
  return <div className="om-tools-home">
    <header><p className="om-label">One Mission</p><h1>Tools</h1></header>
    <nav className="om-tools-list" aria-label="Trading tools">
      {tools.map(({ name, line, href, icon: Icon }) => <Link key={name} href={href}>
        <span className="om-tools-symbol"><Icon aria-hidden="true" /></span>
        <span><strong>{name}</strong><small>{line}</small></span>
        <ChevronRight aria-hidden="true" />
      </Link>)}
    </nav>
    <a className="om-tools-atlas" href="/command-center"><GlobeMark /><span>Need a hand?<strong>Ask Atlas</strong></span><ChevronRight aria-hidden="true" /></a>
  </div>;
}

function GlobeMark() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5c4 2 10 2 14 0M5 17.5c4-2 10-2 14 0" /></svg>;
}
