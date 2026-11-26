import { clock, type IndexedDay } from "../day.ts";
import { AGENTS, LIMITS, parseRoute, TOOLS, type AgentId } from "./agents.ts";
import type { ChatMessage, SafetyCheck, StepReply, StepRequest, ToolCall } from "./proxy.ts";
import { idsIn, runTool, type Proposal, type ToolArgs } from "./tools.ts";

/**
 * One question to the Store Operations Assistant, run in the page: the router picks an agent, the page
 * runs the agent's starting tools, and the model then calls more tools or answers. The tools read the
 * day at the playback time the question was asked; the model sees only what they return.
 */

export type Step = (req: StepRequest) => Promise<StepReply>;

export interface ToolUse {
  name: string;
  args: ToolArgs;
}

export interface Answer {
  question: string;
  /** Playback time the question was asked at. */
  t: number;
  agent: AgentId;
  /** Whether the router chose the agent, or the page did by keyword because the router couldn't. */
  routedBy: "model" | "keywords";
  text: string;
  tools: ToolUse[];
  /** Record ids the answer cites that the tools returned, and any it cites that they didn't. */
  cited: string[];
  unverified: string[];
  /** The models that routed the question and wrote the answer. */
  models: { router?: string; agent?: string };
  /** What the content safety model found in the question and the answer. */
  safety: { question?: SafetyCheck; answer?: SafetyCheck };
  /** Tasks the agent proposed, each waiting for the store manager's approval on the page. */
  proposals: Proposal[];
  /** Why the store's rules turned down each task the agent tried to propose. */
  turnedDown: string[];
}

/** A model's name as NVIDIA's catalog gives it: nvidia/nemotron-3-ultra-550b-a55b is Nemotron 3 Ultra. */
export function modelName(id?: string): string | undefined {
  if (!id) return undefined;
  const known: Record<string, string> = {
    "nvidia/nemotron-3-ultra-550b-a55b": "Nemotron 3 Ultra",
    "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super",
    "nvidia/nemotron-3-nano-30b-a3b": "Nemotron 3 Nano",
    "nvidia/nemotron-3.5-lightning-30b-a3b": "Nemotron 3.5 Lightning",
    "nvidia/nemotron-3.5-content-safety": "Nemotron 3.5 Content Safety",
    "nvidia/llama-3.1-nemotron-safety-guard-8b-v3": "Nemotron Safety Guard 8B",
  };
  return known[id] ?? id.replace(/^[^/]+\//, "");
}

export class AssistantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Calls the server function. */
export const httpStep =
  (url = "/api/assistant"): Step =>
  async (req) => {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    } catch {
      throw new AssistantError("network", "Couldn't reach the assistant.");
    }
    const body = (await res.json().catch(() => null)) as (StepReply & { code?: string; error?: string }) | null;
    if (!res.ok || !body?.message) {
      if (res.status === 404) throw new AssistantError("not_deployed", "The assistant runs on the deployed site, not on the local dev server.");
      if (body?.code === "blocked") throw new AssistantError("blocked", body.error ?? "The safety check turned this question down.");
      throw new AssistantError(body?.code ?? "upstream", body?.error ?? `The assistant answered ${res.status}.`);
    }
    return body;
  };

const MAX_TOOL_CHARS = 9000;

/** The follow-up turn for an agent that recommended shelf work in words but proposed none. */
export const PROPOSE_NUDGE =
  "If your answer recommends shelf work that no open task covers, call propose_task for each, at most three, the most important first. If it recommends none, reply none.";
const MAX_CALLS_PER_TURN = 4;

/** A tool result as the model reads it, cut short when it is long. */
function asText(result: unknown): string {
  const s = JSON.stringify(result);
  return s.length <= MAX_TOOL_CHARS ? s : `${s.slice(0, MAX_TOOL_CHARS)}… (cut short; ask for fewer rows)`;
}

