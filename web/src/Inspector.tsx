import { useState } from "react";
import { SOURCE_INFO } from "./vendors.ts";
import type { IndexedDay } from "./day.ts";
import { checkoutName, duration, flagDetail, flagName, humanize, INCIDENT_LABEL, INCIDENT_STATUS, itemNameAt, money, pct, PRIVACY, SPEC_SLUG, STATUS_LABEL, timeOf, typeName, zoneName } from "./describe.ts";
import { EvidencePreview } from "./EvidencePreview.tsx";
import { VENDOR_NAME, type VendorRaw, vendorRawFor } from "./vendorRaw.ts";
import type { AnyRecord, EvidenceData, IncidentData, OissRecord, Provenance, ShelfObservationData, ShopperPathData, StoreLayoutData, ZoneMetricData } from "./oiss.ts";

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
        {SOURCE_INFO[p.system] ? <span className="about">{SOURCE_INFO[p.system]!.kind}. {SOURCE_INFO[p.system]!.about}</span> : null}
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

/** What the vendor sent, before its adapter, and what the adapter did with it. */
function VendorRawView({ day, record, raw }: { day: IndexedDay; record: AnyRecord; raw: VendorRaw }) {
  let note: string;
  let body: string;
  if (raw.kind === "shelf-scan") {
    const loc = (record.data as { location: { facing: string; fixture: string } }).location;
    note = `The robot's own read, before the adapter. The retailer's mapping table turned section ${raw.capture.section}, position ${raw.capture.position}, shelf ${raw.read.shelf} of ${raw.levels} counted from the top into facing ${loc.facing}, the vendor's state ${raw.read.state} into an OISS status${raw.read.exceptions.length ? `, its exception codes ${raw.read.exceptions.join(" and ")} into flags` : ""}, EAN codes into GTINs and UTC time into store time. The adapter also checked that the item the robot expected is the one the planogram puts there.`;
    body = JSON.stringify({ mission_id: raw.mission, ...raw.capture, shelves: [raw.read] }, null, 2);
  } else if (raw.kind === "traffic") {
    const zone = (record.data as { location: { zone: string } }).location.zone;
    note = `The vendor's CSV row, before the adapter. Zone code ${raw.row.zone_code} became ${zoneName(day, zone)}, the wall-clock start ${raw.row.interval_start} became a window with the store's UTC offset, blank cells were left out, and an accuracy of ${raw.row.accuracy_pct}% became a confidence of ${pct((record.data as { confidence: number }).confidence)}.`;
    body = `${raw.header}\n${raw.line}`;
  } else {
    note = `The shelf label system's report, before the adapter. The retailer's label-to-location table put label ${raw.event.label_id} on this facing, and the adapter checked that the label is linked to the item the planogram puts there. ${raw.event.event === "UPDATE_FAILED" ? `The label didn't take its new price on try ${raw.event.attempt}, so it still shows ${money({ amount: Number(raw.event.displayed_price), currency: "USD" })}.` : "The label confirmed its price."} A label can't see the shelf, so the record carries no on-shelf availability.`;
    body = JSON.stringify(raw.event, null, 2);
  }
  return (
    <details className="vendor-raw">
      <summary>What {VENDOR_NAME[raw.kind]} sent</summary>
      <p className="note">{note}</p>
      <pre className="json">{body}</pre>
    </details>
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
            {d.status ? STATUS_LABEL[d.status] : "Not reported: a price check from a source that can't see the shelf"}
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
              <dd>
                {d.flags.map(flagName).join(", ")}: {flagDetail(day, d)}
              </dd>
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
    case "oiss.Incident": {
      const d = (record as OissRecord<IncidentData>).data;
      const items = (d.gtins ?? []).map((g) => day.items.get(g)?.name ?? g);
      return (
        <>
          <dt>Exception</dt>
          <dd>{INCIDENT_LABEL[d.incidentType] ?? humanize(d.incidentType)}</dd>
          <dt>Where</dt>
          <dd>
            {checkoutName(d.location.fixture)}, {zoneName(day, d.location.zone)}
          </dd>
          <dt>When</dt>
          <dd>
            {timeOf(day, { ...record, time: d.window.start })}, a {duration((Date.parse(d.window.end) - Date.parse(d.window.start)) / 1000)} window
          </dd>
          {items.length > 0 && (
            <>
              <dt>{items.length === 1 ? "Item" : "Items"}</dt>
              <dd>{items.join(", ")}</dd>
            </>
          )}
          {d.severity && (
            <>
              <dt>Severity</dt>
              <dd>{humanize(d.severity)}</dd>
            </>
          )}
          <dt>Status</dt>
          <dd>{INCIDENT_STATUS[d.status] ?? humanize(d.status)}</dd>
          <dt>Confidence</dt>
          <dd>{pct(d.confidence)}</dd>
          {d.summary && (
            <>
              <dt>Summary</dt>
              <dd>{d.summary}</dd>
            </>
          )}
        </>
      );
    }
    case "oiss.Evidence": {
      const d = (record as OissRecord<EvidenceData>).data;
      const backs: AnyRecord | undefined =
        day.files.records.shelfObservations.find((o) => o.data.evidence?.includes(record.id)) ?? (day.files.records.incidents ?? []).find((o) => o.data.evidence?.includes(record.id));
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
                  {typeName(backs.type)} {backs.id}
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
  const vendorAlert = record.type === "oiss.Incident" ? day.vendorAlertFor.get(record.id) : undefined;
  const raw = vendorRawFor(day, record);

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
          {vendorAlert && (
            <details className="vendor-raw">
              <summary>What Mock vendor B sent</summary>
              <p className="note">
                The vendor's own alert, before the adapter. The retailer's mapping table turned site {vendorAlert.site} into store {record.oissstore}, register {vendorAlert.register} into {checkoutName((record.data as IncidentData).location.fixture)}, EAN codes into GTINs, UTC milliseconds into store time and a score of {vendorAlert.score} into a confidence of {pct((record.data as IncidentData).confidence)}.
              </p>
              <pre className="json">{JSON.stringify(vendorAlert, null, 2)}</pre>
            </details>
          )}
          {raw && <VendorRawView day={day} record={record} raw={raw} />}
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
