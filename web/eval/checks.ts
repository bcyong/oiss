/**
 * Checks on one assistant answer against the tool results it was written from. They catch the ways an
 * answer misleads a manager: a citation the tools didn't return, a number or time that isn't in the
 * records, a cause the records don't give, or a team name nobody returned. They are deliberately plain
 * text checks, so a failure points at the exact words to look at.
 */

export interface Finding {
  check: "citation" | "number" | "cause" | "name";
  detail: string;
}

/** Numbers, times and dollar amounts as they appear in text: 6, 8:19, $8.89, 1.5. */
const NUMBER = /\$?\d+(?:[.:]\d+)*/g;
const RECORD_ID = /\[[^\]\n]{3,200}\]|\b[a-z]{2,4}(?:-[a-z]{2,4})?-\d{8}-\d{6}(?:-v\d+)?\b/g;

/** Every number token in the tool results, with and without a dollar sign. */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.replaceAll(",", "").matchAll(NUMBER)) {
    const n = m[0].replace(/\.$/, "");
    out.add(n);
    out.add(n.replace(/^\$/, ""));
    // "$8.90" and "$8.9" are the same amount.
    if (/^\$?\d+\.\d+$/.test(n)) out.add(String(Number(n.replace(/^\$/, ""))));
  }
  return out;
}

/** Numbers in the answer that no tool returned. A number of minutes is fine when the tools gave that many seconds. */
export function unsupportedNumbers(answer: string, toolText: string, question = ""): string[] {
  const known = numbersIn(`${toolText} ${question}`);
  const seconds = [...known].filter((n) => /^\d+$/.test(n)).map(Number);
  const text = answer
    .replace(RECORD_ID, " ")
    .replace(/^\s*\d+[.)]\s+/gm, " ")
    .replaceAll(",", "");
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const n = m[0].replace(/\.$/, "");
    const bare = n.replace(/^\$/, "");
    if (known.has(n) || known.has(bare) || known.has(String(Number(bare)))) continue;
    // "about 3 minutes" from avgWaitSeconds 180, or "1 minute" from 56 seconds.
    if (/^\d+(\.\d+)?$/.test(bare) && seconds.some((s) => Math.abs(s / 60 - Number(bare)) < 0.75)) continue;
    out.push(n);
  }
  return [...new Set(out)];
}

const CAUSE = /\b(because|due to|caused by|owing to|probably|likely|the reason)\b/gi;
/** Phrases that use a cause word without giving a cause. */
const NOT_A_CAUSE = /likely lost sales|most likely to lose sales/gi;

/** Words in the answer that give a cause, when the tool results give none. */
export function statedCauses(answer: string, toolText: string): string[] {
  const tools = toolText.toLowerCase();
  const out: string[] = [];
  for (const m of answer.replace(NOT_A_CAUSE, " ").matchAll(CAUSE)) if (!tools.includes(m[0].toLowerCase())) out.push(m[0].toLowerCase());
  return [...new Set(out)];
}

const GENERIC = new Set(["the", "a", "an", "your", "that", "this", "each", "which", "store", "store's", "same", "other", "responsible", "right"]);

/** Team names in the answer, such as "Price integrity team", that no tool returned. */
export function unknownTeams(answer: string, toolText: string): string[] {
  const tools = toolText.toLowerCase();
  const out: string[] = [];
  for (const m of answer.matchAll(/\b([\w'-]+) team\b/gi)) {
    const word = m[1]!.toLowerCase();
    if (GENERIC.has(word) || tools.includes(`${word} team`)) continue;
    out.push(m[0]);
  }
  return [...new Set(out)];
}

/** Every finding for one answer. */
export function checkAnswer(a: { text: string; unverified: string[] }, toolText: string, question = ""): Finding[] {
  return [
    ...a.unverified.map((id) => ({ check: "citation" as const, detail: `cites ${id}, which no tool returned` })),
    ...unsupportedNumbers(a.text, toolText, question).map((n) => ({ check: "number" as const, detail: `says ${n}, which isn't in the tool results` })),
    ...statedCauses(a.text, toolText).map((w) => ({ check: "cause" as const, detail: `gives a cause ("${w}") the records don't` })),
    ...unknownTeams(a.text, toolText).map((t) => ({ check: "name" as const, detail: `names "${t}", which no tool returned` })),
  ];
}
