import type { ReactElement } from "react";
import type { IndexedDay } from "./day.ts";
import { humanize, itemNameAt } from "./describe.ts";
import type { EvidenceData, OissRecord, ShelfObservationData } from "./oiss.ts";

/** A small deterministic number from a string, so a placeholder looks the same every time. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A drawn stand-in for a shelf image. The synthetic store has no camera frames, so the Evidence
 * record's media does not exist; this draws the bay it would show, with the observed facing
 * filled to the fill level that the backed ShelfObservation reported.
 */
function Placeholder({ seed, fill, status }: { seed: string; fill: number; status: string }) {
  const h = hash(seed);
  const levels = 4;
  const cols = 6;
  const target = { level: h % levels, col: (h >>> 4) % cols };
  const boxes: ReactElement[] = [];
  for (let l = 0; l < levels; l++) {
    for (let c = 0; c < cols; c++) {
      const x0 = 14 + c * 49;
      const y0 = 18 + l * 38;
      const isTarget = l === target.level && c === target.col;
      const units = isTarget ? Math.round(fill * 6) : 4 + ((h >> ((l * cols + c) % 24)) & 1) + ((h >> ((l + c) % 20)) & 1);
      for (let u = 0; u < units; u++) {
        boxes.push(<rect key={`${l}-${c}-${u}`} className={isTarget ? "ev-item target" : "ev-item"} x={x0 + 2 + u * 7} y={y0 + 6} width={6} height={22} rx={1} style={{ opacity: isTarget ? 1 : 0.55 + ((h >> (u + c)) & 3) * 0.1 }} />);
      }
      if (isTarget) boxes.push(<rect key="frame" className={`ev-frame ${status}`} x={x0} y={y0 + 2} width={46} height={30} rx={2} />);
    }
  }
  return (
    <svg className="ev-image" viewBox="0 0 320 180" role="img" aria-label="Placeholder shelf image">
      <rect className="ev-bg" width={320} height={180} />
      {Array.from({ length: levels + 1 }, (_, l) => (
        <rect key={l} className="ev-shelf" x={10} y={16 + l * 38} width={300} height={3} />
      ))}
      {boxes}
      <text className="ev-watermark" x={160} y={172} textAnchor="middle">
        PLACEHOLDER IMAGE
      </text>
    </svg>
  );
}

export function EvidencePreview({ day, evidence, observation, onInspect }: { day: IndexedDay; evidence: OissRecord<EvidenceData>; observation?: OissRecord<ShelfObservationData>; onInspect?: (id: string) => void }) {
  const d = evidence.data;
  const fill = observation?.data.fillLevel ?? (observation?.data.status === "out_of_stock" ? 0 : 0.15);
  return (
    <figure className="evidence">
      <Placeholder seed={evidence.id} fill={fill} status={observation?.data.status ?? "low_stock"} />
      <figcaption>
        <span>
          {itemNameAt(day, d.location.facing)}. {humanize(d.redaction)}, kept until {new Date(d.retainUntil).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, viewable by {d.accessRoles.map(humanize).join(" and ").toLowerCase()}.
        </span>
        <span className="muted">A drawn placeholder: the synthetic store has no camera frames yet.</span>
        {onInspect && (
          <button type="button" className="link" onClick={() => onInspect(evidence.id)}>
            Inspect Evidence {evidence.id}
          </button>
        )}
      </figcaption>
    </figure>
  );
}
