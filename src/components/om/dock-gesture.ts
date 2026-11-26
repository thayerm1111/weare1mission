// The portal and Atlas have separate layouts. Keep a confirmed gesture on the document
// so replacing either dock doesn't drop the finger or restart the browser history entry.
type DockRouter = { push: (href: string) => void; replace: (href: string) => void; back: () => void };

const dockSelector = "nav.om-os-dock";
const linkSelector = "a[data-app]";
const openDelay = 120;
const currentUrl = () => location.pathname + location.search + location.hash;

// Separate App Router requests can resolve out of order on a slow connection. Keep
// one in flight and remember only the latest selection, including after finger-up.
let committed: (() => void) | undefined;
export function notifyDockNavigation() { committed?.(); }

function routeGesture(router: DockRouter) {
  const origin = currentUrl();
  const guards = new AbortController();
  const options = { capture: true, signal: guards.signal };
  let wanted = origin, pending: string | null = null, addedEntry = false, finished = false;
  let timeout: number | undefined;

  function dispose() {
    if (committed === onCommit) committed = undefined;
    guards.abort();
    window.clearTimeout(timeout);
  }
  function next() {
    if (pending || guards.signal.aborted) return;
    if (finished && addedEntry && wanted === origin) { dispose(); router.back(); return; }
    if (wanted === currentUrl()) { if (finished) dispose(); return; }
    pending = wanted;
    // A redirect or interrupted connection may leave the member outside the dock.
    timeout = window.setTimeout(dispose, 30_000);
    if (addedEntry) router.replace(wanted);
    else router.push(wanted);
  }
  function onCommit() {
    if (!pending || currentUrl() !== pending) return;
    window.clearTimeout(timeout);
    addedEntry = true;
    pending = null;
    next();
  }
  committed = onCommit;
  document.addEventListener("pointerdown", dispose, options);
  document.addEventListener("keydown", dispose, options);
  window.addEventListener("popstate", dispose, options);
  window.addEventListener("pagehide", dispose, options);
  return {
    select(href: string) { wanted = href; next(); },
    clearSelection() { wanted = pending ?? currentUrl(); },
    finish() { finished = true; next(); },
    cancel: dispose,
  };
}

function targetAt(x: number, y: number): HTMLAnchorElement | null {
  const hit = document.elementFromPoint(x, y);
  const dock = hit?.closest(dockSelector);
  if (!dock) return null;
  const direct = hit?.closest<HTMLAnchorElement>(linkSelector);
  if (direct) return direct;
  // Include the few pixels of padding or space between icons as part of the nearest slot.
  let nearest: HTMLAnchorElement | null = null, distance = Infinity;
  for (const link of Array.from(dock.querySelectorAll<HTMLAnchorElement>(linkSelector))) {
    const box = link.getBoundingClientRect();
    const offset = Math.abs(x - (box.left + box.width / 2));
    if (offset < distance) { nearest = link; distance = offset; }
  }
  return nearest;
}

function suppressDragClick() {
  const guard = new AbortController();
  const stop = () => { guard.abort(); window.clearTimeout(timer); };
  const timer = window.setTimeout(stop, 650);
  document.addEventListener("click", event => {
    if (event.detail && event.target instanceof Element && event.target.closest(dockSelector)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    stop();
  }, { capture: true, signal: guard.signal });
  document.addEventListener("pointerdown", stop, { capture: true, signal: guard.signal });
}

export function startDockGesture(start: PointerEvent, router: DockRouter) {
  if (!start.isPrimary || start.button !== 0 || (start.pointerType !== "touch" && start.pointerType !== "pen")) return;

  const root = document.documentElement;
  const listeners = new AbortController();
  const capture = { capture: true, signal: listeners.signal };
  let dragging = false;
  let navigation: ReturnType<typeof routeGesture> | undefined;
  let preview: HTMLAnchorElement | null = null;
  let timer: number | undefined;
  let x = start.clientX, y = start.clientY;

  function open(link: HTMLAnchorElement | null) {
    const href = link?.getAttribute("href");
    if (href) navigation?.select(href);
  }

  function highlight(link: HTMLAnchorElement | null) {
    if (link === preview) return;
    window.clearTimeout(timer);
    navigation?.clearSelection();
    preview?.removeAttribute("data-scrubbed");
    preview = link;
    if (!link) return;
    link.setAttribute("data-scrubbed", "");
    timer = window.setTimeout(() => open(targetAt(x, y)), openDelay);
  }

  function end() {
    listeners.abort();
    window.clearTimeout(timer);
    preview?.removeAttribute("data-scrubbed");
    navigation?.cancel();
    if (dragging) {
      if (root.hasPointerCapture(start.pointerId)) root.releasePointerCapture(start.pointerId);
      suppressDragClick();
    }
  }

  function track(event: PointerEvent) {
    if (event.pointerId !== start.pointerId) return;
    x = event.clientX;
    y = event.clientY;
    if (!dragging) {
      const horizontal = Math.abs(x - start.clientX), vertical = Math.abs(y - start.clientY);
      if (vertical >= 8 && vertical >= horizontal) { end(); return; }
      if (horizontal < 8 || horizontal <= vertical * 1.2) return;
      dragging = true;
      root.setPointerCapture(start.pointerId);
      navigation = routeGesture(router);
    }
    highlight(targetAt(x, y));
  }

  document.addEventListener("pointermove", track, capture);
  document.addEventListener("pointerup", event => {
    if (event.pointerId !== start.pointerId) return;
    if (dragging) {
      const target = targetAt(event.clientX, event.clientY);
      if (target) {
        open(target);
        navigation?.finish();
        navigation = undefined;
      }
    }
    end();
  }, capture);
  document.addEventListener("pointercancel", event => {
    if (event.pointerId === start.pointerId) end();
  }, capture);
  document.addEventListener("lostpointercapture", event => {
    if (event.pointerId === start.pointerId && event.target === root) end();
  }, capture);
  document.addEventListener("pointerdown", event => { if (event.pointerId !== start.pointerId) end(); }, capture);
  document.addEventListener("visibilitychange", () => { if (document.hidden) end(); }, capture);
  window.addEventListener("blur", end, capture);
  window.addEventListener("popstate", end, capture);
  window.addEventListener("pagehide", end, capture);
}
