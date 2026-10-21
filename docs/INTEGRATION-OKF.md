# Integrating with okf_god (OKF v0.2)

harness² and okf_god are independent tools that work together through exactly one contract:
harness² can publish a run's stored lessons as a conformant OKF v0.2 markdown document into
a directory okf_god already indexes. There is no API, import, event, or shared state
between the packages, and publishing never happens automatically.

## Independence guarantees (enforced, tested)

1. **Zero runtime dependencies** — pi-harness2 never imports or references okf_god; a test
   greps every `src/*.ts` for it (`test/extension.test.ts`, "grep-clean").
2. **Plain markdown everywhere** — the library, runs, and every command work with plain
   markdown; OKF frontmatter is additive output on stored lessons and published docs.
3. **Opt-in publishing** — only `/h2:publish` writes outside `.harness2/`, and it never
   changes the harness loop's behavior.
4. **Probes stay `--no-extensions`** — OKF benefits accrue to the proposer/reflector layer
   and interactive sessions, never to probe rollouts.

## The coupling

| Direction | Mechanism | Guarantee |
| --- | --- | --- |
| harness2 → okf_god | `/h2:publish` writes the stored lesson to `<docsDir>/harness2/<slug>.md` | Valid markdown+frontmatter with or without either package. |
| Lesson trust | `verified: [{by: "h2:run/<runid>", at: <iso>}]` only on a `pass` best (score >= 0.8) | okf_god derives `machine-confirmed` from the verifier list. |

- Publishing is opt-in and per-task: `/h2:publish "[<task-slug>/]<runid>"` writes the task's
  stored lesson to `<docsDir>/harness2/<task-slug>.md`. The docsDir defaults to `docs`;
  override it with `publish.docsDir` in config.json or the `H2_DOCS_DIR` env var.
- okf_god absent → the file is still valid markdown+frontmatter, readable by humans and pi.
  harness2 absent → okf_god indexes everything else.
- `partial`/`fail` → no verifier → `unverified`. A human who edits a published file and
  adds a `human:<id>` verifier makes it `human-reviewed`.

## Emitted frontmatter

`emitLesson` hand-builds the block (no YAML dependency, fixed key order, one ISO instant
shared by `generated.at` and the verifier's `at`):

```yaml
---
type: doc
resource: harness2-lessons-<task-slug>
status: stable
generated:                     # OKF §5.2 nested mapping (by + at)
  by: "h2:run/<runid>"
  at: 2025-10-20T12:00:00.000Z
verified:                       # ONLY when the best verdict is pass (score >= 0.8)
  - by: "h2:run/<runid>"
    at: 2025-10-20T12:00:00.000Z
stale_after: 2025-11-20T00:00:00.000Z    # only when the author set it
---
<markdown lessons>
```

A run whose best verdict is `partial` or `fail` emits the same block WITHOUT `verified:`.
No other fields are ever emitted; okf_god tolerates unknown fields (§11), but harness²
adds none beyond the six above. The lesson body itself is markdown only — the reflector
is contractually forbidden from emitting frontmatter or HTML; the wrapper owns identity.

## Trust mapping

| Stored lesson state | File content | okf_god tier |
| --- | --- | --- |
| Best `pass`, score >= 0.8 | `verified: [{by: "h2:run/<runid>", ...}]` | machine-confirmed |
| Best verdict `partial` / `fail` | no `verified:` key | unverified |
| Human edit adds `- by: "human:<id>"` | verifier list gains a human entry | human-reviewed |

`/h2:publish` reports the tier it sees in the stored lesson (machine-confirmed or
unverified); it never fabricates a verifier to make a lesson look confirmed.

## What each side guarantees alone

**harness² without okf_god** — lessons are ordinary markdown in `.harness2/library/`; the
library, `/h2:adopt`, `/h2:report`, and the whole propose–probe–compose loop behave
identically; a published file is just a doc in your docs tree.

**okf_god without harness²** — indexing, search, and lifecycle handling simply ignore the
`harness2/` subtree; nothing in okf_god requires harness² to be installed.

## Consuming from okf_god

1. Run `/h2:publish "<task-slug>/<runid>"` once per task whose lessons you want indexed.
2. Point okf_god at your docs root as usual; `okf_search /harness2-lessons` finds the
   published docs.
3. Trust follows the frontmatter verifier list: run verifier → machine-confirmed, human
   verifier → human-reviewed, none → unverified. The file is yours once published.
