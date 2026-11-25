import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IndexedDay, RobotAt, ShopperDot } from "./day.ts";
import type { Camera, Point, ShelfStatus } from "./oiss.ts";

const pts = (ps: Point[]) => ps.map((p) => `${p.x},${p.y}`).join(" ");

function centroid(ps: Point[]): Point {
  const x = ps.reduce((s, p) => s + p.x, 0) / ps.length;
  const y = ps.reduce((s, p) => s + p.y, 0) / ps.length;
  return { x, y };
}

/** What the visitor has picked on the floor plan. */
export type Selection =
  | { kind: "facing"; index: number }
  | { kind: "zone"; id: string }
  | { kind: "shopper"; path: number }
  | { kind: "camera"; id: string }
  | { kind: "checkout"; id: string }
  | { kind: "robot" };

/** Incidents so far at one checkout lane or station, and whether one came in the last few minutes. */
export interface CheckoutIncidents {
  count: number;
  recent: boolean;
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

const Facings = memo(function Facings({ day, statuses, selected, onSelect }: { day: IndexedDay; statuses: (ShelfStatus | "none")[]; selected: number | null; onSelect: (s: Selection) => void }) {
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
          onClick={() => onSelect({ kind: "facing", index: i })}
        />
      ))}
    </g>
  );
});

/** A camera's field of view on the floor: a wedge from its position along its yaw. */
function wedge(c: Camera): string {
  const yaw = ((c.yaw ?? -90) * Math.PI) / 180;
  const half = (((c.hfov ?? 60) / 2) * Math.PI) / 180;
  const r = Math.min(c.range ?? 8, 8);
  const { x, y } = c.position;
  const a = { x: x + r * Math.cos(yaw - half), y: y + r * Math.sin(yaw - half) };
  const b = { x: x + r * Math.cos(yaw + half), y: y + r * Math.sin(yaw + half) };
  return `M${x},${y} L${a.x},${a.y} A${r},${r} 0 0 1 ${b.x},${b.y} Z`;
}

const Cameras = memo(function Cameras({ day, selected, onSelect }: { day: IndexedDay; selected: string | null; onSelect: (s: Selection) => void }) {
  return (
    <g className="cameras">
      {day.layout.cameras.map((c) => (
        <g key={c.id} className={`camera${selected === c.id ? " selected" : ""}${c.id.startsWith("shelf-") ? " shelf-camera" : ""}`} onClick={() => onSelect({ kind: "camera", id: c.id })}>
          <path className="fov" d={wedge(c)} />
          <circle cx={c.position.x} cy={c.position.y} r={0.45} />
        </g>
      ))}
    </g>
  );
});

interface View {
  /** Zoom factor, 1 shows the whole store. */
  k: number;
  cx: number;
  cy: number;
}

const MAX_ZOOM = 8;
const ZOOM_STEP = 1.5;

interface Props {
  day: IndexedDay;
  statuses: (ShelfStatus | "none")[];
  zoneDensity: Map<string, number>;
  shoppers: ShopperDot[];
  queues: Map<string, number>;
  showCameras: boolean;
  incidents: Map<string, CheckoutIncidents>;
  robot: RobotAt | null;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
}

const line = (ps: { x: number; y: number }[]) => ps.map((p) => `${p.x},${p.y}`).join(" ");

