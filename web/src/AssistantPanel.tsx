import { useState, type ReactNode } from "react";
import { clock, secondsOf, type IndexedDay } from "./day.ts";
import { AGENTS, SAMPLE_QUESTIONS } from "./assistant/agents.ts";
import { ask, AssistantError, httpStep, type Answer, type Step } from "./assistant/run.ts";

export type ChatEntry = { id: number; question: string; t: number } & ({ state: "asking"; progress: string } | { state: "answered"; answer: Answer } | { state: "failed"; code: string; error: string });

/** One line of an answer, with **bold** and [record id] citations. A cited id opens the record when it exists by the time asked. */
function inline(text: string, day: IndexedDay, t: number, onInspect: (id: string) => void, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]\n]{3,200})\]/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<b key={`${key}-${n++}`}>{m[1]}</b>);
    else {
      const ids = m[2]!.split(/[,;\s]+/).filter(Boolean);
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
};

export function AssistantPanel({ day, t, onInspect, entries, setEntries, step = httpStep() }: { day: IndexedDay; t: number; onInspect: (id: string) => void; entries: ChatEntry[]; setEntries: (f: (e: ChatEntry[]) => ChatEntry[]) => void; step?: Step }) {
  const [draft, setDraft] = useState("");
  const busy = entries.some((e) => e.state === "asking");

  const submit = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const id = Date.now();
    setDraft("");
    setEntries((es) => [...es, { id, question: q, t, state: "asking", progress: "Starting" }]);
    const update = (e: ChatEntry) => setEntries((es) => es.map((x) => (x.id === id ? e : x)));
    try {
      const answer = await ask(day, t, q, step, (progress) => update({ id, question: q, t, state: "asking", progress }));
      update({ id, question: q, t, state: "answered", answer });
    } catch (err) {
      const code = err instanceof AssistantError ? err.code : "upstream";
      update({ id, question: q, t, state: "failed", code, error: FAILED[code] ?? (err instanceof Error ? err.message : String(err)) });
    }
  };

  return (
    <div className="assistant">
      <p className="note top">
        Ask the Store Operations Assistant about the store at {clock(t)}. A router hands each question to one agent, which reads the day's OISS records as they stood at that time and cites the records it used. It can only read records and never acts toward a shopper. An NVIDIA-hosted model writes the answers.
      </p>
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
        {entries.map((e) => (
          <li key={e.id}>
            <p className="question">
              {e.question} <span className="time">at {clock(e.t)}</span>
            </p>
            {e.state === "asking" && <p className="note">{e.progress}…</p>}
            {e.state === "failed" && <p className="note warn">{e.error}</p>}
            {e.state === "answered" && (
              <div className="answer">
                <AnswerText text={e.answer.text} day={day} t={e.t} onInspect={onInspect} />
                <p className="answer-meta">
                  {AGENTS[e.answer.agent].name}
                  {e.answer.routedBy === "keywords" ? " (picked by keyword)" : ""} · read {[...new Set(e.answer.tools.map((x) => x.name.replaceAll("_", " ")))].join(", ")}
                  {e.answer.unverified.length ? ` · ${e.answer.unverified.length} cited id${e.answer.unverified.length > 1 ? "s" : ""} not from its tools` : ""}
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
      {entries.length > 0 && !busy && (
        <button type="button" className="link" onClick={() => setEntries(() => [])}>
          Clear the conversation
        </button>
      )}
      <form
        className="ask"
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit(draft);
        }}
      >
        <input value={draft} onChange={(ev) => setDraft(ev.target.value)} maxLength={500} placeholder="Ask about stock, shelf tags, lines or checkout exceptions" aria-label="Your question" disabled={busy} />
        <button type="submit" disabled={busy || !draft.trim()}>
          Ask
        </button>
      </form>
      <p className="note">Each question is answered on its own, from the records up to the time shown. Pause playback to ask about one moment.</p>
    </div>
  );
}
