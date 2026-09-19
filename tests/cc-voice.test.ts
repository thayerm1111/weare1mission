import test from 'node:test';
import assert from 'node:assert/strict';
import { availability, MONTHLY_MINUTE_BUDGET, MAX_SESSION_MS, STALE_SESSION_MS } from '../command-center/engines/voice';

/* ─────────────────── configuration is reported, never guessed ─────────────────── */

test('voice reports exactly what is missing rather than a vague no', () => {
  const saveKey = process.env.ELEVENLABS_API_KEY;
  const saveSecret = process.env.CC_VOICE_LLM_SECRET;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.CC_VOICE_LLM_SECRET;

  const none = availability();
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.deepEqual(none.missing.sort(), ['CC_VOICE_LLM_SECRET', 'ELEVENLABS_API_KEY']);
    assert.match(none.reason, /text console still works/i, 'a missing provider must not read as a broken product');
  }

  process.env.ELEVENLABS_API_KEY = 'k';
  const half = availability();
  assert.equal(half.ok, false);
  if (!half.ok) assert.deepEqual(half.missing, ['CC_VOICE_LLM_SECRET']);

  // The AGENT is deliberately NOT required: demanding one would mean a person has to create it in a
  // dashboard, copy an identifier and redeploy, to produce a value the server can produce itself.
  process.env.CC_VOICE_LLM_SECRET = 's';
  const full = availability();
  assert.equal(full.ok, true, 'a key and a callback secret are enough — the agent is provisioned on first use');

  if (saveKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saveKey;
  if (saveSecret === undefined) delete process.env.CC_VOICE_LLM_SECRET; else process.env.CC_VOICE_LLM_SECRET = saveSecret;
});

test('the callback URL the provider is pointed at is our own reasoning endpoint', async () => {
  const { callbackUrl } = await import('../command-center/engines/voice');
  const u = callbackUrl();
  assert.match(u, /\/api\/command-center\/voice\/llm$/);
  assert.ok(u.startsWith('https://'), 'a callback carrying a session token is never sent over plain http');
});

/* ─────────────────── the meter has real limits ─────────────────── */

test('a metered feature has a budget, a session cap and a staleness cap', () => {
  assert.ok(MONTHLY_MINUTE_BUDGET > 0, 'a meter with no limit is not a meter');
  assert.ok(MAX_SESSION_MS <= 2 * 3600_000, 'an unattended session must not be able to run all day');
  assert.ok(STALE_SESSION_MS < MAX_SESSION_MS, 'a silent session is reaped long before the hard cap');
});

/* ─────────────────── the provider never sees a key, and never becomes the brain ─────────────────── */

test('the API key is only ever read server-side', async () => {
  const fs = await import('node:fs/promises');
  const client = await fs.readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  assert.ok(!/ELEVENLABS_API_KEY/.test(client), 'the speech key must never appear in a client component');
  assert.ok(!/xi-api-key/i.test(client), 'and neither must the header that carries it');
  assert.ok(/voiceToken/.test(client), 'the client carries only the short-lived session token');
});

test('the reasoning endpoint refuses an unauthenticated caller', async () => {
  const fs = await import('node:fs/promises');
  const route = await fs.readFile('command-center/brain/voiceLlm.ts', 'utf8');
  assert.ok(/CC_VOICE_LLM_SECRET/.test(route), 'it is protected by a shared secret');
  assert.ok(/status: 401/.test(route), 'and refuses without it');
  // The whole point of this endpoint: the market read and the position come from OUR engines.
  assert.ok(/contextPacket/.test(route), 'it answers from the same context the screen uses');
  assert.ok(/findSetup/.test(route), 'including THE BRAIN\'s own current trade');
  assert.ok(/resolveToken/.test(route), 'and it identifies the member by token, never by voice');
});

test('a spoken instruction is registered before it is confirmed, on the voice path too', async () => {
  const fs = await import('node:fs/promises');
  const route = await fs.readFile('command-center/brain/voiceLlm.ts', 'utf8');
  // Watches must be armed by the route, NOT by the language model, or the model could promise to watch
  // something nobody wrote down — and a spoken promise is the easiest of all to believe.
  const armIdx = route.indexOf('await arm(');
  const modelIdx = route.indexOf('ANTHROPIC_URL, {');
  assert.ok(armIdx > 0 && armIdx < modelIdx, 'instructions are handled before the model is ever called');
  assert.ok(/authority: "informational"/.test(route), 'and a spoken watch can never be action-authorised');
});

/*
 * THE 404 THAT SOUNDED LIKE SILENCE.
 *
 * A custom-LLM url is an OpenAI BASE url — the provider appends `/chat/completions` before calling it.
 * With only the base path mounted, every turn was a 404 and the agent said nothing at all: no error,
 * no close frame, nothing a browser could show. This is the guard that keeps that route mounted.
 */
test('the provider\'s own path is mounted, not just the base one', async () => {
  const fs = await import('node:fs/promises');
  const mounted = await fs.readFile('src/app/api/command-center/voice/llm/chat/completions/route.ts', 'utf8');
  assert.ok(/handleVoiceLlm/.test(mounted), 'the OpenAI path runs the same handler');
  assert.ok(/export async function POST/.test(mounted), 'and it accepts the POST the provider makes');
  const base = await fs.readFile('src/app/api/command-center/voice/llm/route.ts', 'utf8');
  assert.ok(/handleVoiceLlm/.test(base), 'the base path runs it too, for testing by hand');
});

