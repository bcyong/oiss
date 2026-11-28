import { FEATURES, LIMITS, type ContextRow, type ForecastInput, type ForecastReply, type PredictRow } from "./forecast.ts";
import { rateLimited } from "./proxy.ts";

/**
 * The server side of the stock forecast: a thin proxy to NVIDIA Kumo Relational, hosted by NVIDIA, that
 * keeps the API key on the server. The page sends only rows of facing features; this function checks
 * every value and builds the Kumo request itself, with its schema and task fixed here, so the key can
 * be used for this one forecast and nothing else.
 */

export interface ForecastEnv {
  key?: string;
  /** "off" turns the forecast off. */
  forecast?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export const KUMO_URL = "https://ai.api.nvidia.com/v1/structured-data/nvidia/kumo-relational/predictions";
export const KUMO_MODEL = "kumo-relational";
/** As NVIDIA's catalog names it, for the page to show. */
export const KUMO_MODEL_ID = "nvidia/kumo-relational";
const UPSTREAM_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 1_500_000;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CATEGORY = /^[a-z0-9_-]{1,40}$/;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, code: string, error: string) => json(status, { code, error });

function checkFeatures(values: unknown[]): string | undefined {
  if (values.length !== FEATURES.length) return `Each row needs ${FEATURES.length} feature values.`;
  for (const [i, f] of FEATURES.entries()) {
    const v = values[i];
    if (f.kind === "num") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < f.min || v > f.max) return `${f.name} must be a number from ${f.min} to ${f.max}.`;
    } else if (typeof v !== "string" || !CATEGORY.test(v) || ("values" in f && !(f.values as readonly string[]).includes(v))) return `${f.name} isn't a value the forecast takes.`;
  }
  return undefined;
}

const facingId = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100_000;

/** Checks a forecast request, or says what is wrong with it. */
export function validateForecast(body: unknown): ForecastInput | string {
  if (!body || typeof body !== "object") return "Send a JSON object.";
  const b = body as Record<string, unknown>;
  if (typeof b.anchor !== "string" || !ISO.test(b.anchor)) return "Give the anchor time in UTC, like 2026-11-17T21:00:00Z.";
  if (!Array.isArray(b.context) || b.context.length < LIMITS.minLabeled || b.context.length > LIMITS.maxContext) return `Send ${LIMITS.minLabeled} to ${LIMITS.maxContext} labeled rows.`;
  if (!Array.isArray(b.predict) || b.predict.length < 1 || b.predict.length > LIMITS.maxPredict) return `Send 1 to ${LIMITS.maxPredict} rows to score.`;
  let ranOut = 0;
  for (const r of b.context as unknown[]) {
    if (!Array.isArray(r) || typeof r[0] !== "string" || !ISO.test(r[0]) || r[0] > b.anchor || !facingId(r[1]) || typeof r[2] !== "boolean") return "Each labeled row starts with its time, a facing number and true or false.";
    if (r[2]) ranOut++;
    const bad = checkFeatures(r.slice(3));
    if (bad) return bad;
  }
  if (ranOut === 0 || ranOut === b.context.length) return "The labeled rows need both outcomes.";
  for (const r of b.predict as unknown[]) {
    if (!Array.isArray(r) || !facingId(r[0])) return "Each row to score starts with a facing number.";
    const bad = checkFeatures(r.slice(1));
    if (bad) return bad;
  }
  return { anchor: b.anchor, context: b.context as ContextRow[], predict: b.predict as PredictRow[] };
}

const column = (f: (typeof FEATURES)[number]) => (f.kind === "num" ? { dtype: "float64", stype: "numerical" } : { dtype: "string", stype: "categorical" });

/**
 * The request to Kumo Relational: a binary classification over instances (a facing at a moment),
 * each joined to that facing's state then, the layout of NVIDIA's own example.
 */
