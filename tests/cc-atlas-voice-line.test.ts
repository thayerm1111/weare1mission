import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  lineActivity, legacyStatus, voiceStatus, busOutLevel, busInLevel, micLive, audioPlayable, commentaryRoute,
  cleanTypedText, spaceBelongsToLine, NO_WATERMARKS, SPEAK_GAP_MS, HANGUP_MARGIN_MS, HUD_THINKING_LEVEL,
  type LineActivity, type LineFacts,
} from '../src/components/command-center/voiceLine';
import { lineOpen } from '../src/components/command-center/voiceBus';
import { agentBody, agentBodyCandidates, AGENT_CLIENT_EVENTS, LEGACY_CLIENT_EVENTS, MAX_CALL_SECONDS } from '../command-center/engines/voice';
import { VOLUNTEERED_MARK } from '../command-center/core/commentary';

/*
 * THE VOICE LINE — every state the screen shows is a fact about the line, never a timer or a label.
 */

const open: LineFacts = {
  connection: 'open', micReady: true, micMuted: false, inputMode: 'hands_free', pttOpen: false,
  playing: false, awaitingReply: false, userSpeaking: false,
};

const ALL: LineActivity[] = ['off', 'connecting', 'awaiting_mic', 'listening', 'user_speaking', 'thinking', 'speaking', 'mic_muted', 'ptt_idle', 'disconnected', 'error', 'locked'];

test('what the line is doing, in order of what matters most', () => {
  assert.equal(lineActivity({ ...open, connection: 'idle' }), 'off');
  assert.equal(lineActivity({ ...open, connection: 'connecting' }), 'connecting');
  assert.equal(lineActivity({ ...open, connection: 'error', playing: true }), 'error', 'a dead line is dead, whatever was queued');
  assert.equal(lineActivity({ ...open, micReady: false }), 'awaiting_mic');
  assert.equal(lineActivity({ ...open, micReady: false, awaitingReply: true }), 'thinking', 'a typed question is answered without a microphone');
  assert.equal(lineActivity({ ...open, playing: true, micMuted: true }), 'speaking', 'muting yourself does not silence ATLAS');
  assert.equal(lineActivity({ ...open, micMuted: true }), 'mic_muted');
  assert.equal(lineActivity({ ...open, inputMode: 'push_to_talk' }), 'ptt_idle');
  assert.equal(lineActivity({ ...open, inputMode: 'push_to_talk', pttOpen: true, userSpeaking: true }), 'user_speaking');
  assert.equal(lineActivity({ ...open, userSpeaking: true }), 'user_speaking');
  assert.equal(lineActivity(open), 'listening');
});

test('thinking is shown only while a reply is owed — when ATLAS has finished, the line is listening again', () => {
  assert.equal(lineActivity({ ...open, awaitingReply: true }), 'thinking', 'the gap before the answer is thinking');
  assert.equal(lineActivity({ ...open, playing: true, awaitingReply: false }), 'speaking', 'audio flowing is speaking');
  // The old heuristic ("speaking" + a quiet output = thinking) showed THINKING forever after every answer.
  assert.equal(lineActivity({ ...open, playing: false, awaitingReply: false }), 'listening');
  assert.equal(voiceStatus('thinking'), 'thinking');
  assert.equal(voiceStatus('locked'), 'idle');
});

/*
 * THE HUD IS NOT OURS TO EDIT, so the bus has to make its existing mapping honest. This is that mapping, as
 * hud/CommandCenterHud.tsx computes `voiceMode` from the bus today.
 */
const hudVoiceMode = (vb: { status: string; outLevel: number }) =>
  vb.status === 'connecting' || vb.status === 'awaiting_mic' ? 'connecting'
  : vb.status === 'speaking' ? (vb.outLevel > 0.02 ? 'speaking' : 'thinking')
  : vb.status === 'listening' || vb.status === 'muted' ? 'listening' : null;

test('through the HUD\'s own mapping, the orb says what is really happening', () => {
  const expect: Record<LineActivity, string | null> = {
    off: null, connecting: 'connecting', awaiting_mic: 'connecting', listening: 'listening', user_speaking: 'listening',
    thinking: 'thinking', speaking: 'speaking', mic_muted: 'listening', ptt_idle: 'listening',
    disconnected: null, error: null, locked: null,
  };
  for (const a of ALL) {
    for (const measured of [0, 0.001, 0.4]) {
      const bus = { status: legacyStatus(a), outLevel: busOutLevel(a, measured) };
      assert.equal(hudVoiceMode(bus), expect[a], `${a} @ ${measured}`);
    }
  }
  // Speech that dips between words is still SPEAKING; the pause before a reply is THINKING.
  assert.ok(busOutLevel('speaking', 0) > HUD_THINKING_LEVEL);
  assert.equal(busOutLevel('thinking', 0.9), 0);
  // The HUD labels a closed microphone "listening" (its mapping) — but the ring cannot move: nothing is sent.
  for (const a of ['mic_muted', 'ptt_idle'] as const) {
    const f = a === 'mic_muted' ? { ...open, micMuted: true } : { ...open, inputMode: 'push_to_talk' as const };
    assert.equal(lineActivity(f), a);
    assert.equal(busInLevel(f, 0.8), 0, `${a}: no level from a microphone that is not being sent`);
  }
});