/*
 * THE TOKEN HAS TO TRAVEL IN THE ONE FIELD THAT IS FORWARDED.
 *
 * `dynamic_variables` never leaves the provider; only `custom_llm_extra_body` reaches our endpoint,
 * where it arrives as `elevenlabs_extra_body`. Sent in the wrong field, the line works perfectly and
 * THE BRAIN refuses every question about the member's own position — a failure that looks like bad
 * reasoning and is actually a missing key.
 */
test('the session token reaches the brain, not just the provider', async () => {
  const fs = await import('node:fs/promises');
  const client = await fs.readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  assert.ok(/custom_llm_extra_body:\s*\{\s*voice_token/.test(client), 'the token is sent in the forwarded field');
  const route = await fs.readFile('command-center/brain/voiceLlm.ts', 'utf8');
  assert.ok(/elevenlabs_extra_body/.test(route), 'and read back out of the name it arrives under');
});

/*
 * MUTE IS NOT A REQUEST TO BE IGNORED.
 *
 * Playback used to be gated on the mute flag, so muting your own microphone destroyed every answer
 * THE BRAIN gave — each one arriving, being discarded, and appearing on screen marked "cut off".
 */
test('muting the microphone does not silence THE BRAIN', async () => {
  const fs = await import('node:fs/promises');
  const client = await fs.readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  const enqueue = client.slice(client.indexOf('const enqueueAudio'), client.indexOf('/* ── teardown'));
  assert.ok(enqueue.length > 0, 'the playback path is where this is decided');
  assert.ok(!/mutedRef\.current/.test(enqueue), 'playback must not be gated on the microphone being muted');
  // The send path is the one that respects it.
  const send = client.slice(client.indexOf('node.onaudioprocess'), client.indexOf('source.connect(node)'));
  assert.ok(/mutedRef\.current/.test(send), 'muting stops audio leaving, which is what muting means');
});

/*
 * SILENCE IS TRANSCRIBED, NOT SKIPPED.
 *
 * A dead microphone yields "..." rather than an empty string, and "..." is a turn that earns a full
 * spoken market brief. Both ends refuse it: the screen does not show it, the brain does not answer it.
 */
test('a turn with nothing said in it is not answered', async () => {
  const fs = await import('node:fs/promises');
  const route = await fs.readFile('command-center/brain/voiceLlm.ts', 'utf8');
  assert.ok(/\\p\{L\}/.test(route), 'the endpoint requires a letter or a digit before it reasons');
  assert.ok(/didn't catch that/.test(route), 'and says so plainly instead of briefing nobody');
  const client = await fs.readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  const transcript = client.slice(client.indexOf('user_transcript'), client.indexOf('agent_response'));
  assert.ok(/\\p\{L\}/.test(transcript), 'and the transcript is held to the same test before it becomes a turn');
});

/*
 * A GRANTED PERMISSION IS NOT A WORKING MICROPHONE.
 *
 * The browser picks an input on the member's behalf and never says which. When that choice is wrong,
 * every symptom points at the voice system instead of at a dropdown nobody knew existed.
 */
test('the microphone is named, checked, and changeable', async () => {
  const fs = await import('node:fs/promises');
  const client = await fs.readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  assert.ok(/enumerateDevices/.test(client), 'the alternatives are offered');
  assert.ok(/deviceId: \{ exact: wanted \}/.test(client), 'and choosing one re-acquires that exact device');
  assert.ok(/track\.muted|micMuted/.test(client), 'a system-muted device is reported as such');
  assert.ok(/setMicLabel/.test(client), 'and the device in use is named rather than described');
});

/*
 * A LOOPBACK DRIVER IS NOT A MICROPHONE.
 *
 * Measured on the real machine: the browser's default input was "BlackHole 2ch (Virtual)", live,
 * unmuted, sending frames, peak amplitude 0.00000. The built-in microphone on the same machine read
 * 0.086. Every symptom pointed at the voice system; the fault was a dropdown nobody knew existed.
 */
test('a virtual input is recognised and replaced, once', async () => {
  const fs = await import('node:fs/promises');
  const client = await fs.readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  assert.ok(/blackhole/i.test(client), 'loopback drivers are known by name');
  assert.ok(/autoPicked/.test(client), 'and replaced at most once, never in a loop');
  assert.ok(/attempt < 2/.test(client), 'which the control flow guarantees rather than promises');
  // A member's own choice is theirs, however strange.
  assert.ok(/!wanted && !autoPicked\.current/.test(client), 'an explicit pick is never overridden');
});

test('voice is admin-gated on the server, not in a component', async () => {
  const fs = await import('node:fs/promises');
  const route = await fs.readFile('src/app/api/command-center/voice/session/route.ts', 'utf8');
  assert.ok(/role.*admin|admin.*role/s.test(route), 'the gate reads the profile role');
  assert.ok(/budget.exhausted/.test(route), 'and the meter is checked before the line opens');
  const client = await fs.readFile('src/components/command-center/VoiceSession.tsx', 'utf8');
  assert.ok(/enabled === false/.test(client), 'the component merely renders nothing when told no');
});
