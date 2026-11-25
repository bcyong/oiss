import { memo, useRef } from "react";
import { clock, type IndexedDay } from "./day.ts";

const W = 1000;
const H = 44;

/** The shape of the day: out-of-stock and low-stock facings as last reported. Click or drag to jump. */
const Areas = memo(function Areas({ day }: { day: IndexedDay }) {
  const span = day.close - day.open;
  const max = Math.max(1, ...day.timeline.map((p) => p.outOfStock + p.lowStock));
  const x = (t: number) => ((t - day.open) / span) * W;
  const y = (v: number) => H - (v / max) * (H - 4);
  const area = (get: (p: IndexedDay["timeline"][number]) => number) => `M0,${H} ${day.timeline.map((p) => `L${x(p.t)},${y(get(p))}`).join(" ")} L${W},${H} Z`;
  const hours: number[] = [];
  for (let t = Math.ceil(day.open / 7200) * 7200; t < day.close; t += 7200) hours.push(t);
  return (
    <>
      <path className="tl-low" d={area((p) => p.outOfStock + p.lowStock)} />
      <path className="tl-out" d={area((p) => p.outOfStock)} />
      {hours.map((t) => (
        <line key={t} className="tl-tick" x1={x(t)} x2={x(t)} y1={0} y2={H} />
      ))}
    </>
  );
});

export function Timeline({ day, t, onSeek }: { day: IndexedDay; t: number; onSeek: (t: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const span = day.close - day.open;
  const seek = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    onSeek(day.open + f * span);
  };
  const hours: number[] = [];
  for (let h = Math.ceil(day.open / 7200) * 7200; h < day.close; h += 7200) hours.push(h);
  return (
    <div className="timeline">
      <div className="tl-head">
        <span>
          <i className="swatch s-out_of_stock" /> Out of stock
        </span>
        <span>
          <i className="swatch s-low_stock" /> Low stock
        </span>
        <span className="muted">facings through the day</span>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="slider"
        aria-label="Out-of-stock and low-stock facings through the day"
        aria-valuemin={day.open}
        aria-valuemax={day.close}
        aria-valuenow={Math.round(t)}
        aria-valuetext={clock(t)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seek(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)}
      >
        <Areas day={day} />
        <line className="tl-cursor" x1={((t - day.open) / span) * W} x2={((t - day.open) / span) * W} y1={0} y2={H} />
      </svg>
      <div className="tl-hours" aria-hidden="true">
        {hours.map((h) => (
          <span key={h} style={{ left: `${((h - day.open) / span) * 100}%` }}>
            {clock(h).replace(":00", "")}
          </span>
        ))}
      </div>
    </div>
  );
}
