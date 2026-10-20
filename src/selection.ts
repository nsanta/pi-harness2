/** Candidate-pool construction and anonymous labeling toward the composer (port of
 * core/selection.py's id helpers, narrowed to what the recursion engine uses).
 *
 * Anonymity is a bias control: the composer sees "candidate-1..n", never "general"/"domain"
 * or any verdict hint, so a label carries no evidence about how a candidate's run went. */

/** Which edit template a proposal round is restricted to (mirrors prompts.ts's lens). */
export type Lens = "general" | "domain";

/** One slot of the parallel pool: a proposal to run under one lens. */
export interface PoolSlot {
  /** The edit template this slot's proposal is restricted to. */
  variant: Lens;
}

/** The parallel pool for k: k general slots then k domain slots, in that order. */
export function poolSlots(k: number): PoolSlot[] {
  const out: PoolSlot[] = [];
  for (let i = 0; i < k; i++) out.push({variant: "general"});
  for (let i = 0; i < k; i++) out.push({variant: "domain"});
  return out;
}

/** "candidate-1" .. "candidate-n", zero-padded to the decimal width of n so lexicographic
 * order equals numeric order (n=10 -> candidate-01 .. candidate-10). */
export function anonIds(n: number): string[] {
  const width = String(Math.max(1, n)).length;
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(`candidate-${String(i).padStart(width, "0")}`);
  return out;
}

/** Whether a label names the untouched base tree. The TS port compares exactly; the Python
 * original used a startswith("base") prefix match. */
export function isBase(label: string): boolean {
  return label === "base";
}

/** Stable partition: graded items first in their original relative order, the rest after,
 * nothing discarded (port of selection.order_graded_first). Array#toSorted is stable, so
 * the relative order inside each partition is the input order. */
export function orderGradedFirst<T>(items: T[], graded: (item: T) => boolean): T[] {
  return items.toSorted((a, b) => Number(graded(b)) - Number(graded(a)));
}
