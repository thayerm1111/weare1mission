const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const A = "member-a", B = "member-b";
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (tree == null || typeof tree === "boolean") return "";
  return typeof tree === "object" ? content(tree.props?.children) : String(tree);
}

// Actual welcome callbacks and the actual lease coordinator. No media, voice provider, broker,
// credential, or network access exists in this harness; only recorded fixture fetches can resolve.
function harness({ name = "WelcomeTutorial", memberId = A, configured = true, auto = true, consent = false, welcome = false, reduced = false, seen = false } = {}) {
  const slots = [], requests = [], timeouts = new Map(), listeners = new Map(), storage = new Map(), modules = new Map(), emitted = [];
  let cursor = 0, effects = [], dirty = false, tree, promptState, mounted = true, nextTimer = 0, route = "/portal/trading", query = "", atlasOpen = false, closed = 0, complete = 0, afterUnmount = 0;
  const props = name === "WelcomeTutorial" ? { memberId, configured, auto } : name === "LowBalanceFlyer" ? { memberId } : name === "ProfileMenu"
    ? { member: { id: memberId, name: "Fixture member", email: "fixture@example.invalid", admin: false }, configured, preview: false, asApp: false, look: "graphite", onLook() {} }
    : { open: true, onClose: () => { closed++; }, onComplete: () => { complete++; } };
  const on = (key, callback) => { if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(callback); };
  const off = (key, callback) => listeners.get(key)?.delete(callback);
  const emit = (key, event = {}) => { for (const callback of [...(listeners.get(key) ?? [])]) callback(event); };
  let videoProps = {};
  class Element {
    constructor() { this.open = false; this.isConnected = true; this.focused = 0; this.paused = true; this.currentTime = 0; this.playCalls = 0; this.pauseCalls = 0; this.style = {}; this.items = []; }
    focus() { this.focused++; document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    play() { this.playCalls++; this.paused = false; videoProps.onPlay?.(); return Promise.resolve(); }
    pause() { this.pauseCalls++; if (!this.paused) { this.paused = true; videoProps.onPause?.(); } }
    getClientRects() { return this.hidden ? [] : [{ width: 100, height: 40 }]; }
    closest() { return this.inert ? this : null; }
    querySelectorAll() { return this.items; }
    contains(element) { return element === this || this.items.includes(element); }
  }
  const dialog = new Element(), creditPanel = new Element(), video = new Element(), playButton = new Element(), opener = new Element(), classes = new Set(), buttonElements = new Map(), externalDialogs = [];
  const document = {
    activeElement: opener, body: new Element(), visibilityState: "visible",
    documentElement: { classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key) } },
    querySelector: () => opener,
    querySelectorAll: () => [...externalDialogs, ...(dialog.open ? [dialog] : []), ...(name === "LowBalanceFlyer" && tree ? [creditPanel] : [])],
    addEventListener: (key, fn) => on(`document:${key}`, fn), removeEventListener: (key, fn) => off(`document:${key}`, fn),
  };
  const media = { matches: reduced, addEventListener: (key, fn) => on(`media:${key}`, fn), removeEventListener: (key, fn) => off(`media:${key}`, fn) };
  const window = {
    location: { search: "" },
    matchMedia: () => media,
    addEventListener: (key, fn) => on(`window:${key}`, fn), removeEventListener: (key, fn) => off(`window:${key}`, fn),
    dispatchEvent: (event) => { emitted.push(event.type); emit(`window:${event.type}`, event); return true; },
  };
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((value, index) => !Object.is(value, before[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => {
        if (!mounted) { afterUnmount++; return; }
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++, prior = slots[index]; if (!prior || changed(prior.deps, deps)) effects.push(() => { prior?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; }); },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  react.useSyncExternalStore = (subscribe, getSnapshot) => {
    const [snapshot, setSnapshot] = react.useState(getSnapshot);
    react.useEffect(() => { const update = () => setSnapshot(getSnapshot()); const stop = subscribe(update); update(); return stop; }, [subscribe, getSnapshot]);
    return snapshot;
  };
  const jsx = (type, nodeProps) => ({ type, props: nodeProps || {} });
  const context = vm.createContext({
    AbortController, Event, HTMLElement: Element, window, document,
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    localStorage: { getItem: () => null },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timeouts.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });
  function load(relative, append = "") {
    if (modules.has(relative)) return modules.get(relative);
    const filename = path.join(ROOT, relative);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8") + append, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename }).outputText;
    const mod = { exports: {} };
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(requireHere, mod, mod.exports);
    modules.set(relative, mod.exports);
    return mod.exports;
  }
  function requireHere(key) {
    if (key === "react") return react;
    if (key === "react-dom") return { createPortal: (children) => children };
    if (key === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (key === "next/navigation") return { usePathname: () => route, useSearchParams: () => new URLSearchParams(query) };
    if (key === "next/link") return { __esModule: true, default: "Link" };
    if (key === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
    if (key === "@/lib/onboarding/entry") return load("src/lib/onboarding/entry.ts");
    if (key === "@/lib/onboarding/welcome") return load("src/lib/onboarding/welcome.ts");
    if (key === "@/lib/lowBalance") return load("src/lib/lowBalance.ts");
    if (key === "./atlas/AtlasProvider") return { useAtlasPanel: () => ({ open: atlasOpen }) };
    if (key === "./WelcomeTutorial") return load("src/components/om/WelcomeTutorial.tsx");
    if (key === "@/lib/floor/look") return { LOOKS: [] };
    return {};
  }
  const entry = load("src/lib/onboarding/entry.ts");
  const metadata = load("src/lib/onboarding/welcome.ts").WELCOME_TUTORIAL;
  if (seen) storage.set(`om:welcome:${metadata.key}:${encodeURIComponent(memberId)}`, "1");
  const disclosure = consent ? entry.reserveDisclosure(memberId) : () => {};
  const welcomeLease = welcome ? entry.reserveWelcome(memberId) : () => {};
  const component = name === "ProfileMenu" ? load("src/components/om/AppShell.tsx", "\nexport { ProfileMenu };\n")[name]
    : name === "LowBalanceFlyer" ? load("src/components/portal/LowBalanceFlyer.tsx")[name] : load("src/components/om/WelcomeTutorial.tsx")[name];
  function render(nextProps = {}) {
    Object.assign(props, nextProps);
    let turns = 0;
    do {
      assert.ok(turns++ < 25, "Welcome settles without a render loop");
      cursor = 0; dirty = false; effects = [];
      tree = component(props);
      promptState = entry.useEntryPrompts(props.memberId ?? memberId);
      creditPanel.items = nodes(tree, (node) => node.type === "button" && !node.props.disabled).map((node) => {
        const label = node.props["aria-label"] || content(node);
        if (!buttonElements.has(label)) buttonElements.set(label, new Element());
        return buttonElements.get(label);
      });
      for (const node of nodes(tree, (node) => node.props?.ref)) {
        if (node.type === "video") { node.props.ref.current = video; videoProps = node.props; }
        else if (name === "LowBalanceFlyer") node.props.ref.current = node.type === "div" ? creditPanel : buttonElements.get(node.props["aria-label"] || content(node));
        else node.props.ref.current = node.type === "dialog" ? dialog : playButton;
      }
      const run = effects; effects = []; run.forEach((effect) => effect());
    } while (dirty);
    return tree;
  }
  render();
  return {
    render, requests, video, dialog, playButton, opener, classes, storage, emitted, metadata, timeouts,
    get closed() { return closed; }, get complete() { return complete; }, get afterUnmount() { return afterUnmount; }, get prompts() { return promptState; }, get focused() { return document.activeElement; },
    nodes: (predicate) => nodes(tree, predicate), text: () => content(tree),
    player: () => nodes(tree, (node) => node.type?.name === "WelcomeTutorialPlayer")[0],
    button(label) { const found = nodes(tree, (node) => node.type === "button" && (node.props["aria-label"] === label || content(node) === label || content(node.props.children?.[1]) === label)); assert.equal(found.length, 1, label); return found[0]; },
    async reply(index, answer, ok = true) { requests[index].resolve({ ok, json: async () => answer }); await drain(); render(); },
    async timeout(ms) { const match = [...timeouts].find(([, timer]) => timer.ms === ms); assert.ok(match, `Expected ${ms}ms timeout`); timeouts.delete(match[0]); match[1].fn(); await drain(); render(); },
    releaseDisclosure() { disclosure(); render(); },
    releaseWelcome() { welcomeLease(); render(); },
    focusButton(label) { buttonElements.get(label).focus(); },
    focusedButton(label) { return document.activeElement === buttonElements.get(label); },
    nextDialog() { const next = new Element(); externalDialogs.push(next); next.focus(); return next; },
    keyboard(key, shiftKey = false) { let prevented = false; emit("document:keydown", { key, shiftKey, preventDefault() { prevented = true; }, stopPropagation() {} }); render(); return prevented; },
    replay() { load("src/components/om/WelcomeTutorial.tsx").openWelcomeTutorial(); render(); },
    navigation(pathname, search = "") { route = pathname; query = search; render(); },
    atlas(open) { atlasOpen = open; render(); },
    visibility(state) { document.visibilityState = state; emit("document:visibilitychange"); render(); },
    pagehide() { emit("window:pagehide"); render(); },
    mutationCount: () => requests.filter((request) => request.init.method === "POST").length,
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); mounted = false; },
  };
}

test("first welcome waits behind disclosure, reserves the credit prompt, and explicit skip persists only the current member", async () => {
  const h = harness({ consent: true });
  assert.equal(h.requests.length, 1); assert.equal(h.mutationCount(), 0);
  assert.equal(h.prompts.canShowCredits, false); assert.equal(h.prompts.welcomePending, true);
  assert.equal(h.requests[0].init.headers["x-portal-member"], A);
  await h.reply(0, { ok: true, seen: false, memberId: A });
  assert.equal(h.player().props.open, false);
  h.releaseDisclosure(); assert.equal(h.player().props.open, true); assert.equal(h.prompts.canShowCredits, false);
  h.player().props.onClose(); h.render();
  assert.equal(h.player(), undefined); assert.equal(h.mutationCount(), 1); assert.equal(h.prompts.canShowCredits, true);
  assert.deepEqual(JSON.parse(h.requests[1].init.body), { key: h.metadata.key, expectedMemberId: A });
  assert.equal(h.requests[1].url, "/api/portal/announcement");
  assert.equal(h.storage.get(`om:welcome:${h.metadata.key}:${A}`), "1");
  h.replay(); assert.equal(h.player().props.open, true); assert.equal(h.player().props.replay, true);
  h.player().props.onComplete(); h.player().props.onClose(); h.render();
  assert.equal(h.mutationCount(), 1, "Replay does not repeatedly write the same acknowledgement");
  h.unmount();
});

test("seen, sample and command-center visits stay quiet while replay remains available", async () => {
  const h = harness(); await h.reply(0, { ok: true, seen: true, memberId: A });
  assert.equal(h.player(), undefined); assert.equal(h.mutationCount(), 0);
  h.replay(); assert.equal(h.player().props.open, true); h.unmount();
  const local = harness({ seen: true }); assert.equal(local.requests.length, 0); local.unmount();
  const sample = harness({ configured: false }); sample.replay(); assert.equal(sample.requests.length, 0); assert.equal(sample.player(), undefined); sample.unmount();
  const desk = harness({ auto: false }); assert.equal(desk.requests.length, 0); desk.replay(); assert.equal(desk.player().props.open, true); desk.unmount();
});

test("stale member reads and held callbacks cannot open or acknowledge another member's welcome", async () => {
  const h = harness();
  h.render({ memberId: B }); assert.equal(h.requests[0].init.signal.aborted, true);
  await h.reply(0, { ok: true, seen: false, memberId: A }); assert.equal(h.player(), undefined);
  await h.reply(1, { ok: true, seen: false, memberId: B });
  const held = h.player().props.onClose;
  h.render({ memberId: A }); held(); h.render();
  assert.equal(h.mutationCount(), 0);
  await h.reply(2, { ok: true, seen: false, memberId: B });
  assert.equal(h.player(), undefined, "A mismatched server identity is not accepted");
  h.unmount();
});

test("a failed status read releases entry sequencing and replay works; route changes discard queued welcome", async () => {
  const h = harness(); await h.timeout(8000);
  assert.equal(h.requests[0].init.signal.aborted, true); assert.equal(h.player(), undefined); assert.equal(h.prompts.canShowCredits, true);
  h.replay(); assert.equal(h.player().props.open, true);
  h.atlas(true); assert.equal(h.player().props.open, false);
  h.atlas(false); assert.equal(h.player().props.open, true);
  h.navigation("/portal/genx"); assert.equal(h.player(), undefined); assert.equal(h.mutationCount(), 0);
  await h.reply(0, { ok: true, seen: false, memberId: A }); assert.equal(h.player(), undefined);
  h.unmount(); assert.equal(h.timeouts.size, 0);
});

test("the real player never autoplays, includes captions and an actual transcript, and seeks without starting services", async () => {
  const h = harness({ name: "WelcomeTutorialPlayer" });
  assert.equal(h.dialog.open, true); assert.equal(h.playButton.focused > 0, true); assert.equal(h.video.playCalls, 0);
  const player = h.nodes((node) => node.type === "video")[0];
  assert.equal(player.props.controls, true); assert.equal(player.props.playsInline, true); assert.equal(player.props.autoPlay, undefined);
  assert.equal(player.props.preload, "metadata"); assert.equal(player.props.src, h.metadata.videoSrc);
  const captions = h.nodes((node) => node.type === "track")[0];
  assert.equal(captions.props.src, h.metadata.captionsSrc); assert.equal(captions.props.kind, "captions"); assert.equal(captions.props.default, true);
  const seek = h.nodes((node) => node.type === "button" && content(node).includes(h.metadata.chapters[2].title))[0];
  seek.props.onClick(); h.render(); assert.equal(h.video.currentTime, h.metadata.chapters[2].start); assert.equal(h.video.playCalls, 0);
  h.button("Read transcript").props.onClick(); h.render();
  const transcript = h.nodes((node) => node.props?.id === "om-welcome-transcript")[0];
  assert.equal(transcript.props.hidden, false);
  for (const chapter of h.metadata.chapters) assert.ok(content(transcript).includes(chapter.narration));
  h.button("Play welcome video").props.onClick(); await drain(); h.render(); assert.equal(h.video.playCalls, 1);
  h.button("Pause video").props.onClick(); h.render(); assert.equal(h.video.paused, true);
  assert.equal(h.requests.length, 0, "Watching/reading/seeking does not call a market, broker, voice, or paid tool");
  h.unmount(); assert.equal(h.dialog.open, false); assert.equal(h.opener.focused > 0, true);
});

test("media pauses on close, background, page exit and unmount; completion is explicit and reduced motion exposes transcript", async () => {
  const h = harness({ name: "WelcomeTutorialPlayer", reduced: true });
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.nodes((node) => node.props?.id === "om-welcome-transcript")[0].props.hidden, false);
  h.button("Play welcome video").props.onClick(); h.render(); h.visibility("hidden"); assert.equal(h.video.paused, true);
  h.visibility("visible"); assert.equal(h.video.playCalls, 1, "Foregrounding never resumes audio automatically");
  h.button("Resume video").props.onClick(); h.render(); h.pagehide(); assert.equal(h.video.paused, true);
  const player = h.nodes((node) => node.type === "video")[0]; player.props.onEnded(); h.render(); assert.equal(h.complete, 1);
  h.button("Watch again").props.onClick(); h.render(); assert.equal(h.video.currentTime, 0);
  h.button("Close tutorial").props.onClick(); h.render(); assert.equal(h.closed, 1); assert.equal(h.video.paused, true);
  h.render({ open: false }); assert.equal(h.dialog.open, false); assert.equal(h.classes.has("om-welcome-open"), false);
  h.unmount();

  const broken = harness({ name: "WelcomeTutorialPlayer" });
  broken.nodes((node) => node.type === "video")[0].props.onError(); broken.render();
  assert.ok(broken.text().includes("The video could not load"));
  assert.equal(broken.nodes((node) => node.props?.id === "om-welcome-transcript")[0].props.hidden, false);
  assert.equal(broken.button("Play welcome video").props.disabled, true); assert.equal(broken.complete, 0);
  broken.nodes((node) => node.type === "dialog")[0].props.onCancel({ preventDefault() {} });
  assert.equal(broken.closed, 1); broken.unmount();
});

test("the actual account menu replays in place without navigating or generating a signal", () => {
  const h = harness({ name: "ProfileMenu" });
  h.button("Your account").props.onClick(); h.render();
  h.button("Replay tutorial").props.onClick(); h.render();
  assert.ok(h.emitted.includes("om:welcome:open"));
  assert.equal(h.nodes((node) => node.props?.role === "menu").length, 0);
  assert.equal(h.requests.length, 0); h.unmount();
});

test("the queued credit dialog takes focus after welcome, contains keyboard focus and Escape only dismisses the prompt", async () => {
  const h = harness({ name: "LowBalanceFlyer", welcome: true });
  await h.reply(0, { pass: false, balance: { dailyLeft: 0, purchased: 0 }, packs: [] });
  assert.equal(h.nodes((node) => node.props?.role === "dialog").length, 0);
  assert.equal(h.focused, h.opener, "A queued prompt does not steal focus");
  h.releaseWelcome();
  assert.equal(h.nodes((node) => node.props?.role === "dialog").length, 1);
  assert.equal(h.focusedButton("Close"), true);
  h.focusButton("Maybe later"); assert.equal(h.keyboard("Tab"), true); assert.equal(h.focusedButton("Close"), true);
  assert.equal(h.keyboard("Tab", true), true); assert.equal(h.focusedButton("Maybe later"), true);
  const nativeAbove = h.nextDialog();
  assert.equal(h.keyboard("Escape"), false, "A native dialog above the flyer keeps its own Escape handling");
  assert.equal(h.focused, nativeAbove);
  nativeAbove.hidden = true;
  assert.equal(h.keyboard("Escape"), true);
  assert.equal(h.nodes((node) => node.props?.role === "dialog").length, 0);
  assert.equal(h.focused, h.opener);
  assert.equal(h.mutationCount(), 0, "Focus changes and dismissal never start checkout or another action");
  h.unmount();
});

test("welcome cleanup yields focus to the next visible dialog instead of restoring the underlying account button", () => {
  const h = harness({ name: "WelcomeTutorialPlayer" });
  const next = h.nextDialog();
  h.render({ open: false });
  assert.equal(h.dialog.open, false);
  assert.equal(h.focused, next);
  assert.equal(h.opener.focused, 0);
  h.unmount();
});
