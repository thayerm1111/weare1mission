const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Exercise the real component with isolated hooks and JSX, without a browser,
// Supabase connection, or network access. State survives explicit re-renders;
// event handlers retain their render's closures, just as React handlers do.
const componentPath = path.resolve(__dirname, "../src/app/login/LoginForm.tsx");
const redirectPath = path.resolve(__dirname, "../src/app/login/login-redirect.ts");
const sourceCache = new Map();

function compiledSource(filename) {
  if (!sourceCache.has(filename)) {
    const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: filename,
    });
    sourceCache.set(filename, result.outputText);
  }
  return sourceCache.get(filename);
}

function nodes(tree, predicate) {
  if (tree == null || typeof tree === "boolean") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (typeof tree !== "object") return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...nodes(tree.props?.children, predicate),
  ];
}

function content(tree) {
  if (tree == null || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (typeof tree !== "object") return String(tree);
  return content(tree.props?.children);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createHarness(options = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let props = options.props || {};
  let tree;
  const calls = { fetch: [], signIn: [], assign: [], session: 0, focus: [] };
  const depsChanged = (before, after) => !before || !after ||
    before.length !== after.length || after.some((value, index) => !Object.is(value, before[index]));

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { value: typeof initial === "function" ? initial() : initial };
      }
      return [slots[index].value, (value) => {
        slots[index].value = typeof value === "function" ? value(slots[index].value) : value;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || depsChanged(previous.deps, deps)) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[index] = { deps, cleanup: effect() };
        });
      }
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || depsChanged(slots[index].deps, deps)) {
        slots[index] = { deps, value: factory() };
      }
      return slots[index].value;
    },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  react.useLayoutEffect = react.useEffect;
  const jsx = (type, elementProps, key) => ({ type, props: elementProps || {}, key });
  const supabase = options.client === null ? null : {
    auth: {
      getSession() {
        calls.session += 1;
        return options.getSession ? options.getSession() :
          Promise.resolve({ data: { session: options.session || null } });
      },
      signInWithPassword(credentials) {
        calls.signIn.push(JSON.parse(JSON.stringify(credentials)));
        return options.signIn ? options.signIn(credentials) :
          Promise.resolve(options.signInResult || { error: null });
      },
    },
  };
  const modules = new Map();
  const context = vm.createContext({
    URL,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    window: {
      location: {
        origin: "https://weare1mission.com",
        assign: (destination) => calls.assign.push(destination),
      },
    },
    fetch: (url, init) => {
      calls.fetch.push({ url, init });
      return options.fetch ? options.fetch(url, init) : Promise.resolve({
        ok: true,
        json: async () => options.response || { action: "try_local" },
      });
    },
  });

  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    function localRequire(request) {
      if (request === "react") return react;
      if (request === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: Symbol.for("test.fragment") };
      if (request === "next/link") return { __esModule: true, default: "a" };
      if (request === "lucide-react") return new Proxy({}, { get: (_, name) => `icon:${String(name)}` });
      if (request === "@/lib/supabase/client") return { createClient: () => supabase };
      if (request === "@/lib/supabase/config") return { isSupabaseConfigured: options.configured !== false };
      if (request.startsWith(".")) {
        const target = path.resolve(path.dirname(filename), request);
        for (const extension of ["", ".ts", ".tsx"]) {
          if (fs.existsSync(target + extension)) return load(target + extension);
        }
      }
      throw new Error(`Unexpected dependency in login test: ${request}`);
    }
    const wrapper = vm.runInContext(`(function (require, module, exports) {\n${compiledSource(filename)}\n})`, context, { filename });
    wrapper(localRequire, module, module.exports);
    return module.exports;
  }

  const { LoginForm } = load(componentPath);
  function render(nextProps) {
    if (nextProps) props = { ...props, ...nextProps };
    cursor = 0;
    effects = [];
    tree = LoginForm(props);
    for (const node of nodes(tree, (node) => node.props.ref)) {
      const element = { focus: () => calls.focus.push(node.props.id || node.props.role || node.type) };
      if (typeof node.props.ref === "function") node.props.ref(element);
      else node.props.ref.current = element;
    }
    const pendingEffects = effects;
    effects = [];
    pendingEffects.forEach((effect) => effect());
    return tree;
  }
  function one(predicate) {
    const matches = nodes(tree, predicate);
    assert.equal(matches.length, 1, "Expected exactly one matching form control");
    return matches[0];
  }
  const harness = {
    calls,
    render,
    one,
    get tree() { return tree; },
    get text() { return content(tree); },
    get form() { return one((node) => node.type === "form"); },
    get submitButton() { return one((node) => node.type === "button" && node.props.type === "submit"); },
    input(id) { return one((node) => node.type === "input" && node.props.id === id); },
    change(id, value) {
      harness.input(id).props.onChange({ target: { value } });
      render();
    },
    fill(login, password) {
      harness.change("login-id", login);
      harness.change("login-password", password);
    },
    submit() { return harness.form.props.onSubmit({ preventDefault() {} }); },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
      render();
    },
    unmount() { slots.forEach((slot) => slot.cleanup?.()); },
    safeLoginRedirect(value) { return load(redirectPath).safeLoginRedirect(value); },
  };
  render();
  return harness;
}

