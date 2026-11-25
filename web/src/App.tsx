import { useEffect, useMemo, useRef, useState } from "react";
import { clock, clockOf, indexDay, latestObservation, shoppersAt, statusesAt, zoneMetricAt, type IndexedDay } from "./day.ts";
import { FloorPlan } from "./FloorPlan.tsx";
import { loadGoldenDay, simulateInBrowser } from "./load.ts";
import type { ShelfStatus } from "./oiss.ts";

const SPEEDS = [
  { label: "1 min/s", value: 60 },
  { label: "5 min/s", value: 300 },
  { label: "15 min/s", value: 900 },
];

const STATUS_LABEL: Record<ShelfStatus | "none", string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  unknown: "Not readable",
  none: "Not yet observed",
};

const money = (m?: { amount: number; currency: string }) => (m ? m.amount.toLocaleString("en-US", { style: "currency", currency: m.currency }) : "");
const pct = (v: number) => `${Math.round(v * 100)}%`;
const mins = (s?: number) => (s === undefined ? "–" : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);

export function App() {
  const [day, setDay] = useState<IndexedDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [t, setT] = useState(9 * 3600);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(300);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    loadGoldenDay()
      .then((files) => setDay(indexDay(files)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Playback: advance the store clock with the animation frame.
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !day) return;
    let raf = 0;
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setT((prev) => {
        const next = prev + dt * speed;
        if (next >= day.close) {
          setPlaying(false);
          return day.close;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, speed, day]);

  // Facing colors change only when a new observation lands, so keep the same array until then.
  const statusRef = useRef<(ShelfStatus | "none")[]>([]);
  const statuses = useMemo(() => {
    if (!day) return [];
    const next = statusesAt(day, t);
    const prev = statusRef.current;
    if (prev.length === next.length && prev.every((s, i) => s === next[i])) return prev;
    statusRef.current = next;
    return next;
  }, [day, t]);

  // Zone occupancy changes every 15 minutes, so recompute it every 5 minutes of store time, not every frame.
  const bucket = Math.floor(t / 300) * 300;
  const zoneDensity = useMemo(() => {
    const m = new Map<string, number>();
    if (!day || day.maxDensity === 0) return m;
    for (const z of day.layout.zones) {
      const r = zoneMetricAt(day, z.id, bucket);
      const a = day.zoneArea.get(z.id) ?? 0;
      if (r && a > 0) m.set(z.id, (r.data.metrics.avgOccupancy ?? 0) / a / day.maxDensity);
    }
    return m;
  }, [day, bucket]);

  const shoppers = useMemo(() => (day ? shoppersAt(day, t) : []), [day, t]);

  if (error) return <main className="message">{error}</main>;
  if (!day) return <main className="message">Loading the store day…</main>;

  const counts = { in_stock: 0, low_stock: 0, out_of_stock: 0, unknown: 0, none: 0 };
  for (const s of statuses) counts[s]++;
  const known = counts.in_stock + counts.low_stock + counts.out_of_stock;
  const front = zoneMetricAt(day, "front-end", t)?.data.metrics;
  const sco = zoneMetricAt(day, "self-checkout", t)?.data.metrics;
  const staffedLanes = day.layout.fixtures.filter((f) => f.kind === "checkout_lane").length;
  const { records } = day.files;

  const runNewDay = () => {
    setBusy(true);
    setPlaying(false);
    const seed = Math.floor(Math.random() * 1e9);
    simulateInBrowser(seed, day.files.date)
      .then((files) => {
        setSelected(null);
        setDay(indexDay(files));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const sel = selected === null ? null : day.facings[selected];
  const selObs = sel ? latestObservation(sel, t) : undefined;
  const selItem = sel ? day.items.get(sel.facing.gtin) : undefined;

  return (
    <div className="app">
      <nav className="crumbs" aria-label="Breadcrumb">
        <a href="/">OISS</a> <span aria-hidden="true">/</span> Demo store
      </nav>
      <header>
        <div>
          <h1>{day.layout.store.name}</h1>
          <p className="sub">
            A synthetic grocery day, {new Date(`${day.files.date}T12:00:00${day.offset}`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })}, told only in{" "}
            <a href="https://github.com/bcyong/oiss">OISS</a> records from a mock shelf-scanning robot, in-house shelf cameras and a mock people-counting vendor. Milestone M1 preview.
          </p>
        </div>
        <div className="day-source">
          <span>{day.files.origin === "golden" ? "Golden day" : `Simulated in your browser in ${((day.files.simulatedInMs ?? 0) / 1000).toFixed(1)} s`}, seed {day.files.seed}</span>
          <button type="button" onClick={runNewDay} disabled={busy}>
            {busy ? "Simulating…" : "Simulate another day"}
          </button>
        </div>
      </header>

      <div className="layout">
        <section className="map" aria-label="Store floor plan">
          <FloorPlan day={day} t={t} statuses={statuses} zoneDensity={zoneDensity} shoppers={shoppers} selected={selected} onSelect={setSelected} />
          <div className="legend">
            {(["in_stock", "low_stock", "out_of_stock", "unknown", "none"] as const).map((s) => (
              <span key={s}>
                <i className={`swatch s-${s}`} />
                {STATUS_LABEL[s]}
              </span>
            ))}
            <span>
              <i className="swatch dot" />
              Shopper
            </span>
            <span>
              <i className="swatch zone-swatch" />
              Zone occupancy
            </span>
          </div>
          <div className="playback">
            <button type="button" className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <span className="clock">{clock(t)}</span>
            <input type="range" min={day.open} max={day.close} step={30} value={t} onChange={(e) => setT(Number(e.target.value))} aria-label="Time of day" />
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </section>

        <aside>
          {sel ? (
            <section className="card">
              <div className="card-head">
                <h2>{selItem?.name ?? sel.facing.gtin}</h2>
                <button type="button" className="close" onClick={() => setSelected(null)} aria-label="Close">
                  ×
                </button>
              </div>
              <dl>
                <dt>Location</dt>
                <dd>
                  {day.zones.get(sel.zone)?.name}, fixture {sel.fixture.id}, shelf {sel.level + 1}
                </dd>
                <dt>GTIN</dt>
                <dd>{sel.facing.gtin}</dd>
                <dt>Planogram</dt>
                <dd>
                  {sel.facing.facings} facings, capacity {sel.facing.capacity}, {money(sel.facing.shelfPrice)}
                </dd>
                <dt>Last observed</dt>
                <dd>{selObs ? `${STATUS_LABEL[selObs.data.status]}${selObs.data.fillLevel !== undefined ? `, ${pct(selObs.data.fillLevel)} full` : ""}, at ${clockOf(day, selObs.data.window.end)}` : "Not yet today"}</dd>
                {selObs && (
                  <>
                    <dt>Source</dt>
                    <dd>
                      {selObs.data.provenance.system}, confidence {pct(selObs.data.confidence)}
                    </dd>
                  </>
                )}
                {selObs?.data.tagPrice && (
                  <>
                    <dt>Shelf tag</dt>
                    <dd>
                      {money(selObs.data.tagPrice)} (system price {money(selObs.data.systemPrice)})
                    </dd>
                  </>
                )}
              </dl>
              <p className="note">{sel.times.filter((x) => x <= t).length} ShelfObservation records for this facing so far today.</p>
            </section>
          ) : (
            <p className="hint">Tap a facing on the floor plan to see its item and its latest ShelfObservation.</p>
          )}

          <section className="card">
            <h2>At {clock(t)}</h2>
            <div className="kpis">
              <div>
                <b>{known ? pct((counts.in_stock + counts.low_stock) / known) : "–"}</b>
                <span>On-shelf availability, of facings observed</span>
              </div>
              <div>
                <b>{counts.out_of_stock}</b>
                <span>Facings out of stock</span>
              </div>
              <div>
                <b>{shoppers.length}</b>
                <span>Shoppers in the store</span>
              </div>
              <div>
                <b>
                  {front?.openLanes ?? "–"} of {staffedLanes}
                </b>
                <span>Staffed lanes open</span>
              </div>
              <div>
                <b>{front?.queueLength ?? "–"}</b>
                <span>In line at staffed lanes</span>
              </div>
              <div>
                <b>{mins(front?.avgWaitSeconds)}</b>
                <span>Average wait, staffed</span>
              </div>
            </div>
            <p className="note">
              {known} of {day.facings.length} facings observed so far. Self-checkout: {sco?.queueLength ?? 0} in line. Front-end figures are from the last 15-minute ZoneMetric.
            </p>
          </section>

          <section className="card">
            <h2>Sources</h2>
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Record type</th>
                  <th className="num">Records</th>
                </tr>
              </thead>
              <tbody>
                {day.sources.map((s) => (
                  <tr key={`${s.system}|${s.type}`}>
                    <td>
                      {s.system}
                      {s.vendor ? <span className="vendor">{s.vendor}</span> : null}
                    </td>
                    <td>{s.type}</td>
                    <td className="num">{s.records.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">
              {(1 + records.shelfObservations.length + records.zoneMetrics.length + records.shopperPaths.length).toLocaleString("en-US")} records, all synthetic. Item names come from the retailer's item master, which OISS keys by GTIN.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
