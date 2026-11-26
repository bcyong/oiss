import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyTheme, storedTheme, type Theme } from "./theme.ts";
import type { FaultKind, Injection } from "@oiss/sim";
import { arrivedCount, clock, clockOf, disagreementsUpTo, faultSeen, groupDisagreements, LABEL_SOURCE_SUFFIX, ROBOT_SOURCE_SUFFIX, flagsAt, incidentsUpTo, indexDay, latestObservation, latestRecord, liveSeed, nextDate, recentRecords, robotAt, shoppersAt, statusesAt, storeNow, tasksAt, zoneMetricAt, type Disagreement, type IndexedDay } from "./day.ts";
import { assigneeName, checkoutName, duration, TASK_KIND, TASK_OUTCOME, TASK_STATE, observer, elapsed, flagDetail, flagName, humanize, itemNameAt, money, pct, STATUS_LABEL, summarize, timeOf, typeName, zoneName } from "./describe.ts";
import { FloorPlan, type CheckoutIncidents, type Selection } from "./FloorPlan.tsx";
import { Inspector } from "./Inspector.tsx";
import { storyBeats, type Beat } from "./story.ts";
import { VENDORS } from "./vendors.ts";
import { loadGoldenDay, simulateInBrowser } from "./load.ts";
import type { AnyRecord, OissRecord, ShelfObservationData, ShelfStatus, TaskData, TaskState } from "./oiss.ts";
import { Timeline } from "./Timeline.tsx";
import { Tour, tourSeen } from "./Tour.tsx";
import { AssistantPanel, type ChatEntry } from "./AssistantPanel.tsx";
import { approveTask, type Approval } from "./approve.ts";
import type { Proposal } from "./assistant/tools.ts";

const SPEEDS = [
  { label: "Real time", value: 1 },
  { label: "10 s/s", value: 10 },
  { label: "1 min/s", value: 60 },
  { label: "5 min/s", value: 300 },
  { label: "15 min/s", value: 900 },
];

const STREAM_TYPES = ["oiss.ShelfObservation", "oiss.ZoneMetric", "oiss.ShopperPath", "oiss.Evidence", "oiss.Incident", "oiss.Task"] as const;

/** An incident marker stays bright for this long after the alert arrives. */
const RECENT_INCIDENT = 15 * 60;

/** What the drawer over the right column shows. Floor plan, time bar, summary and tasks stay on screen underneath it. */
export type Panel = "detail" | "assistant" | "story" | "faults" | "disagreements" | "stream" | "sources" | "vendors";

const PANEL_TITLE: Record<Panel, string> = {
  detail: "Details",
  assistant: "Ask the store",
  story: "The day's story",
  faults: "Shelf faults",
  disagreements: "Vendor disagreements",
  stream: "Record stream",
  sources: "Sources",
  vendors: "Vendors",
};

/** Secondary views, reached from the header's More menu. */
const MORE_PANELS: Panel[] = ["story", "disagreements", "faults", "stream", "sources", "vendors"];

/** A task still waiting on the store team. */
const OPEN_STATES: TaskState[] = ["open", "assigned", "in_progress"];
const isOpenTask = (r: OissRecord<TaskData>) => OPEN_STATES.includes(r.data.state);
type TaskFilter = "open" | "closed" | "all";

/** The faults a visitor can inject, in a store team's words. */
const FAULTS: { kind: FaultKind; button: string; what: string }[] = [
  { kind: "misplaced_item", button: "Misplace an item", what: "A shopper leaves something else on the facing, a go-back." },
  { kind: "price_mismatch", button: "Mistag the price", what: "The shelf tag stops matching the price file." },
  { kind: "phantom_inventory", button: "Empty it without a sale", what: "The units go missing, but the system still counts them: phantom inventory." },
];

/** What two sources said about a facing, in a store team's words. */
function disagreementText(day: IndexedDay, d: Disagreement): string {
  const other = observer(d.other);
  if (d.kind === "price") return `The robot read a tag of ${money(d.robot.data.tagPrice)}, but ${other} show ${money(d.other.data.tagPrice)}`;
  if (d.kind === "misplaced_item") {
    const robotSees = d.robot.data.flags?.includes("misplaced_item");
    return robotSees ? `The robot saw a misplaced item, ${other} didn't` : `${capital(other)} saw a misplaced item, the robot didn't`;
  }
  const said = (r: OissRecord<ShelfObservationData>) => (r.data.status ? STATUS_LABEL[r.data.status].toLowerCase() : "no status");
  return `The robot says ${said(d.robot)}, ${other} says ${said(d.other)}`;
}

const capital = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/** Where a task stands, such as "Assigned to the Dairy team" or "Verified by a later shelf scan". */
function taskStateText(r: OissRecord<TaskData>): string {
  const d = r.data;
  if (d.state === "assigned" || d.state === "in_progress") return `${TASK_STATE[d.state]}${d.assignedTo ? `, ${assigneeName(d.assignedTo)}` : ""}`;
  if (d.state === "verified") return "Verified by a later record";
  if (d.state === "done" && d.resolution) return `Done: ${TASK_OUTCOME[d.resolution.outcome].toLowerCase()}`;
  if (d.state === "done") return d.verification?.required ? "Done, waiting for a later record to confirm it" : "Done";
  if (d.state === "cancelled" && d.resolution) return `Cancelled: ${TASK_OUTCOME[d.resolution.outcome].toLowerCase()}`;
  return TASK_STATE[d.state];
}

const DISAGREEMENT_KIND: Record<Disagreement["kind"], string> = { availability: "Availability", misplaced_item: "Misplaced item", price: "Shelf price" };