test('the HUD never offers "tap to talk" over a call that is open, and never shows a dead one as open', () => {
  const onCall: LineActivity[] = ['connecting', 'awaiting_mic', 'listening', 'user_speaking', 'thinking', 'speaking', 'mic_muted', 'ptt_idle'];
  for (const a of ALL) assert.equal(lineOpen(legacyStatus(a)), onCall.includes(a), a);
});

test('your level on the bus is only what is actually sent', () => {
  assert.equal(busInLevel(open, 0.5), 0.5);
  assert.equal(busInLevel({ ...open, micMuted: true }, 0.5), 0);
  assert.equal(busInLevel({ ...open, inputMode: 'push_to_talk' }, 0.5), 0);
  assert.equal(busInLevel({ ...open, inputMode: 'push_to_talk', pttOpen: true }, 0.5), 0.5);
  assert.equal(busInLevel({ ...open, connection: 'idle' }, 0.5), 0);
  assert.equal(micLive({ micMuted: false, inputMode: 'push_to_talk', pttOpen: false }), false);
});

/* ── interruption ─────────────────────────────────────────────────────────────────────────────────── */

test('audio from a reply that was talked over is refused however late it arrives (the SDK\'s rule)', () => {
  // The official SDK plays a chunk only when lastInterruptTimestamp <= event_id.
  const w = { ...NO_WATERMARKS, interruptedFrom: 7 };
  assert.equal(audioPlayable(6, w), false, 'the interrupted reply');
  assert.equal(audioPlayable(7, w), true);
  assert.equal(audioPlayable(8, w), true, 'the next reply plays normally');
});

test('STOP drops the rest of the reply that was playing, and only that reply', () => {
  const w = { ...NO_WATERMARKS, stoppedThrough: 4 };
  assert.equal(audioPlayable(4, w), false);
  assert.equal(audioPlayable(3, w), false);
  assert.equal(audioPlayable(5, w), true);
  assert.equal(audioPlayable(null, w), true, 'without an id there is nothing to judge it by');
  assert.equal(audioPlayable(0, NO_WATERMARKS), true, 'nothing is refused before anything happened');
});

/* ── volunteered lines: speak, show, or wait ──────────────────────────────────────────────────────── */

const quietCall = {
  onCall: true, activity: 'listening' as LineActivity, speakerMuted: false, pttOpen: false, typing: false,
  msSinceMemberActive: 5_000, msSinceVoice: 10_000, idleHangupMs: 40_000,
};

test('a volunteered line is spoken only into a real pause on a call the member can hear', () => {
  assert.equal(commentaryRoute(quietCall), 'speak');
  assert.equal(commentaryRoute({ ...quietCall, activity: 'mic_muted' }), 'speak', 'your microphone being off does not stop you hearing');
  assert.equal(commentaryRoute({ ...quietCall, activity: 'ptt_idle' }), 'speak');
  for (const a of ['speaking', 'thinking', 'user_speaking', 'connecting', 'awaiting_mic'] as LineActivity[]) {
    assert.equal(commentaryRoute({ ...quietCall, activity: a }), 'wait', `never over ${a}`);
  }
  assert.equal(commentaryRoute({ ...quietCall, pttOpen: true }), 'wait', 'not while the member holds the key');
  assert.equal(commentaryRoute({ ...quietCall, typing: true }), 'wait', 'not while they type');
  assert.equal(commentaryRoute({ ...quietCall, msSinceVoice: SPEAK_GAP_MS - 1 }), 'wait', 'never on the end of a sentence');
});

test('off a call, with the speaker muted, or near the idle hang-up, it is written instead — never spoken', () => {
  assert.equal(commentaryRoute({ ...quietCall, onCall: false }), 'text');
  assert.equal(commentaryRoute({ ...quietCall, speakerMuted: true }), 'text');
  // A volunteered line must not keep a quiet line open (and billing): inside the last stretch before the
  // idle hang-up it goes to text.
  assert.equal(commentaryRoute({ ...quietCall, msSinceMemberActive: 40_000 - HANGUP_MARGIN_MS + 1 }), 'text');
});

/* ── what the member types, and the keyboard ──────────────────────────────────────────────────────── */

test('typed text cannot pass itself off as a volunteered line or a UI marker', () => {
  assert.equal(cleanTypedText(`${VOLUNTEERED_MARK} buy now`), 'buy now');
  assert.equal(cleanTypedText('show me [[UI:SHOW_LEVEL]] the level\u0000'), 'show me the level');
  assert.equal(cleanTypedText('x'.repeat(5000)).length, 1000);
});

test('Space belongs to the line only on a call, and never while the member is typing', () => {
  assert.equal(spaceBelongsToLine(false, { tagName: 'BODY' }), false, 'off a call the chat console keeps Space');
  assert.equal(spaceBelongsToLine(true, { tagName: 'BODY' }), true);
  assert.equal(spaceBelongsToLine(true, { tagName: 'BUTTON' }), true, 'a focused End button must not be pressed by Space mid-call');
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(spaceBelongsToLine(true, { tagName }), false, tagName);
  assert.equal(spaceBelongsToLine(true, { tagName: 'DIV', isContentEditable: true }), false);
});