function assertError(harness, message) {
  harness.render();
  assert.ok(harness.text.includes(message), `Expected visible error: ${message}`);
  assert.equal(harness.submitButton.props.disabled, false, "A failed attempt must allow retrying");
  assert.deepEqual(harness.calls.assign, []);
}

test("safe redirects preserve same-site path, query, and fragment", () => {
  const h = createHarness();
  for (const destination of ["/", "/portal", "/portal/training?next=%2Flesson&view=all#chapter-2", "/events?day=1#agenda"]) {
    assert.equal(h.safeLoginRedirect(destination), destination);
  }
  assert.equal(h.safeLoginRedirect("/portal/../events?day=1#agenda"), "/events?day=1#agenda");
});

test("unsafe, malformed, and duplicate redirect inputs fall back to the portal", () => {
  const h = createHarness();
  const invalid = [
    undefined, null, "", 42, true, {}, [], ["/one"], ["/one", "/two"], ["/one", "/one"],
    "portal", " /portal", "https://outside.example/", "javascript:alert(1)",
    "//outside.example/", "///outside.example/", "/\\outside.example/", "\\outside.example/",
    "/portal\\other", "/\t/outside.example", "/\n/outside.example", "/\r/outside.example",
    "/portal\u0000suffix", "/portal\u001fsuffix", "/portal\u007fsuffix",
    "/a/..//outside.example", "/a/%2e%2e//outside.example",
  ];
  for (const destination of invalid) {
    assert.equal(h.safeLoginRedirect(destination), "/portal", `Rejected redirect: ${JSON.stringify(destination)}`);
  }
});

test("the optional default appearance retains working login form semantics", () => {
  const h = createHarness();
  assert.equal(h.form.props.noValidate, true);
  assert.equal(typeof h.form.props.onSubmit, "function");
  assert.equal(h.input("login-id").props.autoComplete, "username");
  assert.equal(h.input("login-password").props.autoComplete, "current-password");
  assert.equal(h.input("login-password").props.type, "password");
  assert.equal(h.submitButton.props.disabled, false);
  assert.equal(h.one((node) => node.type === "a" && node.props.href === "/forgot-password").props.href, "/forgot-password");
});

test("premium password visibility is a non-submit control and preserves the password", () => {
  const h = createHarness({ props: { variant: "premium" } });
  const password = "  pÄss🔐\t ";
  h.fill("member@example.com", password);
  const reveal = () => h.one((node) => node.type === "button" &&
    /show password|hide password/i.test(`${node.props["aria-label"] || ""}${content(node)}`));
  assert.equal(reveal().props.type, "button");
  reveal().props.onClick();
  h.render();
  assert.equal(h.input("login-password").props.type, "text");
  assert.equal(h.input("login-password").props.value, password);
  assert.match(`${reveal().props["aria-label"] || ""}${content(reveal())}`, /hide password/i);
  reveal().props.onClick();
  h.render();
  assert.equal(h.input("login-password").props.type, "password");
  assert.equal(h.input("login-password").props.value, password);
  assert.equal(h.calls.fetch.length, 0);
});

test("translation updates copy without resetting or translating entered credentials", async () => {
  const h = createHarness({ props: { variant: "premium" }, response: { action: "try_local" } });
  const login = "  Member.Name@Example.com  ";
  const password = "  MiXeD Ä🔐\t ";
  h.fill(login, password);
  const placeholder = h.input("login-id").props.placeholder;
  const translated = [];
  h.render({ translate: (copy) => { translated.push(copy); return `Translated: ${copy}`; } });
  assert.equal(h.input("login-id").props.placeholder, `Translated: ${placeholder}`);
  assert.equal(h.input("login-id").props.value, login);
  assert.equal(h.input("login-password").props.value, password);
  assert.ok(!translated.includes(login) && !translated.includes(password), "Credential values are never translation inputs");
  await h.submit();
  assert.deepEqual(JSON.parse(h.calls.fetch[0].init.body), { login: login.trim(), password });
  assert.deepEqual(h.calls.signIn, [{ email: login.trim(), password }]);
});

