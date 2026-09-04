/**
 * HOMEPAGE PROOF NUMBERS — OWNER-APPROVED VALUES ONLY.
 *
 * ⚠️ Nothing is invented here. This file ships EMPTY of claims: the proof
 * section renders only the entries you add. Fill in numbers you can verify
 * (e.g. from the trading desk's own records) and they appear on the homepage
 * automatically. Leave the array empty and the section shows process facts
 * with no statistics.
 *
 * Example entry:  { value: "1,240", label: "Setups identified" }
 */
export interface HomeStat { value: string; label: string }

export const homeStats: HomeStat[] = [
  // { value: "", label: "" },
];

/** Shown under any statistics. Keep the disclosure intact. */
export const statsDisclosure =
  "Figures reflect platform activity, not typical member results. Trading involves substantial risk of loss; past performance does not guarantee future outcomes. Educational tools — not financial advice.";
