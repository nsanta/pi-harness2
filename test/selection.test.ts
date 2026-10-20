import assert from "node:assert/strict";
import { test } from "node:test";
import { anonIds, isBase, orderGradedFirst, poolSlots } from "../src/selection.ts";

test("poolSlots yields k general slots then k domain slots", () => {
  assert.deepEqual(
    poolSlots(2).map((s) => s.variant),
    ["general", "general", "domain", "domain"],
  );
  assert.deepEqual(
    poolSlots(1).map((s) => s.variant),
    ["general", "domain"],
  );
  assert.deepEqual(poolSlots(0), []);
});

test("anonIds counts candidate-1..n, zero-padded to the width of n", () => {
  assert.deepEqual(anonIds(1), ["candidate-1"]);
  assert.deepEqual(anonIds(3), ["candidate-1", "candidate-2", "candidate-3"]);
  assert.deepEqual(anonIds(10), [
    "candidate-01",
    "candidate-02",
    "candidate-03",
    "candidate-04",
    "candidate-05",
    "candidate-06",
    "candidate-07",
    "candidate-08",
    "candidate-09",
    "candidate-10",
  ]);
  const ids = anonIds(10);
  assert.deepEqual([...ids].sort(), ids); // lexicographic order equals numeric order
});

test("isBase matches only the exact base label", () => {
  assert.equal(isBase("base"), true);
  assert.equal(isBase("base-2"), false);
  assert.equal(isBase("Base"), false);
  assert.equal(isBase("candidate-1"), false);
  assert.equal(isBase(""), false);
});

test("orderGradedFirst is a stable graded-first partition; the input is untouched", () => {
  const items = [
    {id: "a", graded: false},
    {id: "b", graded: true},
    {id: "c", graded: false},
    {id: "d", graded: true},
    {id: "e", graded: true},
  ];
  const out = orderGradedFirst(items, (i) => i.graded);
  assert.deepEqual(
    out.map((i) => i.id),
    ["b", "d", "e", "a", "c"],
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ["a", "b", "c", "d", "e"],
  );
});

test("orderGradedFirst keeps everything when nothing (or everything) is graded", () => {
  const all = [1, 2, 3];
  assert.deepEqual(orderGradedFirst(all, () => false), [1, 2, 3]);
  assert.deepEqual(orderGradedFirst(all, () => true), [1, 2, 3]);
});