/** The thing on the floor plan that a record is about, so picking a record also picks it on the map. */
function selectionFor(day: IndexedDay, r: AnyRecord): Selection | null {
  const loc = (r.data as { location?: { facing?: string; zone?: string; fixture?: string } }).location;
  if (loc?.fixture && !loc.facing && day.incidentsByFixture.has(loc.fixture) && (r.type === "oiss.Incident" || r.type === "oiss.Evidence" || r.type === "oiss.Task")) return { kind: "checkout", id: loc.fixture };
  if (loc?.facing) {
    const index = day.facingById.get(loc.facing);
    if (index !== undefined) return { kind: "facing", index };
  }
  if ((r.type === "oiss.ZoneMetric" || r.type === "oiss.Task") && loc?.zone) return { kind: "zone", id: loc.zone };
  if (r.type === "oiss.ShopperPath") {
    const path = day.paths.findIndex((p) => p.record.id === r.id);
    if (path >= 0) return { kind: "shopper", path };
  }
  return null;
}

/** A starting state, for rendering the app in tests without loading data. */
export interface AppStart {
  day: IndexedDay;
  t?: number;
  selection?: Selection;
  pinned?: string;
  panel?: Panel;
  showCameras?: boolean;
  /** Source systems switched off. */
  off?: string[];
}


const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** The story panel's lead line, counting only the moments shown, so Live never says four when one has happened. */
function storyNote(n: number, live: boolean): string {
  if (!n) return live ? "The moments a store team would act on show up here as the day reaches them." : "Moments from this store day that a store team would act on, each found in the day's OISS records.";
  const count = NUMBER_WORDS[n] ?? String(n);
  const noun = n === 1 ? "moment" : "moments";
  return `${count} ${noun} ${live ? "so far today" : "from this store day"} that a store team would act on, each found in the day's OISS records. Tap one to jump there.`;
}

