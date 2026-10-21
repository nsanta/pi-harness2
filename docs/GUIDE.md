# pi-harness2 guide

Related: **[Using pi-harness2 with Gentle AI](GENTLE-AI.md)** — patterns, boundaries, and
the division of labor between the two systems.

harness² is a method, not a model: instead of tuning the model, it tunes the *harness* —
the files around the model that shape its behavior. This package runs that method inside
a pi session: it proposes edits to your harness, probes each candidate on your real task
with headless child `pi` runs, composes the best-argued changes into one refined harness,
and remembers what worked.

```
            ┌────────────────────────────────────────────────┐
            │  your harness (.harness2/harness/)             │
            │  systemprompt · guardrails · memory · tool     │
            │  guidance · skills · scripts · extensions      │
            └───────────────┬────────────────────────────────┘
                            │ propose (k general + k domain lenses)
                            ▼
        candidate harnesses ──► probes: one headless pi run each
                            │            on YOUR task
                            ▼
                     judge each trajectory
                            │  (graded candidates only;
                            │   unavailable ≠ zero)
                            ▼
        compose: one merged tree, keep-base unless evidence
                            │
                            ▼
              runs/<task-slug>/<runid>/final ──► h2:adopt (your call)
                            │
                            ▼
        reflect → lessons → .harness2/library/<task>/
```

## Install

```bash
# from GitHub (default branch)
pi install https://github.com/nsanta/pi-harness2
# or pinned to a tag/commit via the git scheme
pi install git:github.com/nsanta/pi-harness2@<ref>

# for development: from a local checkout (loaded in place, not copied)
pi install ./pi-harness2
```

Requirements: pi ≥ 1.3 on PATH with a configured provider; Node ≥ 22. The package has
zero runtime npm dependencies. You pay model tokens only when a command runs the loop —
loading the extension is free.

## Quickstart

```text
/h2:init                                  # seed .harness2/ (idempotent)
/h2:run "Audit data/customers.csv against docs/schema.md and write audit/findings.md" --k 1
/h2:report                                # read the run report
/h2:adopt r-20260714-a1b2                 # promote the refined harness (backs up first)
/h2:run "Audit data/orders.csv the same way" --k 1   # library lessons apply here
```

## Commands

| Command | What it does |
|---|---|
| `/h2:init` | Create `.harness2/` with a starter harness (4 always-on files) and default `config.json`. Idempotent: existing files are never overwritten; skipped paths are reported. |
| `/h2:run "<task>" [--k N] [--mode parallel\|sequential]` | Run the loop. `--k` is the recursion budget (default from config, 1). Parallel probes k general + k domain candidates and composes once; sequential carries the refined tree through k steps. Archives everything under `runs/<task-slug>/<runid>/` (slug from the task text). |
| `/h2:adopt <runid>` | Replace the live harness with a run's composed tree. A one-time backup of the previous tree is kept at `harness.bak-<runid>` — including files the proposal deleted. Adoption is always explicit; a run never mutates your live harness. |
| `/h2:status` | Ledger tail (last 10 stages) + library entry count. |
| `/h2:report [runid]` | Render the markdown report for a run (latest if omitted). Falls back to a labeled ledger-tail summary when stage records are missing. |

The model can also drive a run itself via the `h2_run` tool (`task` required; optional
`k`, `mode`). Failures surface as `isError` tool results, never as thrown exceptions.

## Configuration

`.harness2/config.json` (all keys optional; environment overrides win):

| Key | Env | Default | Meaning |
|---|---|---|---|
| `channelModel` | `H2_CHANNEL_MODEL` | *(pi default)* | Model for proposer/reflector/judge one-shot calls |
| `solverModel` | `H2_SOLVER_MODEL` | *(pi default)* | Model for probe rollouts |
| `k` | `H2_K` | `1` | Recursion budget (candidates per lens / steps) |
| `mode` | `H2_MODE` | `parallel` | `parallel` (wide) or `sequential` (deep) |
| `wallSeconds` | `H2_WALL_SECONDS` | `900` | Per-probe wall timeout; the child is killed on expiry |
| `piBin` | `H2_PI_BIN` | `pi` | Binary used for probes and channel calls (tests use a stub) |

Invalid values throw naming the variable and the offending bytes — nothing silently
falls back.

## What a run costs and touches

- **Model calls**: 1 propose + 1 probe rollout + 1 judge per candidate slot, 1 compose,
  1 reflect per run. `--k 1` in parallel mode ≈ 5 calls; scale with k and task length.
- **Isolation**: probes run in disposable `mkdtemp` workspaces with `--no-extensions` and
  `--approve`; candidate skills/extensions never load into your interactive session.
  Stream, trajectory, judged stages, and the final tree are archived before cleanup.
- **Your project**: only `.harness2/` is written (plus whatever the probe itself does
  inside its own disposable workspace). Adoption into the live harness happens only via
  `/h2:adopt`.

## Use case: schema audit, twice

