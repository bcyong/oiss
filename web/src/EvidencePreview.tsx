import type { ReactElement } from "react";
import { clockOf, type IndexedDay } from "./day.ts";
import { checkoutName, humanize, itemNameAt } from "./describe.ts";
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

/**
 * A drawn stand-in for a checkout clip: the lane from above, the belt with the order on it, a
 * blurred shopper and cashier, and a playback bar. There is no footage behind it.
 */
function ClipPlaceholder({ seed, seconds, self }: { seed: string; seconds: number; self: boolean }) {
  const h = hash(seed);
  const items: ReactElement[] = [];
  const count = 5 + (h % 4);
  for (let i = 0; i < count; i++) {
    const w = 12 + ((h >>> (i * 3)) & 7) * 2;
    items.push(<rect key={i} className={i === (h >>> 8) % count ? "ev-item target" : "ev-item"} x={70 + i * 26} y={self ? 64 : 58 + ((h >>> i) & 3) * 3} width={w} height={14 + ((h >>> (i + 5)) & 3) * 3} rx={2} />);
  }
  const length = `0:${String(Math.round(seconds)).padStart(2, "0")}`;
  return (
    <svg className="ev-image" viewBox="0 0 320 180" role="img" aria-label="Placeholder checkout clip">
      <defs>
        <filter id="ev-blur">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>
      <rect className="ev-bg" width={320} height={180} />
      <rect className="ev-belt" x={56} y={52} width={self ? 120 : 210} height={40} rx={3} />
      <rect className="ev-counter" x={self ? 186 : 274} y={44} width={self ? 60 : 36} height={56} rx={3} />
      {items}
      <ellipse className="ev-person" cx={150} cy={124} rx={26} ry={18} filter="url(#ev-blur)" />
      {!self && <ellipse className="ev-person" cx={292} cy={28} rx={18} ry={14} filter="url(#ev-blur)" />}
      <rect className="ev-bar" x={10} y={150} width={300} height={4} rx={2} />
      <rect className="ev-bar-done" x={10} y={150} width={225} height={4} rx={2} />
      <path className="ev-play" d="M14,160 L14,172 L24,166 Z" />
      <text className="ev-time" x={306} y={170} textAnchor="end">
        0:15 / {length}
      </text>
      <text className="ev-watermark" x={160} y={24} textAnchor="middle">
        PLACEHOLDER CLIP
      </text>
    </svg>
  );
}

export function EvidencePreview({ day, evidence, observation, onInspect }: { day: IndexedDay; evidence: OissRecord<EvidenceData>; observation?: OissRecord<ShelfObservationData>; onInspect?: (id: string) => void }) {
  const d = evidence.data;
  const kept = new Date(d.retainUntil).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const viewers = d.accessRoles.map(humanize).join(" and ").toLowerCase();
  if (d.mediaType.startsWith("video/")) {
    const seconds = (Date.parse(d.window.end) - Date.parse(d.window.start)) / 1000;
    return (
      <figure className="evidence">
        <ClipPlaceholder seed={evidence.id} seconds={seconds} self={d.location.fixture?.startsWith("sco-") ?? false} />
        <figcaption>
          <span>
            {checkoutName(d.location.fixture)}, {clockOf(day, d.window.start)} to {clockOf(day, d.window.end)}. {humanize(d.redaction)}, kept until {kept}, viewable by {viewers}.
          </span>
          <span className="muted">A drawn placeholder: the synthetic store has no camera footage.</span>
          {onInspect && (
            <button type="button" className="link" onClick={() => onInspect(evidence.id)}>
              Inspect Evidence {evidence.id}
            </button>
          )}
        </figcaption>
      </figure>
    );
  }
  const fill = observation?.data.fillLevel ?? (observation?.data.status === "out_of_stock" ? 0 : 0.15);
  return (
    <figure className="evidence">
      <Placeholder seed={evidence.id} fill={fill} status={observation?.data.status ?? "low_stock"} />
      <figcaption>
        <span>
          {itemNameAt(day, d.location.facing)}. {humanize(d.redaction)}, kept until {kept}, viewable by {viewers}.
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