export function kumoRequest(input: ForecastInput): Record<string, unknown> {
  const featureNames = FEATURES.map((f) => f.name);
  const facingColumns = ["instance_id", "facing_id", ...featureNames];
  const n = input.context.length;
  const facingRows = (rows: { id: number; facing: number; values: unknown[] }[]) => rows.map((r) => [r.id, r.facing, ...r.values]);
  const context = input.context.map((r, i) => ({ id: i, anchor: r[0], facing: r[1], label: r[2], values: r.slice(3) }));
  const predict = input.predict.map((r, i) => ({ id: n + i, facing: r[0], values: r.slice(1) }));
  return {
    model: KUMO_MODEL,
    task: {
      kind: "binary_classification",
      target: { column_name: "label", dtype: "bool", classes: ["false", "true"], positive_class: "true" },
      entity_table_names: ["facings"],
      anchor_time_column: "anchor_time",
    },
    schema: {
      instance_table: {
        columns: {
          instance_id: { dtype: "int64", stype: "ID", nullable: false },
          anchor_time: { dtype: "timestamp[us]", stype: "timestamp", nullable: false },
          facing_id: { dtype: "int64", stype: "ID", nullable: false },
          label: { dtype: "bool", stype: "categorical" },
        },
        primary_key: "instance_id",
      },
      related_tables: {
        facings: {
          columns: {
            instance_id: { dtype: "int64", stype: "ID", nullable: false },
            facing_id: { dtype: "int64", stype: "ID", nullable: false },
            ...Object.fromEntries(FEATURES.map((f) => [f.name, column(f)])),
          },
          primary_key: ["instance_id", "facing_id"],
        },
      },
      relationships: [{ source_columns: ["instance_id", "facing_id"], target_table: "facings", target_columns: ["instance_id", "facing_id"] }],
    },
    context: {
      instance_table: { format: "arrays", columns: ["instance_id", "anchor_time", "facing_id", "label"], rows: context.map((r) => [r.id, r.anchor, r.facing, r.label]) },
      related_tables: { facings: { format: "arrays", columns: facingColumns, rows: facingRows(context) } },
    },
    predict: {
      instance_table: { format: "arrays", columns: ["instance_id", "anchor_time", "facing_id"], rows: predict.map((r) => [r.id, input.anchor, r.facing]) },
      related_tables: { facings: { format: "arrays", columns: facingColumns, rows: facingRows(predict) } },
    },
    output: { fields: ["prediction", "probabilities"] },
  };
}

/** The chance of "true" for each row to score, in order, from Kumo's reply. */
export function parseKumo(data: unknown, count: number, firstId: number): (number | null)[] {
  const out: (number | null)[] = new Array(count).fill(null);
  const preds = (data as { predictions?: unknown })?.predictions;
  if (!Array.isArray(preds)) return out;
  preds.forEach((p: Record<string, unknown>, k) => {
    // Kumo numbers its replies by row_index within the rows to score; its id is the instance id.
    const byIndex = typeof p?.row_index === "number" ? p.row_index : undefined;
    const byId = typeof p?.id === "string" || typeof p?.id === "number" ? Number(p.id) - firstId : undefined;
    const i = byIndex !== undefined && byIndex >= 0 && byIndex < count ? byIndex : byId !== undefined && byId >= 0 && byId < count ? byId : k;
    const probs = p?.probabilities as Record<string, unknown> | undefined;
    let v = probs?.true ?? probs?.["1"];
    if (typeof v !== "number" && typeof p?.prediction !== "undefined") v = String(p.prediction) === "true" ? 1 : 0;
    if (typeof v === "number" && Number.isFinite(v) && i < count) out[i] = Math.max(0, Math.min(1, v));
  });
  return out;
}

/** Handles POST /api/forecast. */
export async function handleForecast(request: Request, env: ForecastEnv): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  if (env.forecast === "off") return fail(503, "not_configured", "The stock forecast is turned off on this site.");
  if (!env.key) return fail(503, "not_configured", "The stock forecast isn't set up on this site yet: it needs an NVIDIA API key in the site's environment variables.");
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return fail(403, "forbidden", "This endpoint serves the demo page only.");
  const ip = request.headers.get("x-nf-client-connection-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(`forecast:${ip}`, (env.now ?? Date.now)())) return fail(429, "rate_limited", "The forecast is busy. Try again in a few minutes.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return fail(413, "too_large", "The forecast request is too large.");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "bad_request", "Send JSON.");
  }
  const input = validateForecast(body);
  if (typeof input === "string") return fail(400, "bad_request", input);

  let res: Response;
  try {
    res = await (env.fetch ?? fetch)(KUMO_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(kumoRequest(input)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return fail(504, timeout ? "timeout" : "upstream", timeout ? "The forecast model took too long to answer." : "Couldn't reach the forecast model.");
  }
  if (!res.ok) {
    // The status and the start of NVIDIA's error go to the function's own log, never to the page.
    console.warn(`Kumo Relational answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const code = res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "not_configured" : "upstream";
    return fail(res.status === 429 ? 429 : 502, code, code === "rate_limited" ? "The forecast model is busy. Try again in a few minutes." : code === "not_configured" ? "The forecast model turned the site's API key down." : `The forecast model answered ${res.status}.`);
  }
  const data = await res.json().catch(() => null);
  const probabilities = parseKumo(data, input.predict.length, input.context.length);
  if (probabilities.every((p) => p === null)) return fail(502, "upstream", "The forecast model sent no predictions.");
  const reply: ForecastReply = { model: KUMO_MODEL_ID, probabilities };
  return json(200, reply);
}
