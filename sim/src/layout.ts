/**
 * The demo store: a mid-size grocery store on a 60 x 40 m floor plan.
 *
 * Frame (as in spec/store-layout.md): origin at the southwest corner, x east,
 * y north, meters. The front of the store, with the entrance, the front end
 * and the exit, runs along the north wall.
 *
 *   north wall:  entrance (NW) ............ front end, self-checkout ...... exit (NE)
 *                action alley with endcaps
 *   west:        produce          center store: aisles 1-6, frozen aisle 7    bakery, deli   dairy (east wall)
 *   south wall:  meat and seafood                                               backroom behind
 */
import { type Point, type Polygon, rect } from "./geometry.ts";
import { MAIN_STREET, type StoreProfile } from "./stores.ts";

export type ZoneKind =
  | "aisle" | "endcap" | "front_end" | "self_checkout" | "entrance" | "exit" | "produce" | "deli"
  | "bakery" | "meat_and_seafood" | "dairy" | "frozen" | "backroom";

export type FixtureKind = "gondola" | "endcap" | "cooler" | "freezer" | "display" | "service_counter" | "checkout_lane" | "self_checkout";

/** Which way a fixture's shelves face, toward the shopper. */
export type Facing = "N" | "S" | "E" | "W";

export interface Zone {
  id: string;
  name: string;
  kind: ZoneKind;
  polygon: Polygon;
  /** True for zones shoppers walk in, which get ZoneMetric records. */
  public: boolean;
}

export interface Fixture {
  id: string;
  zone: string;
  kind: FixtureKind;
  footprint: Polygon;
  /** Merchandise department, for shelf fixtures. */
  department?: Department;
  front?: Facing;
  /** Shelf levels, 0 at the bottom. */
  levels?: number;
  /** Planogram positions per shelf. */
  slots?: number;
  /** The walkway line shoppers stand on to shop this fixture: x = value (vertical) or y = value (horizontal). */
  access?: { axis: "x" | "y"; value: number };
}

export type Department =
  | "breakfast" | "snacks" | "beverages" | "pantry" | "baking" | "household" | "frozen"
  | "produce" | "dairy" | "bakery" | "deli" | "meat_and_seafood" | "promo";

export interface Camera {
  id: string;
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  hfov: number;
  vfov: number;
  range: number;
  covers: string[];
  /** In-house shelf cameras watch these fixtures for on-shelf availability. */
  shelfFixtures?: string[];
}

export interface Slot {
  /** Facing id, such as A03-L-S2-F07. */
  id: string;
  fixture: string;
  shelf: string;
  level: number;
  sequence: number;
  width: number;
  /** Center of the facing on the floor plan. */
  center: Point;
  /** Where a shopper stands to pick from it, on a walkway. */
  access: Point;
}

export interface Shelf {
  id: string;
  fixture: string;
  level: number;
  height: number;
}

export interface Lane {
  id: string;
  kind: "staffed" | "self";
  /** Where the shopper stands while being served. */
  service: Point;
  /** Head of the waiting line; later places step back toward the sales floor. */
  queueHead: Point;
}

export interface StoreLayoutModel {
  store: { id: string; storeNumber: string; banner: string; name: string; timezone: string; width: number; depth: number };
  planogramVersion: string;
  zones: Zone[];
  fixtures: Fixture[];
  shelves: Shelf[];
  slots: Slot[];
  cameras: Camera[];
  lanes: Lane[];
  selfCheckoutStations: number;
  walk: WalkGraph;
  entrance: Point;
  exit: Point;
  /** The walkway along the front, between the front end and the exit door. */
  frontWalkY: number;
}

// ---- dimensions -------------------------------------------------------------

const W = 60;
const D = 40;
const ALLEY_N = 27.5; // action alley walkway, behind the front end
const ALLEY_S = 7.8; // walkway in front of the meat and seafood wall
const GONDOLA_Y0 = 9;
const GONDOLA_Y1 = 25.6;
const GONDOLA_X0 = 12;
const GONDOLA_PITCH = 4.2; // gondola (1.2 m) plus aisle (3.0 m)
const PRODUCE_WALK = 3.5;
const BAKERY_WALK = 49;
const DAIRY_WALK = 55.5;
const FRONT_WALK = 35.3;

