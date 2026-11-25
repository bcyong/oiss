import { useState } from "react";
import type { IndexedDay } from "./day.ts";
import { duration, humanize, itemNameAt, money, pct, PRIVACY, SPEC_SLUG, STATUS_LABEL, timeOf, typeName, zoneName } from "./describe.ts";
import { EvidencePreview } from "./EvidencePreview.tsx";
import type { AnyRecord, EvidenceData, OissRecord, Provenance, ShelfObservationData, ShopperPathData, StoreLayoutData, ZoneMetricData } from "./oiss.ts";

/** Lists longer than this are cut in the JSON view, so a StoreLayout or a long path stays readable. */
const LIST_LIMIT = 12;

function shorten(v: unknown): unknown {
  if (Array.isArray(v)) {
    const head = v.slice(0, v.length > LIST_LIMIT ? 3 : v.length).map(shorten);
    return v.length > LIST_LIMIT ? [...head, `… ${v.length - 3} more`] : head;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x)]));
  return v;
}

const METRIC_LABEL: Record<string, string> = {
  traffic: "Shoppers who entered",
  avgOccupancy: "Average shoppers in the zone",
  peakOccupancy: "Most shoppers at once",
  avgDwellSeconds: "Average time in the zone",
  queueLength: "In line at the end",
  avgWaitSeconds: "Average wait",
  openLanes: "Lanes open",
};

function ProvenanceRows({ p }: { p: Provenance }) {
  return (
    <>
      <dt>Produced by</dt>
      <dd>
        {p.system}
        {p.vendor ? `, ${p.vendor}` : ""}
      </dd>
      {p.model && (
        <>
          <dt>Model</dt>
          <dd>
            {p.model.name}
            {p.model.version ? ` ${p.model.version}` : ""}
          </dd>
        </>
      )}
      {p.adapter && (
        <>
          <dt>Adapter</dt>
          <dd>
            {p.adapter.name} {p.adapter.version}
          </dd>
        </>
      )}
    </>
  );
}

function Details({ day, record, onInspect }: { day: IndexedDay; record: AnyRecord; onInspect: (id: string) => void }) {
  switch (record.type) {
    case "oiss.ShelfObservation": {
      const d = (record as OissRecord<ShelfObservationData>).data;
      const item = itemNameAt(day, d.location.facing);
      return (
        <>
          <dt>Item</dt>
          <dd>{item}</dd>
          <dt>Shelf</dt>
          <dd>
            {STATUS_LABEL[d.status]}
            {d.fillLevel !== undefined ? `, ${pct(d.fillLevel)} full` : ""}
          </dd>
          <dt>Confidence</dt>
          <dd>{pct(d.confidence)}</dd>
          {d.tagPrice && (
            <>
              <dt>Shelf tag</dt>
              <dd>
                {money(d.tagPrice)}, system price {money(d.systemPrice)}
              </dd>
            </>
          )}
          {d.flags?.length ? (
            <>
              <dt>Flags</dt>
              <dd>{d.flags.map(humanize).join(", ")}</dd>
            </>
          ) : null}
          <dt>Where</dt>
          <dd>
            {zoneName(day, d.location.zone)}, shelf {d.location.shelf}
            {d.location.camera ? `, camera ${d.location.camera}` : ""}
          </dd>
        </>
      );
    }
    case "oiss.ZoneMetric": {
      const d = (record as OissRecord<ZoneMetricData>).data;
      return (
        <>
          <dt>Zone</dt>
          <dd>{zoneName(day, d.location.zone)}</dd>
          <dt>Interval</dt>
          <dd>
            {timeOf(day, { ...record, time: d.window.start })} to {timeOf(day, { ...record, time: d.window.end })}
          </dd>
          {Object.entries(d.metrics).map(([k, v]) => (
            <div className="dl-row" key={k}>
              <dt>{METRIC_LABEL[k] ?? k}</dt>
              <dd>{k.endsWith("Seconds") ? duration(v) : v}</dd>
            </div>
          ))}
          <dt>Confidence</dt>
          <dd>{pct(d.confidence)}</dd>
        </>
      );
    }
    case "oiss.ShopperPath": {
      const d = (record as OissRecord<ShopperPathData>).data;
      return (
        <>
          <dt>Object</dt>
          <dd>{d.objectClass}, no face or identity</dd>
          <dt>Path</dt>
          <dd>
            {d.points.length} points, {timeOf(day, { ...record, time: d.window.start })} to {timeOf(day, { ...record, time: d.window.end })}
          </dd>
          <dt>Id valid until</dt>
          <dd>{timeOf(day, { ...record, time: d.idValidUntil })}, then the shopper gets a new id</dd>
        </>
      );
    }
    case "oiss.Evidence": {
      const d = (record as OissRecord<EvidenceData>).data;
      const backs = day.files.records.shelfObservations.find((o) => o.data.evidence?.includes(record.id));
      return (
        <>
          <dt>Media</dt>
          <dd>
            {d.mediaType}, {d.uri}
          </dd>
          <dt>Redaction</dt>
          <dd>{humanize(d.redaction)}</dd>
          <dt>Kept until</dt>
          <dd>{new Date(d.retainUntil).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}</dd>
          <dt>Who may view</dt>
          <dd>{d.accessRoles.map(humanize).join(", ")}</dd>
          {backs && (
            <>
              <dt>Backs</dt>
              <dd>
                <button type="button" className="link" onClick={() => onInspect(backs.id)}>
                  ShelfObservation {backs.id}
                </button>
              </dd>
            </>
          )}
        </>
      );
    }
    case "oiss.StoreLayout": {
      const d = (record as OissRecord<StoreLayoutData>).data;
      return (
        <>
          <dt>Store</dt>
          <dd>
            {d.store.name}, store {d.store.storeNumber}
          </dd>
          <dt>Planogram</dt>
          <dd>{d.planogramVersion}</dd>
          <dt>Contents</dt>
          <dd>
            {d.zones.length} zones, {d.fixtures.length} fixtures, {d.facings.length} facings, {d.cameras.length} cameras
          </dd>
        </>
      );
    }
    default:
      return null;
  }
}

