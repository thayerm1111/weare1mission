"use client";

import { C } from "./theme";

export function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border" style={{ borderColor: C.line, background: C.card }}>
      <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: C.line }}>
        <h3 className="text-sm font-semibold" style={{ color: C.ink }}>{title}</h3>
        {right}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function Btn({ children, onClick, disabled, kind = "plain" }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; kind?: "plain" | "primary" | "danger" }) {
  const s = kind === "primary" ? { background: C.blue, color: "#fff", borderColor: C.blue } : kind === "danger" ? { background: "#fff", color: C.red, borderColor: "#F4C7C3" } : { background: "#fff", color: C.ink, borderColor: C.line };
  return (
    <button onClick={onClick} disabled={disabled} className="rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40" style={s}>
      {children}
    </button>
  );
}
