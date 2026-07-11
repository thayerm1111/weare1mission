"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Plays the community video and (if a leadId is given) reports how much was
 * watched to the `update_lead_progress` RPC. Supports direct video files
 * (MP4/WebM — precise tracking) and Vimeo links (via the Vimeo Player SDK).
 */
export function VideoTracker({ url, leadId }: { url: string; leadId: string | null }) {
  const isVimeo = /vimeo\.com/i.test(url);
  const maxSeconds = useRef(0);
  const duration = useRef(0);
  const lastReport = useRef(0);

  async function report(force = false) {
    if (!leadId) return;
    const now = Date.now();
    if (!force && now - lastReport.current < 8000) return; // throttle
    lastReport.current = now;
    const supabase = createClient();
    if (!supabase) return;
    await supabase.rpc("update_lead_progress", {
      p_lead_id: leadId,
      p_seconds: Math.round(maxSeconds.current),
      p_duration: Math.round(duration.current) || null,
    });
  }

  // ---- Vimeo ----
  const vimeoRef = useRef<HTMLDivElement>(null);
  const [vimeoId] = useState(() => (url.match(/vimeo\.com\/(?:video\/)?(\d+)/)?.[1] ?? ""));
  useEffect(() => {
    if (!isVimeo || !vimeoId || !vimeoRef.current) return;
    let player: any;
    const script = document.createElement("script");
    script.src = "https://player.vimeo.com/api/player.js";
    script.onload = () => {
      // @ts-ignore
      player = new window.Vimeo.Player(vimeoRef.current, { id: vimeoId, responsive: true });
      player.on("timeupdate", (d: { seconds: number; duration: number }) => {
        maxSeconds.current = Math.max(maxSeconds.current, d.seconds);
        duration.current = d.duration;
        report();
      });
      player.on("pause", () => report(true));
      player.on("ended", () => report(true));
    };
    document.body.appendChild(script);
    return () => { report(true); script.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVimeo, vimeoId, leadId]);

  if (isVimeo) {
    return <div ref={vimeoRef} className="overflow-hidden rounded-xl bg-navy shadow-card" />;
  }

  // ---- Direct video file ----
  return (
    <video
      src={url}
      controls
      playsInline
      className="aspect-video w-full rounded-xl bg-navy shadow-card"
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        maxSeconds.current = Math.max(maxSeconds.current, v.currentTime);
        duration.current = v.duration || duration.current;
        report();
      }}
      onPause={() => report(true)}
      onEnded={() => report(true)}
    />
  );
}
