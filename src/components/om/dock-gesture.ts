// The portal and Atlas have separate layouts. Keep a confirmed gesture on the document
// so replacing either dock doesn't drop the finger or restart the browser history entry.
type DockRouter = { push: (href: string) => void; replace: (href: string) => void };

const dockSelector = "nav.om-os-dock";
const linkSelector = "a[data-app]";
const openDelay = 120;
const currentUrl = () => location.pathname + location.search + location.hash;

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

  const origin = currentUrl();
  const root = document.documentElement;
  const listeners = new AbortController();
  const capture = { capture: true, signal: listeners.signal };
  let dragging = false;
  let visited = false;
  let requested = origin;
  let preview: HTMLAnchorElement | null = null;
  let timer: number | undefined;
  let x = start.clientX, y = start.clientY;

  function open(link: HTMLAnchorElement | null) {
    const href = link?.getAttribute("href");
    if (!href || href === requested) return;
    visited ||= currentUrl() !== origin;
    requested = href;
    // A slow route may still be pending when another icon is selected. Only
    // replace after the first transition has actually added a history entry.
    if (visited) router.replace(href);
    else router.push(href);
  }

  function highlight(link: HTMLAnchorElement | null) {
    if (link === preview) return;
    window.clearTimeout(timer);
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
    }
    highlight(targetAt(x, y));
  }

  document.addEventListener("pointermove", track, capture);
  document.addEventListener("pointerup", event => {
    if (event.pointerId !== start.pointerId) return;
    if (dragging) open(targetAt(event.clientX, event.clientY));
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
