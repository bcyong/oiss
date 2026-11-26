/**
 * The Store Operations Assistant: a router and the agents it hands each question to, with the
 * read-only tools each agent may call. Shared by the demo page, which runs the tools over the day's
 * OISS records, and the server function, which holds the model key and builds every model request
 * from these definitions, so the key can only be used for this assistant.
 */

export type AgentId = "availability" | "price_and_label" | "front_end" | "loss_prevention";

export type ToolName = "store_summary" | "shelf_gaps" | "find_item" | "store_tasks" | "shelf_tag_issues" | "front_end_status" | "zone_traffic" | "checkout_incidents" | "get_record";

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

export interface AgentSpec {
  id: AgentId;
  name: string;
  /** What the router reads to pick this agent. */
  handles: string;
  /** What this agent does, for its system prompt. */
  role: string;
  tools: ToolName[];
  /** Tools the page runs before the first model call, so every answer starts from the records. */
  start: { name: ToolName; args: Record<string, unknown> }[];
}

const limit = { type: "integer", minimum: 1, maximum: 25, description: "Most rows to return. Default 10." };

export const TOOLS: Record<ToolName, ToolSpec> = {
  store_summary: {
    name: "store_summary",
    description: "The store at the current time: facings out of stock, low, not readable and not yet observed; store tasks by kind split into open, marked done but not yet confirmed, confirmed, done with no confirmation needed, and cancelled; checkout incidents so far and how many the store has reviewed; and the front end's latest line, wait and open lanes out of the lanes the store has.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  shelf_gaps: {
    name: "shelf_gaps",
    description:
      "Facings whose latest shelf observation is out of stock or low stock, highest priority first: promoted items, then out of stock ahead of low stock, then the busiest zones, then the longest short. Each row has the item, location, since when, when it was last in stock, the record that reported it, and where replenishment stands (no task, task open, marked done but not confirmed, or cancelled). Counts by replenishment status cover every facing, not only the rows shown.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["out_of_stock", "low_stock", "both"], description: "Default out_of_stock." },
        department: { type: "string", description: "Only this department, such as dairy or produce." },
        limit,
      },
      additionalProperties: false,
    },
  },
  find_item: {
    name: "find_item",
    description: "Find facings by item name, GTIN or facing id, with the shelf status now, whether its shelf tag has a price problem, the latest report from each source that watches it (shelf-scanning robot, shelf cameras, shelf labels) and any store tasks on it.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Part of an item name, a GTIN or a facing id." }, limit }, required: ["query"], additionalProperties: false },
  },
  store_tasks: {
    name: "store_tasks",
    description: "Store tasks raised by the store's task management system so far, as they stand now, most recently changed first, with counts by state. Done means an associate marked it done; Verified means a later record confirmed the fix.",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"], description: "open: open or assigned. closed: done, verified or cancelled. Default open." },
        kind: { type: "string", enum: ["replenish", "go_back", "fix_shelf_tag", "review_exception", "open_lane"] },
        limit,
      },
      additionalProperties: false,
    },
  },
  shelf_tag_issues: {
    name: "shelf_tag_issues",
    description: "Shelf tags whose latest read shows a price other than the register price, with counts: still wrong on the shelf, fix marked done and waiting for the robot's next read, flagged again after a fix, and fixes confirmed today. Each tag has its status, who flagged it, the robot's read, the shelf label's report and its fix task.",
    parameters: { type: "object", properties: { limit }, additionalProperties: false },
  },
  front_end_status: {
    name: "front_end_status",
    description: "The front end now and over the last hours: line length, average wait and open lanes per 15-minute interval, newest first, for staffed lanes and self-checkout; how many lanes the store has; the rule for opening another staffed lane and whether it is met now; and the latest open-lane tasks.",
    parameters: { type: "object", properties: { hours: { type: "number", minimum: 0.25, maximum: 16, description: "How far back to look. Default 2." } }, additionalProperties: false },
  },
  zone_traffic: {
    name: "zone_traffic",
    description: "Shopper traffic, occupancy and dwell per sales-floor zone in the latest 15-minute interval, busiest first.",
    parameters: { type: "object", properties: { limit }, additionalProperties: false },
  },
  checkout_incidents: {
    name: "checkout_incidents",
    description: "Checkout exceptions the loss prevention vendor flagged so far, those not yet reviewed first: type, severity, lane, the store's review status from its review task, the vendor's own status, evidence ids and counts by review status. Evidence is restricted; only its id and retention are shown.",
    parameters: {
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "medium", "high"] }, limit },
      additionalProperties: false,
    },
  },
  get_record: {
    name: "get_record",
    description: "One OISS record by id, as it arrived, for details the other tools leave out. Restricted records (shopper paths, evidence) show only their envelope.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
};

