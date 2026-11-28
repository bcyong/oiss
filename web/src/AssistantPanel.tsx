import { useEffect, useRef, useState, type ReactNode } from "react";
import { clock, secondsOf, type IndexedDay } from "./day.ts";
import { AGENTS, SAMPLE_QUESTIONS } from "./assistant/agents.ts";
import { ask, AssistantError, httpStep, modelName, type Answer, type LoadPeers, type Step } from "./assistant/run.ts";
import { httpForecast, type Forecaster } from "./assistant/forecast.ts";
import { loadDistrict } from "./district.ts";
import type { Proposal } from "./assistant/tools.ts";
import type { Approval } from "./approve.ts";

/** What the store manager did with one proposed task. */
export type ProposalState = { state: "approving" } | { state: "dismissed" } | Approval;

export type ChatEntry = { id: number; question: string; t: number } & ({ state: "asking"; progress: string } | { state: "answered"; answer: Answer; decisions?: Record<string, ProposalState> } | { state: "failed"; code: string; error: string });

const proposalKey = (p: Proposal) => `${p.kind}:${p.facing}`;

/** One line of an answer, with **bold**, *italics* and [record id] citations. A cited id opens the record when it exists by the time asked. */
function inline(text: string, day: IndexedDay, t: number, onInspect: (id: string) => void, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])|\[([^\]\n]{3,200})\]/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    // Bold text can hold citations too.
    if (m[1] !== undefined) out.push(<b key={`${key}-${n++}`}>{inline(m[1], day, t, onInspect, `${key}-${n}`)}</b>);
    else if (m[2] !== undefined) out.push(<i key={`${key}-${n++}`}>{inline(m[2], day, t, onInspect, `${key}-${n}`)}</i>);
    else {
      const ids = m[3]!.split(/[,;\s]+/).filter(Boolean);
      const records = ids.map((id) => day.byId.get(id));
      if (records.every((r) => r && secondsOf(day, r.time) <= t)) {
        out.push(
          <span key={`${key}-${n++}`} className="cite">
            {ids.map((id) => (
              <button key={id} type="button" onClick={() => onInspect(id)} title={`Open ${id}`}>
                {id}
              </button>
            ))}
          </span>,
        );
      } else out.push(m[0]);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A small, safe rendering of the model's text: paragraphs and bullet lists, with no HTML passed through. */
function AnswerText({ text, day, t, onInspect }: { text: string; day: IndexedDay; t: number; onInspect: (id: string) => void }) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list}</ul>);
    list = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim().replace(/^#+\s*/, "");
    const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) list.push(<li key={i}>{inline(bullet[2]!, day, t, onInspect, `b${i}`)}</li>);
    else {
      flush();
      if (line) blocks.push(<p key={i}>{inline(line, day, t, onInspect, `p${i}`)}</p>);
    }
  });
  flush();
  return <div className="answer-text">{blocks}</div>;
}

const FAILED: Record<string, string> = {
  not_configured: "The assistant isn't switched on for this site yet. It needs an NVIDIA API key in the site's environment variables.",
  not_deployed: "The assistant runs on the deployed site, where its server function is. The local dev server doesn't have it.",
  rate_limited: "The assistant is busy right now. Try again in a few minutes.",
  model_unavailable: "NVIDIA no longer serves the model this site uses. Set NVIDIA_MODEL in the site's environment variables to a current one.",
  blocked: "The safety check turned this question down. Ask about the store's stock, shelf tags, lines or checkout exceptions.",
};

