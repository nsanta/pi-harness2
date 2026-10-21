# Feature: harness2 ↔ okf_god bridge (independent, together)

Principle (user-directed): both extensions must work **independently** — fully functional
without the other — and work **together** through one narrow, explicit contract.

## The contract (the ONLY coupling)

harness² publishes conformant **OKF v0.2 artifacts** into locations okf_god already
indexes by default. There is no API, import, event, or shared state between the packages.

| Direction | Mechanism | Independence guarantee |
|---|---|---|
| harness2 → okf_god | `/h2:publish <runid>` (opt-in) writes the run's lessons as an OKF doc to `<docsDir>/harness2/<task-slug>.md` (default docsDir `docs`) | okf_god absent → the file is still valid markdown+frontmatter, readable by humans and pi. harness2 absent → okf_god indexes other things. |
| Lesson trust | Frontmatter `verified: [{by: "h2:run/<runid>", at: <iso>}]` when the run's best verdict is `pass` | okf_god derives `machine-confirmed` from the verifier list (§5.2) — the graded run IS the machine verification. `partial` → no verifier → `unverified`. Humans add `human:<id>` verifiers by editing the file → `human-reviewed`. |
| Skills | Seed SKILL.md stubs document OKF lifecycle fields (`stale_after`, `generated.at`) as optional frontmatter | pi parses its own fields; okf_god tolerates extra fields (§11); probes unaffected (`--no-extensions`). |

## Independence guarantees (enforced, tested)

1. Zero runtime deps in pi-harness2 (no okf_god import, ever).
2. Library, runs, commands all function with plain markdown; OKF frontmatter is additive.
3. Publish is opt-in and never touches the harness loop's behavior.
4. Probes stay `--no-extensions`: OKF benefits accrue to the proposer/reflector layer and
   interactive sessions, never to probe rollouts.

## Tasks

- [ ] T1 `library.ts`: `emitLesson({taskSlug, runId, verdict, body})` → OKF frontmatter +
      body; verifier mapping pass→`h2:run/<runid>`, partial/fail→none; `generated.at` ISO.
- [ ] T2 `recursion.ts`: `reflectAndStore` stores the emitted lesson (frontmatter included)
      via Library; reflect() body contract updated in `prompts.ts` (markdown only, evidence
      links; NO frontmatter from the model — the wrapper owns it).
- [ ] T3 `config.ts` + `extension.ts`: `publish.docsDir` (default `docs`) +
      `/h2:publish <runid>` writing the lesson doc for a resolved run; notify path; opt-in,
      never automatic.
- [ ] T4 Tests: emitLesson mapping (pass/partial), publish command happy path + opt-out
      default (no docs writes without the command), independence (no okf_god import; grep).
- [ ] T5 `docs/INTEGRATION-OKF.md`: the contract doc (this table, expanded); README link.

## Constraints

- OKF v0.2 field names exactly as okf_god reads them: `type`, `resource`, `status`,
  `stale_after`, `generated.at`, verifier list per §5.2 (bare `{by, at}` tolerated).
- Status field: harness lessons use `stable` (absent also fine); staleness via
  `stale_after` left to authors, not automation, in this phase.
- Zero new deps; width ≤ 100; canonical test command unchanged.

## Evidence log

- OKF bridge (user-directed: independent extensions, together by contract): commits
  2f78d68 (feat library/OKF emission), d88dbae (feat publish + independence guard test),
  68051fe (docs contract + feature plan). Suite 93/93.
- Verify found one real interop defect: flat `generated.at:` vs the consumer's nested
  `generated:{by,at}` mapping — fixed in emitLesson and proven empirically through
  okf_god's own parser: pass → machine-confirmed + generatedAt read; partial → unverified.
  The independence grep guard correctly rejected my first fix (comment named the consumer
  inside src/) — reworded.
- (pending — record commit ids per closed group)