const gondolaX = (k: number) => GONDOLA_X0 + GONDOLA_PITCH * k;
export const aisleCenterX = (i: number) => gondolaX(i - 1) + 1.2 + 1.5;

const AISLE_DEPARTMENTS: Department[] = ["breakfast", "snacks", "beverages", "pantry", "baking", "household", "frozen"];
const AISLE_NAMES = ["breakfast and coffee", "snacks and candy", "beverages", "canned and dry goods", "baking, spices and condiments", "household and paper", "frozen"];

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The prototype floor plan, for one store of the district. */
export function buildLayout(store: StoreProfile = MAIN_STREET): StoreLayoutModel {
  const zones: Zone[] = [];
  const fixtures: Fixture[] = [];
  const cameras: Camera[] = [];

  // Center store: aisles 1-6 on gondolas, aisle 7 frozen in freezer cases.
  for (let i = 1; i <= 7; i++) {
    const frozen = i === 7;
    const x0 = gondolaX(i - 1) + 1.2;
    const x1 = gondolaX(i);
    zones.push({
      id: `aisle-${pad2(i)}`,
      name: `Aisle ${i}, ${AISLE_NAMES[i - 1]}`,
      kind: frozen ? "frozen" : "aisle",
      polygon: rect(x0, GONDOLA_Y0, x1, GONDOLA_Y1),
      public: true,
    });
    const common = {
      zone: `aisle-${pad2(i)}`,
      kind: (frozen ? "freezer" : "gondola") as FixtureKind,
      department: AISLE_DEPARTMENTS[i - 1]!,
      levels: frozen ? 4 : 5,
      slots: 12,
      access: { axis: "x" as const, value: aisleCenterX(i) },
    };
    fixtures.push({ id: `A${pad2(i)}-L`, footprint: rect(x0 - 0.6, GONDOLA_Y0, x0, GONDOLA_Y1), front: "E", ...common });
    fixtures.push({ id: `A${pad2(i)}-R`, footprint: rect(x1, GONDOLA_Y0, x1 + 0.6, GONDOLA_Y1), front: "W", ...common });
  }

  // Endcaps at the front of each gondola between aisles, facing the action alley.
  zones.push({ id: "endcaps", name: "Action alley endcaps", kind: "endcap", polygon: rect(GONDOLA_X0, GONDOLA_Y1, gondolaX(7) + 1.2, 28.2), public: true });
  for (let k = 1; k <= 6; k++) {
    fixtures.push({
      id: `EC-${pad2(k)}`,
      zone: "endcaps",
      kind: "endcap",
      footprint: rect(gondolaX(k), GONDOLA_Y1, gondolaX(k) + 1.2, GONDOLA_Y1 + 0.8),
      department: "promo",
      front: "N",
      levels: 3,
      slots: 2,
      access: { axis: "y", value: ALLEY_N },
    });
  }

  // Perimeter: produce (west), bakery and deli, dairy (east wall), meat and seafood (south wall).
  zones.push({ id: "produce", name: "Produce", kind: "produce", polygon: rect(1, GONDOLA_Y0, 10.5, 28), public: true });
  fixtures.push({ id: "PR-WALL", zone: "produce", kind: "cooler", footprint: rect(1, 10, 2, 27), department: "produce", front: "E", levels: 3, slots: 10, access: { axis: "x", value: PRODUCE_WALK } });
  fixtures.push({ id: "PR-T1", zone: "produce", kind: "display", footprint: rect(5, 12, 7.5, 17), department: "produce", front: "W", levels: 1, slots: 4, access: { axis: "x", value: PRODUCE_WALK } });
  fixtures.push({ id: "PR-T2", zone: "produce", kind: "display", footprint: rect(5, 20, 7.5, 25), department: "produce", front: "W", levels: 1, slots: 4, access: { axis: "x", value: PRODUCE_WALK } });

  zones.push({ id: "bakery", name: "Bakery", kind: "bakery", polygon: rect(44, 18, 54, 27), public: true });
  fixtures.push({ id: "BK-T1", zone: "bakery", kind: "display", footprint: rect(45.5, 19.5, 47.5, 25.5), department: "bakery", front: "E", levels: 2, slots: 4, access: { axis: "x", value: BAKERY_WALK } });
  fixtures.push({ id: "BK-T2", zone: "bakery", kind: "display", footprint: rect(50.5, 19.5, 52.5, 25.5), department: "bakery", front: "W", levels: 2, slots: 4, access: { axis: "x", value: BAKERY_WALK } });

  zones.push({ id: "deli", name: "Deli", kind: "deli", polygon: rect(44, GONDOLA_Y0, 54, 17), public: true });
  fixtures.push({ id: "DL-CTR", zone: "deli", kind: "service_counter", footprint: rect(44.5, 10, 47.5, 16), department: "deli", front: "E", levels: 2, slots: 4, access: { axis: "x", value: BAKERY_WALK } });

  zones.push({ id: "dairy", name: "Dairy", kind: "dairy", polygon: rect(54, GONDOLA_Y0, 59, 27), public: true });
  fixtures.push({ id: "DA-WALL", zone: "dairy", kind: "cooler", footprint: rect(57, 10, 58, 26), department: "dairy", front: "W", levels: 4, slots: 12, access: { axis: "x", value: DAIRY_WALK } });

  zones.push({ id: "meat-seafood", name: "Meat and seafood", kind: "meat_and_seafood", polygon: rect(GONDOLA_X0, 4.5, 43, GONDOLA_Y0), public: true });
  fixtures.push({ id: "MT-WALL", zone: "meat-seafood", kind: "cooler", footprint: rect(12.5, 5, 42.5, 6), department: "meat_and_seafood", front: "N", levels: 3, slots: 16, access: { axis: "y", value: ALLEY_S } });

  zones.push({ id: "backroom", name: "Backroom", kind: "backroom", polygon: rect(0, 0, W, 4.5), public: false });

  // Front of store.
  zones.push({ id: "entrance", name: "Entrance", kind: "entrance", polygon: rect(2, 36, 10, D), public: true });
  zones.push({ id: "exit", name: "Exit", kind: "exit", polygon: rect(50, 36, 58, D), public: true });
  zones.push({ id: "front-end", name: "Front end, staffed lanes", kind: "front_end", polygon: rect(GONDOLA_X0, 29, 40, 34.6), public: true });
  zones.push({ id: "self-checkout", name: "Self-checkout", kind: "self_checkout", polygon: rect(41, 29, 50, 34.6), public: true });

  const lanes: Lane[] = [];
  for (let i = 1; i <= 8; i++) {
    const x0 = 13 + 3.25 * (i - 1);
    fixtures.push({ id: `lane-${pad2(i)}`, zone: "front-end", kind: "checkout_lane", footprint: rect(x0, 31, x0 + 1.6, 34) });
    lanes.push({ id: `lane-${pad2(i)}`, kind: "staffed", service: { x: x0 + 2.2, y: 32.6 }, queueHead: { x: x0 + 2.2, y: 30.6 } });
  }
  let station = 0;
  for (const y of [31, 33]) {
    for (const x of [42, 44.6, 47.2]) {
      station++;
      fixtures.push({ id: `sco-${pad2(station)}`, zone: "self-checkout", kind: "self_checkout", footprint: rect(x, y, x + 0.8, y + 0.8) });
    }
  }
  // One shared line for self-checkout; a shopper walks from its head to a free station.
  lanes.push({ id: "self-checkout", kind: "self", service: { x: 45.5, y: 32.4 }, queueHead: { x: 45.5, y: 30.2 } });

  // Ceiling cameras for traffic and tracking, plus in-house shelf cameras on aisle 3 and the dairy wall.
  const cam = (id: string, x: number, y: number, yaw: number, pitch: number, hfov: number, range: number, covers: string[], shelfFixtures?: string[]): Camera => ({
    id, position: { x, y, z: shelfFixtures ? 2.4 : 4.5 }, yaw, pitch, hfov, vfov: Math.round(hfov * 0.6), range, covers, ...(shelfFixtures ? { shelfFixtures } : {}),
  });
  cameras.push(cam("cam-entrance", 6, 39.5, -90, -40, 90, 12, ["entrance"]));
  cameras.push(cam("cam-exit", 54, 39.5, -90, -40, 90, 12, ["exit"]));
  cameras.push(cam("cam-fe-1", 19, 36, -90, -35, 100, 15, ["front-end", "endcaps"]));
  cameras.push(cam("cam-fe-2", 33, 36, -90, -35, 100, 15, ["front-end", "endcaps"]));
  cameras.push(cam("cam-sco", 45.5, 36, -90, -35, 100, 12, ["self-checkout"]));
  for (let i = 1; i <= 7; i++) cameras.push(cam(`cam-a${pad2(i)}`, aisleCenterX(i), 26.8, -90, -15, 60, 20, [`aisle-${pad2(i)}`, "endcaps"]));
  cameras.push(cam("cam-produce", 6, 28.5, -90, -30, 100, 20, ["produce"]));
  cameras.push(cam("cam-bakery-deli", 49, 27.5, -90, -20, 80, 20, ["bakery", "deli"]));
  cameras.push(cam("cam-dairy", 55.5, 27.5, -90, -15, 60, 20, ["dairy"]));
  cameras.push(cam("cam-meat", 27, 9, -90, -35, 120, 20, ["meat-seafood"]));
  const x3 = aisleCenterX(3);
  cameras.push(cam("shelf-cam-a03-1", x3 + 1.3, 13, 180, -10, 110, 6, ["aisle-03"], ["A03-L"]));
  cameras.push(cam("shelf-cam-a03-2", x3 + 1.3, 21, 180, -10, 110, 6, ["aisle-03"], ["A03-L"]));
  cameras.push(cam("shelf-cam-a03-3", x3 - 1.3, 13, 0, -10, 110, 6, ["aisle-03"], ["A03-R"]));
  cameras.push(cam("shelf-cam-a03-4", x3 - 1.3, 21, 0, -10, 110, 6, ["aisle-03"], ["A03-R"]));
  cameras.push(cam("shelf-cam-dairy-1", DAIRY_WALK - 1, 14, 0, -10, 110, 6, ["dairy"], ["DA-WALL"]));
  cameras.push(cam("shelf-cam-dairy-2", DAIRY_WALK - 1, 22, 0, -10, 110, 6, ["dairy"], ["DA-WALL"]));

  const { shelves, slots } = buildSlots(fixtures);
  const walk = buildWalkGraph();

  return {
    store: { id: store.id, storeNumber: store.storeNumber, banner: "Demo Grocery", name: store.name, timezone: "America/Los_Angeles", width: W, depth: D },
    planogramVersion: "2026-11-A",
    zones,
    fixtures,
    shelves,
    slots,
    cameras,
    lanes,
    selfCheckoutStations: station,
    walk,
    entrance: { x: 6, y: 39 },
    exit: { x: 54, y: 39 },
    frontWalkY: FRONT_WALK,
  };
}

