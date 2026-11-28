import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAnswer, claimedActions, claimedProposal, nonRecordCitations, statedCauses, unknownRoles, unknownTeams, unsupportedNumbers } from "../eval/checks.ts";

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
  // The same wait in other units: seconds from a rule given in minutes, and minutes and seconds spelled out.
  const lane = JSON.stringify({ now: { avgWaitSeconds: 199 }, rule: "Open another lane when the wait reaches 3 minutes." });
  assert.deepEqual(unsupportedNumbers("The wait is 199 s (3 min 19 s), past the 3 minutes (180 s) rule.", lane), []);
  assert.deepEqual(unsupportedNumbers("The wait is 3 min 40 s.", lane), ["40"]);
});

test("an answer may not give a cause the records don't", () => {
  assert.deepEqual(statedCauses("The tag is wrong, likely because the price file changed overnight.", tools), ["likely", "because"]);
  assert.deepEqual(statedCauses("The records don't say why. Replenish by likely lost sales.", tools), []);
  assert.deepEqual(statedCauses("The forecast can't say which shelves are likely to run out yet.", tools), []);
  // A cause word is fine when what follows it is the cause a record gave.
  const cancelled = JSON.stringify({ outcome: "No backroom stock. The facing needs a store order." });
  assert.deepEqual(statedCauses("Its task was cancelled due to no backroom stock.", cancelled), []);
  assert.deepEqual(statedCauses("All other facings have cancelled tasks due to \"No backroom stock\" and need store orders.", cancelled), []);
  assert.deepEqual(statedCauses("Its task was cancelled due to a late delivery.", cancelled), ["due to"]);
});

test("team names must come from the tool results", () => {
  assert.deepEqual(unknownTeams("The Price integrity team has the fix task.", tools), []);
  assert.deepEqual(unknownTeams("Ask the pricing team, or the store team.", tools), ["pricing team"]);
});

test("roles, systems and vendors must come from the tool results or the question", () => {
  assert.deepEqual(unknownRoles("Ask the front-end lead, or check the vendor portal.", tools), ["lead", "vendor", "portal"]);
  assert.deepEqual(unknownRoles("The Price integrity team has it; this leads the list. Lead with the promoted items.", tools), []);
  // A key such as vendorStatus doesn't name a vendor, but a value does.
  assert.deepEqual(unknownRoles("The vendor marked it open.", JSON.stringify({ vendorStatus: "Open" })), ["vendor"]);
  assert.deepEqual(unknownRoles("The vendor marked it open.", JSON.stringify({ note: "vendorStatus is the vendor's status" })), []);
  assert.deepEqual(unknownRoles("Your store manager can approve it.", tools, "What should my store manager do?"), []);
});

test("only record ids go in citation brackets", () => {
  assert.deepEqual(nonRecordCitations("Two are open [inc-20261117-000004, task-20261117-000010-v2]."), []);
  assert.deepEqual(nonRecordCitations("Three exceptions [checkout_incidents]; see [the guide](https://example.com)."), ["[checkout_incidents]"]);
});

test("an answer may propose a task but never say it raised one", () => {
  assert.deepEqual(claimedActions("I proposed two replenishment tasks; approve them below."), []);
  assert.deepEqual(claimedActions("I've created a replenishment task, and the task has been assigned to Dairy."), ["I've created", "task has been assigned"]);
  assert.deepEqual(claimedActions("Two tasks have been raised for the Grocery team."), ["tasks have been raised"]);
});

test("every finding for an answer, including citations the tools didn't return", () => {
  const f = checkAnswer({ text: "6 tags are wrong because of a bad price file [shelf_tag_issues]. Ask the merchandising team or your supervisor.", unverified: ["so-20261117-999999"] }, tools);
  assert.deepEqual(
    f.map((x) => x.check),
    ["citation", "number", "cause", "name", "role", "citation"],
  );
});

test("an answer that says it proposed a task, with none proposed, is caught", () => {
  assert.equal(claimedProposal("Proposed replenishment tasks for the Grocery team:", 0), "Proposed replenishment");
  assert.equal(claimedProposal("I proposed one replenishment task.", 1), undefined);
  assert.equal(claimedProposal("Nothing needs a task right now.", 0), undefined);
});

test("a wait written as minutes and seconds matches the seconds the tools gave", () => {
  const tools = JSON.stringify({ avgWaitSeconds: 199 });
  assert.deepEqual(unsupportedNumbers("Average wait is 199 seconds (3:19).", tools), []);
  assert.deepEqual(unsupportedNumbers("Average wait is 4:05.", tools), ["4:05"]);
});

test("the 15 minutes of a ZoneMetric and 'the other N' of a count the tools gave aren't new numbers", () => {
  assert.deepEqual(unsupportedNumbers("The latest 15-minute interval shows 12 in line.", '{"inLine":12}'), []);
  assert.deepEqual(unsupportedNumbers("All other 16 out-of-stock facings need store orders.", '{"outOfStock":17}'), []);
  assert.deepEqual(unsupportedNumbers("16 facings are out.", '{"outOfStock":17}'), ["16"]);
  assert.deepEqual(unknownTeams("each assigned team places a store order", ""), []);
});

test("the store manager who approves a proposal isn't a new role", () => {
  assert.deepEqual(unknownRoles("I proposed it; it waits for the store manager's approval.", "{}"), []);
  assert.deepEqual(unknownRoles("Proposed tasks (awaiting store-manager approval):", "{}"), []);
  assert.deepEqual(unknownRoles("Ask the department manager.", "{}"), ["manager"]);
});
