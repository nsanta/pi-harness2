# pi-harness2

The harness² method as a native pi package: instead of hand-tuning your agent's harness
(system prompt, guardrails, skills, memory), the package runs a propose → probe → compose
loop that adapts the harness for a task, remembers what worked, and lets you adopt the
result with one command.

**Full guide with a worked use case: [docs/GUIDE.md](docs/GUIDE.md).**
**Using it together with Gentle AI: [docs/GENTLE-AI.md](docs/GENTLE-AI.md).**

- **Propose** — candidate edits to the harness tree, from two lenses (general and
  task-domain).
- **Probe** — each candidate runs headlessly on your task in a throwaway workspace.
- **Compose** — the judged candidates are anonymized and merged into one final tree.
- **Remember** — distilled lessons are stored in a per-task library for future runs.

## Install

```bash
pi install /path/to/pi-harness2        # local checkout
pi install git+https://…/pi-harness2   # or a git URL
```

Requires pi (the `pi` binary on PATH) and Node >= 22. Zero runtime dependencies.

## Quickstart

```bash
/h2:init                       # seed .harness2/ with the starter harness + config
/h2:run "fix the flaky login test" --k 1    # one parallel round (model calls cost money)
/h2:adopt r-20251020-cafe      # make the run's final tree the live harness (backup kept)
/h2:status                     # ledger tail + library size
```

`h2:report [runid]` (re)writes `runs/<runid>/report.md`; the model can also call the
`h2_run` tool directly with `{task, k?, mode?}`.

## State layout

Everything lives under `.harness2/` (default; see Configuration):

```
.harness2/
  config.json        # optional settings file
  harness/           # the live harness tree (systemprompt.md, guardrails.md, skills/, …)
  harness.bak-<id>/  # one-time pre-adopt backup of the previous tree
  ledger.jsonl       # one JSON line per run stage (audit trail)
  runs/<runid>/      # stream.jsonl, trajectory.md, final/, report.md, stages.json
  library/<slug>/    # adopted tree snapshot + lessons.md + entry.json per task
```

## Configuration

`<stateDir>/config.json` (partial merges over defaults), then `H2_*` env vars win.
Invalid values fail loudly with the offending key or variable named.

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `channelModel` | `H2_CHANNEL_MODEL` | `""` (pi default) | Model pattern for propose/compose |
| `solverModel` | `H2_SOLVER_MODEL` | `""` (pi default) | Reserved for a future solver lane |
| `k` | `H2_K` | `1` | Slots per lens (parallel) or steps (sequential), integer > 0 |
| `mode` | `H2_MODE` | `parallel` | `parallel` (width) or `sequential` (depth) |
| `wallSeconds` | `H2_WALL_SECONDS` | `900` | Wall budget per channel call, seconds |
| `piBin` | `H2_PI_BIN` | `pi` | pi binary used for probes and channel calls |

## Design invariants

- **Probe isolation** — candidates run in throwaway temp workspaces; the live harness is
  never touched until you adopt.
- **Anonymization** — the composer sees `candidate-1..n`, never lens labels; judgement
  cannot leak into composition.
- **Unavailable ≠ zero** — a failed or unjudgeable candidate is excluded from composition
  and best-so-far, never scored as 0. A failed reflection never fails a run.
- **Leak guard** — task-facing prompts never name the method's machinery; evidence flows
  one way (trajectory → judge/composer).
- **Deterministic reports** — `renderRunReport` is a pure function of stages + result; no
  timestamps are injected.
- **Adopt is explicit and reversible** — the previous tree is backed up once at
  `harness.bak-<runid>` before replacement.

## Honest limitations

- **c5 subagents are stubbed** — the tree carries `sub_agents/README.md` prose only.
- **c8 candidate extensions are staged but not loaded during probes** — probes run with
  `--no-extensions`, so extension levers are proposed, never measured.
- **No benchmark adapters** — judgement is an LLM rubric judge, not a grader; scores are
  opinions with evidence, not measurements.
- **Model cost** — every `h2:run` makes real channel calls (propose, judge, compose,
  reflect per candidate); `--k` multiplies it.
- Fingerprints are sha256 and not comparable with the Python core's sha1 runmarks.