const SHELF_HEIGHTS = [0.15, 0.55, 0.95, 1.35, 1.75];

function buildSlots(fixtures: Fixture[]): { shelves: Shelf[]; slots: Slot[] } {
  const shelves: Shelf[] = [];
  const slots: Slot[] = [];
  for (const f of fixtures) {
    if (!f.levels || !f.slots || !f.front || !f.access) continue;
    const [sw, , ne] = [f.footprint[0]!, f.footprint[1]!, f.footprint[2]!];
    const vertical = f.front === "E" || f.front === "W"; // long axis runs north-south
    const length = vertical ? ne.y - sw.y : ne.x - sw.x;
    const width = Math.round((length / f.slots) * 100) / 100;
    // A shopper facing the shelf reads left to right. Facing west their left is south, and so on.
    const startsAtLow = f.front === "E" || f.front === "S";
    for (let level = 0; level < f.levels; level++) {
      const shelfId = `${f.id}-S${level}`;
      shelves.push({ id: shelfId, fixture: f.id, level, height: SHELF_HEIGHTS[level] ?? 0.4 * level + 0.15 });
      for (let s = 0; s < f.slots; s++) {
        const sequence = s + 1;
        const along = startsAtLow ? (s + 0.5) * (length / f.slots) : length - (s + 0.5) * (length / f.slots);
        const center = vertical ? { x: (sw.x + ne.x) / 2, y: sw.y + along } : { x: sw.x + along, y: (sw.y + ne.y) / 2 };
        const access = f.access.axis === "x" ? { x: f.access.value, y: center.y } : { x: center.x, y: f.access.value };
        slots.push({ id: `${shelfId}-F${pad2(sequence)}`, fixture: f.id, shelf: shelfId, level, sequence, width, center, access });
      }
    }
  }
  return { shelves, slots };
}

