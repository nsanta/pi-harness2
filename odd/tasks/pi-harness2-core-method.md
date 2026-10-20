# Feature: pi-harness2 — the harness² method as a native pi package

Port the harness² recursive-harnessing method (google-research/harness2, Apache-2.0) from
Python to a TypeScript pi package, so a pi session can harness itself: propose harness
edits, probe them with headless child pi rollouts, compose refinements from behavioral
contrasts, and accumulate a persistent experience library.

Reference implementation (read-only): `~/projects/harness2-pi/upstream` (our clone,
branch feat/pi-substrate — also carries our verified pi headless contract).

## Non-goals

- No benchmark adapters (JobBench/LAB/WorkBuddy) — generic tasks + LLM judge instead.
- No Python dependency; no transliteration of Python idioms — reimplement against pi
  primitives, keeping the c1–c8 tree and `[ACTION]/[OBSERVATION]/[ERROR]` grammar as the
  compatibility contracts.

## Architecture

**Package**: npm name `pi-harness2`, standard pi package (`pi` manifest in package.json,
`extensions/` entry). Zero runtime deps beyond Node builtins. Loaded via
`pi install git:…` or path.

```
package.json          pi manifest: extensions:["./src/extension.ts"]
src/
  extension.ts        commands: /h2:init /h2:run /h2:status /h2:report; tool: h2_run
  config.ts           .harness2/config.json + env overrides (models, k, budgets)
  types.ts            Tree, SurfaceSpec, Stage, Reply, Lesson, Ledger types
  tree.ts             c1–c8 surface: read/write/validate/fingerprint/diff (port of core/tree.py)
  runner.ts           headless child pi: argv builder, spawn, JSONL capture, trajectory
                      renderer (port of our verified substrate/pi.py contract)
  channel.ts          one-shot proposer/reflector/composer calls via `pi --print` with
                      retry, wall timeout, cost tracking, JSON repair (port of Proposer.call)
  prompts.ts          method text: pi surface docs, invariant/domain edit templates,
                      generalize/compose, evidence boundary, leak guard (port of prompts.py)
  proposer.ts         propose + compose orchestration over the channel
  selection.ts        anonymous candidate ids, pool building (port of selection.py)
  recursion.ts        stages, run_parallel, run_sequential, ledger (port of recursion.py)
  library.ts          persistent adopted harnesses + lessons, index (port of library.py)
  judge.ts            generic LLM-as-judge + deliverable extraction
  report.ts           human-readable run report
test/                 node:test suite + stub-pi executable fixture (offline)
```

**State layout** (in the target project, NOT temp): `.harness2/`
- `harness/` — current adopted c1–c8 tree (pi-native files)
- `library/<slug>/` — per-task experience: adopted tree snapshot + lessons.md
- `runs/<runid>/` — probe streams (stream.jsonl), trajectories, judgments
- `ledger.jsonl` — append-only stage records
- `config.json`

**Isolation invariants** (hard requirements):
1. Probes always execute in `mkdtemp` workspaces, never in the user's project — candidate
   extensions/skills must never leak into the interactive session (pi project extension
   discovery would auto-load them).
2. Probe argv contract (verified against pi 1.3.0): `pi --print --mode json
   --no-extensions --session-dir <ws>/sessions --session-id <id> --approve --model <m>`
   + one `--append-system-prompt <file>` per staged always-on file + prompt last.
   Candidate c6 skills stage to `<ws>/.agents/skills/`; c8 plugins stage to
   `<ws>/.pi/extensions/` (only loaded if the candidate declares them; loaded via
   explicit `-e` — deferred unless trivial).
3. Channel calls are separate one-shot `pi --print` runs, never the interactive session.
4. Anonymous candidate ids toward the proposer (bias control, from selection.py).

**Method mapping** (Python → TS):
- Proposer `_claude_cli/_opencode` → `channel.ts` (single mechanism: pi subprocess).
- `_INV_TEMPLATE`/`_DOM_TEMPLATE`/`GENERALIZE`/`EVIDENCE_BOUNDARY`/leak guard → prompts.ts,
  rewritten for the pi surface (systemprompt/guardrails/memory/tool-guidance/skills/
  scripts/extensions; c5 subagents stubbed with a documented gap).
- `run_parallel` (probe k general + k domain candidates, k compositions) and
  `run_sequential` (carry refined harness + evidence through k steps) → recursion.ts.
- `Library.add/retain/forget` + index → library.ts (adopted tree snapshot + lessons.md).
- Bench judge → generic LLM judge: rubric = task text + optional user rubric file; verdict
  JSON with pass/partial/fail + evidence quotes; never cached as zero on failure.

## Tasks

- [x] G1 Foundation: scaffold package + types + tree.ts + runner.ts + channel.ts;
      node:test suite with stub-pi fixture (argv contract, tree validation, JSONL→grammar,
      channel JSON repair) — 14 tests green; verify agent 7/7 PASS, READY_TO_COMMIT
- [x] G2 Method text: prompts.ts (pi surface docs, INV/DOM/generalize templates, evidence
      boundary, leak guard) + proposer.ts (propose/compose, retries, audit) — 11 tests;
      suite 25/25; verify 7/7 PASS (adjudicated: odd/ doc diff is parent bookkeeping)
- [ ] G3 Engine: selection.ts + recursion.ts (parallel/sequential, stages, ledger) +
      library.ts + judge.ts
- [ ] G4 Surface: extension.ts commands + h2_run tool + config.ts + report.ts + README +
      full-suite green
- [ ] G5 (user-gated, model cost) live smoke: /h2:init + one /h2:run k=1 on a toy task

Constraints: Conventional Commits per work unit; tests alongside code in every group;
runner: `node --test "test/*.test.ts"` (directory-arg form `node --test test/` does not
expand on any installed node — verified environmental finding, G1); line width ≤ 100; no
runtime deps; TypeScript strict semantics under jiti (no build step). Reference paths for
workers: Python core at
`~/projects/harness2-pi/upstream/harness2/core/`, our verified substrate at
`~/projects/harness2-pi/upstream/harness2/substrate/pi.py`, pi docs at
`/home/nicolas/.local/share/mise/installs/node/22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/`.

## Evidence log

- G1 verification (gentle-ai-verify): 7/7 PASS. Compat contracts byte-match pi.py
  (argv, grammar incl. TRUNC_FMT, PI_SURFACE constants + stub prose); zero-dep proven;
  kill-on-timeout is real SIGTERM→SIGKILL; parsePiJson never throws.
- Parent decisions on verifier flags: (1) odd/ doc committed as its own docs commit;
  (2) `pi.extensions` manifest key removed until G4 lands src/extension.ts (every commit
  stays loadable); (3) fingerprint stays sha256 — Python runmark.py uses sha1, so
  fingerprints are NOT cross-language comparable (documented, not a requirement).
- G2 commits: (pending ids — feat(prompts), feat(proposer), docs evidence).
- G2 verification: 25/25 green; semantics parity confirmed against prompts.py (INV/DOM/
  GENERALIZE/_KEEP_BASE); leak guard clean in all task-facing text; retry budget exactly 2;
  no OpenCode residue in SURFACE_DOC (single JSDoc port note only, developer-facing).
