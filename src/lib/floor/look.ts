/**
 * THE NEW DESIGN'S TWO LOOKS (owner 11-21: "make it a little brighter… clean Apple, Restoration Hardware, ultra luxury",
 * chose "B · Stone", then "have a toggle that can go from graphite and stone").
 *
 *   Stone     the light alternative. One Mission's own white, warm stone and ink: the website's palette.
 *   Graphite  the default OS canvas: near-black with graphite surfaces.
 *
 * Every colour in the shell is a token (components/om/om.css); a look is a set of tokens. The choice is the member's,
 * kept in this browser, and is put on <html> before the first paint (nav.SHELL_SCRIPT), so a page never shows the other
 * look first. With Graphite the classic portal's own dark mode is on too, for anything of it drawn inside the shell.
 *
 * Pure: no server or browser imports.
 */
export type Look = "stone" | "graphite";

export const LOOK_KEY = "om-look";
/** On <html> while Graphite is chosen. */
export const LOOK_CLASS = "om-look-graphite";
export const DEFAULT_LOOK: Look = "graphite";

export const LOOKS: { key: Look; label: string; theme: string }[] = [
  { key: "stone", label: "Stone", theme: "#f5f4f1" },
  { key: "graphite", label: "Graphite", theme: "#08090b" },
];

export function lookOf(v: unknown): Look {
  return v === "stone" || v === "graphite" ? v : DEFAULT_LOOK;
}

/** The browser's own bar colour for a look (theme-color). */
export function themeOf(look: Look): string {
  return (LOOKS.find((l) => l.key === look) ?? LOOKS[0]).theme;
}

type Root = { classList: { toggle(token: string, force?: boolean): boolean } };

/** Puts a look on the page: the shell's look, and the classic portal's dark mode with Graphite. */
export function applyLook(root: Root, look: Look): void {
  root.classList.toggle(LOOK_CLASS, look === "graphite");
  root.classList.toggle("om-dark", look === "graphite");
}
