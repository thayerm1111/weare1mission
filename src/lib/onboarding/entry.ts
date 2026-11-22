"use client";

import { useSyncExternalStore } from "react";

export type EntryPromptState = {
  /** Presentation only: no disclosure is checking/open. This never means trading consent was signed. */
  consentReady: boolean; welcomePending: boolean; canShowWelcome: boolean; canShowCredits: boolean;
};
const READY: EntryPromptState = Object.freeze({ consentReady: true, welcomePending: false, canShowWelcome: true, canShowCredits: true });

/** Independent leases survive StrictMode cleanup and asynchronous answers without clearing a newer prompt. */
export function createEntryPromptCoordinator() {
  const disclosure = new Set<symbol>(), welcome = new Set<symbol>(), listeners = new Set<() => void>();
  let snapshot = READY;
  const publish = () => {
    const consentReady = disclosure.size === 0, welcomePending = welcome.size > 0;
    if (snapshot.consentReady === consentReady && snapshot.welcomePending === welcomePending) return;
    snapshot = { consentReady, welcomePending, canShowWelcome: consentReady, canShowCredits: consentReady && !welcomePending };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reserve(kind: "disclosure" | "welcome") {
      const token = Symbol(kind), holders = kind === "disclosure" ? disclosure : welcome;
      holders.add(token); publish();
      return () => { if (holders.delete(token)) publish(); };
    },
  };
}
const coordinators = new Map<string, ReturnType<typeof createEntryPromptCoordinator>>();
const SERVER = { getSnapshot: () => READY, subscribe: () => () => {}, reserve: () => () => {} };
const coordinatorFor = (memberId: string) => {
  // Server rendering never retains a member ID or mutable presentation state between requests.
  if (typeof window === "undefined") return SERVER;
  let coordinator = coordinators.get(memberId);
  if (!coordinator) { coordinator = createEntryPromptCoordinator(); coordinators.set(memberId, coordinator); }
  return coordinator;
};
export function useEntryPrompts(memberId = "") {
  const coordinator = coordinatorFor(memberId);
  return useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, () => READY);
}
export const reserveWelcome = (memberId: string) => coordinatorFor(memberId).reserve("welcome");
export const reserveDisclosure = (memberId = "") => coordinatorFor(memberId).reserve("disclosure");