export const AGENTS: Record<AgentId, AgentSpec> = {
  availability: {
    id: "availability",
    name: "Availability agent",
    handles: "Out-of-stocks, low stock, empty shelves, replenishment priorities, go-backs and misplaced items, phantom inventory, store tasks and whether shelf work got done.",
    role: "You prioritize replenishment by likely lost sales and follow store tasks until a later shelf observation shows the fix.",
    tools: ["store_summary", "shelf_gaps", "find_item", "store_tasks", "zone_traffic", "get_record"],
    start: [{ name: "store_summary", args: {} }, { name: "shelf_gaps", args: { status: "out_of_stock", limit: 10 } }],
  },
  price_and_label: {
    id: "price_and_label",
    name: "Price and label agent",
    handles: "Shelf tag prices, electronic shelf labels, sale signs left up, price mismatches and disagreements between the robot and the labels.",
    role: "You find shelf tags that don't match the register price and say where each fix stands, telling tags still wrong on the shelf apart from fixes that wait for the robot's next read.",
    tools: ["shelf_tag_issues", "find_item", "store_tasks", "get_record"],
    start: [{ name: "shelf_tag_issues", args: { limit: 10 } }],
  },
  front_end: {
    id: "front_end",
    name: "Front-end agent",
    handles: "Checkout lines, wait times, open lanes, self-checkout, staffing the front end, shopper traffic and busy zones.",
    role: "You watch lines and waits at the front end and say, by the store's open-lane rule, whether another staffed lane should open.",
    tools: ["front_end_status", "zone_traffic", "store_tasks", "store_summary", "get_record"],
    start: [{ name: "front_end_status", args: { hours: 1 } }],
  },
  loss_prevention: {
    id: "loss_prevention",
    name: "Loss prevention agent",
    handles: "Checkout exceptions, non-scans, ticket switching, sweethearting, shrink, theft, incidents and their evidence and review.",
    role: "You summarize checkout exceptions for a person to review. You never accuse a shopper or an associate, and nothing you say acts toward one.",
    tools: ["checkout_incidents", "store_tasks", "find_item", "get_record"],
    start: [{ name: "checkout_incidents", args: { limit: 10 } }],
  },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** The router's instructions: pick one agent, answer with its id alone. */
export function routerPrompt(): string {
  const lines = AGENT_IDS.map((id) => `- ${id}: ${AGENTS[id].handles}`);
  return [
    "You route a retail store manager's question to one agent of the Store Operations Assistant.",
    "Agents:",
    ...lines,
    'Answer with JSON only, like {"agent":"availability"}. Pick the closest agent even for a general question about the store; use availability when unsure.',
  ].join("\n");
}

/** One agent's instructions. The time is the demo's playback time, which is "now" for the store. */
export function agentPrompt(id: AgentId, store: string, now: string): string {
  const a = AGENTS[id];
  return [
    `You are the ${a.name} of the Store Operations Assistant for ${store}, a grocery store. ${a.role}`,
    `It is ${now} at the store. Everything you know comes from the store's OISS records up to now, through your tools. Call tools before you answer; never guess a number, item or time.`,
    "Use standard retail terms (facing, out of stock, replenishment, go-back, shelf tag, front end, shrink). Your reader is a store or retail operations manager.",
    "Answer in at most 120 words: lead with the answer, then a few short bullet points if they help. Cite every fact with the id of the record it came from in square brackets, like [so-20261117-000123]. Only cite ids your tools returned.",
    "You can only read records. If something should be done, say what and who would do it; don't claim you did it. Shopper paths and evidence are restricted: never describe a shopper, and never suggest acting toward one.",
    "Your tools work out every status, count and priority. Use them as given: never recount them, add counts of different statuses together or regroup them, lead with the answer line when a tool gives one, and never call something wrong, open or done when its status says otherwise.",
    "A tool's rows are only the first few; say something about all of them only from the tool's counts and answer line, never from the rows shown.",
    "Recommend a next step only when the records support it, and never one a status argues against, such as raising a task again when the last one was cancelled for a reason the records don't give.",
    "Say why something happened only when a record says why. Otherwise say the records don't say, and name who could find out, using a team your tools returned.",
    "Name people, teams and vendors only as your tools return them; never make up a name or a role.",
    "If your tools can't answer, say so plainly.",
  ].join("\n");
}

/** The OpenAI-style tool definitions for one agent. */
export function toolsFor(id: AgentId): { type: "function"; function: ToolSpec }[] {
  return AGENTS[id].tools.map((name) => ({ type: "function" as const, function: TOOLS[name] }));
}

/** Picks an agent from the router's reply, or by keyword when the reply can't be read. */
export function parseRoute(reply: string, question: string): AgentId {
  const m = /"agent"\s*:\s*"([a-z_]+)"/.exec(reply) ?? /\b(availability|price_and_label|front_end|loss_prevention)\b/.exec(reply);
  if (m && (AGENT_IDS as string[]).includes(m[1]!)) return m[1] as AgentId;
  const q = question.toLowerCase();
  if (/(price|tag|label|sign|\$)/.test(q)) return "price_and_label";
  if (/(line|queue|wait|lane|checkout|cashier|register|traffic|busy|rush)/.test(q) && !/(exception|scan|theft|shrink|incident|switch)/.test(q)) return "front_end";
  if (/(exception|non-scan|scan|theft|shrink|incident|switch|sweetheart|fraud|loss)/.test(q)) return "loss_prevention";
  return "availability";
}

/** Questions a visitor can tap. */
export const SAMPLE_QUESTIONS = [
  "What should the grocery team replenish first right now?",
  "Are any shelf tags showing the wrong price?",
  "Do we need another lane open at the front end?",
  "Which checkout exceptions need review?",
];

/** Limits the server function enforces on every request. */
export const LIMITS = {
  /** Messages after the system prompt, including tool results. */
  maxMessages: 40,
  /** Characters across all messages. */
  maxChars: 60_000,
  /** Characters in one visitor question. */
  maxQuestionChars: 500,
  /** Model calls one question may take: one to route, the rest for the agent's tool use. */
  maxModelCalls: 6,
  maxTokens: 900,
};
