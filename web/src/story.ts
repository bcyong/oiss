/**
 * The day's story: four moments a store team would care about, found in the day's OISS records.
 * Nothing here is scripted into the records. The beats are looked up the way any OISS consumer
 * could, so they hold for the golden day, a day simulated in the browser, and any feed toggles.
 */
import { clock, zoneMetricAt, type IndexedDay } from "./day.ts";
import { checkoutName, duration, INCIDENT_LABEL, humanize, itemNameAt, money, observer } from "./describe.ts";
import type { Selection } from "./FloorPlan.tsx";
import type { AnyRecord, OissRecord, ShelfObservationData } from "./oiss.ts";

export interface Beat {
  id: "rush" | "promo-out-of-stock" | "price-error" | "incident";
  /** When to show it, in seconds since store midnight. */
  t: number;
  title: string;
  /** What happened, from the records. */
  what: string;
  /** Why a store team, or a retail executive, cares. */
  why: string;
  record: AnyRecord;
  selection: Selection;
}

const LUNCH: [number, number] = [11 * 3600, 14 * 3600];

export function storyBeats(day: IndexedDay): Beat[] {
  const beats: Beat[] = [];
  const sec = (iso: string) => (Date.parse(iso) - day.midnightMs) / 1000;

  // The lunch rush: the busiest quarter hour at the entrance between 11 AM and 2 PM.
  const entrance = day.zoneSeries.get("entrance");
  if (entrance) {
    let best = -1;
    entrance.recs.forEach((r, i) => {
      const end = entrance.end[i]!;
      if (end <= LUNCH[0] || end > LUNCH[1]) return;
      if (best < 0 || (r.data.metrics.traffic ?? 0) > (entrance.recs[best]!.data.metrics.traffic ?? 0)) best = i;
    });
    if (best >= 0) {
      const r = entrance.recs[best]!;
      const t = entrance.end[best]!;
      const front = zoneMetricAt(day, "front-end", t);
      const lanes = day.layout.fixtures.filter((f) => f.kind === "checkout_lane").length;
      const m = front?.data.metrics;
      beats.push({
        id: "rush",
        t,
        title: "The lunch rush",
        what:
          `${r.data.metrics.traffic ?? 0} shoppers came in between ${clock(sec(r.data.window.start))} and ${clock(t)}, the busiest quarter hour of lunch.` +
          (m ? ` At the front end, ${m.queueLength ?? 0} were in line with ${m.openLanes ?? 0} of ${lanes} staffed lanes open, a ${duration(m.avgWaitSeconds)} average wait.` : ""),
        why: "A manager decides whether to open another lane from these figures. The people-counting vendor sends traffic, line length and wait as OISS ZoneMetrics every 15 minutes, so any vendor's counts read the same way.",
        record: front ?? r,
        selection: { kind: "zone", id: front ? "front-end" : "entrance" },
      });
    }
  }

  // The first out-of-stock on a promoted item.
  let promo: { t: number; index: number; r: OissRecord<ShelfObservationData> } | undefined;
  day.facings.forEach((v, index) => {
    if (!day.items.get(v.facing.gtin)?.promo) return;
    const i = v.statusObs.findIndex((r) => r.data.status === "out_of_stock");
    if (i >= 0 && (!promo || v.statusTimes[i]! < promo.t)) promo = { t: v.statusTimes[i]!, index, r: v.statusObs[i]! };
  });
  if (promo) {
    const v = day.facings[promo.index]!;
    beats.push({
      id: "promo-out-of-stock",
      t: promo.t,
      title: "A promoted item runs out",
      what: `${itemNameAt(day, v.facing.id)}, on promotion on endcap ${v.fixture.id}, is out of stock. ${capital(observer(promo.r))} reported it at ${clock(promo.t)}.`,
      why: "An empty promoted item is lost sales on the item the store paid to feature. The record names the facing and the GTIN, so a replenishment task can go straight to an associate.",
      record: promo.r,
      selection: { kind: "facing", index: promo.index },
    });
  }

  // A price error: a robot read that disagrees with the shelf label, else the first wrong tag.
  const price = day.disagreements.find((d) => d.kind === "price");
  if (price) {
    const name = itemNameAt(day, day.facings[price.facing]!.facing.id);
    const tag = money(price.robot.data.tagPrice);
    const label = money(price.other.data.tagPrice);
    beats.push({
      id: "price-error",
      t: price.t,
      title: "Two systems disagree on a price",
      what: `On ${name}, the robot read a shelf tag of ${tag}, but the electronic shelf label shows ${label}, the price in the price file. A tag lower than the label is most likely a sale sign left up after its promotion ended.`,
      why: `Shoppers will be charged ${label} at the register for an item tagged ${tag}. In many places the store must honor the lower shelf price, and either way it is a complaint at the register. Only comparing the two vendors catches it, which is simple when both report the same facing in OISS.`,
      record: price.robot,
      selection: { kind: "facing", index: price.facing },
    });
  } else {
    let first: { t: number; index: number; r: OissRecord<ShelfObservationData> } | undefined;
    day.facings.forEach((v, index) => {
      const i = v.obs.findIndex((r) => r.data.flags?.includes("price_mismatch"));
      if (i >= 0 && (!first || v.times[i]! < first.t)) first = { t: v.times[i]!, index, r: v.obs[i]! };
    });
    if (first) {
      const d = first.r.data;
      beats.push({
        id: "price-error",
        t: first.t,
        title: "A wrong shelf price",
        what: `${capital(observer(first.r))} found ${itemNameAt(day, d.location.facing)} tagged ${money(d.tagPrice)} against ${money(d.systemPrice)} in the price file, at ${clock(first.t)}.`,
        why: "A shelf price that doesn't match the register is a complaint at checkout, and in many places the store must honor the lower price.",
        record: first.r,
        selection: { kind: "facing", index: first.index },
      });
    }
  }

  // A checkout incident: the first one serious enough to rank above low, else the first.
  const incident = day.incidents.recs.find((r) => r.data.severity === "medium" || r.data.severity === "high") ?? day.incidents.recs[0];
  if (incident) {
    const d = incident.data;
    const t = sec(incident.time);
    beats.push({
      id: "incident",
      t,
      title: "A checkout incident to review",
      what: `The loss prevention vendor flagged a possible ${(INCIDENT_LABEL[d.incidentType] ?? humanize(d.incidentType)).toLowerCase()} at ${checkoutName(d.location.fixture)} at ${clock(t)}${d.severity ? `, ${d.severity} severity` : ""}, with a clip for a person to review.`,
      why: "The alert arrives as an OISS Incident with its evidence, retention date and access roles, next to shelf and traffic data instead of in a separate vendor console. A person reviews it; nothing is done to the shopper automatically.",
      record: incident,
      selection: d.location.fixture ? { kind: "checkout", id: d.location.fixture } : { kind: "zone", id: d.location.zone ?? "front-end" },
    });
  }

  return beats.sort((a, b) => a.t - b.t);
}

const capital = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);


