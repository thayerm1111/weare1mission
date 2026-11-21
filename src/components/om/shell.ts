"use client";

import { createContext, useContext } from "react";

/**
 * "Am I inside the trading platform's new shell?" — true under AppShell, false everywhere else.
 *
 * The tools are shared with the classic portal, which every member still uses. A tool that has a
 * redesigned view asks this and renders it; outside the shell it renders exactly what it always has.
 * The answer changes what is DRAWN and nothing else: both views run on the same state and handlers.
 */
export const ShellContext = createContext(false);
export const useNextShell = (): boolean => useContext(ShellContext);
