import { useEffect, useState, type ReactNode } from "react";
import { CURRENT } from "./versions.ts";

// The schemas and examples are bundled from the repo at build time, so this page always matches the
// schemas the validator checks.
type Schema = {
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  if?: Schema;
  then?: Schema;
  $defs?: Record<string, Schema>;
  minimum?: number;
  maximum?: number;
  format?: string;
  pattern?: string;
};

const schemaFiles = import.meta.glob<Schema>("../../schemas/v0.2/*.schema.json", { eager: true, import: "default" });
const validFiles = import.meta.glob<unknown>("../../examples/valid/*.json", { eager: true, import: "default" });
const invalidFiles = import.meta.glob<unknown>("../../examples/invalid/*.json", { eager: true, import: "default" });
const invalidNotes = import.meta.glob<string>("../../examples/invalid/README.md", { eager: true, import: "default", query: "?raw" });

const base = (path: string) => path.split("/").pop()!;
const schemas = new Map(Object.entries(schemaFiles).map(([p, s]) => [base(p).replace(".schema.json", ""), s]));
const valid = new Map(Object.entries(validFiles).map(([p, s]) => [base(p).replace(".json", ""), s]));
const invalid = Object.entries(invalidFiles).map(([p, s]) => ({ file: base(p), record: s }));
const whatsWrong = new Map<string, string>();
for (const md of Object.values(invalidNotes)) {
  for (const line of md.split("\n")) {
    const m = /^\| `([^`]+)` \| (.+?) \|$/.exec(line.trim());
    if (m) whatsWrong.set(m[1]!, m[2]!);
  }
}

const defs = schemas.get("defs")?.$defs ?? {};
const vocab = schemas.get("vocab")?.$defs ?? {};

const RECORD_TYPES = [
  { slug: "store-layout", type: "StoreLayout", about: "the store", what: "Zones, fixtures, shelves and facings, with the planogram and camera placement." },
  { slug: "shelf-observation", type: "ShelfObservation", about: "a facing", what: "On-shelf availability, planogram compliance and price integrity at one facing." },
  { slug: "zone-metric", type: "ZoneMetric", about: "a zone", what: "Traffic, dwell, queue length, wait time and open lanes for one zone over one interval." },
  { slug: "shopper-path", type: "ShopperPath", about: "an anonymous path", what: "An anonymous shopper path on the floor plan, with an id that changes at least every 15 minutes." },
  { slug: "incident", type: "Incident", about: "an incident", what: "A loss-prevention exception or safety incident, with a confidence, for a person to review." },
  { slug: "evidence", type: "Evidence", about: "an evidence item", what: "An image or clip reference, with its redaction, retention date and the roles that may view it." },
  { slug: "task", type: "Task", about: "a task", what: "A store task, such as replenish or fix a shelf tag, and its status." },
] as const;

const PAGES = [{ slug: "envelope", label: "Envelope" }, ...RECORD_TYPES.map((r) => ({ slug: r.slug, label: r.type })), { slug: "shared", label: "Shared definitions" }, { slug: "vocabularies", label: "Vocabularies" }];

const DEF_LABEL: Record<string, string> = {
  id: "id",
  gtin: "GTIN",
  gln: "GLN",
  timestamp: "timestamp",
  window: "time window",
  point: "point",
  polygon: "polygon",
  location: "location",
  confidence: "confidence",
  provenance: "provenance",
  evidenceRefs: "Evidence ids",
  recordRefs: "record ids",
  money: "money",
  namespace: "namespace",
  vendorRecordType: "vendor record type",
  extensions: "extensions",
};

const humanize = (v: string) => v.replaceAll("_", " ");

/** The privacy class each record type may use, from the envelope schema. */
function privacyByType(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rule of schemas.get("envelope")?.allOf ?? []) {
    const type = rule.if?.properties?.type?.const as string | undefined;
    const p = rule.then?.properties?.oissprivacy;
    if (type && p) out.set(type, p.enum ? (p.enum as string[]) : [String(p.const)]);
  }
  return out;
}

function refTarget(ref: string): { file: "defs" | "vocab" | "other"; name: string } {
  const m = /^(defs|vocab)\.schema\.json#\/\$defs\/(.+)$/.exec(ref) ?? /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m) return { file: "other", name: ref };
  return m.length === 3 ? { file: m[1] as "defs" | "vocab", name: m[2]! } : { file: "defs", name: m[1]! };
}

function Values({ values }: { values: unknown[] }) {
  return (
    <span className="values">
      {values.map((v) => (
        <code key={String(v)}>{String(v)}</code>
      ))}
    </span>
  );
}

/** A short description of a field's type, in words. */
function typeOf(s: Schema): ReactNode {
  if (s.$ref) {
    const { file, name } = refTarget(s.$ref);
    if (file === "vocab") {
      const e = vocab[name]?.enum ?? [];
      return (
        <>
          one of <Values values={e} />
        </>
      );
    }
    if (file === "defs") return <a href={`#shared-${name}`}>{DEF_LABEL[name] ?? name}</a>;
    return s.$ref;
  }
  if (s.anyOf)
    return s.anyOf.map((alt, i) => (
      <span key={i}>
        {i ? " or " : ""}
        {typeOf(alt)}
      </span>
    ));
  if (s.const !== undefined) return <code>{JSON.stringify(s.const)}</code>;
  if (s.enum)
    return (
      <>
        one of <Values values={s.enum} />
      </>
    );
  if (s.type === "array" && s.items) return <>list of {typeOf(s.items)}</>;
  if (s.type === "number" || s.type === "integer") {
    const range = s.minimum !== undefined && s.maximum !== undefined ? ` from ${s.minimum} to ${s.maximum}` : s.minimum !== undefined ? `, ${s.minimum} or more` : "";
    return `${s.type}${range}`;
  }
  if (s.type === "object") return s.properties ? "object, below" : "object";
  if (s.format) return `${s.type ?? "string"} (${s.format})`;
  return Array.isArray(s.type) ? s.type.join(" or ") : (s.type ?? "any");
}

