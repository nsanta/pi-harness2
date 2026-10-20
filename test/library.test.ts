import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callChannel, type CallChannelOptions } from "../src/channel.ts";
import { Library, reflect, slugify } from "../src/library.ts";
import { fingerprint } from "../src/tree.ts";
import type { ChannelReply, Tree } from "../src/types.ts";

const TREE_A: Tree = {"systemprompt.md": "a\n"};
const TREE_B: Tree = {"systemprompt.md": "b\n", "guardrails.md": "- rule\n"};

/** A fresh library under a temp stateDir, cleaned up by the caller. */
function tmpLib(): {lib: Library; root: string} {
  const root = mkdtempSync(join(tmpdir(), "h2-lib-"));
  return {lib: new Library(root), root};
}

function withCleanup(root: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .finally(() => rmSync(root, {recursive: true, force: true}));
}

test("add roundtrips tree, lessons and entries; the fingerprint ties the exact bytes", () => {
  const {lib, root} = tmpLib();
  return withCleanup(root, () => {
    lib.add({taskSlug: "Task One", tree: TREE_A, lessons: "# lesson", summary: "first"});
    assert.deepEqual(lib.treeOf("task-one"), TREE_A);
    assert.equal(lib.lessonsOf("task-one"), "# lesson");
    const entries = lib.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.taskSlug, "task-one");
    assert.equal(entries[0]!.summary, "first");
    assert.equal(entries[0]!.fingerprint, fingerprint(TREE_A));
    assert.match(entries[0]!.created, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(lib.treeOf("missing"), null);
    assert.equal(lib.lessonsOf("missing"), null);
    assert.equal(lib.entries().length, 1); // "missing" lookups created nothing
  });
});

test("slugify is filesystem-safe and never empty", () => {
  assert.equal(slugify("Reconcile the Ledger/2024 Q1"), "reconcile-the-ledger-2024-q1");
  assert.equal(slugify("  ..//..  "), "task");
  assert.equal(slugify(""), "task");
});

test("retain keeps only the listed slugs; forget removes exactly the listed ones", () => {
  const {lib, root} = tmpLib();
  return withCleanup(root, () => {
    for (const s of ["alpha", "beta", "gamma"]) {
      lib.add({taskSlug: s, tree: TREE_A, lessons: "l", summary: s});
    }
    assert.deepEqual(lib.retain(["alpha", "gamma"]), ["alpha", "gamma"]);
    assert.deepEqual(
      lib.entries().map((e) => e.taskSlug),
      ["alpha", "gamma"],
    );
    assert.ok(!existsSync(join(lib.dir, "beta")));
    assert.deepEqual(lib.forget(["alpha"]), ["gamma"]);
    assert.ok(!existsSync(join(lib.dir, "alpha")));
    assert.deepEqual(lib.forget(["nope"]), ["gamma"]); // unknown slugs are ignored
  });
});

test("rebuildIndex writes one '- slug: summary' line per entry, slug-sorted", () => {
  const {lib, root} = tmpLib();
  return withCleanup(root, () => {
    lib.add({taskSlug: "zulu", tree: TREE_A, lessons: "l", summary: "last words"});
    lib.add({taskSlug: "alpha", tree: TREE_A, lessons: "l", summary: "first words"});
    const text = lib.rebuildIndex();
    assert.deepEqual(
      text.split("\n").filter((l) => l.startsWith("- ")),
      ["- alpha: first words", "- zulu: last words"],
    );
    assert.equal(readFileSync(join(lib.dir, "index.md"), "utf8"), text);
  });
});

test("add overwrites an existing slug atomically and leaves exactly one entry", () => {
  const {lib, root} = tmpLib();
  return withCleanup(root, () => {
    lib.add({taskSlug: "dup", tree: TREE_A, lessons: "old", summary: "old"});
    lib.add({taskSlug: "dup", tree: TREE_B, lessons: "new", summary: "new"});
    assert.deepEqual(lib.treeOf("dup"), TREE_B);
    assert.equal(lib.lessonsOf("dup"), "new");
    const entries = lib.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.fingerprint, fingerprint(TREE_B));
    assert.equal(entries[0]!.summary, "new");
    // No staging or retired residue is left behind.
    const residue = readdirSync(lib.dir).filter((n) => n.startsWith("."));
    assert.deepEqual(residue, []);
    assert.ok(existsSync(join(lib.dir, "dup", "entry.json")));
  });
});

test("reflect returns lessons; any failure returns empty, never throws", async () => {
  const good: ChannelReply = {
    ok: true,
    text: JSON.stringify({lessons: "# shared lesson"}),
    costUsd: 0.01,
    raw: "",
    attempts: 1,
  };
  const calls: CallChannelOptions[] = [];
  const lessons = await reflect({
    task: "t",
    trajectory: "traj",
    tree: TREE_A,
    model: "m",
    wallSeconds: 5,
    channel: async (opts: CallChannelOptions): Promise<ChannelReply> => {
      calls.push(opts);
      return good;
    },
  });
  assert.equal(lessons, "# shared lesson");
  assert.ok(calls[0]!.system.includes("VERBATIM"));
  assert.ok(calls[0]!.mission.includes("# THE FINAL HARNESS"));

  const bad: ChannelReply = {ok: true, text: "garbage", costUsd: 0.01, raw: "", attempts: 1};
  const badCall = async (): Promise<ChannelReply> => bad;
  const badInput = {
    task: "t",
    trajectory: "traj",
    tree: TREE_A,
    model: "m",
    wallSeconds: 5,
    channel: badCall,
  };
  assert.equal(await reflect(badInput), "");
  const throwing = async (): Promise<ChannelReply> => {
    throw new Error("channel down");
  };
  const thrownCall = {
    task: "t",
    trajectory: "traj",
    tree: TREE_A,
    model: "m",
    wallSeconds: 5,
    channel: throwing,
  };
  assert.equal(await reflect(thrownCall), "");
});
