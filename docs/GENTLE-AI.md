# Using pi-harness2 with Gentle AI

Gentle AI (el Gentleman) and pi-harness2 solve different problems and compose cleanly:

| | Gentle AI | pi-harness2 |
|---|---|---|
| Governs | **Process** — how work is authorized, tracked, delegated, verified, reviewed (ODD, subagents, RDD) | **Capability** — how well your agent executes a recurring task type (harness refinement) |
| State | `odd/` feature docs, review receipts, OpenSpec | `.harness2/` (harness, library, runs, ledger) |
| Improves | The development workflow itself | The files around the model for one task shape at a time |

They share a pi session without collision: disjoint command namespaces (`/sdd-*`, skills,
workers vs `/h2:*`), disjoint state directories. Install both; nothing conflicts.

## Setup checklist

1. Gentle AI installed (it governs the session you are reading this in).
2. `pi install /home/you/projects/pi-harness2` (or the git source).
3. In any project: `/h2:init` when you are ready to tune a task type. `odd/` and
   `.harness2/` stay independent — never point one at the other.

## Pattern 1 — build with Gentle AI, tune execution with harness²

Use ODD as usual to build a feature. When a *recurring task shape* appears (audits,
runbooks, release notes, changelog triage), spin one representative instance through the
loop:

```text
/h2:run "<representative task with a concrete deliverable>" --k 1
/h2:report
/h2:adopt <runid>
```

The adopted harness encodes the contrasts the loop found (helper scripts over manual
repetition, report structure, anti-fabrication guardrails). Future instances of that task
shape — run through `/h2:run` — start from that harness instead of rediscovering it.

## Pattern 2 — harnessing as a tracked ODD feature

A tuning session is real work; track it like any other feature. In an ODD session, the
parent creates `odd/tasks/tune-audit-harness.md` with tasks such as:

- [ ] Pick the representative task and rubric
- [ ] `/h2:run --k 1`, inspect the report
- [ ] Independent check of the run evidence before adoption
- [ ] `/h2:adopt`, then a second run to confirm lessons apply

The verification step fits `gentle-ai-verify` naturally: it is read-only, reads
`runs/<task-slug>/<runid>/report.md`, `stages.json`, and
`library/<task>/lessons.md`, and confirms
the judgement quotes real evidence before **you** adopt. Adoption stays a human decision —
both systems are built on that same rule.

## Pattern 3 — chain Judgment Day after a tuned harness

The two evaluation layers are complementary:

- harness² improves the **generator** (behavioral contrasts across probe runs).
- Judgment Day blind-reviews a **deliverable** (dual adversarial reviewers, scoped fix
  rounds).

Chain them on high-stakes artifacts: tune the audit harness with h2, produce the critical
audit, then run Judgment Day on the audit itself. Do not use h2 as a deliverable reviewer —
its judge scores a probe trajectory to steer harness edits, not to certify a final
artifact.

## Making an adopted harness benefit daily Gentle AI sessions (today: manual)

`/h2:adopt` updates `.harness2/harness/`, which shapes **future h2 runs**. It does not
change your interactive sessions — Gentle AI keeps running under your normal `AGENTS.md`
and skills. To carry a refined harness into daily work, mirror it by hand:

```bash
# guardrails: append the adopted rules you want project-wide
cat .harness2/harness/guardrails.md >> AGENTS.md        # review before committing
# skills and scripts: stage into pi's Agent Skills location
cp -r .harness2/harness/skills/<name> .agents/skills/
cp .harness2/harness/scripts/<helper>.py scripts/
```

A `/h2:export <runid>` command to automate this merge (always-on content into `AGENTS.md`
sections, skills into `.agents/skills/`, with a reviewable diff) is **planned, not
shipped** — this manual step is the current contract.

## Isolation rules — keep these true

- **Probes are plain pi.** They run with `--no-extensions` in disposable workspaces, so
  Gentle AI extensions do not load during probes. That is the experiment's control
  condition: you are measuring the harness, not your tooling. Do not "fix" this.
- **Two state stores, never merged.** `odd/` is process history; `.harness2/` is harness
  state. A feature doc may *reference* a run id; the run artifacts stay in `.harness2/`.
- **Adoption is always explicit**, in both systems: harness changes via `/h2:adopt`,
  code delivery via your ordinary git policy and (optionally) native review.

## Division of labor cheat sheet

| Question | Reach for |
|---|---|
| "How do I structure this work?" | Gentle AI (ODD authorize → explore → classify → track) |
| "Who implements/verifies this?" | Gentle AI (`gentle-ai-worker`, `gentle-ai-verify` delegation) |
| "Why is the agent bad at this *kind* of task?" | harness² (`/h2:run`, read the contrasts) |
| "Should we keep this harness change?" | You, after `/h2:report` — then `/h2:adopt` |
| "Review this diff before merge?" | Gentle AI native review (RDD) |
| "Certify this critical deliverable?" | Judgment Day |
| "Did the tuned harness actually help the next task?" | Compare runs in `.harness2/runs/` + the library's lessons |

## Known integration limits

- The mirror step in "Making an adopted harness benefit daily sessions" is manual until
  `/h2:export` ships.
- Probes cannot use your installed Gentle AI packages (by design — see isolation rules).
- h2's judge and Judgment Day answer different questions; neither substitutes for the other.