function parseArgs(raw: string): ToolArgs {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The model's answer without any reasoning it showed. */
export function clean(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*<\/think>/, "")
    .trim();
}

/**
 * Takes tool names out of square brackets, so "[checkout_incidents]" doesn't show as if it were a
 * citation. A bracket that also holds record ids keeps them.
 */
export function dropToolCitations(text: string): string {
  return text.replace(/ ?\[([^\]\n]+)\](?!\()/g, (whole, inner: string) => {
    const parts = inner.split(/\s*[,;]\s*/);
    // "[front_end_status]" and "[front_end_status answer]" both name a tool, not a record.
    const kept = parts.filter((p) => !Object.hasOwn(TOOLS, p.trim().split(/\s+/)[0]!));
    if (kept.length === parts.length) return whole;
    return kept.length ? `${whole.startsWith(" ") ? " " : ""}[${kept.join(", ")}]` : "";
  });
}

/** A line that heads a list of proposals, such as "**Proposed tasks:**" or "I've proposed:". */
const PROPOSAL_HEADING = /^\W*(?:I(?:'ve| have)? )?(?:proposed|proposals?)\b[^.!?\n]{0,40}:\W*$/i;
/** A sentence that tells of the agent's own proposals. */
const PROPOSAL_SENTENCE = /\b(?:I(?:'ve| have)? (?:also )?proposed|I(?:'m| am) proposing|(?:has|have) been proposed|proposed (?:a |the |two |three )?(?:tasks?|replenish\w*|go-backs?|shelf[- ]tag)|(?:awaits?|waits? for|pending) (?:the store manager's |your |store manager )?approval)\b/i;

/**
 * Takes the agent's own account of its proposals out of the answer. The page lists what was actually
 * proposed, with Approve buttons, and what the store's rules turned down, so the answer's words can't
 * claim a proposal that never reached a card.
 */
export function dropProposalTalk(text: string): string {
  const out: string[] = [];
  let inList = false;
  for (const line of text.split("\n")) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s/.test(line);
    if (PROPOSAL_HEADING.test(line.trim())) {
      inList = true;
      continue;
    }
    if (inList && (bullet || !line.trim())) {
      if (!line.trim()) inList = false;
      continue;
    }
    inList = false;
    if (!PROPOSAL_SENTENCE.test(line)) {
      out.push(line);
      continue;
    }
    if (bullet) continue;
    // Keep a paragraph's other sentences; drop only the ones about proposals.
    const kept = line.split(/(?<=[.!?])\s+(?=[A-Z*])/).filter((sentence) => !PROPOSAL_SENTENCE.test(sentence));
    if (kept.length) out.push(kept.join(" "));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Record ids cited in square brackets, such as [so-20261117-000123] or [so-…, task-…-v2]. */
export function citations(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[([^\]\n]{3,200})\]/g)) for (const part of m[1]!.split(/[,;\s]+/)) if (/^[a-z]{2,4}(-[a-z]{2,4})?-\d{8}-\d{6}(-v\d+)?$/.test(part)) out.add(part);
  return [...out];
}

export async function ask(day: IndexedDay, t: number, question: string, step: Step, onProgress?: (note: string) => void): Promise<Answer> {
  const q = question.trim().slice(0, LIMITS.maxQuestionChars);
  let calls = 0;
  let agent: AgentId;
  let routedBy: Answer["routedBy"] = "model";
  const models: Answer["models"] = {};
  const safety: Answer["safety"] = {};
  onProgress?.("Checking the question and choosing an agent");
  try {
    calls++;
    const r = await step({ step: "route", question: q });
    agent = parseRoute(r.message.content ?? "", q);
    models.router = r.model;
    safety.question = r.safety;
  } catch (err) {
    // A missing key or function, a busy or retired model, or a question the safety check turned down stops
    // the question; anything else falls back to keywords.
    if (err instanceof AssistantError && ["not_configured", "not_deployed", "rate_limited", "model_unavailable", "blocked"].includes(err.code)) throw err;
    agent = parseRoute("", q);
    routedBy = "keywords";
  }

  const seen = new Set<string>();
  const tools: ToolUse[] = [];
  const proposals: Proposal[] = [];
  const turnedDown: string[] = [];
  const run = (name: string, args: ToolArgs) => {
    const result = runTool(day, t, agent, name, args);
    idsIn(result, seen);
    const p = (result as { decision?: string; proposal?: Proposal }).proposal;
    if (name === "propose_task" && p && !proposals.some((x) => x.kind === p.kind && x.facing === p.facing) && proposals.length < 3) proposals.push(p);
    // A store rule's "no" is worth showing; a facing id the model got wrong or a kind it can't propose is not.
    const no = (result as { decision?: string; reason?: string }).decision === "rejected" ? (result as { reason?: string }).reason : undefined;
    if (name === "propose_task" && no && !/^(There is no facing|This agent can propose only)/.test(no) && !turnedDown.includes(no)) turnedDown.push(no);
    tools.push({ name, args });
    return asText(result);
  };

  // The page runs the agent's starting tools itself, so the first model call already has the records.
  const start = AGENTS[agent].start;
  const startCalls: ToolCall[] = start.map((s, i) => ({ id: `start-${i + 1}`, type: "function", function: { name: s.name, arguments: JSON.stringify(s.args) } }));
  const messages: ChatMessage[] = [{ role: "user", content: q }, { role: "assistant", content: null, tool_calls: startCalls }, ...startCalls.map((c, i) => ({ role: "tool" as const, tool_call_id: c.id, content: run(start[i]!.name, start[i]!.args) }))];

  const store = day.layout.store.name;
  const now = `${clock(t)} on ${day.files.date}`;
  onProgress?.(`Asking the ${AGENTS[agent].name.toLowerCase()}`);
  let text = "";
  while (calls < LIMITS.maxModelCalls) {
    calls++;
    const final = calls === LIMITS.maxModelCalls;
    const { message, model, safety: checked } = await step({ step: "agent", agent, store, now, messages, final });
    models.agent = model ?? models.agent;
    if (checked) safety.answer = checked;
    const wanted = final ? [] : (message.tool_calls ?? []).slice(0, MAX_CALLS_PER_TURN);
    if (!wanted.length) {
      text = dropToolCitations(clean(message.content ?? ""));
      break;
    }
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: wanted });
    for (const c of wanted) {
      onProgress?.(`Reading ${c.function.name.replaceAll("_", " ")}`);
      messages.push({ role: "tool", tool_call_id: c.id, content: run(c.function.name, parseArgs(c.function.arguments)) });
    }
  }
  // Models often write "I'd propose…" without calling the tool, so an agent that can propose but didn't
  // gets one more turn that may only propose. Its words are dropped; the answer stays as written.
  if (text && AGENTS[agent].tools.includes("propose_task") && !tools.some((u) => u.name === "propose_task") && calls < LIMITS.maxModelCalls) {
    calls++;
    onProgress?.("Checking for shelf work to propose");
    const nudge: ChatMessage[] = [...messages, { role: "assistant", content: text }, { role: "user", content: PROPOSE_NUDGE }];
    try {
      const { message } = await step({ step: "agent", agent, store, now, messages: nudge, final: false });
      for (const c of (message.tool_calls ?? []).filter((c) => c.function.name === "propose_task").slice(0, 3)) run(c.function.name, parseArgs(c.function.arguments));
    } catch {
      // The answer is already in hand; a failed follow-up only means no proposals.
    }
  }
  text = dropProposalTalk(text);
  if (!text) text = "I couldn't put an answer together from the records. Try asking a narrower question.";
  const cited = citations(text);
  return { question: q, t, agent, routedBy, text, tools, cited: cited.filter((id) => seen.has(id)), unverified: cited.filter((id) => !seen.has(id)), models, safety, proposals, turnedDown };
}
