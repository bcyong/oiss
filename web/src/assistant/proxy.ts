import { AGENT_IDS, agentPrompt, LIMITS, routerPrompt, toolsFor, type AgentId } from "./agents.ts";

/**
 * The server side of the assistant: a thin proxy to the NVIDIA-hosted model that keeps the key on the
 * server. It builds every model request itself from the agent definitions, so a visitor can send only a
 * question and the assistant's own tool turns, never a prompt or a tool of their own. The page runs the
 * tools; the server never sees the store's records.
 *
 * Like NVIDIA's Multi-Agent Intelligent Warehouse blueprint, it picks a model for each step: a small, fast
 * Nemotron routes the question and the large one answers it. A content safety model screens the question
 * before routing and the answer before it goes back.
 */

export interface ProxyEnv {
  key?: string;
  /** The model that answers. */
  model?: string;
  /** The model that routes each question to an agent. */
  routerModel?: string;
  /** The content safety model. "off" turns the safety check off. */
  safetyModel?: string;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
/** Tried once when the chosen model is gone (NVIDIA answers 404 or 410 for a retired model). */
export const FALLBACK_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
/** Routing is a one-word choice, so the small, fast Nemotron makes it. */
export const ROUTER_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
/** Screens each question and answer. The 8B guard model is tried once if this one is gone. */
export const SAFETY_MODEL = "nvidia/nemotron-3.5-content-safety";
export const SAFETY_FALLBACK_MODEL = "nvidia/llama-3.1-nemotron-safety-guard-8b-v3";
/** The safety check gets at most this long; past it, the answer goes back marked as not checked. */
const SAFETY_TIMEOUT_MS = 8_000;
/** Netlify ends a synchronous function after 60 seconds; one model call gets at most 25. */
const UPSTREAM_TIMEOUT_MS = 25_000;

export type StepRequest =
  | { step: "route"; question: string }
  | { step: "agent"; agent: AgentId; store: string; now: string; messages: ChatMessage[]; final?: boolean };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type SafetyVerdict = "safe" | "unsafe" | "unchecked";

export interface SafetyCheck {
  /** What was checked: the visitor's question, or the assistant's answer to it. */
  checked: "question" | "answer";
  verdict: SafetyVerdict;
  model?: string;
  categories?: string[];
}

export interface StepReply {
  message: { content: string | null; tool_calls?: ToolCall[] };
  /** The model that wrote this step. */
  model?: string;
  safety?: SafetyCheck;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, code: string, error: string) => json(status, { code, error });

// Best effort: one function instance keeps its own counts and forgets them when it stops. The durable
// per-visitor limit and the daily spending cap are M5 server work.
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 60;
const hits = new Map<string, number[]>();
export function rateLimited(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

/** Text that goes into a system prompt: a store name or a time, never instructions. */
const plain = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max && /^[\p{L}\p{N} ,.:'#&()-]+$/u.test(v);

/** Checks a step request, or says what is wrong with it. */
export function validate(body: unknown): StepRequest | string {
  if (!body || typeof body !== "object") return "Send a JSON object.";
  const b = body as Record<string, unknown>;
  if (b.step === "route") {
    if (typeof b.question !== "string" || !b.question.trim() || b.question.length > LIMITS.maxQuestionChars) return `Ask a question of at most ${LIMITS.maxQuestionChars} characters.`;
    return { step: "route", question: b.question };
  }
  if (b.step !== "agent") return "Unknown step.";
  if (!(AGENT_IDS as unknown[]).includes(b.agent)) return "Unknown agent.";
  const agent = b.agent as AgentId;
  if (!plain(b.store, 80) || !plain(b.now, 40)) return "Give the store's name and the time as plain text.";
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > LIMITS.maxMessages) return `Send 1 to ${LIMITS.maxMessages} messages.`;
  const allowed = new Set(toolsFor(agent).map((t) => t.function.name));
  let chars = 0;
  const messages: ChatMessage[] = [];
  for (const m of b.messages as Record<string, unknown>[]) {
    if (!m || typeof m !== "object") return "Each message must be an object.";
    if (m.role === "user") {
      if (typeof m.content !== "string" || m.content.length > LIMITS.maxQuestionChars) return `A question can be at most ${LIMITS.maxQuestionChars} characters.`;
      chars += m.content.length;
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      if (m.content !== null && m.content !== undefined && typeof m.content !== "string") return "An assistant message's content must be text.";
      const calls: ToolCall[] = [];
      if (m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length > 6) return "Too many tool calls in one message.";
        for (const c of m.tool_calls as Record<string, unknown>[]) {
          const f = c?.function as Record<string, unknown> | undefined;
          if (typeof c?.id !== "string" || c.id.length > 64 || !f || typeof f.name !== "string" || !allowed.has(f.name as never) || typeof f.arguments !== "string") return "A tool call names a tool this agent doesn't have.";
          chars += f.arguments.length;
          calls.push({ id: c.id, type: "function", function: { name: f.name, arguments: f.arguments } });
        }
      }
      const content = (m.content as string | null | undefined) ?? null;
      chars += content?.length ?? 0;
      messages.push(calls.length ? { role: "assistant", content, tool_calls: calls } : { role: "assistant", content });
    } else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || typeof m.content !== "string") return "A tool result needs its call id and text.";
      chars += m.content.length;
      messages.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
    } else return "Messages may come only from the visitor, the assistant or its tools.";
  }
  if (chars > LIMITS.maxChars) return "The conversation is too long.";
  if (messages[0]!.role !== "user") return "Start with the visitor's question.";
  return { step: "agent", agent, store: b.store as string, now: b.now as string, messages, final: b.final === true };
}