A small data team keeps receiving customer CSVs. The first audit went poorly: the
assistant eyeballed the file, invented two column checks, and buried the real finding.
The team wants the *harness* to make this kind of task reliable — not to babysit each run.

**1. Seed and tune the harness once.**

```text
/h2:init
```

Then a 3-minute manual edit of `.harness2/harness/guardrails.md` — this is your harness,
plain files:

```markdown
- Never fabricate column names, row counts, or findings. Quote the data.
- Deterministic checks belong in scripts/, not in the chat.
- Findings reports lead with the three most severe issues, then details.
```

**2. Run the loop on the real task.**

```text
/h2:run "Audit data/customers.csv against docs/schema.md. Write audit/findings.md
with: verified column-level conformance, row counts, duplicate-key check, and the
three most severe issues first." --k 1
```

What happens (abridged, illustrative output):

```text
h2:run: k=1 mode=parallel — 2 candidate slots
[general-1]  propose ok (1 edit: guardrails.md)          cost $0.011
[general-1]  probe ok — 14 tool calls, deliverable found  wall 212s
[general-1]  judge: partial (0.6) — "duplicate-key check missing"
[domain-1]   propose ok (2 edits: scripts/check_schema.py, guardrails.md)
[domain-1]   probe ok — 9 tool calls (script did the column checks)
[domain-1]   judge: pass (0.9) — "all four sections present, counts quoted"
compose: adopted candidate-1 (script + report-structure guardrail)
reflect: 3 lessons stored
report: .harness2/runs/customer-csv-audit/r-20260714-a1b2/report.md
```

The domain candidate won because it moved the mechanical checks into a `scripts/` helper
— exactly the kind of contrast the proposer is told to find and generalize.

**3. Read, then decide.**

```text
/h2:report r-20260714-a1b2
```

The report shows the stage table, the winning score, and what changed vs the base. The
composed tree sits at `runs/customer-csv-audit/r-20260714-a1b2/final/` — inspect the diff
before adopting.
Nothing has touched your live harness yet.

```text
/h2:adopt r-20260714-a1b2
h2:adopt: 2 file(s) changed (1 added, 1 modified, 0 deleted); previous tree kept at harness.bak-r-20260714-a1b2
```

**4. The next task starts smarter.**

```text
/h2:run "Audit data/orders.csv against docs/schema.md, same report format." --k 1
```

This run's proposals start from your adopted tree, and the reflector's lessons for the
customer audit are injected as experience: the very first candidate proposes the
`check_schema.py` pattern adapted to the orders schema, skipping the dead end the first
run explored. That is the second recursion of harness² — the improvement harness
compounding across tasks.

**5. Inspect the state.**

```text
.harness2/
├── harness/                  # the live harness you adopted
│   ├── systemprompt.md
│   ├── guardrails.md         # now carries the report-structure rule
│   ├── LongTermMEMORY.md
│   ├── tool_descriptions/tool_guidance.md
│   └── scripts/check_schema.py
├── library/customers-audit/  # adopted tree snapshot + lessons.md
├── runs/customer-csv-audit/  # grouped by task slug; per run: stream.jsonl,
│   └── r-20260714-a1b2/      # trajectory.md, stages.json, report.md, final/
│                             # report.md, final/
├── ledger.jsonl              # one stage row per line, append-only
└── config.json
```

Roll back any time: `cp .harness2/harness.bak-r-20260714-a1b2/* .harness2/harness/`.

## Writing good tasks

The loop amplifies task quality. A good task states the **deliverable** (file path),
the **inputs**, and what **done** means — the judge grades against exactly that. Compare:

- Weak: `"look at the customer data"` — nothing to judge, every candidate passes.
- Strong: the audit task above — conformance per column, row counts, duplicate check,
  severity-first ordering.

## Current limitations

- `sub_agents/` (c5) is reserved but not yet materialized into probes; candidate
  extensions (c8) are staged into workspaces but not loaded during probes.
- No benchmark adapters (JobBench/LAB/WorkBuddy) — this package targets open tasks with
  an LLM judge, not paper reproduction.
- Proposer/reflector/judge calls honor `channelModel`; empty means your pi default.
- The judge can be wrong; it quotes evidence so you can audit it, and `unavailable`
  judgements are excluded from decisions rather than counted as failures.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `h2:run failed: no harness tree at …` | Run `/h2:init` first. |
| `pi CLI not runnable` | Install pi (`npm install -g @earendil-works/pi-coding-agent`) or point `H2_PI_BIN` at it. |
| Probe fails with auth errors | Check the provider auth for `solverModel`; probes run with your pi credentials. |
| Every slot fell back | The task may be too large for `wallSeconds`; raise it, or shrink the task. Stage details are in `ledger.jsonl`. |
| Report says "ledger-tail summary" (warning) | `stages.json` is missing for that run (older run or interrupted); the ledger still has the rows. |
| `env H2_K: k is "abc"` | Environment overrides are validated strictly; unset or fix the variable. |
