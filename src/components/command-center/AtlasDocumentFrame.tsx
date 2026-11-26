"use client";

import { useEffect, useLayoutEffect } from "react";

const useFrameEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The document stays mounted when the dock switches between Atlas and the portal. */
export function AtlasDocumentFrame({ os }: { os: boolean }) {
  useFrameEffect(() => {
    const classes = document.documentElement.classList;
    classes.add("om-fullscreen");
    classes.toggle("om-cc-next", os);
    return () => classes.remove("om-fullscreen", "om-cc-next");
  }, [os]);
  return null;
}