/** The request to the model for one step. */
export function modelRequest(req: StepRequest, model: string): Record<string, unknown> {
  const common = { model, temperature: 0.2, top_p: 0.9, stream: false, chat_template_kwargs: { enable_thinking: false } };
  if (req.step === "route") {
    return { ...common, max_tokens: 40, messages: [{ role: "system", content: routerPrompt() }, { role: "user", content: req.question }] };
  }
  const base = { ...common, max_tokens: LIMITS.maxTokens, messages: [{ role: "system", content: agentPrompt(req.agent, req.store, req.now) }, ...req.messages] };
  return req.final ? base : { ...base, tools: toolsFor(req.agent), tool_choice: "auto" };
}

/** The content safety model's request: the question, and the answer when there is one. */
export function safetyRequest(model: string, question: string, answer?: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 60,
    temperature: 0.01,
    top_p: 0.95,
    stream: false,
    chat_template_kwargs: { request_categories: "/categories" },
    messages: [{ role: "user", content: question }, ...(answer !== undefined ? [{ role: "assistant", content: answer }] : [])],
  };
}

/**
 * Reads the safety model's verdict. Nemotron 3.5 Content Safety answers in lines ("User Safety: unsafe");
 * the 8B guard model answers in JSON with the same names. Anything else counts as not checked.
 */
export function parseSafety(text: string, checked: SafetyCheck["checked"]): Pick<SafetyCheck, "verdict" | "categories"> {
  const field = (name: string) => new RegExp(`"?${name}"?\\s*:\\s*"?([^"\\n,}]+(?:,[^"\\n}]+)*)`, "i").exec(text)?.[1]?.trim();
  const user = field("User Safety")?.toLowerCase();
  const response = field("Response Safety")?.toLowerCase();
  const verdictOf = (v?: string): SafetyVerdict | undefined => (v?.startsWith("unsafe") ? "unsafe" : v?.startsWith("safe") ? "safe" : undefined);
  const verdict = checked === "answer" ? verdictOf(response) : verdictOf(user);
  if (!verdict) return { verdict: "unchecked" };
  const categories = field("Safety Categories")
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return verdict === "unsafe" && categories?.length ? { verdict, categories } : { verdict };
}

export const BLOCKED_ANSWER = "I can't share that answer: the safety check turned it down. Ask about the store's stock, shelf tags, lines or checkout exceptions.";