export function FloorPlan({ day, statuses, zoneDensity, shoppers, queues, showCameras, incidents, robot, selection, onSelect }: Props) {
  const { width, depth } = day.layout.store.floor;
  const full = useMemo(() => ({ x: -1, y: -1, w: width + 2, h: depth + 2 }), [width, depth]);
  const home: View = useMemo(() => ({ k: 1, cx: full.x + full.w / 2, cy: full.y + full.h / 2 }), [full]);
  const [view, setView] = useState<View>(home);
  const svgRef = useRef<SVGSVGElement>(null);

  // A new store goes back to the whole-store view.
  useEffect(() => setView(home), [home]);

  const clamp = useCallback(
    (v: View): View => {
      const k = Math.min(MAX_ZOOM, Math.max(1, v.k));
      const w = full.w / k;
      const h = full.h / k;
      const cx = Math.min(full.x + full.w - w / 2, Math.max(full.x + w / 2, v.cx));
      const cy = Math.min(full.y + full.h - h / 2, Math.max(full.y + h / 2, v.cy));
      return { k, cx, cy };
    },
    [full],
  );

  /** Zoom by a factor, keeping the floor point under `at` where it is on screen. */
  const zoomBy = useCallback(
    (factor: number, at?: Point) =>
      setView((v) => {
        const k = Math.min(MAX_ZOOM, Math.max(1, v.k * factor));
        if (!at) return clamp({ ...v, k });
        const f = v.k / k;
        return clamp({ k, cx: at.x + (v.cx - at.x) * f, cy: at.y + (v.cy - at.y) * f });
      }),
    [clamp],
  );

  const w = full.w / view.k;
  const h = full.h / view.k;
  const viewBox = `${view.cx - w / 2} ${view.cy - h / 2} ${w} ${h}`;

  const toFloor = useCallback((clientX: number, clientY: number): Point | undefined => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return undefined;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }, []);

  // A trackpad pinch (a wheel event with ctrlKey), or ctrl or cmd with the scroll wheel, zooms.
  // A plain scroll still scrolls the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.01), toFloor(e.clientX, e.clientY));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomBy, toFloor]);

  // Drag to pan, and pinch with two fingers on a touch screen. A press that moves less than a few
  // pixels is still a tap, so facings, zones and shoppers stay easy to pick.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; startX: number; startY: number; dist?: number }>({ moved: false, startX: 0, startY: 0 });
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { moved: false, startX: e.clientX, startY: e.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      gesture.current.moved = true;
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const svg = svgRef.current!;
    if (pointers.current.size === 2 && gesture.current.dist) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      zoomBy(dist / gesture.current.dist, toFloor((a!.x + b!.x) / 2, (a!.y + b!.y) / 2));
      gesture.current.dist = dist;
      return;
    }
    if (!gesture.current.moved && Math.hypot(e.clientX - gesture.current.startX, e.clientY - gesture.current.startY) > 4) {
      gesture.current.moved = true;
      svg.setPointerCapture(e.pointerId);
    }
    if (gesture.current.moved && view.k > 1) {
      const scale = w / svg.getBoundingClientRect().width;
      const dx = (e.clientX - prev.x) * scale;
      const dy = (e.clientY - prev.y) * scale;
      setView((v) => clamp({ ...v, cx: v.cx - dx, cy: v.cy - dy }));
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerEnd = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.dist = undefined;
  };

  const sel = selection;
  const selectedPath = sel?.kind === "shopper" ? day.paths[sel.path] : undefined;
  const queueZones = day.layout.zones.filter((z) => queues.has(z.id));

  return (
    <div className="plan-wrap">
      <svg
        ref={svgRef}
        className={`plan${view.k > 1 ? " zoomed" : ""}`}
        viewBox={viewBox}
        role="img"
        aria-label={`Floor plan of ${day.layout.store.name}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(e) => {
          if (gesture.current.moved) {
            e.stopPropagation();
            gesture.current.moved = false;
          }
        }}
        onClick={(e) => e.target === e.currentTarget && onSelect(null)}
        onDoubleClick={(e) => zoomBy(ZOOM_STEP, toFloor(e.clientX, e.clientY))}
      >
        <StaticPlan day={day} />
        <g>
          {day.layout.zones
            .filter((z) => z.kind !== "backroom")
            .map((z) => (
              <polygon
                key={z.id}
                className={`zone${sel?.kind === "zone" && sel.id === z.id ? " selected" : ""}`}
                points={pts(z.polygon)}
                style={{ fillOpacity: Math.min(0.45, (zoneDensity.get(z.id) ?? 0) * 0.45) }}
                onClick={() => onSelect({ kind: "zone", id: z.id })}
              />
            ))}
        </g>
        <Facings day={day} statuses={statuses} selected={sel?.kind === "facing" ? sel.index : null} onSelect={onSelect} />
        {showCameras && <Cameras day={day} selected={sel?.kind === "camera" ? sel.id : null} onSelect={onSelect} />}
        <Labels day={day} />
        <g className="queues" aria-hidden="true">
          {queueZones.map((z) => {
            const c = centroid(z.polygon);
            const n = queues.get(z.id) ?? 0;
            return (
              <text key={z.id} className={`queue${n >= 4 ? " long" : ""}`} x={c.x} y={Math.max(...z.polygon.map((p) => p.y)) - 0.6} textAnchor="middle">
                {n} in line
              </text>
            );
          })}
        </g>
        {robot && (
          <g className={`robot${sel?.kind === "robot" ? " selected" : ""}`}>
            {robot.route.map((piece, i) => (
              <polyline key={`r${i}`} className="robot-route" points={line(piece)} />
            ))}
            {robot.trail.map((piece, i) => (
              <polyline key={`t${i}`} className="robot-trail" points={line(piece)} />
            ))}
            <g className="robot-body" transform={`translate(${robot.x} ${robot.y})`} onClick={() => onSelect({ kind: "robot" })}>
              <rect x={-0.55} y={-0.55} width={1.1} height={1.1} rx={0.25} />
              <text className="robot-label" textAnchor="middle" dominantBaseline="central">
                R
              </text>
            </g>
          </g>
        )}
        <g className="incidents">
          {day.layout.fixtures
            .filter((f) => incidents.has(f.id))
            .map((f) => {
              const n = incidents.get(f.id)!;
              const c = centroid(f.footprint);
              const lane = f.kind === "checkout_lane";
              const y = lane ? Math.min(...f.footprint.map((p) => p.y)) - 0.7 : c.y;
              const picked = sel?.kind === "checkout" && sel.id === f.id;
              return (
                <g key={f.id} className={`incident${n.recent ? " recent" : ""}${picked ? " selected" : ""}`} transform={`translate(${c.x} ${y})`} onClick={() => onSelect({ kind: "checkout", id: f.id })}>
                  <path d="M0,-0.62 L0.62,0 L0,0.62 L-0.62,0 Z" />
                  <text textAnchor="middle" dominantBaseline="central">
                    {n.count}
                  </text>
                </g>
              );
            })}
        </g>
        {selectedPath && <polyline className="path-trace" points={selectedPath.x.map((x, i) => `${x},${selectedPath.y[i]}`).join(" ")} />}
        <g className="shoppers">
          {shoppers.map((p) => (
            <circle key={p.path} className={sel?.kind === "shopper" && sel.path === p.path ? "selected" : undefined} cx={p.x} cy={p.y} r={0.38} onClick={() => onSelect({ kind: "shopper", path: p.path })} />
          ))}
        </g>
      </svg>
      <div className="zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={view.k >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={view.k <= 1} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button type="button" className="fit" onClick={() => setView(home)} disabled={view.k === 1} title="Show the whole store">
          Reset
        </button>
      </div>
      {view.k > 1 && <span className="zoom-level">{Math.round(view.k * 100)}%</span>}
    </div>
  );
}