// ---- walkways ---------------------------------------------------------------

export interface WalkGraph {
  nodes: Point[];
  edges: [number, number][];
  /** All-pairs shortest distance and next hop (Floyd-Warshall). */
  distance: number[][];
  next: number[][];
}

function buildWalkGraph(): WalkGraph {
  const verticals = [PRODUCE_WALK, ...Array.from({ length: 7 }, (_, i) => aisleCenterX(i + 1)), BAKERY_WALK, DAIRY_WALK];
  const nodes: Point[] = [];
  const edges: [number, number][] = [];
  const add = (p: Point) => nodes.push(p) - 1;

  const north: number[] = [];
  const northXs = [...verticals, 6].sort((a, b) => a - b);
  for (const x of northXs) north.push(add({ x, y: ALLEY_N }));
  const south: number[] = verticals.map((x) => add({ x, y: ALLEY_S }));
  for (let i = 1; i < north.length; i++) edges.push([north[i - 1]!, north[i]!]);
  for (let i = 1; i < south.length; i++) edges.push([south[i - 1]!, south[i]!]);
  verticals.forEach((x, i) => edges.push([north[northXs.indexOf(x)]!, south[i]!]));
  const door = add({ x: 6, y: 39 });
  edges.push([north[northXs.indexOf(6)]!, door]);

  const n = nodes.length;
  const distance = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
  const next = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? j : -1)));
  for (const [a, b] of edges) {
    const d = Math.abs(nodes[a]!.x - nodes[b]!.x) + Math.abs(nodes[a]!.y - nodes[b]!.y);
    distance[a]![b] = distance[b]![a] = d;
    next[a]![b] = b;
    next[b]![a] = a;
  }
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const via = distance[i]![k]! + distance[k]![j]!;
        if (via < distance[i]![j]!) {
          distance[i]![j] = via;
          next[i]![j] = next[i]![k]!;
        }
      }
  return { nodes, edges, distance, next };
}