/** Handles POST /api/assistant. */
export async function handleAssistant(request: Request, env: ProxyEnv): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  if (!env.key) return fail(503, "not_configured", "The assistant isn't set up on this site yet: it needs an NVIDIA API key in the site's environment variables.");
  // Only the demo page calls this. A browser on another site says so in its Origin header.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return fail(403, "forbidden", "This endpoint serves the demo page only.");
  const ip = request.headers.get("x-nf-client-connection-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip, (env.now ?? Date.now)())) return fail(429, "rate_limited", "The assistant is busy. Try again in a few minutes.");
  if (Number(request.headers.get("content-length") ?? 0) > LIMITS.maxChars * 2) return fail(413, "too_large", "The conversation is too long.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "bad_request", "Send JSON.");
  }
  const req = validate(body);
  if (typeof req === "string") return fail(400, "bad_request", req);

  const doFetch = env.fetch ?? fetch;
  const post = (body: Record<string, unknown>, timeout: number) =>
    doFetch(NVIDIA_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  const call = (model: string) => post(modelRequest(req, model), UPSTREAM_TIMEOUT_MS);
  const gone = (r: Response) => r.status === 404 || r.status === 410;

  // The safety check. It never stops the assistant working: if the safety model can't be reached, the step
  // goes on and says it wasn't checked.
  const safetyModel = env.safetyModel || SAFETY_MODEL;
  const screen = async (checked: SafetyCheck["checked"], question: string, answer?: string): Promise<SafetyCheck | undefined> => {
    if (safetyModel === "off") return undefined;
    const tryModel = async (model: string): Promise<SafetyCheck | "gone"> => {
      const r = await post(safetyRequest(model, question, answer), SAFETY_TIMEOUT_MS);
      // The status, and the start of NVIDIA's error, go to the function's own log, never to the page.
      if (!r.ok || r.status === 202) console.warn(`Safety model ${model} answered ${r.status}: ${(await r.clone().text().catch(() => "")).slice(0, 200)}`);
      if (gone(r)) return "gone";
      if (!r.ok) return { checked, verdict: "unchecked", model };
      const d = (await r.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
      const text = d?.choices?.[0]?.message?.content;
      return { checked, model, ...parseSafety(typeof text === "string" ? text : "", checked) };
    };
    try {
      const first = await tryModel(safetyModel);
      if (first !== "gone") return first;
      if (safetyModel === SAFETY_FALLBACK_MODEL) return { checked, verdict: "unchecked" };
      const second = await tryModel(SAFETY_FALLBACK_MODEL);
      return second === "gone" ? { checked, verdict: "unchecked" } : second;
    } catch {
      return { checked, verdict: "unchecked", model: safetyModel };
    }
  };

  // A small, fast model routes; the large one answers. Either falls back once if NVIDIA has retired it.
  const model = req.step === "route" ? env.routerModel || ROUTER_MODEL : env.model || DEFAULT_MODEL;
  const fallback = req.step === "route" ? env.model || DEFAULT_MODEL : FALLBACK_MODEL;
  let used = model;
  let res: Response;
  // The question is screened while the router works on it.
  const questionCheck = req.step === "route" ? screen("question", req.question) : Promise.resolve(undefined);
  try {
    res = await call(model);
    if (gone(res) && model !== fallback) {
      used = fallback;
      res = await call(fallback);
    }
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return fail(504, timeout ? "timeout" : "upstream", timeout ? "The model took too long to answer." : "Couldn't reach the model.");
  }
  if (!res.ok) {
    // Don't pass the provider's error text on: it can echo the request.
    if (gone(res)) return fail(502, "model_unavailable", "The model provider no longer serves this site's model.");
    const code = res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "not_configured" : "upstream";
    return fail(res.status === 429 ? 429 : 502, code, code === "not_configured" ? "The model provider turned the site's API key down." : `The model provider answered ${res.status}.`);
  }
  const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] } | null;
  const msg = data?.choices?.[0]?.message;
  if (!msg) return fail(502, "upstream", "The model sent no answer.");
  const asked = await questionCheck;
  if (asked?.verdict === "unsafe") return json(422, { code: "blocked", error: "The safety check turned this question down.", safety: asked });
  const allowed = new Set<string>(req.step === "agent" && !req.final ? toolsFor(req.agent).map((t) => t.function.name) : []);
  const calls = Array.isArray(msg.tool_calls)
    ? (msg.tool_calls as Record<string, unknown>[])
        .map((c, i) => {
          const f = (c?.function ?? {}) as Record<string, unknown>;
          const args = typeof f.arguments === "string" ? f.arguments : JSON.stringify(f.arguments ?? {});
          return { id: typeof c?.id === "string" && c.id ? c.id.slice(0, 64) : `call-${i}`, type: "function" as const, function: { name: String(f.name ?? ""), arguments: args } };
        })
        .filter((c) => allowed.has(c.function.name))
        .slice(0, 6)
    : [];
  let content = typeof msg.content === "string" ? msg.content : null;
  let safety = asked;
  // An answer, as opposed to a request for more tools, is screened with the question it answers.
  if (req.step === "agent" && !calls.length && content?.trim()) {
    const first = req.messages[0]!;
    safety = await screen("answer", first.role === "user" ? first.content : "", content);
    if (safety?.verdict === "unsafe") content = BLOCKED_ANSWER;
  }
  const reply: StepReply = { message: { content, ...(calls.length ? { tool_calls: calls } : {}) }, model: used, ...(safety ? { safety } : {}) };
  return json(200, reply);
}
