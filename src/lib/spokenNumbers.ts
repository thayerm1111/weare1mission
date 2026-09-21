/**
 * NUMBERS THE WAY A PERSON SAYS THEM.
 *
 * Owner 09-21, after the first spoken welcome: "when it reads numbers, it does it literal. It doesn't speak
 * how someone would normally speak." The speech engine reads "$4,362.35" as "four thousand three hundred
 * sixty-two dollars and thirty-five cents". A trader says "forty-three sixty-two". A balance of $12,348 is
 * "about twelve thousand three hundred", not every digit.
 *
 * Everything here turns digits into the words a desk would use, before the text reaches the voice.
 * Screens keep their digits; only what is SPOKEN goes through this.
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0–99 → words ("sixty-two"). */
function under100(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}

/** Any whole number below a billion → words, the way it is said aloud ("twelve thousand three hundred"). */
export function intWords(n: number): string {
  n = Math.round(Math.abs(n));
  if (n < 100) return under100(n);
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    return `${ONES[h]} hundred${r ? ` ${under100(r)}` : ""}`;
  }
  if (n < 1_000_000) {
    const th = Math.floor(n / 1000), r = n % 1000;
    return `${intWords(th)} thousand${r ? ` ${intWords(r)}` : ""}`;
  }
  const m = Math.floor(n / 1_000_000), r = n % 1_000_000;
  return `${intWords(m)} million${r ? ` ${intWords(r)}` : ""}`;
}

/**
 * A gold price, desk style: 4362.35 → "forty-three sixty-two". 4305 → "forty-three oh-five".
 * 4300 → "forty-three hundred". Cents are dropped — nobody says them out loud on a gold quote.
 */
export function priceWords(p: number): string {
  const n = Math.round(p);
  if (n < 1000 || n > 9999) return intWords(n);
  const hi = Math.floor(n / 100), lo = n % 100;
  if (lo === 0) return `${under100(hi)} hundred`;
  if (lo < 10) return `${under100(hi)} oh-${ONES[lo]}`;
  return `${under100(hi)} ${under100(lo)}`;
}

/** A move in dollars: 18.4 → "eighteen dollars", 0.6 → "under a dollar", 2.5 → "two and a half dollars". */
export function moveWords(d: number): string {
  const a = Math.abs(d);
  if (a < 1) return "under a dollar";
  const whole = Math.floor(a), frac = a - whole;
  if (whole < 10 && frac >= 0.35 && frac < 0.75) return `${intWords(whole)} and a half dollars`;
  const r = Math.round(a);
  return `${intWords(r)} ${r === 1 ? "dollar" : "dollars"}`;
}

/**
 * An account balance, rounded to what a person would say: 12,348 → "about twelve thousand three hundred
 * dollars"; 50,000 → "fifty thousand dollars"; 842 → "eight hundred forty dollars".
 */
export function balanceWords(v: number): string {
  const a = Math.abs(v);
  let r: number;
  if (a < 1000) r = Math.round(a / 10) * 10;
  else if (a < 100_000) r = Math.round(a / 100) * 100;
  else r = Math.round(a / 1000) * 1000;
  const about = Math.abs(r - a) >= 1 ? "about " : "";
  return `${about}${intWords(r)} dollars`;
}

/**
 * Rewrites any digits left in a sentence into spoken form. Used on text the model or the narrator
 * produced, so it has to cope with whatever shape the number arrives in.
 *   $4,362.35 / 4362.35 / 4362   → "forty-three sixty-two"   (a 4-digit gold-range price)
 *   $18.40                       → "eighteen dollars"
 *   $12,348                      → "about twelve thousand three hundred dollars"
 *   52%                          → "fifty-two percent"
 *   1.8R                         → "one point eight R"
 */
export function speakNumbers(text: string): string {
  return speakWords(text)
    // money with a dollar sign
    .replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b/g, (_m, i: string, c: string | undefined) => {
      const v = Number(i.replace(/,/g, "") + (c ? `.${c}` : ""));
      if (v >= 1000 && v < 10000) return priceWords(v);  // "$4,362" is a gold price
      if (v >= 1000) return balanceWords(v);
      return moveWords(v);
    })
    // percentages ("+0.42%" — the sign is already said by "up"/"down" around it)
    .replace(/\+(?=\d[\d.]*\s?%)/g, "")
    .replace(/(-?\d+(?:\.\d+)?)\s?%/g, (_m, n: string) => `${Number(n) < 0 ? "minus " : ""}${decimalWords(Math.abs(Number(n)))} percent`)
    // R multiples
    .replace(/(-?\d+(?:\.\d+)?)R\b/g, (_m, n: string) => `${Number(n) < 0 ? "minus " : ""}${decimalWords(Math.abs(Number(n)))} R`)
    // bare gold-range prices (1000–9999 with optional cents, optional thousands comma)
    .replace(/\b(\d,\d{3}|\d{4})(?:\.\d{1,2})?\b/g, (m) => {
      const v = Number(m.replace(/,/g, ""));
      return v >= 1000 && v <= 9999 && !/^(19|20)\d{2}$/.test(m) ? priceWords(v) : m;  // leave years alone
    })
    // anything else with a decimal point
    .replace(/\b(\d+)\.(\d+)\b/g, (_m, a: string, b: string) => `${intWords(Number(a))} point ${b.split("").map((d) => ONES[Number(d)]).join(" ")}`)
    // remaining whole numbers
    .replace(/\b\d{1,6}\b/g, (m) => (/^(19|20)\d{2}$/.test(m) ? m : intWords(Number(m))));
}