const EPS = 1e-6;

/** The walkway edge a point lies on. */
function edgeOf(g: WalkGraph, p: Point): [number, number] {
  for (const [a, b] of g.edges) {
    const A = g.nodes[a]!, B = g.nodes[b]!;
    if (Math.abs(A.x - B.x) < EPS && Math.abs(p.x - A.x) < EPS && p.y >= Math.min(A.y, B.y) - EPS && p.y <= Math.max(A.y, B.y) + EPS) return [a, b];
    if (Math.abs(A.y - B.y) < EPS && Math.abs(p.y - A.y) < EPS && p.x >= Math.min(A.x, B.x) - EPS && p.x <= Math.max(A.x, B.x) + EPS) return [a, b];
  }
  throw new Error(`point (${p.x}, ${p.y}) is not on a walkway`);
}

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Shortest walkway route between two points on walkways, as corner points from p to q inclusive. */
export function route(g: WalkGraph, p: Point, q: Point): Point[] {
  const [a1, b1] = edgeOf(g, p);
  const [a2, b2] = edgeOf(g, q);
  if ((a1 === a2 && b1 === b2) || (a1 === b2 && b1 === a2)) return [p, q];
  let best = Infinity;
  let pick: [number, number] = [a1, a2];
  for (const u of [a1, b1])
    for (const v of [a2, b2]) {
      const d = manhattan(p, g.nodes[u]!) + g.distance[u]![v]! + manhattan(g.nodes[v]!, q);
      if (d < best) {
        best = d;
        pick = [u, v];
      }
    }
  const out: Point[] = [p];
  let u = pick[0];
  out.push(g.nodes[u]!);
  while (u !== pick[1]) {
    u = g.next[u]![pick[1]]!;
    out.push(g.nodes[u]!);
  }
  out.push(q);
  // Drop repeated points.
  return out.filter((pt, i) => i === 0 || manhattan(pt, out[i - 1]!) > EPS);
}

export function routeLength(points: Point[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += manhattan(points[i - 1]!, points[i]!);
  return d;
}

/** Distance along walkways, for ordering a shopping trip. */
export function walkDistance(g: WalkGraph, p: Point, q: Point): number {
  return routeLength(route(g, p, q));
}

export const ALLEY_NORTH_Y = ALLEY_N;
