/**
 * Checks on one assistant answer against the tool results it was written from. They catch the ways an
 * answer misleads a manager: a citation the tools didn't return, a number or time that isn't in the
 * records, a cause the records don't give, a team name or a role nobody returned, or something in
 * citation brackets that isn't a record id. They are deliberately plain
 * text checks, so a failure points at the exact words to look at.
 */

export interface Finding {
  check: "citation" | "number" | "cause" | "name" | "role" | "action";
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
    // "3 min 19 s" spells out 199 seconds, which the tools may well have given.
    .replace(/\b(\d+) ?min(?:utes?)? (\d+) ?s(?:ec(?:onds?)?)?\b/gi, (whole, m: string, sec: string) => (known.has(String(Number(m) * 60 + Number(sec))) ? " " : whole))
    .replace(/^\s*\d+[.)]\s+/gm, " ")
    // A ZoneMetric covers 15 minutes by definition, so "the 15-minute interval" needs no tool to say 15.
    .replace(/\b15[- ]min(?:ute)?s?\b/gi, " ")
    .replaceAll(",", "");
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const n = m[0].replace(/\.$/, "");
    const bare = n.replace(/^\$/, "");
    if (known.has(n) || known.has(bare) || known.has(String(Number(bare)))) continue;
    // "about 3 minutes" from avgWaitSeconds 180, or "1 minute" from 56 seconds.
    if (/^\d+(\.\d+)?$/.test(bare) && seconds.some((s) => Math.abs(s / 60 - Number(bare)) < 0.75)) continue;
    // "180 s" from a rule the tools gave as 3 minutes.
    if (/^\d+$/.test(bare) && Number(bare) % 60 === 0 && known.has(String(Number(bare) / 60))) continue;
    // "the other 16" of 17 the tools counted, once one of them has been named.
    const around = text.slice(Math.max(0, m.index! - 12), m.index! + n.length + 8);
    if (/^\d+$/.test(bare) && known.has(String(Number(bare) + 1)) && new RegExp(`\\bother ${bare}\\b|\\b${bare} other\\b`, "i").test(around)) continue;
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
  for (const m of answer.replace(NOT_A_CAUSE, " ").matchAll(CAUSE)) {
    if (tools.includes(m[0].toLowerCase())) continue;
    // "cancelled due to no backroom stock" gives the cause a record gave, which is fine.
    const after = answer.slice(m.index! + m[0].length).toLowerCase().match(/^\s+([a-z'-]+(?: [a-z'-]+){0,2})/);
    if (after && after[1]!.split(" ").length >= 2 && tools.includes(after[1]!)) continue;
    out.push(m[0].toLowerCase());
  }
  return [...new Set(out)];
}

const GENERIC = new Set(["the", "a", "an", "your", "that", "this", "each", "which", "store", "store's", "same", "other", "responsible", "right", "assigned"]);

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

/** Words for a person, role or system an answer might add that the records never named. */
const ROLE = /\b(managers?|supervisors?|directors?|coordinators?|portals?|vendors?|dashboards?|hotlines?)\b|\b(?:the|a|your|shift|team|department|front[- ]end|store|aisle|night|pricing|stocking|LP|AP) (leads?)\b/gi;

/** The text of the tool results without their JSON keys, so a key such as vendorStatus doesn't count as naming a vendor. */
const valuesOf = (toolText: string) => toolText.replace(/"[A-Za-z_]+"\s*:/g, " ").replaceAll("_", " ").toLowerCase();

/** Role words in the answer, such as "front-end lead" or "the vendor's portal", that neither the tool results nor the question used. */
export function unknownRoles(answer: string, toolText: string, question = ""): string[] {
  const known = `${valuesOf(toolText)} ${question.toLowerCase()}`;
  const out: string[] = [];
  // The store manager is who approves a proposed task on the page, so the agents are told of one.
  for (const m of answer.replace(/\bstore[- ]manager(?:'s)?\b/gi, " ").matchAll(ROLE)) {
    const word = (m[1] ?? m[2]!).toLowerCase();
    const stem = word.replace(/s$/, "");
    if (new RegExp(`\\b${stem}s?\\b`).test(known)) continue;
    out.push(word);
  }
  return [...new Set(out)];
}

const CITED_ID = /^[a-z]{2,4}(?:-[a-z]{2,4})?-\d{8}-\d{6}(?:-v\d+)?$/;

/** Things in citation brackets that aren't record ids, such as [checkout_incidents]. Markdown links are left alone. */
export function nonRecordCitations(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\[([^\]\n]+)\](?!\()/g)) for (const part of m[1]!.split(/[,;]/).map((p) => p.trim())) if (part && !CITED_ID.test(part)) out.push(`[${part}]`);
  return [...new Set(out)];
}

/** Words that say the assistant raised or assigned a task itself, when it can only propose one. */
const DID_IT = /\bI(?:'ve| have)? (?:created|raised|opened|assigned|added|submitted|scheduled|dispatched)\b|\btasks? (?:has|have) been (?:created|raised|opened|assigned|added)\b/gi;

/** Phrases in the answer that claim a task was raised or assigned, which only the store manager's approval does. */
export function claimedActions(answer: string): string[] {
  return [...new Set([...answer.matchAll(DID_IT)].map((m) => m[0]))];
}

const PROPOSED_IT = /\b(?:I(?:'ve| have)? proposed|proposed (?:for|tasks?|replenish\w*|go-backs?))\b/i;

/** Words saying the assistant proposed a task, when the answer came with no proposal. */
export function claimedProposal(answer: string, proposals: number): string | undefined {
  // "Not proposed: …" is the page saying the store's rules turned the proposal down.
  return proposals || /\bNot proposed:/.test(answer) ? undefined : answer.match(PROPOSED_IT)?.[0];
}

/** Every finding for one answer. */
export function checkAnswer(a: { text: string; unverified: string[]; proposals?: unknown[] }, toolText: string, question = ""): Finding[] {
  const proposed = a.proposals ? claimedProposal(a.text, a.proposals.length) : undefined;
  return [
    ...a.unverified.map((id) => ({ check: "citation" as const, detail: `cites ${id}, which no tool returned` })),
    ...unsupportedNumbers(a.text, toolText, question).map((n) => ({ check: "number" as const, detail: `says ${n}, which isn't in the tool results` })),
    ...statedCauses(a.text, toolText).map((w) => ({ check: "cause" as const, detail: `gives a cause ("${w}") the records don't` })),
    ...unknownTeams(a.text, toolText).map((t) => ({ check: "name" as const, detail: `names "${t}", which no tool returned` })),
    ...unknownRoles(a.text, toolText, question).map((w) => ({ check: "role" as const, detail: `mentions a ${w.replace(/s$/, "")}, which no tool returned` })),
    ...claimedActions(a.text).map((w) => ({ check: "action" as const, detail: `says "${w}", but the assistant only proposes tasks` })),
    ...(proposed ? [{ check: "action" as const, detail: `says "${proposed}", but no task was proposed` }] : []),
    ...nonRecordCitations(a.text).map((c) => ({ check: "citation" as const, detail: `cites ${c}, which isn't a record id` })),
  ];
}