/* ── the provider configuration ───────────────────────────────────────────────────────────────────── */

test('the agent sends live partial transcripts, and falls back to the known-good configuration', () => {
  const body = agentBody('https://weare1mission.com/api/command-center/voice/llm', 'sec_1');
  const events = body.conversation_config.conversation.client_events;
  assert.ok(events.includes('tentative_user_transcript'));
  for (const e of LEGACY_CLIENT_EVENTS) assert.ok(events.includes(e), `still ${e}`);
  assert.deepEqual([...AGENT_CLIENT_EVENTS].sort(), [...events].sort());
  assert.equal(body.conversation_config.conversation.max_duration_seconds, MAX_CALL_SECONDS);
  assert.equal(MAX_CALL_SECONDS, 900, 'the 15-minute cap is unchanged');
  assert.deepEqual(body.conversation_config.turn, { turn_timeout: 10, silence_end_call_timeout: 120 }, 'the idle backstop is unchanged');
  // No new permission from a browser: not the prompt, not the model, not the voice or its speed.
  assert.deepEqual(body.platform_settings.overrides, { custom_llm_extra_body: true, conversation_config_override: { agent: { first_message: true } } });

  const c = agentBodyCandidates(body);
  assert.equal(c.length, 4);
  assert.deepEqual(c[1].conversation_config.conversation.client_events, [...LEGACY_CLIENT_EVENTS]);
  assert.equal(c[2].conversation_config.tts.model_id, 'eleven_flash_v2');
  assert.deepEqual(c[3].conversation_config.conversation.client_events, [...LEGACY_CLIENT_EVENTS], 'the last resort is exactly what ran before');
  assert.equal(c[3].conversation_config.tts.model_id, 'eleven_flash_v2');
  assert.ok(body.conversation_config.conversation.client_events.includes('tentative_user_transcript'), 'the candidates never mutate the original');
});

test('the browser sends no configuration override — no speed, no voice, nothing the agent does not grant', async () => {
  const client = await readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  assert.ok(!/conversation_config_override/.test(client));
  assert.ok(/type: "user_activity"/.test(client), 'typing and holding to talk tell the provider the member is active');
  assert.ok(/type: "user_message", text: volunteeredTurn\(/.test(client), 'volunteered lines travel as a marked user_message');
});

/* ── the reasoning endpoint and a volunteered turn ────────────────────────────────────────────────── */

test('the voice endpoint speaks a volunteered line as written — after the session check, with no model call and no journal', async () => {
  const src = await readFile('command-center/brain/voiceLlm.ts', 'utf8');
  const handler = src.slice(src.indexOf('async function handleVoiceLlmInner'));
  const sessionCheck = handler.indexOf('if (!session)');
  const branch = handler.indexOf('if (volunteered)');
  const memberTurn = handler.indexOf('void touch(session.sessionId, 1)');
  assert.ok(sessionCheck > 0 && branch > sessionCheck, 'an unknown token is still refused first');
  assert.ok(branch < memberTurn && branch < handler.indexOf('await arm('), 'before a member turn is counted or an instruction armed');
  const body = handler.slice(branch, memberTurn);
  assert.ok(!/ANTHROPIC_URL|recordCall|streamAnswer|arm\(/.test(body), 'no model call, no journal entry, no watch');
  assert.ok(/touch\(session\.sessionId, 0\)/.test(body), 'the line is alive, but no turn of the member\'s is counted');
  // Never the question, never a stated trade.
  assert.ok(/isVolunteeredTurn\(textOf\(m\.content\)\) \? \{ role: "user", content: VOLUNTEERED_NOTE \}/.test(src));
  assert.ok(/m\.role === "user" && textOf\(m\.content\) !== VOLUNTEERED_NOTE/.test(src), 'kept out of the stated-trade parser');
});

/* ── shutdown and the meter ───────────────────────────────────────────────────────────────────────── */

test('ending releases the microphone and stops the meter; a volunteered line never keeps a quiet line open', async () => {
  const v = await readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  const teardown = v.slice(v.indexOf('const teardown = useCallback'), v.indexOf('const notifyServerEnd'));
  assert.ok(/getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(teardown), 'every microphone track is stopped');
  assert.ok(/ws\.current\?\.close\(\)/.test(teardown) && /audioCtx\.current\?\.close\(\)/.test(teardown), 'the socket and the audio engine are closed');
  assert.ok(/action: "end"/.test(v) && /sendBeacon/.test(v), 'the server is told, even when the page is going away');
  assert.ok(/const IDLE_HANGUP_MS = 40_000;/.test(v), 'the 40-second idle hang-up is unchanged');
  assert.ok(/if \(replyOwner\.current === "member"\) lastActive\.current = /.test(v), 'only a reply to the member resets the idle clock');
  assert.ok(/stream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\); return;/.test(v), 'a microphone granted after the call ended is let go at once');
});