test("required credentials fail locally before any auth request", async (t) => {
  for (const [login, password, message] of [
    [" \t ", "secret", "Enter your member ID or email."],
    ["member@example.com", "", "Enter your password."],
  ]) {
    await t.test(message, async () => {
      const h = createHarness();
      h.fill(login, password);
      await h.submit();
      assert.equal(h.calls.fetch.length, 0);
      assert.equal(h.calls.signIn.length, 0);
      assertError(h, message);
    });
  }
});

test("membership sign-in sends the exact password and uses the server-confirmed email", async () => {
  const destination = "/portal/training?course=one#lesson-2";
  const h = createHarness({ props: { redirect: destination }, response: { action: "signin", email: "verified@example.com" } });
  const password = " \tpaß🔐 with spaces  ";
  h.fill("  MEMBER-123  ", password);
  await h.submit();
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.fetch[0].url, "/api/auth/login");
  assert.equal(h.calls.fetch[0].init.method, "POST");
  assert.equal(h.calls.fetch[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(h.calls.fetch[0].init.body), { login: "MEMBER-123", password });
  assert.deepEqual(h.calls.signIn, [{ email: "verified@example.com", password }]);
  assert.deepEqual(h.calls.assign, [destination]);
});

test("confirmed membership with failed password sign-in keeps the existing friendly error", async () => {
  const h = createHarness({
    response: { action: "signin", email: "verified@example.com" },
    signInResult: { error: { message: "Invalid login credentials" } },
  });
  h.fill("MEMBER-123", "secret");
  await h.submit();
  assertError(h, "We confirmed your membership but couldn't open your portal. Please try again.");
});

test("approved local account sign-in uses the trimmed email and portal fallback", async () => {
  const h = createHarness({ props: { redirect: "//outside.example/" }, response: { action: "try_local" } });
  h.fill("  Member@Example.com  ", "  Secret\t ");
  await h.submit();
  assert.deepEqual(h.calls.signIn, [{ email: "Member@Example.com", password: "  Secret\t " }]);
  assert.deepEqual(h.calls.assign, ["/portal"]);
});

test("local-account fallback requires an email before calling password authentication", async () => {
  const h = createHarness({ response: { action: "try_local" } });
  h.fill("MEMBER-123", "secret");
  await h.submit();
  assert.equal(h.calls.signIn.length, 0);
  assertError(h, "We couldn't confirm that login. Check your details, or your account may be awaiting approval.");
});

test("local-account invalid credentials and other provider errors retain their distinct handling", async (t) => {
  for (const [providerMessage, visibleMessage] of [
    ["INVALID login credentials", "We couldn't sign you in. Check your details, or your account may be awaiting approval."],
    ["Temporarily unavailable", "Temporarily unavailable"],
  ]) {
    await t.test(providerMessage, async () => {
      const h = createHarness({ response: { action: "try_local" }, signInResult: { error: { message: providerMessage } } });
      h.fill("member@example.com", "secret");
      await h.submit();
      assertError(h, visibleMessage);
    });
  }
});

test("unconfigured authentication fails locally without a login request", async () => {
  const h = createHarness({ client: null, configured: false, response: { action: "try_local" } });
  h.fill("member@example.com", "secret");
  await h.submit();
  assert.equal(h.calls.session, 0);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.signIn.length, 0);
  assertError(h, "Sign-in is temporarily unavailable. Please try again later.");
});

test("an unavailable auth client leaves local-account sign-in recoverable", async () => {
  const h = createHarness({ client: null, response: { action: "try_local" } });
  h.fill("member@example.com", "secret");
  await h.submit();
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.signIn.length, 0);
  assertError(h, "Sign-in is temporarily unavailable. Please try again later.");
});

test("membership blocking reasons retain their existing messages and never call password authentication", async (t) => {
  for (const [reason, message] of [
    ["inactive", "We couldn't confirm an active membership for that login. If you just renewed, give it a few minutes and try again."],
    ["physical_only", "That membership doesn't include member-area access."],
    ["other", "We couldn't sign you in right now. Please try again, or reach out to your team."],
  ]) {
    await t.test(reason, async () => {
      const h = createHarness({ response: { action: "blocked", reason } });
      h.fill("member@example.com", "secret");
      await h.submit();
      assert.equal(h.calls.signIn.length, 0);
      assertError(h, message);
    });
  }
});