/** One proposed task, with the buttons that approve or dismiss it and what came of it. */
function ProposalCard({ p, decision, t, onApprove, onDismiss, onInspect, disabled }: { p: Proposal; decision?: ProposalState; t: number; onApprove: () => void; onDismiss: () => void; onInspect: (id: string) => void; disabled: boolean }) {
  return (
    <div className="proposal">
      <p className="proposal-title">
        <b>{p.title}</b> <span className="time">for {p.team}</span>
      </p>
      {p.reason && <p className="note">{p.reason}</p>}
      {!decision && (
        <div className="proposal-actions">
          <button type="button" onClick={onApprove} disabled={disabled}>
            Approve
          </button>
          <button type="button" className="link" onClick={onDismiss} disabled={disabled}>
            Dismiss
          </button>
        </div>
      )}
      {decision?.state === "approving" && <p className="note">Checking the records again and raising the task…</p>}
      {decision?.state === "dismissed" && <p className="note">Dismissed. Nothing was raised.</p>}
      {decision?.state === "approved" && (
        <p className="note ok">
          Approved at {clock(decision.at)}. The store's task system raised{" "}
          {decision.at <= t ? (
            <button type="button" className="link" onClick={() => onInspect(decision.taskId)}>
              {decision.taskId}
            </button>
          ) : (
            decision.taskId
          )}{" "}
          and routed it to {p.team}. It's on the task board.
        </p>
      )}
      {decision?.state === "rejected" && (
        <p className="note warn">
          Not raised at {clock(decision.at)}: {decision.reason}
          {decision.openTask && (
            <>
              {" "}
              <button type="button" className="link" onClick={() => onInspect(decision.openTask!)}>
                Open that task
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Which models answered and what the safety check found, in a few words. */
function modelsLine(a: Answer): string {
  const parts: string[] = [];
  const router = modelName(a.models.router);
  const agent = modelName(a.models.agent);
  if (router && agent && router !== agent) parts.push(`routed by ${router}, answered by ${agent}`);
  else if (agent) parts.push(`answered by ${agent}`);
  const forecast = modelName(a.models.forecast);
  if (forecast) parts.push(`stock forecast by ${forecast}`);
  const checks = [a.safety.question, a.safety.answer].filter((c) => c && c.verdict !== "unchecked");
  const safetyModel = modelName(checks[0]?.model);
  if (checks.length && safetyModel) parts.push(`${a.safety.answer?.verdict === "unsafe" ? "answer withheld" : "screened"} by ${safetyModel}`);
  else if (a.safety.question || a.safety.answer) parts.push("safety check didn't run");
  return parts.join(" · ");
}

export function AssistantPanel({ day, t, onInspect, entries, setEntries, onApprove, step = httpStep(), loadPeers, forecaster = httpForecast() }: { day: IndexedDay; t: number; onInspect: (id: string) => void; entries: ChatEntry[]; setEntries: (f: (e: ChatEntry[]) => ChatEntry[]) => void; onApprove?: (p: Proposal) => Promise<Approval>; step?: Step; loadPeers?: LoadPeers; forecaster?: Forecaster }) {
  const [draft, setDraft] = useState("");
  const date = day.files.date;
  const peers: LoadPeers = loadPeers ?? (() => loadDistrict(date));
  // Start simulating the district's other stores while the visitor reads or types, so a comparison doesn't wait.
  useEffect(() => {
    if (!loadPeers) loadDistrict(date).catch(() => undefined);
  }, [date, loadPeers]);
  // Bring each new question to the top of the panel, so its answer appears where the eye already is.
  const latest = useRef<HTMLLIElement>(null);
  useEffect(() => {
    latest.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [entries.length]);
  const busy = entries.some((e) => e.state === "asking" || (e.state === "answered" && Object.values(e.decisions ?? {}).some((d) => d.state === "approving")));

  const decide = (id: number, p: Proposal, d: ProposalState) => setEntries((es) => es.map((e) => (e.id === id && e.state === "answered" ? { ...e, decisions: { ...e.decisions, [proposalKey(p)]: d } } : e)));
  const approve = async (id: number, p: Proposal) => {
    if (!onApprove) return;
    decide(id, p, { state: "approving" });
    try {
      decide(id, p, await onApprove(p));
    } catch (err) {
      decide(id, p, { state: "rejected", reason: err instanceof Error ? err.message : String(err), at: Math.floor(t) });
    }
  };

  const submit = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = Date.now();
    setDraft("");
    setEntries((es) => [...es, { id, question: q, t, state: "asking", progress: "Starting" }]);
    const update = (e: ChatEntry) => setEntries((es) => es.map((x) => (x.id === id ? e : x)));
    try {
      const answer = await ask(day, t, q, step, (progress) => update({ id, question: q, t, state: "asking", progress }), peers, forecaster);
      update({ id, question: q, t, state: "answered", answer });
    } catch (err) {
      const code = err instanceof AssistantError ? err.code : "upstream";
      update({ id, question: q, t, state: "failed", code, error: FAILED[code] ?? (err instanceof Error ? err.message : String(err)) });
    }
  };

  return (
    <div className="assistant">
      <details className="about">
        <summary>How the assistant works</summary>
        <p>
          A small, fast NVIDIA Nemotron model hands each question to one agent, which reads the day's OISS records as they stood at the time shown and cites the records it used. A larger Nemotron writes the answer, and a content safety model screens the question and the answer.
        </p>
        <p>The store insights agent also compares this store with three other stores in its district, simulated on this page from the same floor plan.</p>
        <p>Agents can propose shelf tasks. The store's rules check each one, and nothing is raised until you approve it. The assistant never acts toward a shopper.</p>
        <p>Each question is answered on its own. Pause playback to ask about one moment.</p>
      </details>
      {!entries.length && (
        <div className="samples">
          {SAMPLE_QUESTIONS.map((q) => (
            <button key={q} type="button" onClick={() => submit(q)} disabled={busy}>
              {q}
            </button>
          ))}
        </div>
      )}
      <ol className="chat" aria-live="polite">
        {entries.map((e, i) => (
          <li key={e.id} ref={i === entries.length - 1 ? latest : undefined}>
            <p className="question">
              {e.question} <span className="time">at {clock(e.t)}</span>
            </p>
            {e.state === "asking" && <p className="note">{e.progress}…</p>}
            {e.state === "failed" && <p className="note warn">{e.error}</p>}
            {e.state === "answered" && (
              <div className="answer">
                <AnswerText text={e.answer.text} day={day} t={e.t} onInspect={onInspect} />
                {e.answer.proposals.length > 0 && (
                  <div className="proposals">
                    <p className="proposals-head">
                      {e.answer.proposals.length === 1 ? "1 task proposed" : `${e.answer.proposals.length} tasks proposed`} for your approval
                    </p>
                    {e.answer.proposals.map((p) => (
                      <ProposalCard key={proposalKey(p)} p={p} decision={e.decisions?.[proposalKey(p)]} t={t} onApprove={() => void approve(e.id, p)} onDismiss={() => decide(e.id, p, { state: "dismissed" })} onInspect={onInspect} disabled={busy || !onApprove || t >= day.close} />
                    ))}
                  </div>
                )}
                {(e.answer.turnedDown?.length ?? 0) > 0 && (
                  <div className="turned-down">
                    <p className="proposals-head">Not proposed, by the store's rules</p>
                    <ul>
                      {e.answer.turnedDown.map((why) => (
                        <li key={why}>{why}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="answer-meta">
                  {AGENTS[e.answer.agent].name}
                  {e.answer.routedBy === "keywords" ? " (picked by keyword)" : ""} · read {[...new Set(e.answer.tools.map((x) => x.name.replaceAll("_", " ")))].join(", ")}
                  {e.answer.unverified.length ? ` · ${e.answer.unverified.length} cited id${e.answer.unverified.length > 1 ? "s" : ""} not from its tools` : ""}
                  {modelsLine(e.answer) ? ` · ${modelsLine(e.answer)}` : ""}
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
      <form
        className="ask"
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit(draft);
        }}
      >
        <input value={draft} onChange={(ev) => setDraft(ev.target.value)} maxLength={500} placeholder={`Ask about the store at ${clock(t)}`} aria-label="Your question" disabled={busy} />
        <button type="submit" disabled={busy || !draft.trim()}>
          Ask
        </button>
        {entries.length > 0 && !busy && (
          <button type="button" className="link clear" onClick={() => setEntries(() => [])}>
            Clear
          </button>
        )}
      </form>
    </div>
  );
}
