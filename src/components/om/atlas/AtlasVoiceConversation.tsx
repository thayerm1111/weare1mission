"use client";

import { Mic, Settings2 } from "lucide-react";
import { lineOpen, type VoiceBusState } from "@/components/command-center/voiceBus";
import "./atlas-voice-conversation.css";

/** A view of the one existing voice transport. Meters are actual input/output levels, never simulated. */
export function AtlasVoiceConversation({ voice, contextLabel, onStart, onSettings }: {
  voice: VoiceBusState; contextLabel?: string; onStart: () => void; onSettings: () => void;
}) {
  const connected = lineOpen(voice.status);
  const status = voice.activity === "connecting" ? "Connecting to Atlas…"
    : voice.activity === "awaiting_mic" ? "Allow microphone access to start talking"
      : voice.activity === "user_speaking" ? "Listening to you…"
        : voice.activity === "thinking" ? "Atlas is thinking…"
          : voice.activity === "speaking" ? "Atlas is speaking"
            : connected ? voice.micMuted ? "Microphone muted" : "Listening · ask your question"
              : voice.needsSubscription ? "Voice plan needed" : voice.status === "error" ? "Voice needs attention" : "Ready for a conversation";
  return <section className="om-atlas-voice-conversation" aria-label="Voice conversation with Atlas">
    <div className="om-atlas-voice-conversation-head"><Mic size={22} aria-hidden="true" /><div><h3>Talk with Atlas</h3><p>{contextLabel || "Your current trading workspace"}</p></div></div>
    <div className="om-atlas-voice-activity" data-active={connected}><span role="status" aria-live="polite">{status}</span><div><label>You<meter min={0} max={1} value={voice.inLevel} aria-label="Your live microphone level" /></label><label>Atlas<meter min={0} max={1} value={voice.outLevel} aria-label="Atlas live voice level" /></label></div></div>
    <p className="om-atlas-voice-hint">Ask a question, listen, and keep talking. Your words and Atlas’s replies appear in the conversation below.</p>
    <div className="om-atlas-voice-start-actions">
      {!connected && !voice.needsSubscription && <button type="button" onClick={onStart}><Mic size={15} aria-hidden="true" />{voice.status === "error" || voice.status === "disconnected" ? "Try voice again" : "Start voice"}</button>}
      <button type="button" onClick={onSettings}><Settings2 size={15} aria-hidden="true" />{voice.needsSubscription ? "View voice plan" : "Voice settings"}</button>
    </div>
  </section>;
}
