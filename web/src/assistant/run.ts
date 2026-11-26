import { clock, type IndexedDay } from "../day.ts";
import { AGENTS, LIMITS, parseRoute, TOOLS, type AgentId } from "./agents.ts";
import type { ChatMessage, StepReply, StepRequest, ToolCall } from "./proxy.ts";
import { idsIn, runTool, type ToolArgs } from "./tools.ts";

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
      throw new AssistantError(body?.code ?? "upstream", body?.error ?? `The assistant answered ${res.status}.`);
    }
    return body;
  };

const MAX_TOOL_CHARS = 9000;
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
    const kept = parts.filter((p) => !Object.hasOwn(TOOLS, p.trim()));
    if (kept.length === parts.length) return whole;
    return kept.length ? `${whole.startsWith(" ") ? " " : ""}[${kept.join(", ")}]` : "";
  });
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
  onProgress?.("Choosing an agent");
  try {
    calls++;
    const r = await step({ step: "route", question: q });
    agent = parseRoute(r.message.content ?? "", q);
  } catch (err) {
    // Only a missing key or a missing function stops the question; anything else falls back to keywords.
    if (err instanceof AssistantError && (err.code === "not_configured" || err.code === "not_deployed" || err.code === "rate_limited" || err.code === "model_unavailable")) throw err;
    agent = parseRoute("", q);
    routedBy = "keywords";
  }

  const seen = new Set<string>();
  const tools: ToolUse[] = [];
  const run = (name: string, args: ToolArgs) => {
    const result = runTool(day, t, agent, name, args);
    idsIn(result, seen);
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
    const { message } = await step({ step: "agent", agent, store, now, messages, final });
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
  if (!text) text = "I couldn't put an answer together from the records. Try asking a narrower question.";
  const cited = citations(text);
  return { question: q, t, agent, routedBy, text, tools, cited: cited.filter((id) => seen.has(id)), unverified: cited.filter((id) => !seen.has(id)) };
}
