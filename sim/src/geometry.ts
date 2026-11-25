export interface Point {
  x: number;
  y: number;
}

export type Polygon = Point[];

/** Axis-aligned rectangle as a polygon, counterclockwise from the southwest corner. */
export function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** Ray-casting point-in-polygon test. Points on an edge may fall either way. */
export function inPolygon(p: Point, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function bounds(poly: Polygon): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export const lerp = (a: Point, b: Point, f: number): Point => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

export const round = (n: number, places = 2): number => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};
