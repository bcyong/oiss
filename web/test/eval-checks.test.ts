import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAnswer, statedCauses, unknownTeams, unsupportedNumbers } from "../eval/checks.ts";

const tools = JSON.stringify({
  counts: { wrongOnShelf: 2, fixedWaitingForRead: 4 },
  tags: [{ item: "Harbor Lane Mayonnaise", priceAtRegister: "$11.79", status: "Wrong on the shelf. Fix task assigned.", flaggedAt: "8:19 AM", fixTask: { id: "task-20261117-000009-v2", assignedTo: "Price integrity team" }, robotTagRead: { tagPrice: "$8.89" } }],
  now: { avgWaitSeconds: 180, openLanes: 5, of: 8 },
  note: "The record doesn't say why.",
});

test("numbers, times and amounts must come from the tool results", () => {
  assert.deepEqual(unsupportedNumbers("Two tags are wrong: Harbor Lane Mayonnaise reads $8.89 against $11.79 since 8:19 AM [so-20261117-000717].", tools), []);
  assert.deepEqual(unsupportedNumbers("6 shelf tags show the wrong price.", tools), ["6"]);
  assert.deepEqual(unsupportedNumbers("The tag reads $8.99.", tools), ["$8.99"]);
  // List markers and record ids aren't facts; a wait in minutes from seconds is.
  assert.deepEqual(unsupportedNumbers("1. 5 of 8 lanes are open, with a 3 minute wait [zm-20261117-000747].", tools), []);
});

test("an answer may not give a cause the records don't", () => {
  assert.deepEqual(statedCauses("The tag is wrong, likely because the price file changed overnight.", tools), ["likely", "because"]);
  assert.deepEqual(statedCauses("The records don't say why. Replenish by likely lost sales.", tools), []);
});

test("team names must come from the tool results", () => {
  assert.deepEqual(unknownTeams("The Price integrity team has the fix task.", tools), []);
  assert.deepEqual(unknownTeams("Ask the pricing team, or the store team.", tools), ["pricing team"]);
});

test("every finding for an answer, including citations the tools didn't return", () => {
  const f = checkAnswer({ text: "6 tags are wrong because of a bad price file. Ask the merchandising team.", unverified: ["so-20261117-999999"] }, tools);
  assert.deepEqual(
    f.map((x) => x.check),
    ["citation", "number", "cause", "name"],
  );
});