function decimalWords(n: number): string {
  if (Number.isInteger(n)) return intWords(n);
  const [a, b] = n.toString().split(".");
  return `${intWords(Number(a))} point ${b.slice(0, 2).split("").map((d) => ONES[Number(d)]).join(" ")}`;
}

/**
 * For streamed text: numbers arrive split across chunks ("43" then "62.35"), so text is held back until
 * a word boundary that is not inside a number, then converted. `flush()` releases the tail at the end.
 */
export class SpokenStream {
  private held = "";
  push(chunk: string): string {
    this.held += chunk;
    // Release up to the last whitespace that is not immediately after a digit, comma, $ or point.
    let cut = -1;
    for (let i = this.held.length - 1; i >= 0; i--) {
      if (/\s/.test(this.held[i]) && !/[\d$.,]/.test(this.held[i - 1] ?? "")) { cut = i + 1; break; }
    }
    if (cut <= 0) return "";
    const out = this.held.slice(0, cut);
    this.held = this.held.slice(cut);
    return speakNumbers(out);
  }
  flush(): string {
    const out = this.held; this.held = "";
    return out ? speakNumbers(out) : "";
  }
}

/* ── words a person says in full ─────────────────────────────────────────────── */

const DAYS: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Tues: "Tuesday", Wed: "Wednesday", Thu: "Thursday",
  Thur: "Thursday", Thurs: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ORD: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh",
  8: "eighth", 9: "ninth", 10: "tenth", 11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth", 15: "fifteenth",
  16: "sixteenth", 17: "seventeenth", 18: "eighteenth", 19: "nineteenth", 20: "twentieth", 30: "thirtieth" };
function ordinal(n: number): string {
  if (ORD[n]) return ORD[n];
  const t = Math.floor(n / 10) * 10;
  return `${TENS[t / 10]}-${ORD[n % 10]}`;
}

/**
 * Abbreviations the screen uses and a voice must not (owner 09-21: it said "Sun" instead of "Sunday").
 * Day names, month/day dates, timeframe shorthand and desk jargon become the words a person says.
 */
export function speakWords(text: string): string {
  return text
    // "(Sun, 09/20)" → "Sunday the twentieth" style: drop the brackets, keep the words
    .replace(/\(\s*(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\.?,?\s*(\d{1,2})\/(\d{1,2})\s*\)/g,
      (_m, d: string, mo: string, da: string) => `from ${DAYS[d]}, ${MONTHS[Number(mo) - 1] ?? ""} ${ordinal(Number(da))}`)
    .replace(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g, (m, mo: string, da: string) =>
      Number(mo) >= 1 && Number(mo) <= 12 && Number(da) >= 1 && Number(da) <= 31 ? `${MONTHS[Number(mo) - 1]} ${ordinal(Number(da))}` : m)
    .replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b\.?(?=[\s,;:)\-—]|$)/g, (_m, d: string) => DAYS[d])
    .replace(/\b(\d{1,2})\s?h\b/gi, (_m, n: string) => `${intWords(Number(n))}-hour`)
    .replace(/\b(\d{1,2})\s?m\b(?![a-z])/g, (_m, n: string) => `${intWords(Number(n))}-minute`)
    .replace(/\b(\d{1,2})\s?D\b/g, (_m, n: string) => `${intWords(Number(n))}-day`)
    .replace(/\bPDH\b/g, "yesterday's high").replace(/\bPDL\b/g, "yesterday's low")
    .replace(/\bNY\b/g, "New York").replace(/\bHTF\b/g, "higher timeframe").replace(/\bLTF\b/g, "lower timeframe")
    .replace(/\bvs\.?(?=\s)/g, "versus").replace(/\bapprox\.?(?=\s)/g, "about")
    .replace(/\s·\s/g, ", ").replace(/\s[—–]\s/g, ", ");
}
