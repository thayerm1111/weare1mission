"use client";

/**
 * DASHBOARD → FLOW walkthrough opener (owner directive 09-03): the guided prompts start on
 * the member dashboard itself — baby steps that show where The Floor lives and send them
 * there, where the FLOW intro + spotlight tour (FlowTour v2) take over and walk the connect
 * form and every switch. Shows ONCE per browser (v2 key — reset for the whole community so
 * everyone, including existing connected members, walks it fresh).
 */

import { useEffect, useState } from "react";
import Link from "next/link";

const LS_KEY = "w1m_dash_intro_v2";
const lsGet = () => { try { return window.localStorage.getItem(LS_KEY); } catch { return null; } };
const lsSet = () => { try { window.localStorage.setItem(LS_KEY, "1"); } catch { /* private mode */ } };

export function DashboardTradingIntro() {
  const [step, setStep] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    if (!lsGet()) setStep(1);
  }, []);

  if (step === 0) return null;
  const dismiss = () => { lsSet(); setStep(0); };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-emerald-500/40 bg-[#0c1220] p-6 text-white shadow-[0_0_60px_rgba(16,185,129,0.25)]">
        {step === 1 ? (
          <>
            <div className="text-4xl">⚡</div>
            <h2 className="mt-3 text-xl font-extrabold tracking-tight">Let the platform trade for you.</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              FLOW links to your broker and takes the desk&apos;s gold plays on your account automatically —
              entries, stops, and exits handled for you. Setting it up takes about{" "}
              <b className="text-emerald-400">2 minutes</b>, and we&apos;ll walk you through it one step at a time.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                onClick={() => setStep(2)}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-3 text-sm font-extrabold text-white shadow-[0_0_20px_rgba(16,185,129,0.4)] transition hover:brightness-110"
              >
                🎮 Show me — step by step
              </button>
              <button onClick={dismiss} className="w-full rounded-xl px-4 py-2 text-xs font-semibold text-white/40 hover:text-white/70">
                Maybe later
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[11px] font-extrabold uppercase tracking-[0.2em] text-emerald-400">Step 1 of 2</div>
            <h2 className="mt-2 text-xl font-extrabold tracking-tight">Everything lives on The Floor.</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              The Floor is the trading hub — find <b className="text-white">Trading Floor</b> in the menu any time.
              That&apos;s where the live plays, GENX gold calls, and the <b className="text-emerald-400">FLOW</b> tab
              (your auto-trading setup) all live.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-white/70">
              Tap below and the guide continues right there: connect your broker, flip Trading on, and pick your
              risk — each switch explained as you go.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Link
                href="/portal/trading"
                onClick={() => lsSet()}
                className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-emerald-600 px-4 py-3 text-center text-sm font-extrabold text-white shadow-[0_0_20px_rgba(16,185,129,0.4)] transition hover:brightness-110"
              >
                Take me to The Floor →
              </Link>
              <button onClick={dismiss} className="w-full rounded-xl px-4 py-2 text-xs font-semibold text-white/40 hover:text-white/70">
                I&apos;ll find it myself
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
