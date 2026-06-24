import test from "node:test";
import assert from "node:assert/strict";
import { chooseProjectId, matchingProjectState } from "./projectSelection.js";

const projects = [
  { id: "one", name: "One" },
  { id: "two", name: "Two" }
];

test("chooseProjectId keeps the selected project when refreshing the list", () => {
  assert.equal(chooseProjectId(projects, "two"), "two");
});

test("chooseProjectId uses a valid preferred project after creating one", () => {
  assert.equal(chooseProjectId(projects, "one", "two"), "two");
});

test("chooseProjectId falls back to first project when current id is missing", () => {
  assert.equal(chooseProjectId(projects, "missing"), "one");
});

test("matchingProjectState rejects stale project data", () => {
  const state = { project: { id: "one" }, tasks: [{ id: "task" }] };
  assert.equal(matchingProjectState(state, "two"), null);
  assert.equal(matchingProjectState(state, "one"), state);
});
