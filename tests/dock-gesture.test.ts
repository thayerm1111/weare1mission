import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { notifyDockNavigation, startDockGesture } from "../src/components/om/dock-gesture";

const routes = ["/portal/trading", "/command-center", "/portal/genx", "/portal/trading?view=pulse", "/portal/trading?view=flow"];

class Slot {
  attributes = new Set<string>();
  constructor(readonly dock: object | null, readonly index: number, readonly href: string) {}
  closest(selector: string) { return selector === "a[data-app]" ? this : this.dock; }
  getAttribute(key: string) { return key === "href" ? this.href : null; }
  setAttribute(key: string) { this.attributes.add(key); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  getBoundingClientRect() { return { left: this.index * 40, width: 40 }; }
}

function browser(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captures = new Set<number>();
  const root = {
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id),
  };
  const outside = new Slot(null, 0, "/other");
  class Dock {
    slots = routes.map((href, i) => new Slot(this, i, href));
    closest(selector: string) { return selector === "nav.om-os-dock" ? this : null; }
    querySelectorAll() { return this.slots; }
  }
  let dock = new Dock();
  const doc = Object.assign(new EventTarget(), {
    documentElement: root,
    elementFromPoint(x: number, y: number) {
      if (y < 400 || y > 460 || x < 0 || x >= dock.slots.length * 40) return outside;
      return x % 40 === 0 ? dock : dock.slots[Math.floor(x / 40)];
    },
  });
  const url = new URL("https://example.test/portal/trading");
  const win = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  for (const [key, value] of Object.entries({ document: doc, window: win, location: url, Element: Slot })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  const calls: [string, string][] = [];
  const router = {
    push: (href: string) => { calls.push(["push", href]); },
    replace: (href: string) => { calls.push(["replace", href]); },
    back: () => { calls.push(["back", ""]); },
  };
  function pointer(type: string, x: number, y = 430, overrides = {}) {
    const e = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: "touch", pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, ...overrides,
    });
    doc.dispatchEvent(e);
    if (type === "pointerdown") startDockGesture(e as unknown as PointerEvent, router);
  }
  function click(detail: number, target = dock.slots[0]) {
    const e = Object.assign(new Event("click", { cancelable: true }), { detail });
    Object.defineProperty(e, "target", { value: target });
    doc.dispatchEvent(e);
    return e.defaultPrevented;
  }
  return {
    pointer, click, calls, captures, outside, slots: () => dock.slots,
    dwell: () => t.mock.timers.tick(160),
    commit(href: string) { url.href = new URL(href, url).href; notifyDockNavigation(); },
    remount() { dock = new Dock(); },
  };
}

test("holding over tools routes while the finger stays down, even after the dock remounts", t => {
  const h = browser(t);
  h.pointer("pointerdown", 20);
  h.pointer("pointermove", 60);
  assert.equal(h.slots()[1].attributes.has("data-scrubbed"), true);
  assert.equal(h.calls.length, 0);
  h.dwell();
  assert.deepEqual(h.calls, [["push", routes[1]]]);
  h.pointer("pointermove", 100);
  h.dwell();
  assert.equal(h.calls.length, 1, "a held target waits for the pending navigation");
  h.remount();
  h.commit(routes[1]);
  assert.deepEqual(h.calls[1], ["replace", routes[2]]);
  assert.equal(h.captures.has(1), true);
  h.pointer("pointermove", 140);
  h.dwell();
  h.pointer("pointermove", 180);
  h.pointer("pointerup", 180);
  h.dwell();
  assert.equal(h.calls.length, 2, "releasing on FLOW queues it while GENX is loading");
  h.commit(routes[2]);
  assert.deepEqual(h.calls[2], ["replace", routes[4]], "only the final destination opens after release");
  h.commit(routes[4]);
  h.dwell();
  assert.equal(h.calls.length, 3);
  assert.equal(h.captures.size, 0);
  assert.ok(h.slots().every(link => !link.attributes.has("data-scrubbed")));
});

test("releasing on the original tool restores the prior history entry once", t => {
  const h = browser(t);
  h.pointer("pointerdown", 20);
  h.pointer("pointermove", 60);
  h.dwell();
  h.pointer("pointerup", 20);
  h.commit(routes[1]);
  h.commit(routes[0]);
  assert.deepEqual(h.calls, [["push", routes[1]], ["back", ""]]);
});

test("taps, mouse clicks and vertical scrolling keep native behavior", t => {
  const h = browser(t);
  for (const pointerType of ["touch", "mouse"]) {
    h.pointer("pointerdown", 20, 430, { pointerType });
    h.pointer("pointermove", 23);
    h.pointer("pointerup", 23);
    assert.equal(h.click(1), false);
  }
  h.pointer("pointerdown", 20);
  h.pointer("pointermove", 22, 445);
  h.pointer("pointermove", 100, 445);
  h.dwell();
  h.pointer("pointerup", 100, 445);
  assert.deepEqual(h.calls, []);
  assert.equal(h.captures.size, 0);
});

test("leaving the dock or canceling before dwell never follows the prior target", t => {
  const h = browser(t);
  h.pointer("pointerdown", 20);
  h.pointer("pointermove", 60);
  h.pointer("pointermove", 60, 375);
  h.dwell();
  h.pointer("pointerup", 60, 375);
  assert.equal(h.click(1, h.outside), false);
  h.pointer("pointerdown", 20);
  h.pointer("pointermove", 100);
  h.pointer("pointercancel", 100);
  h.dwell();
  h.pointer("pointerup", 100);
  assert.equal(h.captures.size, 0);
  assert.deepEqual(h.calls, []);
});

test("a canceled drag or an immediate new tap discards pending gesture destinations", t => {
  const h = browser(t);
  h.pointer("pointerdown", 20);
  h.pointer("pointermove", 60);
  h.dwell();
  h.pointer("pointermove", 100);
  h.dwell();
  h.pointer("pointercancel", 100);
  h.commit(routes[1]);
  assert.deepEqual(h.calls, [["push", routes[1]]]);

  h.pointer("pointerdown", 60);
  h.pointer("pointermove", 140);
  h.dwell();
  h.pointer("pointerup", 180);
  h.pointer("pointerdown", 100);
  h.pointer("pointerup", 100);
  assert.equal(h.click(1), false);
  h.commit(routes[3]);
  h.commit(routes[2]); // The link activated by the subsequent native tap.
  assert.deepEqual(h.calls, [["push", routes[1]], ["push", routes[3]]]);
});

test("the compatibility click from a drag is suppressed while the next tap and keyboard activation work", t => {
  const h = browser(t);
  const flick = () => {
    h.pointer("pointerdown", 20);
    h.pointer("pointermove", 60);
    h.pointer("pointerup", 100);
  };
  flick();
  assert.deepEqual(h.calls, [["push", routes[2]]]);
  assert.equal(h.click(1), true);
  flick();
  assert.equal(h.click(0), false);
  flick();
  h.pointer("pointerdown", 20);
  h.pointer("pointerup", 20);
  assert.equal(h.click(1), false);
});