export function App({ start }: { start?: AppStart } = {}) {
  /** The whole day, every feed on. */
  const [base, setDay] = useState<IndexedDay | null>(start?.day ?? null);
  /** Source systems the visitor switched off. The demo shows only what the feeds that are on report. */
  const [off, setOff] = useState<Set<string>>(() => new Set(start?.off ?? []));
  const day = useMemo(() => (base && off.size ? indexDay(base.files, off) : base), [base, off]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [t, setT] = useState(start?.t ?? 9 * 3600);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(300);
  const [selection, setSelection] = useState<Selection | null>(start?.selection ?? null);
  /** A record the visitor picked. Without one, the inspector follows the selection's latest record. */
  const [pinned, setPinned] = useState<string | null>(start?.pinned ?? null);
  const [showCameras, setShowCameras] = useState(start?.showCameras ?? true);
  const [theme, setTheme] = useState<Theme>(() => (typeof document === "undefined" ? "dark" : storedTheme()));
  const switchTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
    setMoreOpen(false);
  };
  const [panel, setPanel] = useState<Panel | null>(start?.panel ?? null);
  /** The view to go back to after inspecting a record from it. */
  const [back, setBack] = useState<Panel | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  /** The first-visit tour. It shows once per browser and can be replayed from More. */
  const [touring, setTouring] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  /** The map's key starts closed so it doesn't cover the store. */
  const [keyOpen, setKeyOpen] = useState(false);
  const drawerBody = useRef<HTMLDivElement>(null);
  /** The store's clock now, for Live: the slider stops here. */
  const [nowClock, setNowClock] = useState<number | null>(null);
  const [streamType, setStreamType] = useState<string>("");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("open");
  /**
   * The conversation with the Store Operations Assistant, kept while the visitor switches tabs. A new day starts
   * a new one; replaying the same day with an injected fault or an approved task keeps it, since every record
   * sent before then stays the same.
   */
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const dayKey = base ? `${base.files.seed}:${base.files.date}` : "";
  useEffect(() => setChat([]), [dayKey]);
  /** Running continuously: the day rolls over to the next one at close. Starts on the store's own clock. */
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (start) return;
    loadGoldenDay()
      .then((files) => setDay(indexDay(files)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: MouseEvent) => {
      // The tour opens the menu itself, so its own buttons don't close it.
      if ((e.target as Element | null)?.closest?.(".tour")) return;
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMoreOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [moreOpen]);

  // A new view or record in the drawer starts at its top.
  useEffect(() => {
    drawerBody.current?.scrollTo?.({ top: 0 });
  }, [panel, pinned]);

  // Live: keep the store's clock, so the slider can't run past now.
  useEffect(() => {
    if (!live || !base) return;
    const tick = () => setNowClock(storeNow(base.layout.store.timezone).t);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [live, base]);

  // A first visit starts with the tour, once the store day has loaded.
  const loaded = base !== null;
  useEffect(() => {
    if (!start && loaded && !tourSeen()) setTouring(true);
  }, [loaded]);

  // Playback: advance the store clock with the animation frame.
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !day) return;
    let raf = 0;
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setT((prev) => {
        let next = prev + dt * speed;
        if (live && nowClock !== null && next > nowClock && nowClock < day.close) next = Math.max(prev, nowClock);
        if (next >= day.close) {
          if (!live) setPlaying(false);
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
  }, [playing, speed, day, live, nowClock]);

  // A live store doesn't stop at close: the next day starts at opening.
  useEffect(() => {
    if (!live || !day || busy || t < day.close) return;
    const date = nextDate(day.files.date);
    setBusy(true);
    simulateInBrowser(liveSeed(day.files.store, date), date)
      .then((files) => {
        const next = indexDay(files);
        setSelection(null);
        setPinned(null);
        setDay(next);
        setT(next.open);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [live, day, busy, t]);

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

  const flagRef = useRef<boolean[]>([]);
  const flagged = useMemo(() => {
    if (!day) return [];
    const next = flagsAt(day, t);
    const prev = flagRef.current;
    if (prev.length === next.length && prev.every((f, i) => f === next[i])) return prev;
    flagRef.current = next;
    return next;
  }, [day, t]);

  // Zone figures change every 15 minutes, so recompute them every 5 minutes of store time, not every frame.
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
  const queues = useMemo(() => {
    const m = new Map<string, number>();
    if (!day) return m;
    for (const z of day.layout.zones) {
      const q = zoneMetricAt(day, z.id, bucket)?.data.metrics.queueLength;
      if (q !== undefined) m.set(z.id, q);
    }
    return m;
  }, [day, bucket]);

  const shoppers = useMemo(() => (day ? shoppersAt(day, t) : []), [day, t]);
  const robot = useMemo(() => (day ? robotAt(day, t) : null), [day, t]);

  // Incident markers change when an alert arrives or stops being recent, so a minute's resolution is enough.
  const minute = Math.floor(t / 60) * 60;
  const incidentMarks = useMemo(() => {
    const m = new Map<string, CheckoutIncidents>();
    if (!day) return m;
    for (const [fixture, series] of day.incidentsByFixture) {
      const so = incidentsUpTo(series, minute);
      if (!so.length) continue;
      const lastAt = (Date.parse(so[so.length - 1]!.time) - day.midnightMs) / 1000;
      m.set(fixture, { count: so.length, recent: minute - lastAt < RECENT_INCIDENT });
    }
    return m;
  }, [day, minute]);

  // Records from each in-house shelf camera, for the camera card.
  const byCamera = useMemo(() => {
    const m = new Map<string, number[]>();
    if (!day) return m;
    for (const r of day.files.records.shelfObservations) {
      const cam = r.data.location.camera;
      if (!cam) continue;
      const list = m.get(cam) ?? [];
      list.push((Date.parse(r.data.window.end) - day.midnightMs) / 1000);
      m.set(cam, list);
    }
    return m;
  }, [day]);

  // The day's story, found in its records.
  const beats = useMemo(() => (day ? storyBeats(day) : []), [day]);

  if (error) return <main className="message">{error}</main>;
  if (!day) return <main className="message">Loading the store day…</main>;

  const openPanel = (p: Panel) => {
    setMoreOpen(false);
    setBack(null);
    if (p !== "detail") {
      setSelection(null);
      setPinned(null);
    }
    setPanel((cur) => (cur === p && p !== "detail" ? null : p));
  };
  const closePanel = () => {
    setPanel(null);
    setBack(null);
    setSelection(null);
    setPinned(null);
  };
  const startTour = () => {
    setMoreOpen(false);
    setPanel(null);
    setBack(null);
    setSelection(null);
    setPinned(null);
    setPlaying(false);
    setTouring(true);
  };
  // Picking something on the floor plan shows its details, except while choosing a facing for a shelf fault.
  const select = (s: Selection | null) => {
    setSelection(s);
    setPinned(null);
    if (panel === "faults") return;
    if (s) {
      if (panel !== "detail") setBack(null);
      setPanel("detail");
    } else if (panel === "detail") {
      setPanel(null);
      setBack(null);
    }
  };
  // Opening a record from another view keeps a way back to it.
  const inspect = (id: string) => {
    const r = day.byId.get(id);
    if (!r) return;
    setPinned(id);
    const s = selectionFor(day, r);
    setSelection(s);
    if (panel && panel !== "detail") setBack(panel);
    setPanel("detail");
  };
  const nowT = Math.min(Math.max(nowClock ?? t, day.open), day.close);
  const seek = (x: number) => {
    setT(live ? Math.min(x, nowT) : x);
  };
  const dayName = new Date(`${day.files.date}T12:00:00${day.offset}`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const storyBeatsSoFar = live ? beats.filter((b) => b.t <= nowT) : beats;

  const counts = { in_stock: 0, low_stock: 0, out_of_stock: 0, unknown: 0, none: 0 };
  for (const s of statuses) counts[s]++;
  const known = counts.in_stock + counts.low_stock + counts.out_of_stock;
  const front = zoneMetricAt(day, "front-end", t)?.data.metrics;
  const sco = zoneMetricAt(day, "self-checkout", t)?.data.metrics;
  const staffedLanes = day.layout.fixtures.filter((f) => f.kind === "checkout_lane").length;
  const total = day.stream.length;
  const forReview = incidentsUpTo(day.incidents, t).filter((r) => r.data.status === "open" || r.data.status === "under_review").length;
  const nextRun = day.robot.runs.find((r) => r.start > t);
  const disputes = groupDisagreements(disagreementsUpTo(day, t));
  const taskList = tasksAt(day, t);
  const openTasks = taskList.filter((x) => isOpenTask(x.latest));
  const taskCounts = { open: openTasks.length, done: 0, verified: 0, cancelled: 0 };
  for (const x of taskList) {
    const st = x.latest.data.state;
    if (st === "done" || st === "verified" || st === "cancelled") taskCounts[st]++;
  }
  const shownTasks = taskList.filter((x) => (taskFilter === "all" ? true : taskFilter === "open" ? isOpenTask(x.latest) : !isOpenTask(x.latest)));
  const taskMarks = [...new Set(openTasks.map((x) => day.facingById.get(x.latest.data.location.facing ?? "")).filter((i): i is number => i !== undefined))];
  // Tasks about the thing picked on the floor plan, as they stood at t.
  const selectionTasks = !selection
    ? []
    : taskList.filter(({ latest }) => {
        const loc = latest.data.location;
        if (selection.kind === "facing") return loc.facing === day.facings[selection.index]!.facing.id;
        if (selection.kind === "checkout") return !loc.facing && loc.fixture === selection.id;
        if (selection.kind === "zone") return !loc.facing && !loc.fixture && loc.zone === selection.id;
        return false;
      });
  // A story moment: stop at it and show its record, with a way back to the story.
  const showBeat = (b: Beat) => {
    setPlaying(false);
    setT(b.t);
    setSelection(b.selection);
    setPinned(b.record.id);
    setBack("story");
    setPanel("detail");
  };

  // Each source system is one feed the visitor can switch off. The store layout is the frame every
  // record refers to, so it stays on.
  const feeds: { system: string; vendor?: string; types: { type: string; records: number }[] }[] = [];
  for (const src of day.sources) {
    let f = feeds.find((x) => x.system === src.system);
    if (!f) feeds.push((f = { system: src.system, vendor: src.vendor, types: [] }));
    f.types.push({ type: src.type, records: src.records });
  }
  const toggleFeed = (system: string) => {
    const next = new Set(off);
    if (next.has(system)) next.delete(system);
    else next.add(system);
    setOff(next);
    setPinned(null);
    // A facing is still there with any feed off; a shopper, camera, zone or incident may not be.
    if (selection && selection.kind !== "facing") setSelection(null);
  };
  const arrived = arrivedCount(day, t);

  const runNewDay = () => {
    setBusy(true);
    setPlaying(false);
    setLive(false);
    const seed = Math.floor(Math.random() * 1e9);
    simulateInBrowser(seed, day.files.date)
      .then((files) => {
        setSelection(null);
        setPinned(null);
        setDay(indexDay(files));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Sample day: back to the fixed day everyone sees, at 9:00 AM.
  const goSample = () => {
    if (!live && day.files.origin === "golden") return;
    setBusy(true);
    setPlaying(false);
    loadGoldenDay()
      .then((files) => {
        setLive(false);
        setSelection(null);
        setPinned(null);
        if (panel === "detail") setPanel(null);
        setDay(indexDay(files));
        setT(9 * 3600);
        setSpeed(300);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Live: today's store day, the same for everyone watching, from the store's clock now.
  const goLive = () => {
    if (live) return;
    const now = storeNow(day.layout.store.timezone);
    setBusy(true);
    setPlaying(false);
    simulateInBrowser(liveSeed(day.files.store, now.date), now.date)
      .then((files) => {
        const next = indexDay(files);
        setSelection(null);
        setPinned(null);
        if (panel === "detail") setPanel(null);
        setNowClock(now.t);
        setDay(next);
        setT(Math.min(Math.max(now.t, next.open), next.close));
        setSpeed(1);
        setLive(true);
        setPlaying(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Injecting a fault replays the day with it from now on. Every record sent before now stays the same.
  const injected = day.files.injected ?? [];
  const selectedFacing = selection?.kind === "facing" ? selection.index : null;
  const inject = (kind: FaultKind) => {
    const index = selectedFacing ?? Math.floor(Math.random() * day.facings.length);
    const injections: Injection[] = [...injected.map((f) => ({ kind: f.kind, facing: f.facing, t: f.start })), { kind, facing: day.facings[index]!.facing.id, t: Math.floor(t) }];
    const wasPlaying = playing;
    setPlaying(false);
    setBusy(true);
    setReplaying(true);
    simulateInBrowser(day.files.seed, day.files.date, injections, day.files.requested)
      .then((files) => {
        setDay(indexDay({ ...files, origin: day.files.origin }));
        setSelection({ kind: "facing", index });
        setPinned(null);
        setPlaying(wasPlaying);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        setReplaying(false);
      });
  };
  // Approving a task the assistant proposed replays the day with it from now on, the way injecting a fault does.
  const approve = async (p: Proposal): Promise<Approval> => {
    const wasPlaying = playing;
    setPlaying(false);
    setBusy(true);
    try {
      const { files, result } = await approveTask(day, t, p, simulateInBrowser);
      if (files) setDay(indexDay(files));
      return result;
    } finally {
      setBusy(false);
      setPlaying(wasPlaying);
    }
  };

  const faultText = (f: (typeof injected)[number]) => {
    const own = itemNameAt(day, f.facing);
    if (f.kind === "misplaced_item") return `${(f.gtin && day.items.get(f.gtin)?.name) || "Another item"} left on the ${own} facing`;
    if (f.kind === "price_mismatch") {
      const gtin = day.facings[day.facingById.get(f.facing) ?? 0]!.facing.gtin;
      return `${own} tagged ${money({ amount: f.tagPrice ?? 0, currency: "USD" })}, price file ${money(day.items.get(gtin)?.price)}`;
    }
    return `${own} emptied without a sale`;
  };

  // The selection's card, and the record the inspector shows.
  const injectedCount = injected.length ? `, ${injected.length} injected ${injected.length === 1 ? "fault" : "faults"}` : "";
  let selectionCard: ReactNode = null;
  let following: AnyRecord | undefined;
  let related: AnyRecord[] = [];
  if (selection?.kind === "facing") {
    const v = day.facings[selection.index]!;
    const obs = latestObservation(v, t);
    const latest = latestRecord(v, t);
    const item = day.items.get(v.facing.gtin);
    following = latest;
    related = v.obs.filter((_, i) => v.times[i]! <= t).reverse();
    const label = related.find((r) => r.source.endsWith(LABEL_SOURCE_SUFFIX)) as OissRecord<ShelfObservationData> | undefined;
    const disputes = groupDisagreements(disagreementsUpTo(day, t).filter((d) => d.facing === selection.index));
    selectionCard = (
      <>
        <h2>{item?.name ?? v.facing.gtin}</h2>
        <dl>
          <dt>Location</dt>
          <dd>
            {zoneName(day, v.zone)}, fixture {v.fixture.id}, shelf {v.level + 1}
          </dd>
          <dt>GTIN</dt>
          <dd>{v.facing.gtin}</dd>
          <dt>Planogram</dt>
          <dd>
            {v.facing.facings} facings, capacity {v.facing.capacity}, {money(v.facing.shelfPrice)}
          </dd>
          <dt>On the shelf</dt>
          <dd>{obs?.data.status ? `${STATUS_LABEL[obs.data.status]}${obs.data.fillLevel !== undefined ? `, ${pct(obs.data.fillLevel)} full` : ""}, at ${clockOf(day, obs.data.window.end)}` : "Not observed yet today"}</dd>
          {label && (
            <>
              <dt>Shelf label</dt>
              <dd>
                Shows {money(label.data.tagPrice)}
                {label.data.flags?.includes("price_mismatch") ? " and hasn't taken its new price" : ", confirmed"}, at {clockOf(day, label.time)}
              </dd>
            </>
          )}
          {latest?.data.flags?.length ? (
            <>
              <dt>Flagged</dt>
              <dd>
                {latest.data.flags.map(flagName).join(", ")}: {flagDetail(day, latest.data)}
              </dd>
            </>
          ) : null}
          {disputes.length > 0 && (
            <>
              <dt>Sources disagree</dt>
              {disputes.map((g) => (
                <dd key={g.latest.kind}>
                  {/* A link, not a button, so the text after it stays on the same line when it wraps. */}
                  <a
                    href={`#${g.latest.robot.id}`}
                    className="link"
                    onClick={(e) => {
                      e.preventDefault();
                      inspect(g.latest.robot.id);
                    }}
                  >
                    {disagreementText(day, g.latest)}
                  </a>
                  , since {clock(g.first)}
                </dd>
              ))}
            </>
          )}
          {item?.promo && (
            <>
              <dt>Promotion</dt>
              <dd>On promotion this week</dd>
            </>
          )}
        </dl>
      </>
    );
  } else if (selection?.kind === "zone") {
    const z = day.zones.get(selection.id);
    const m = zoneMetricAt(day, selection.id, t);
    following = m;
    const series = day.zoneSeries.get(selection.id);
    related = series ? series.recs.filter((_, i) => series.end[i]! <= t).reverse() : [];
    selectionCard = (
      <>
        <h2>{z?.name ?? selection.id}</h2>
        <dl>
          <dt>Kind</dt>
          <dd>{humanize(z?.kind ?? "")}</dd>
          <dt>Area</dt>
          <dd>{Math.round(day.zoneArea.get(selection.id) ?? 0)} m²</dd>
          <dt>Shoppers now</dt>
          <dd>{m ? `${m.data.metrics.avgOccupancy ?? 0} on average in the last 15 minutes` : "No figures yet"}</dd>
        </dl>
      </>
    );
  } else if (selection?.kind === "shopper") {
    const p = day.paths[selection.path]!;
    following = p.record;
    related = [p.record];
    selectionCard = (
      <>
        <h2>Anonymous shopper</h2>
        <p className="note top">One ShopperPath record covers at most 15 minutes. After that the tracker gives the same shopper a new id, so no one can be followed through a whole visit.</p>
      </>
    );
  } else if (selection?.kind === "camera") {
    const c = day.layout.cameras.find((x) => x.id === selection.id);
    const times = byCamera.get(selection.id) ?? [];
    const shelf = selection.id.startsWith("shelf-");
    selectionCard = c ? (
      <>
        <h2>Camera {c.id}</h2>
        <dl>
          <dt>Kind</dt>
          <dd>{shelf ? "In-house shelf camera" : "Ceiling camera"}</dd>
          <dt>Covers</dt>
          <dd>{(c.covers ?? []).map((id) => zoneName(day, id).split(", ")[0] || id).join(", ")}</dd>
          <dt>Mounted</dt>
          <dd>
            {c.position.z} m up, {c.hfov}° wide, about {c.range} m range
          </dd>
          <dt>Records</dt>
          <dd>{shelf ? `${times.filter((x) => x <= t).length} ShelfObservation records so far today` : "Feeds people counting and anonymous shopper paths"}</dd>
        </dl>
      </>
    ) : null;
  } else if (selection?.kind === "checkout") {
    const series = day.incidentsByFixture.get(selection.id);
    const so = incidentsUpTo(series, t);
    const fixture = day.layout.fixtures.find((f) => f.id === selection.id);
    following = so[so.length - 1];
    related = [...so].reverse();
    selectionCard = (
      <>
        <h2>{checkoutName(selection.id)}</h2>
        <dl>
          <dt>Kind</dt>
          <dd>{fixture?.kind === "self_checkout" ? "Self-checkout station" : "Staffed checkout lane"}</dd>
          <dt>For review</dt>
          <dd>
            {so.length} possible {so.length === 1 ? "exception" : "exceptions"} so far today, of {series?.recs.length ?? 0} for the day
          </dd>
        </dl>
        <p className="note top">Each one is an alert from the loss prevention vendor, written as an open Incident for asset protection to review. It is not an accusation.</p>
      </>
    );
  } else if (selection?.kind === "robot") {
    const run = robot?.run;
    const runIndex = run ? day.robot.runs.indexOf(run) : -1;
    const done = robot ? robot.stop - run!.first + 1 : 0;
    const total = run ? run.last - run.first + 1 : 0;
    const facing = robot ? day.files.records.shelfObservations.find((r) => r.source === day.robot.source && (Date.parse(r.time) - day.midnightMs) / 1000 === day.robot.stops[robot.stop]!.t) : undefined;
    following = facing;
    selectionCard = (
      <>
        <h2>Shelf-scanning robot</h2>
        <dl>
          <dt>Made by</dt>
          <dd>Vendor A</dd>
          <dt>Scan run</dt>
          <dd>{run ? `Run ${runIndex + 1} of ${day.robot.runs.length}, started ${clock(run.start)}` : "Not scanning now"}</dd>
          {run && (
            <>
              <dt>Progress</dt>
              <dd>
                {done} of {total} bay positions, now at fixture {robot && `${day.robot.stops[robot.stop]!.fixture}, ${zoneName(day, day.layout.fixtures.find((f) => f.id === day.robot.stops[robot.stop]!.fixture)?.zone)}`}
              </dd>
            </>
          )}
          <dt>Today</dt>
          <dd>{day.robot.runs.length} scan runs, the first at {clock(day.robot.runs[0]?.start ?? 0)} and the last ending at {clock(day.robot.runs[day.robot.runs.length - 1]?.end ?? 0)}</dd>
        </dl>
        <p className="note top">The route is drawn only from the robot's ShelfObservation records: each bay column it photographs is one stop. OISS needs no separate location feed for it.</p>
      </>
    );
  }
  const pinnedRecord = pinned ? day.byId.get(pinned) : undefined;
  const shown = pinnedRecord ?? following;

  const stream = recentRecords(day, t, 14, streamType || undefined);

  const newest = recentRecords(day, t, 1)[0];
  const panelTitle = panel === "detail" ? "Details" : panel ? PANEL_TITLE[panel] : "";

  return (
    <div className="app">
      <header className="demo-head">
        <div className="title">
          <h1>{day.layout.store.name}</h1>
          <p className="sub">
            {live
              ? "Today's store day, simulated live in your browser on the store's own clock"
              : day.files.origin === "golden"
                ? `A sample grocery day, ${dayName}`
                : `Another simulated grocery day, ${dayName}`}
            {injectedCount}, told only through <a href="/spec/">OISS</a> records from four vendors. Tap anything on the map to see the records behind it.
          </p>
        </div>
        <div className="head-controls">
          <div className="mode" role="group" aria-label="Which store day">
            <button type="button" aria-pressed={!live} onClick={goSample} disabled={busy}>
              Sample day
            </button>
            <button type="button" aria-pressed={live} onClick={goLive} disabled={busy}>
              Live
            </button>
          </div>
          <div className="more" ref={moreRef}>
            <button type="button" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              More
            </button>
            {moreOpen && (
              <div className="menu" role="menu">
                <button type="button" role="menuitem" onClick={startTour}>
                  Take the tour
                </button>
                <button type="button" role="menuitem" onClick={switchTheme}>
                  {theme === "dark" ? "Light theme, for screenshots" : "Dark theme"}
                </button>
                <hr />
                {MORE_PANELS.map((x) => (
                  <button key={x} type="button" role="menuitem" aria-current={panel === x ? "true" : undefined} onClick={() => openPanel(x)}>
                    {PANEL_TITLE[x]}
                    {x === "disagreements" && disputes.length ? ` (${disputes.length})` : ""}
                  </button>
                ))}
                <hr />
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); runNewDay(); }} disabled={busy}>
                  {busy ? "Simulating…" : "Simulate another day"}
                </button>
                <p className="menu-note">{day.files.origin === "golden" ? "Showing the sample store day." : day.files.simulatedInMs ? `Showing a new store day, simulated in your browser in ${(day.files.simulatedInMs / 1000).toFixed(1)} seconds.` : "Showing a new simulated store day."}</p>
              </div>
            )}
          </div>
          <button type="button" className="ask-button" aria-pressed={panel === "assistant"} onClick={() => openPanel("assistant")}>
            Ask the store
          </button>
        </div>
      </header>

      <div className="stage">
        <section className="map" aria-label="Store floor plan">
          <FloorPlan day={day} statuses={statuses} flagged={flagged} zoneDensity={zoneDensity} shoppers={shoppers} queues={queues} showCameras={showCameras} onToggleCameras={() => setShowCameras((v) => !v)} incidents={incidentMarks} robot={robot} taskMarks={taskMarks} selection={selection} onSelect={select}>
            <div className={`key${keyOpen ? " open" : ""}`}>
              <button type="button" className="key-toggle" aria-expanded={keyOpen} onClick={() => setKeyOpen((o) => !o)}>
                {keyOpen ? "Hide key" : "Key"}
              </button>
              {keyOpen && (
                <div className="legend">
            {(["in_stock", "low_stock", "out_of_stock", "unknown", "none"] as const).map((s) => (
              <span key={s}>
                <i className={`swatch s-${s}`} />
                {STATUS_LABEL[s]}
              </span>
            ))}
            <span>
              <i className="swatch flag-swatch" />
              Flagged by a shelf scan or shelf label
            </span>
            <span>
              <i className="swatch dot" />
              Shopper
            </span>
            <span>
              <i className="swatch zone-swatch" />
              Zone occupancy
            </span>
            <span>
              <i className="swatch incident-swatch" />
              Incidents at a checkout
            </span>
            <span>
              <i className="swatch robot-swatch" />
              Robot and its route
            </span>
            {taskMarks.length > 0 && (
              <span>
                <i className="swatch task-swatch" />
                Open store task
              </span>
            )}
          </div>
              )}
            </div>
          </FloorPlan>
        </section>

        <section className="timebar" aria-label="Time">
          <div className="playback">
            <button type="button" className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <span className="clock">{clock(t)}</span>
            {live ? (
              t < nowT - 60 ? (
                <button type="button" className="now-button" onClick={() => { setT(nowT); setPlaying(true); }}>
                  Back to now
                </button>
              ) : (
                <span className="live-pill">Live</span>
              )
            ) : (
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
                {SPEEDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <Timeline day={day} t={t} onSeek={seek} limit={live ? nowT : undefined} />
          <button type="button" className="ticker" onClick={() => openPanel("stream")} aria-label="Open the record stream">
            <span className="ticker-label">Arriving as OISS</span>
            {newest ? (
              <span className="ticker-record" key={newest.id}>
                <span className="time">{timeOf(day, newest)}</span> <span className="type">{typeName(newest.type)}</span> {summarize(day, newest)}
              </span>
            ) : (
              <span className="ticker-record muted">No records yet</span>
            )}
            <span className="ticker-count">
              {arrived.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
            </span>
          </button>
        </section>

        <aside className="side">
          <section className="card summary">
                <h2>At {clock(t)}</h2>
                <div className="kpis headline">
                  <div>
                    <b>{known ? pct((counts.in_stock + counts.low_stock) / known) : "–"}</b>
                    <span>On-shelf availability, of facings observed</span>
                  </div>
                  <div className={counts.out_of_stock > 0 ? "bad" : undefined}>
                    <b>{counts.out_of_stock}</b>
                    <span>Facings out of stock</span>
                  </div>
                </div>
                <h3 className="kpi-group">Shelves</h3>
                <div className="kpis">
                  <div>
                    <b>{flagged.filter(Boolean).length}</b>
                    <span>Facings flagged: misplaced items or wrong tags</span>
                  </div>
                  <div>
                    <b>{robot ? "Scanning" : nextRun ? clock(nextRun.start) : "Done"}</b>
                    <span>{robot ? `Robot, ${robot.stop - robot.run.first + 1} of ${robot.run.last - robot.run.first + 1} bay positions` : nextRun ? "Robot's next scan run" : "Robot's scan runs for today"}</span>
                  </div>
                </div>
                <h3 className="kpi-group">Front end</h3>
                <div className="kpis three">
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
                    <b>{duration(front?.avgWaitSeconds)}</b>
                    <span>Average wait, staffed</span>
                  </div>
                  <div>
                    <b>{front?.queueLength ?? "–"}</b>
                    <span>In line, staffed lanes</span>
                  </div>
                  <div>
                    <b>{sco?.queueLength ?? "–"}</b>
                    <span>In line, self-checkout</span>
                  </div>
                  <div>
                    <b>{forReview}</b>
                    <span>Incidents to review</span>
                  </div>
                </div>
                <p className="note">{known} of {day.facings.length} facings observed so far. Front-end figures are from the last 15-minute ZoneMetric.</p>
          </section>
          <section className="card tasks">
                <div className="task-head">
                  <h2>Store tasks</h2>
                  <select className="filter" value={taskFilter} onChange={(e) => setTaskFilter(e.target.value as TaskFilter)} aria-label="Which tasks">
                    <option value="open">Open</option>
                    <option value="closed">Done, verified and cancelled</option>
                    <option value="all">All so far</option>
                  </select>
                </div>
                <div className="task-summary">
                  <span>
                    <b>{taskCounts.open}</b> open
                  </span>
                  <span>
                    <b>{taskCounts.done}</b> done, to verify
                  </span>
                  <span>
                    <b>{taskCounts.verified}</b> verified
                  </span>
                  <span>
                    <b>{taskCounts.cancelled}</b> cancelled
                  </span>
                </div>
                {shownTasks.length ? (
                  <ul className="records task-list">
                    {shownTasks.slice(0, 60).map(({ view, latest, changed }) => (
                      <li key={view.subject}>
                        <button type="button" className={shown?.type === "oiss.Task" && shown.subject === view.subject ? "current" : undefined} onClick={() => inspect(latest.id)}>
                          <span className="time">{clock(changed)}</span>
                          <span>
                            <span className="type">{TASK_KIND[latest.data.kind]}</span> {latest.data.title}
                            <span className={`task-state state-${latest.data.state}`}>{taskStateText(latest)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="note">{taskList.length ? "None of these yet." : off.size ? `No tasks by ${clock(t)} from the feeds that are on.` : `No tasks by ${clock(t)}.`}</p>
                )}
                {shownTasks.length > 60 && <p className="note">and {shownTasks.length - 60} more</p>}
          </section>

          {panel && (
            <section className="drawer" aria-label={panelTitle}>
              <div className="drawer-head">
                {panel === "detail" && back ? (
                  <button type="button" className="back" onClick={() => { setPanel(back); setBack(null); setPinned(null); }}>
                    ← {PANEL_TITLE[back]}
                  </button>
                ) : (
                  <h2>{panelTitle}</h2>
                )}
                <button type="button" className="close" onClick={closePanel} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="drawer-body" ref={drawerBody}>
                {panel === "detail" && (
                  <>
                    {pinnedRecord && <Inspector key={pinnedRecord.id} day={day} record={pinnedRecord} onInspect={inspect} following={false} onClose={selectionCard ? () => setPinned(null) : undefined} t={t} />}
                    {selectionCard && (
                      <div className="selection">
                        {selectionCard}
                        {selectionTasks.length > 0 && (
                <>
                  <h3>Store tasks here</h3>
                  <ul className="records">
                    {selectionTasks.slice(0, 4).map(({ view, latest }) => (
                      <li key={view.subject}>
                        <button type="button" className={latest.id === shown?.id ? "current" : undefined} onClick={() => inspect(latest.id)}>
                          <span className="time">{timeOf(day, view.versions[0]!)}</span>
                          <span>
                            {latest.data.title}
                            <span className={`task-state state-${latest.data.state}`}>{taskStateText(latest)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {selectionTasks.length > 4 && <p className="note">and {selectionTasks.length - 4} earlier</p>}
                </>
              )}
              {related.length > 1 && (
                <>
                  <h3>Records so far today</h3>
                  <ul className="records">
                    {related.slice(0, 6).map((r) => (
                      <li key={r.id}>
                        <button type="button" className={r.id === shown?.id ? "current" : undefined} onClick={() => inspect(r.id)}>
                          <span className="time">{timeOf(day, r)}</span>
                          <span>{summarize(day, r)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {related.length > 6 && <p className="note">and {related.length - 6} earlier</p>}
                </>
              )}
                      </div>
                    )}
                    {!pinnedRecord && following && <Inspector key={following.id} day={day} record={following} onInspect={inspect} following t={t} />}
                  </>
                )}
                {panel === "assistant" && <AssistantPanel day={day} t={t} onInspect={inspect} entries={chat} setEntries={setChat} onApprove={approve} />}
                {panel === "story" && (
                  <>
                <p className="note top">{storyNote(storyBeatsSoFar.length, live)}</p>
                {storyBeatsSoFar.length ? (
                  <ol className="beats">
                    {storyBeatsSoFar.map((b, i) => (
                      <li key={b.id} className={shown?.id === b.record.id ? "current" : undefined}>
                        <button type="button" onClick={() => showBeat(b)}>
                          <span className="step">{i + 1}</span>
                          <span>
                            <span className="beat-title">
                              {b.title} <span className="time">{clock(b.t)}</span>
                            </span>
                            <span className="beat-what">{b.what}</span>
                            <span className="beat-why">{b.why}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="note">{live && beats.length ? "None of today's story has happened yet." : "None of the story's moments are in the feeds that are on."}</p>
                )}
              </>
                )}
                {panel === "faults" && (
                  <>
                <p className="note top">
                  Make something go wrong at {clock(t)}, then play on to see whether the robot or the shelf cameras report it. Every record sent before {clock(t)} stays exactly the same. The day already has its own go-backs, wrong tags and phantom inventory, as any store does.
                </p>
                <p className="target">
                  {selectedFacing !== null ? (
                    <>
                      On <b>{itemNameAt(day, day.facings[selectedFacing]!.facing.id)}</b>, the facing you picked.
                    </>
                  ) : (
                    "On a random facing. Tap a facing on the floor plan to pick one."
                  )}
                </p>
                <div className="inject">
                  {FAULTS.map((f) => (
                    <button key={f.kind} type="button" onClick={() => inject(f.kind)} disabled={busy || t >= day.close}>
                      <b>{f.button}</b>
                      <span>{f.what}</span>
                    </button>
                  ))}
                </div>
                {replaying && <p className="note">Replaying the day with your fault…</p>}
                {injected.length > 0 && (
                  <>
                    <h3>Your faults</h3>
                    <ul className="records">
                      {injected.map((f) => {
                        const seen = faultSeen(day, f, t);
                        const status =
                          seen.kind === "caught"
                            ? `Caught by ${observer(seen.record)} at ${clock(seen.at)}, ${elapsed(seen.at - f.start)} later`
                            : seen.kind === "cleared"
                              ? `An associate put it back at ${clock(seen.at)}, before any scan saw it`
                              : seen.kind === "ahead"
                                ? `Happens at ${clock(f.start)}`
                                : "Not in any record yet";
                        return (
                          <li key={f.id}>
                            <button
                              type="button"
                              onClick={() => {
                                const index = day.facingById.get(f.facing);
                                if (index !== undefined) select({ kind: "facing", index });
                                if (seen.kind === "caught") inspect(seen.record.id);
                              }}
                            >
                              <span className="time">{clock(f.start)}</span>
                              <span>
                                {faultText(f)}
                                <span className={`seen seen-${seen.kind}`}>{status}</span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
                )}
                {panel === "disagreements" && (
                  <>
                <p className="note top">
                  Where two systems watching the same shelf don't agree, someone should look. Each robot pass is checked against what the shelf cameras and the shelf labels last reported for that facing. OISS makes this a simple comparison, because every vendor reports the same facing ids in the same format.
                </p>
                {disputes.length ? (
                  <ul className="records">
                    {disputes.map((g) => (
                      <li key={`${g.latest.facing}|${g.latest.kind}`}>
                        <button
                          type="button"
                          className={g.latest.robot.id === shown?.id ? "current" : undefined}
                          onClick={() => {
                            select({ kind: "facing", index: g.latest.facing });
                            setPinned(g.latest.robot.id);
                          }}
                        >
                          <span className="time">{clock(g.latest.t)}</span>
                          <span>
                            <span className="type">{DISAGREEMENT_KIND[g.latest.kind]}</span> {itemNameAt(day, day.facings[g.latest.facing]!.facing.id)}: {disagreementText(day, g.latest)}
                            <span className="seen">{g.passes === 1 ? `First seen at ${clock(g.first)}` : `Since ${clock(g.first)}, on ${g.passes} robot passes`}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="note">
                    {off.size && [...off].some((x) => /robot|camera|label/i.test(x)) ? "No disagreements by " + clock(t) + " among the feeds that are on. Disagreements need the robot and a shelf camera or the shelf labels." : `No disagreements by ${clock(t)}.`}
                  </p>
                )}
              </>
                )}
                {panel === "stream" && (
                  <>
                <select className="filter" value={streamType} onChange={(e) => setStreamType(e.target.value)} aria-label="Record type">
                  <option value="">All record types</option>
                  {STREAM_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {typeName(ty)}
                    </option>
                  ))}
                </select>
                <ul className="records">
                  {stream.map((r) => (
                    <li key={r.id}>
                      <button type="button" className={r.id === shown?.id ? "current" : undefined} onClick={() => inspect(r.id)}>
                        <span className="time">{timeOf(day, r)}</span>
                        <span>
                          <span className="type">{typeName(r.type)}</span> {summarize(day, r)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="note">The newest records at {clock(t)}, newest first. Pause playback to read them.</p>
              </>
                )}
                {panel === "sources" && (
                  <>
                <p className="note top">Switch a feed off to see what the store would know without it. Counts are for the whole day. Vendors describes who sends each feed.</p>
                <table className="feeds">
                  <thead>
                    <tr>
                      <th>Feed</th>
                      <th>Records</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feeds.map((f) => {
                      const fixed = f.types.every((x) => x.type === "StoreLayout");
                      const isOn = !off.has(f.system);
                      return (
                        <tr key={f.system} className={isOn ? undefined : "off"}>
                          <td>
                            <label className="feed">
                              <input type="checkbox" checked={isOn} disabled={fixed || busy} onChange={() => toggleFeed(f.system)} />
                              <span>
                                {f.system}
                                {f.vendor ? <span className="vendor">{f.vendor}</span> : null}
                                {fixed ? <span className="vendor">Always on: every record refers to it</span> : null}
                              </span>
                            </label>
                          </td>
                          <td className="num">
                            {f.types.map((x) => (
                              <div key={x.type}>
                                {x.type} {x.records.toLocaleString("en-US")}
                              </div>
                            ))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="note">
                  {total.toLocaleString("en-US")} records {off.size ? "from the feeds that are on" : "from every feed"}, all synthetic. Item names come from the retailer's item master, which OISS keys by GTIN.
                </p>
              </>
                )}
                {panel === "vendors" && (
                  <>
                <p className="note top">The vendors are made up, labeled A to D, and their feed formats are invented. Each is modeled on a kind of company that sells to retailers today.</p>
                <div className="vendors">
                  {VENDORS.map((v) => (
                    <section key={v.name}>
                      <h3>
                        {v.name} <span className="vendor">{v.kind}</span>
                      </h3>
                      {v.about.map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                      <p className="feeds-of">Feeds in this demo: {v.systems.join(", ")}</p>
                    </section>
                  ))}
                </div>
              </>
                )}
              </div>
            </section>
          )}
        </aside>
      </div>
      {touring && <Tour onClose={() => setTouring(false)} onStory={() => openPanel("story")} onMore={setMoreOpen} />}
    </div>
  );
}
