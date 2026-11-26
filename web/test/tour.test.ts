import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { place, TOUR_STEPS } from "../src/tourSteps.ts";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("every tour step rings a part the demo draws", () => {
  for (const step of TOUR_STEPS) {
    // The last class in the selector names the part, e.g. ".stage .map" -> map.
    const cls = step.target.split(".").pop()!.trim();
    assert.match(app, new RegExp(`className="${cls}["\\s]|className=\\{\`${cls}[$\\s\`]`), `${step.target} is not in App.tsx`);
  }
});

test("the More step lists every option in the More menu", () => {
  const more = TOUR_STEPS.find((s) => s.opensMore);
  assert.ok(more?.items);
  const names = more.items.map(([n]) => n);
  for (const n of ["Take the tour", "Simulate another day"]) assert.ok(names.includes(n), n);
  const panels = app.match(/const MORE_PANELS: Panel\[\] = \[([^\]]+)\]/)![1]!.match(/"(\w+)"/g)!.length;
  assert.equal(names.length, panels + 2);
  // It comes just before the last step, Ask the store.
  assert.equal(TOUR_STEPS.indexOf(more), TOUR_STEPS.length - 2);
  assert.equal(TOUR_STEPS.at(-1)!.target, ".ask-button");
});

test("the card stays on screen wherever the ringed part is", () => {
  const card = { w: 340, h: 260 };
  const boxes = [
    { top: 140, left: 16, width: 960, height: 580 }, // the floor plan
    { top: 140, left: 1000, width: 380, height: 700 }, // the right column
    { top: 830, left: 16, width: 960, height: 30 }, // the ticker
    { top: 80, left: 1240, width: 120, height: 34 }, // Ask the store
    { top: 10, left: 10, width: 1420, height: 880 }, // something that fills the screen
  ];
  for (const box of boxes) {
    const s = place(box, card, 1440, 900) as { left: number; top: number };
    assert.ok(s.left >= 0 && s.left + card.w <= 1440, `left ${s.left} for ${JSON.stringify(box)}`);
    assert.ok(s.top >= 0 && s.top + card.h <= 900, `top ${s.top} for ${JSON.stringify(box)}`);
  }
});

test("on a phone the card goes to the end of the screen away from the ringed part", () => {
  assert.ok("bottom" in place({ top: 100, left: 0, width: 400, height: 200 }, { w: 400, h: 200 }, 420, 900));
  assert.ok("top" in place({ top: 700, left: 0, width: 400, height: 150 }, { w: 400, h: 200 }, 420, 900));
});
