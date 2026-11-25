import { memo } from "react";
import type { IndexedDay } from "./day.ts";
import type { Point, ShelfStatus } from "./oiss.ts";

const pts = (ps: Point[]) => ps.map((p) => `${p.x},${p.y}`).join(" ");

function centroid(ps: Point[]): Point {
  const x = ps.reduce((s, p) => s + p.x, 0) / ps.length;
  const y = ps.reduce((s, p) => s + p.y, 0) / ps.length;
  return { x, y };
}

/** Zones, fixtures and labels: the parts of the floor plan that never change during the day. */
const StaticPlan = memo(function StaticPlan({ day }: { day: IndexedDay }) {
  const { layout } = day;
  return (
    <g>
      <rect className="floor" x={0} y={0} width={layout.store.floor.width} height={layout.store.floor.depth} />
      {layout.fixtures.map((f) => (
        <polygon key={f.id} className={`fixture fixture-${f.kind}`} points={pts(f.footprint)} />
      ))}
    </g>
  );
});

const Labels = memo(function Labels({ day }: { day: IndexedDay }) {
  return (
    <g className="labels" aria-hidden="true">
      {day.layout.zones
        .filter((z) => z.kind !== "endcap")
        .map((z) => {
          const c = centroid(z.polygon);
          if (z.kind === "aisle" || z.kind === "frozen") {
            const [num, ...rest] = z.name.split(", ");
            return (
              <g key={z.id}>
                <text className="label label-strong" x={c.x} y={8.4} textAnchor="middle">
                  {num?.replace("Aisle ", "")}
                </text>
                <text className="label" x={c.x} y={c.y} textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${c.x} ${c.y})`}>
                  {rest.join(", ")}
                </text>
              </g>
            );
          }
          const name = z.name.split(", ")[0];
          return (
            <text key={z.id} className="label" x={c.x} y={c.y} textAnchor="middle" dominantBaseline="middle">
              {name}
            </text>
          );
        })}
    </g>
  );
});

const Facings = memo(function Facings({ day, statuses, selected, onSelect }: { day: IndexedDay; statuses: (ShelfStatus | "none")[]; selected: number | null; onSelect: (i: number) => void }) {
  return (
    <g>
      {day.facings.map((v, i) => (
        <rect
          key={v.facing.id}
          className={`facing s-${statuses[i]}${selected === i ? " selected" : ""}`}
          x={v.rect.x}
          y={v.rect.y}
          width={v.rect.w}
          height={v.rect.h}
          onClick={() => onSelect(i)}
        />
      ))}
    </g>
  );
});

interface Props {
  day: IndexedDay;
  t: number;
  statuses: (ShelfStatus | "none")[];
  zoneDensity: Map<string, number>;
  shoppers: Point[];
  selected: number | null;
  onSelect: (i: number | null) => void;
}

export function FloorPlan({ day, statuses, zoneDensity, shoppers, selected, onSelect }: Props) {
  const { width, depth } = day.layout.store.floor;
  return (
    <svg className="plan" viewBox={`-1 -1 ${width + 2} ${depth + 2}`} role="img" aria-label={`Floor plan of ${day.layout.store.name}`} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
      <StaticPlan day={day} />
      <g>
        {day.layout.zones
          .filter((z) => z.kind !== "backroom")
          .map((z) => (
            <polygon key={z.id} className="zone" points={pts(z.polygon)} style={{ fillOpacity: Math.min(0.45, (zoneDensity.get(z.id) ?? 0) * 0.45) }} />
          ))}
      </g>
      <Facings day={day} statuses={statuses} selected={selected} onSelect={onSelect} />
      <Labels day={day} />
      <g className="shoppers">
        {shoppers.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={0.38} />
        ))}
      </g>
    </svg>
  );
}