export function Inspector({ day, record, onInspect, onClose, following }: { day: IndexedDay; record: AnyRecord; onInspect: (id: string) => void; onClose?: () => void; following: boolean }) {
  const [tab, setTab] = useState<"summary" | "json">("summary");
  const [copied, setCopied] = useState(false);
  const privacy = PRIVACY[record.oissprivacy];
  const provenance = (record.data as { provenance: Provenance }).provenance;
  const evidenceIds = (record.data as { evidence?: string[] }).evidence ?? [];
  const asEvidence = record.type === "oiss.Evidence" ? (record as OissRecord<EvidenceData>) : undefined;
  const observation = asEvidence ? day.files.records.shelfObservations.find((o) => o.data.evidence?.includes(record.id)) : record.type === "oiss.ShelfObservation" ? (record as OissRecord<ShelfObservationData>) : undefined;
  const slug = SPEC_SLUG[record.type];

  const copy = () => {
    navigator.clipboard
      ?.writeText(JSON.stringify(record, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <section className="card inspector" aria-label="Record inspector">
      <div className="card-head">
        <div>
          <p className="eyebrow">{following ? "Latest record" : "Record"}</p>
          <h2>
            {typeName(record.type)} <span className="mono">{record.id}</span>
          </h2>
        </div>
        {onClose && (
          <button type="button" className="close" onClick={onClose} aria-label="Close the record">
            ×
          </button>
        )}
      </div>
      <div className="badges">
        {privacy && (
          <span className={`badge privacy-${record.oissprivacy}`} title={privacy.meaning}>
            {privacy.label}
          </span>
        )}
        {provenance?.synthetic && <span className="badge">Synthetic</span>}
        <span className="badge">OISS {record.oissversion}</span>
      </div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "summary"} onClick={() => setTab("summary")}>
          Summary
        </button>
        <button type="button" role="tab" aria-selected={tab === "json"} onClick={() => setTab("json")}>
          Raw JSON
        </button>
      </div>
      {tab === "summary" ? (
        <>
          <dl>
            <dt>Time</dt>
            <dd>{timeOf(day, record)}</dd>
            <Details day={day} record={record} onInspect={onInspect} />
            {provenance && <ProvenanceRows p={provenance} />}
            <dt>Source</dt>
            <dd className="mono small">{record.source}</dd>
            <dt>Privacy</dt>
            <dd>{privacy?.meaning ?? record.oissprivacy}</dd>
            {slug && (
              <>
                <dt>Schema</dt>
                <dd>
                  <a href={`/spec/#${slug}`}>{typeName(record.type)} in the spec</a>
                </dd>
              </>
            )}
          </dl>
          {asEvidence && <EvidencePreview day={day} evidence={asEvidence} observation={observation} />}
          {evidenceIds.map((id) => {
            const ev = day.evidence.get(id);
            return ev ? <EvidencePreview key={id} day={day} evidence={ev} observation={observation} onInspect={onInspect} /> : null;
          })}
        </>
      ) : (
        <>
          <pre className="json">{JSON.stringify(shorten(record), null, 2)}</pre>
          <div className="json-foot">
            <span className="muted">{JSON.stringify(record).length > 4000 ? `Lists over ${LIST_LIMIT} items are shortened here.` : "The record exactly as the source sent it."}</span>
            <button type="button" onClick={copy}>
              {copied ? "Copied" : "Copy JSON"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
