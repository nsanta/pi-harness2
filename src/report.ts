/** The deterministic markdown run report: same stages and result in, same bytes out — no
 * timestamps, no wall-clock, no map-order dependence. It is what h2:run shows the user and
 * what h2:report archives as runs/<runid>/report.md. */

import type { ModeResult, Stage } from "./recursion.ts";
import { diffTrees } from "./tree.ts";
import type { Tree } from "./types.ts";

export interface RunReportInput {
  runId: string;
  mode: string;
  k: number;
  stages: Stage[];
  result: ModeResult;
  task: string;
  /** The tree the run started from. When present together with a final tree, the report
   * gains a "Changed files vs base" section; without it the section is skipped. */
  baseTree?: Tree;
}

/** Markdown-safe cell: pipes escaped, newlines flattened. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function changedLine(rel: string, before: Tree, after: Tree): string {
  const was = before[rel];
  const now = after[rel];
  if (was === undefined) return `- ${rel}: added (+${(now ?? "").length} chars)`;
  if (now === undefined || now === "") return `- ${rel}: deleted`;
  return `- ${rel}: modified: ${was.length} -> ${now.length} chars`;
}

export function renderRunReport(input: RunReportInput): string {
  const {runId, mode, k, stages, result, task} = input;
  const total = stages.reduce((sum, s) => sum + s.costUsd, 0);
  const outcome = result.ok ? "ok" : "fell back";
  const out: string[] = [
    `# harness² run ${runId}`,
    "",
    `**Task:** ${task}`,
    `**Mode:** ${mode} (k=${k})`,
    `**Outcome:** ${outcome} — ${stages.length} stage(s), ${usd(total)} total`,
    `**Best:** ${result.best ? `${result.best.label} (score ${result.best.score})` : "none"}`,
    "",
    "## Final tree",
    "",
  ];
  if (result.finalTree === null) {
    out.push("No final tree: the run produced nothing to adopt.", "");
  } else {
    for (const rel of Object.keys(result.finalTree).sort()) {
      out.push(`- ${rel}: ${result.finalTree[rel]!.length} chars`);
    }
    out.push("");
  }
  out.push("## Stages", "");
  out.push("| stage | ok | attempts | costUsd | detail |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const s of stages) {
    out.push(
      `| ${cell(s.name)} | ${s.ok ? "yes" : "no"} | ${s.attempts} | ${s.costUsd.toFixed(6)} | ` +
        `${cell(s.detail ?? "")} |`,
    );
  }
  out.push("", "## Fell back", "");
  out.push(
    ...(result.fellBack.length > 0
      ? result.fellBack.map((slot) => `- ${slot}`)
      : ["None — every slot produced usable evidence."]),
    "",
  );
  if (input.baseTree !== undefined && result.finalTree !== null) {
    out.push("## Changed files vs base", "");
    const changed = diffTrees(input.baseTree, result.finalTree);
    const rels = Object.keys(changed).sort();
    if (rels.length === 0) out.push("None — the final tree equals the base.");
    else for (const rel of rels) out.push(changedLine(rel, input.baseTree, result.finalTree));
    out.push("");
  }
  return out.join("\n");
}
