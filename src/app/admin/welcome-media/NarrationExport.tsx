"use client";
import { useState } from "react";
import { WELCOME_TUTORIAL } from "@/lib/onboarding/welcome";

export default function NarrationExport() {
  const [state, setState] = useState("ready");
  const [message, setMessage] = useState("");
  const [download, setDownload] = useState<string | null>(null);
  async function generate() {
    if (state !== "ready") return;
    setState("generating");
    setMessage("Generating the fixed welcome narration. Please keep this page open.");
    try {
      const r = await fetch("/api/admin/welcome-narration", { method: "POST", cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Export failed.");
      setDownload(URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" })));
      setState("done");
      setMessage("Narration and timing are ready to download.");
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "Export failed. No automatic retry was made.");
    }
  }
  return <main style={{ maxWidth: 760, margin: "40px auto", padding: 24, color: "#eef2f7", background: "#10151e", borderRadius: 24 }}>
    <p>ONE MISSION · ADMIN MEDIA EXPORT</p>
    <h1>Welcome tutorial narration</h1>
    <p>Generate this fixed tutorial once using the existing Atlas narration provider. This creates a reusable media file and does not start a member voice session.</p>
    <button onClick={() => void generate()} disabled={state !== "ready"} style={{ padding: "14px 20px", background: "#cbdcff", color: "#10151e", borderRadius: 12, fontWeight: 700 }}>Generate narration once</button>
    <p role="status">{message}</p>
    {download && <a href={download} download="welcome-narration-v1.json" style={{ display: "inline-block", padding: 16, color: "#a9e6cd" }}>Download narration and timing</a>}
    <h2>{WELCOME_TUTORIAL.title}</h2>
    {WELCOME_TUTORIAL.chapters.map(chapter => <section key={chapter.id}><h3>{chapter.title}</h3><p>{chapter.narration}</p></section>)}
  </main>;
}