test("server errors and malformed responses remain recoverable", async (t) => {
  const cases = [
    ["server message", { response: { action: "error", message: "Please try later." } }, "Please try later."],
    ["unknown action", { response: { action: "unknown" } }, "We couldn't sign you in. Please try again."],
    ["missing confirmed email", { response: { action: "signin" } }, "We couldn't sign you in. Please try again."],
    ["invalid JSON", { fetch: async () => ({ json: async () => { throw new Error("invalid JSON"); } }) }, "We couldn't sign you in. Please try again."],
    ["request failure", { fetch: async () => { throw new Error("offline"); } }, "Something went wrong signing in. Please try again."],
  ];
  for (const [name, options, message] of cases) {
    await t.test(name, async () => {
      const h = createHarness(options);
      h.fill("member@example.com", "secret");
      await h.submit();
      assert.equal(h.calls.signIn.length, 0);
      assertError(h, message);
    });
  }
});

test("same-tick duplicate submissions make one request and a failed request can be retried", async () => {
  const pending = deferred();
  const h = createHarness({ fetch: () => pending.promise });
  h.fill("member@example.com", "secret");
  const originalHandler = h.form.props.onSubmit;
  const first = originalHandler({ preventDefault() {} });
  const duplicate = originalHandler({ preventDefault() {} });
  assert.equal(h.calls.fetch.length, 1, "The synchronous guard must work before React re-renders");
  h.render();
  assert.equal(h.submitButton.props.disabled, true);
  pending.resolve({ json: async () => ({ action: "blocked", reason: "inactive" }) });
  await Promise.all([first, duplicate]);
  h.render();
  assert.equal(h.submitButton.props.disabled, false);
  await h.submit();
  assert.equal(h.calls.fetch.length, 2, "A failure must release the synchronous guard");
});

test("duplicate protection remains active while password authentication is pending", async () => {
  const pending = deferred();
  const h = createHarness({ response: { action: "signin", email: "verified@example.com" }, signIn: () => pending.promise });
  h.fill("MEMBER-123", "secret");
  const first = h.submit();
  await h.flush();
  assert.equal(h.calls.signIn.length, 1);
  assert.equal(h.submitButton.props.disabled, true);
  await h.submit();
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.signIn.length, 1);
  pending.resolve({ error: null });
  await first;
  assert.deepEqual(h.calls.assign, ["/portal"]);
});

test("existing sessions navigate through the same safe redirect without a login request", async (t) => {
  for (const [redirect, expected] of [
    ["/portal/training?course=one#lesson", "/portal/training?course=one#lesson"],
    ["/\\outside.example", "/portal"],
    [["/portal", "/admin"], "/portal"],
  ]) {
    await t.test(JSON.stringify(redirect), async () => {
      const h = createHarness({ props: { redirect }, session: { user: { id: "existing-user" } } });
      await h.flush();
      assert.equal(h.calls.session, 1);
      assert.deepEqual(h.calls.assign, [expected]);
      assert.equal(h.calls.fetch.length, 0);
      assert.equal(h.calls.signIn.length, 0);
    });
  }
});

test("changing the translation after an error preserves credentials and translates the current message", async () => {
  const message = "That membership doesn't include member-area access.";
  const h = createHarness({ props: { variant: "premium" }, response: { action: "blocked", reason: "physical_only" } });
  h.fill("MEMBER-123", " secret ");
  await h.submit();
  h.render({ translate: (copy) => `Translated: ${copy}` });
  assert.equal(h.input("login-id").props.value, "MEMBER-123");
  assert.equal(h.input("login-password").props.value, " secret ");
  assert.ok(h.text.includes(`Translated: ${message}`));
});

test("a rejected session lookup leaves manual sign-in available", async () => {
  const h = createHarness({ getSession: async () => { throw new Error("session lookup unavailable"); } });
  await h.flush();
  assert.deepEqual(h.calls.assign, []);
  assert.equal(h.submitButton.props.disabled, false);
  h.fill("member@example.com", "secret");
  await h.submit();
  assert.deepEqual(h.calls.assign, ["/portal"]);
});

test("a session lookup that resolves after unmount does not navigate", async () => {
  const pending = deferred();
  const h = createHarness({ getSession: () => pending.promise });
  h.unmount();
  pending.resolve({ data: { session: { user: { id: "existing-user" } } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.assign, []);
  assert.equal(h.calls.fetch.length, 0);
});