interface Row {
  name: string;
  depth: number;
  schema: Schema;
  required: boolean;
  shared?: boolean;
}

function rows(s: Schema, depth = 0, prefix = ""): Row[] {
  const out: Row[] = [];
  const req = new Set(s.required ?? []);
  for (const [name, p] of Object.entries(s.properties ?? {})) {
    out.push({ name: prefix + name, depth, schema: p, required: req.has(name) });
    if (depth < 2) {
      if (p.type === "object" && p.properties) out.push(...rows(p, depth + 1, `${prefix}${name}.`));
      if (p.type === "array" && p.items?.properties) out.push(...rows(p.items, depth + 1, `${prefix}${name}[].`));
    }
  }
  return out;
}

/** The record type's own fields, then the shared fields it takes from defs common. */
function recordRows(s: Schema): Row[] {
  const own = rows(s);
  const req = new Set(s.required ?? []);
  const usesCommon = (s.allOf ?? []).some((a) => a.$ref?.endsWith("$defs/common"));
  if (!usesCommon) return own;
  const common = defs.common;
  const commonReq = new Set(common?.required ?? []);
  const shared = Object.entries(common?.properties ?? {})
    .filter(([name]) => !(name in (s.properties ?? {})))
    .map(([name, p]) => ({ name, depth: 0, schema: p, required: req.has(name) || commonReq.has(name), shared: true }));
  return [...own, ...shared];
}

