const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree == null || typeof tree === "boolean" ? "" : typeof tree === "object" ? text(tree.props?.children) : String(tree);
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((child) => nodes(child, predicate)) : !tree || typeof tree !== "object" ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
function storage(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [];
  return { writes, getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); values.set(key, value); },
    removeItem: (key) => values.delete(key), clear: () => values.clear() };
}

// Run the real preference hook and the real context-consuming buttons together.
// The provider's value is assigned before rendering its child, as React does.
function harness(options = {}) {
  const slots = [], listeners = new Map(), cache = new Map(), seenModes = [];
  const backing = options.storage ?? storage();
  let cursor = 0, effects = [], dirty = false, mounted = true, tree, preference;
  let networkCalls = 0;
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]));
  const react = {
    createContext: (initial) => ({ current: initial }),
    useContext: (context) => context.current,
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => {
        assert.ok(mounted, "An unmounted preference cannot update");
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const index = cursor++, before = slots[index];
      if (!before || changed(before.deps, deps)) effects.push(() => {
        before?.cleanup?.(); slots[index] = { deps, cleanup: effect() };
      });
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const context = vm.createContext({
    localStorage: backing,
    window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
    },
    fetch: () => { networkCalls++; throw new Error("A display preference must never make a network request"); },
  });
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative).exports;
    const filename = path.join(ROOT, relative);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const mod = { exports: {} }; cache.set(relative, mod);
    const requireHere = (name) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "@/lib/floor/experience") return load("src/lib/floor/experience.ts");
      throw new Error("Unexpected preference dependency: " + name);
    };
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(requireHere, mod, mod.exports);
    return mod.exports;
  }
  const lib = load("src/lib/floor/experience.ts");
  const ui = load("src/components/om/experience.tsx");
  function render() {
    let turns = 0;
    do {
      assert.ok(turns++ < 12, "The preference settles without a render loop");
      cursor = 0; effects = []; dirty = false;
      if (!options.outsideShell) {
        preference = ui.useExperiencePreference();
        seenModes.push(preference.mode);
        ui.ExperienceContext.current = preference;
      }
      tree = ui.ExperienceSwitch();
      effects.forEach((effect) => effect());
    } while (dirty);
  }
  render();
  const buttons = () => nodes(tree, (node) => node.type === "button");
  return {
    lib, backing, seenModes, render, buttons,
    value: () => preference ?? ui.useExperienceMode(),
    click(label) { const button = buttons().find((node) => text(node) === label); assert.ok(button); button.props.onClick(); render(); },
    selected: () => buttons().filter((node) => node.props["aria-pressed"]).map(text),
    sync(key, newValue) { listeners.get("storage")?.({ key, newValue, storageArea: backing }); render(); },
    listenerCount: () => listeners.size,
    get networkCalls() { return networkCalls; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); mounted = false; },
  };
}

test("the actual OM preference starts Simple while classic consumers retain Advanced", () => {
  const h = harness();
  assert.equal(h.lib.DEFAULT_EXPERIENCE, "simple");
  assert.equal(h.value().mode, "simple"); assert.equal(h.value().isSimple, true);
  assert.deepEqual(h.selected(), ["Simple"]);
  assert.equal(h.backing.writes.length, 0, "Opening the page does not overwrite a saved preference");
  for (const bad of [undefined, null, "", "SIMPLE", "ADVANCED", "unexpected", 1, {}, []]) assert.equal(h.lib.experienceModeOf(bad), "simple");
  assert.equal(h.lib.experienceModeOf("advanced"), "advanced");
  assert.equal(h.networkCalls, 0); h.unmount();
  const classic = harness({ outsideShell: true });
  assert.deepEqual(classic.selected(), ["Advanced"]);
  assert.equal(classic.value().isSimple, false);
  assert.equal(classic.networkCalls, 0); classic.unmount();
});

test("pressing the actual switch changes the shared value and persists it; remount restores saved Advanced", () => {
  const shared = storage(), h = harness({ storage: shared });
  h.click("Advanced");
  assert.deepEqual(h.selected(), ["Advanced"]);
  assert.equal(h.value().mode, "advanced"); assert.equal(h.value().isSimple, false);
  assert.equal(shared.getItem(h.lib.EXPERIENCE_KEY), "advanced");
  h.render(); assert.deepEqual(h.selected(), ["Advanced"]);
  assert.equal(shared.writes.length, 1);
  assert.equal(h.networkCalls, 0); h.unmount();
  assert.equal(h.listenerCount(), 0, "Unmount removes the storage listener");
  const restored = harness({ storage: shared });
  assert.equal(restored.seenModes[0], "simple", "The hydration-safe initial render uses the default");
  assert.deepEqual(restored.selected(), ["Advanced"], "The actual mount effect restores the saved choice");
  assert.equal(shared.writes.length, 1, "Restoring a preference does not write or charge anything");
  restored.click("Simple");
  assert.equal(restored.value().isSimple, true);
  assert.equal(shared.getItem(restored.lib.EXPERIENCE_KEY), "simple");
  assert.equal(restored.networkCalls, 0); restored.unmount();
});

test("another tab's mode changes synchronize while unrelated storage keys are ignored and clear resets Simple", () => {
  const h = harness();
  h.sync(h.lib.EXPERIENCE_KEY, "advanced");
  assert.deepEqual(h.selected(), ["Advanced"]);
  h.sync("unrelated-preference", "simple");
  assert.deepEqual(h.selected(), ["Advanced"]);
  h.sync(h.lib.EXPERIENCE_KEY, null);
  assert.deepEqual(h.selected(), ["Simple"], "Removing this preference resets the default");
  h.sync(h.lib.EXPERIENCE_KEY, "advanced");
  h.sync(null, null);
  assert.deepEqual(h.selected(), ["Simple"], "Clearing storage resets the preference");
  h.sync(h.lib.EXPERIENCE_KEY, "corrupt");
  assert.deepEqual(h.selected(), ["Simple"]);
  assert.equal(h.backing.writes.length, 0, "Storage synchronization cannot echo writes into other tabs");
  assert.equal(h.networkCalls, 0); h.unmount();
});

test("blocked browser storage still permits both button choices for the current visit", () => {
  let readAttempts = 0, writeAttempts = 0;
  const blocked = { getItem() { readAttempts++; throw new Error("Storage denied"); }, setItem() { writeAttempts++; throw new Error("Storage denied"); } };
  const h = harness({ storage: blocked });
  assert.deepEqual(h.selected(), ["Simple"]);
  h.click("Advanced"); h.render();
  assert.deepEqual(h.selected(), ["Advanced"]);
  assert.equal(h.value().isSimple, false);
  h.click("Simple");
  assert.deepEqual(h.selected(), ["Simple"]);
  assert.equal(readAttempts, 1); assert.equal(writeAttempts, 2);
  assert.equal(h.networkCalls, 0); h.unmount();
});
