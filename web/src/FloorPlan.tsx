import { memo, useCallback, type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IndexedDay, RobotAt, ShopperDot } from "./day.ts";
import type { Camera, Point, ShelfStatus } from "./oiss.ts";

const pts = (ps: Point[]) => ps.map((p) => `${p.x},${p.y}`).join(" ");

/** Area names on the floor all start with a capital, like "Produce" and "Breakfast and coffee". */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Front-end zones hold checkout lanes and their incident markers, so their names sit just above the zone. */
const NAME_ABOVE = new Set(["front_end", "self_checkout"]);

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
                  {cap(rest.join(", "))}
                </text>
              </g>
            );
          }
          const name = cap(z.name.split(", ")[0] ?? "");
          const y = NAME_ABOVE.has(z.kind) ? Math.min(...z.polygon.map((p) => p.y)) - 0.45 : c.y;
          return (
            <text key={z.id} className="label" x={c.x} y={y} textAnchor="middle" dominantBaseline="middle">
              {name}
            </text>
          );
        })}
    </g>
  );
});

const Facings = memo(function Facings({ day, statuses, flagged, selected, onSelect }: { day: IndexedDay; statuses: (ShelfStatus | "none")[]; flagged: boolean[]; selected: number | null; onSelect: (s: Selection) => void }) {
  return (
    <g>
      {day.facings.map((v, i) => (
        <rect
          key={v.facing.id}
          className={`facing s-${statuses[i]}${flagged[i] ? " flagged" : ""}${selected === i ? " selected" : ""}`}
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
          <rect className="cam-mark" x={c.position.x - 0.32} y={c.position.y - 0.32} width={0.64} height={0.64} rx={0.12} />
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
  /** Whether each facing's latest observation is flagged, such as a misplaced item or a wrong shelf tag. */
  flagged: boolean[];
  zoneDensity: Map<string, number>;
  shoppers: ShopperDot[];
  queues: Map<string, number>;
  showCameras: boolean;
  onToggleCameras: () => void;
  incidents: Map<string, CheckoutIncidents>;
  robot: RobotAt | null;
  /** Facings with an open store task, marked while the task board is open. */
  taskMarks?: number[];
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  /** Overlays drawn over the map, like the key. */
  children?: ReactNode;
}

const line = (ps: { x: number; y: number }[]) => ps.map((p) => `${p.x},${p.y}`).join(" ");

export function FloorPlan({ day, statuses, flagged, zoneDensity, shoppers, queues, showCameras, onToggleCameras, incidents, robot, taskMarks, selection, onSelect, children }: Props) {
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
      // The plan keeps its shape inside its box, so the drawn plan may be narrower or shorter than the box.
      const box = svg.getBoundingClientRect();
      const scale = Math.max(w / box.width, h / box.height);
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
    // The store's outer wall sits 1 m inside the plan's edge; the controls sit just inside the wall at any width.
    <div className="plan-wrap" style={{ "--wall-x": `${(100 * -full.x) / full.w}%`, "--wall-y": `${(100 * -full.y) / full.h}%` } as CSSProperties}>
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
        <Facings day={day} statuses={statuses} flagged={flagged} selected={sel?.kind === "facing" ? sel.index : null} onSelect={onSelect} />
        {taskMarks && (
          <g className="task-marks">
            {taskMarks.map((i) => {
              const r = day.facings[i]!.rect;
              return <circle key={i} className={`task-mark${sel?.kind === "facing" && sel.index === i ? " selected" : ""}`} cx={r.x + r.w / 2} cy={r.y + r.h / 2} r={0.7} onClick={() => onSelect({ kind: "facing", index: i })} />;
            })}
          </g>
        )}
        {showCameras && <Cameras day={day} selected={sel?.kind === "camera" ? sel.id : null} onSelect={onSelect} />}
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
        {/* Names and line counts go on top, with a halo, so shoppers and cones never hide them. */}
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
      </svg>
      <div className="map-controls">
        <button type="button" className={`layer${showCameras ? " on" : ""}`} aria-pressed={showCameras} aria-label="Cameras" onClick={onToggleCameras} title={showCameras ? "Hide cameras" : "Show cameras"}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <rect x="1.5" y="4.5" width="9" height="7" rx="1.8" />
            <path d="M10.5 7.2l3.3-1.9a.5.5 0 0 1 .7.4v4.6a.5.5 0 0 1-.7.4l-3.3-1.9" />
            {!showCameras && <path className="slash" d="M2 2.5l12 11" />}
          </svg>
        </button>
      </div>
      <div className="zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={view.k >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={view.k <= 1} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button type="button" className="fit" onClick={() => setView(home)} disabled={view.k === 1} aria-label="Show the whole store" title="Show the whole store">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M2 6V4.5A2.5 2.5 0 0 1 4.5 2H6M10 2h1.5A2.5 2.5 0 0 1 14 4.5V6M14 10v1.5a2.5 2.5 0 0 1-2.5 2.5H10M6 14H4.5A2.5 2.5 0 0 1 2 11.5V10" />
          </svg>
        </button>
      </div>
      {view.k > 1 && <span className="zoom-level">{Math.round(view.k * 100)}%</span>}
      {children}
    </div>
  );
}