function FieldTable({ list }: { list: Row[] }) {
  return (
    <div className="table-scroll">
      <table className="fields">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Required</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.name} className={r.depth ? "nested" : undefined}>
              <td>
                <code style={{ marginLeft: r.depth * 14 }}>{r.depth ? r.name.split(/\.|\[\]\./).pop() : r.name}</code>
                {r.shared && <span className="tag">shared</span>}
              </td>
              <td>{typeOf(r.schema)}</td>
              <td>{r.required ? "Yes" : ""}</td>
              <td>{r.schema.description ?? (r.schema.$ref ? defs[refTarget(r.schema.$ref).name]?.description : "") ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

function RecordPage({ slug }: { slug: (typeof RECORD_TYPES)[number]["slug"] }) {
  const meta = RECORD_TYPES.find((r) => r.slug === slug)!;
  const s = schemas.get(slug)!;
  const privacy = privacyByType().get(`oiss.${meta.type}`) ?? [];
  const example = valid.get(slug);
  const bad = invalid.filter((x) => x.file.startsWith(`${slug}-`));
  const [tab, setTab] = useState<"valid" | number>("valid");
  return (
    <>
      <p className="eyebrow">Record type</p>
      <h1>{meta.type}</h1>
      <p className="lede">{meta.what}</p>
      <dl className="facts">
        <dt>type</dt>
        <dd>
          <code>oiss.{meta.type}</code>
        </dd>
        <dt>subject</dt>
        <dd>{meta.about}</dd>
        <dt>Privacy class</dt>
        <dd>{privacy.map(humanize).join(" or ")}</dd>
        <dt>Schema</dt>
        <dd>
          <a href={`https://github.com/bcyong/oiss/blob/main/schemas/v${CURRENT}/${slug}.schema.json`} target="_blank" rel="noopener noreferrer">{slug}.schema.json</a>
        </dd>
      </dl>
      <p>{s.description}</p>
      <h2>Fields in data</h2>
      <FieldTable list={recordRows(s)} />
      <h2>Examples</h2>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "valid"} onClick={() => setTab("valid")}>
          Valid
        </button>
        {bad.map((b, i) => (
          <button key={b.file} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>
            Invalid{bad.length > 1 ? ` ${i + 1}` : ""}
          </button>
        ))}
      </div>
      {tab === "valid" ? (
        example ? (
          <>
            <p className="note top">A complete record, envelope and data, that the validator accepts.</p>
            <Json value={example} />
          </>
        ) : null
      ) : (
        <>
          <p className="note top">
            The validator rejects this record: {whatsWrong.get(bad[tab]!.file) ?? "see examples/invalid"}.
          </p>
          <Json value={bad[tab]!.record} />
        </>
      )}
    </>
  );
}

function EnvelopePage() {
  const s = schemas.get("envelope")!;
  const privacy = privacyByType();
  return (
    <>
      <p className="eyebrow">Every record</p>
      <h1>Envelope</h1>
      <p className="lede">Every OISS record is a CloudEvents 1.0 event in structured JSON. The envelope says what the record is, who sent it, when and how sensitive it is. The record itself is in data.</p>
      <FieldTable list={rows(s)} />
      <h2>Privacy class by record type</h2>
      <table className="fields">
        <thead>
          <tr>
            <th>Record type</th>
            <th>Allowed privacy class</th>
          </tr>
        </thead>
        <tbody>
          {RECORD_TYPES.map((r) => (
            <tr key={r.slug}>
              <td>
                <a href={`#${r.slug}`}>{r.type}</a>
              </td>
              <td>{(privacy.get(`oiss.${r.type}`) ?? []).map(humanize).join(" or ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SharedPage() {
  return (
    <>
      <p className="eyebrow">Building blocks</p>
      <h1>Shared definitions</h1>
      <p className="lede">Identifiers, times, places and money that every record type uses the same way.</p>
      {Object.entries(defs)
        .filter(([name]) => name !== "common")
        .map(([name, d]) => (
          <section key={name} id={`shared-${name}`} className="def">
            <h2>{DEF_LABEL[name] ?? name}</h2>
            {d.description && <p>{d.description}</p>}
            {d.properties ? <FieldTable list={rows(d)} /> : <p className="note top">Type: {typeOf(d)}{d.pattern ? `, matching ${d.pattern}` : ""}</p>}
          </section>
        ))}
    </>
  );
}

function VocabPage() {
  return (
    <>
      <p className="eyebrow">Controlled values</p>
      <h1>Vocabularies</h1>
      <p className="lede">The fixed lists of values that records use, so every vendor says out of stock or ticket switching the same way.</p>
      <table className="fields">
        <tbody>
          {Object.entries(vocab).map(([name, v]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
                {v.description && <p className="note top">{v.description}</p>}
              </td>
              <td>
                <Values values={v.enum ?? []} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function pageFromHash(): string {
  if (typeof window === "undefined") return "envelope";
  const h = decodeURIComponent(window.location.hash.slice(1));
  if (h.startsWith("shared-")) return "shared";
  return PAGES.some((p) => p.slug === h) ? h : "envelope";
}

export function SpecBrowser({ initialPage }: { initialPage?: string } = {}) {
  const [page, setPage] = useState(() => initialPage ?? pageFromHash());
  useEffect(() => {
    const onHash = () => {
      setPage(pageFromHash());
      const h = window.location.hash.slice(1);
      if (h.startsWith("shared-")) requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView());
      else window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const record = RECORD_TYPES.find((r) => r.slug === page);
  return (
    <div className="app spec">
      <div className="spec-layout">
        <nav className="spec-nav" aria-label="Spec pages">
          <p className="eyebrow">OISS v{CURRENT}</p>
          {PAGES.map((p, i) => (
            <a key={p.slug} href={`#${p.slug}`} aria-current={page === p.slug ? "page" : undefined} className={i === 1 || i === RECORD_TYPES.length + 1 ? "gap" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <main className="card spec-page">
          {page === "envelope" && <EnvelopePage />}
          {record && <RecordPage key={record.slug} slug={record.slug} />}
          {page === "shared" && <SharedPage />}
          {page === "vocabularies" && <VocabPage />}
        </main>
      </div>
    </div>
  );
}
