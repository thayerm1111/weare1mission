/**
 * THE LOW-BALANCE POP-UP — when it opens by itself, and what it tells the member spends credits.
 * (The pop-up is components/portal/LowBalanceFlyer.tsx; the rule is here so it can be run without a page.)
 *
 * It opens on its own, once a browser session, for a member whose balance has dropped under the
 * threshold: "You're down to 2 credits … top up now". That is right for a member on the meter.
 *
 * It is wrong for a FLOW PASS holder (owner 10-07: "this person bought the flow pass, but it's saying
 * he needs more credits"). What the Pass is bought for — GENX, GEN FX, FLOW — never takes credits, so
 * a low balance stops them doing none of it; and the line it carried, "every … GENX call spends
 * credits", is not true of them. For a Pass holder it does not open by itself. It still opens when a
 * tool that DOES take credits turns them away (that tool asks for it), and then says which tools those are.
 */
export const LOW_BALANCE_THRESHOLD = 5; // "low" is fewer credits than this — less than the dearest single action costs

export function opensOnItsOwn(o: { total: number | null; pass: boolean; snoozed: boolean; forced: boolean }): boolean {
  if (o.forced) return true;                 // ?flyer=1 — the owner's preview
  if (o.pass) return false;
  return o.total != null && o.total < LOW_BALANCE_THRESHOLD && !o.snoozed;
}

/** The line under "You're down to N credits". */
export function whatSpendsCredits(pass: boolean): string {
  return pass
    ? "Your FLOW Pass covers GENX, GEN FX and FLOW — those never take credits. Plays, chart reads, MFX Ghost and the other tools do: top up to keep using them."
    : "Every play, chart read and GENX call spends credits. Top up now so you don't miss the next setup the desk calls.";
}
