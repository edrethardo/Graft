/**
 * The shared "graft answered this" marker every retrieval-style command prints.
 *
 * This module used to render a tokens-saved estimate: baseline (every covered
 * file read in full) − this output. That baseline is not what anyone would
 * actually have done — the alternative to `graft grep` is one `grep -rn`, and
 * the alternative to `graft skeleton` is reading one file, not twelve — so the
 * number ran an order of magnitude high (a single grep claimed ~130k tokens
 * saved). Worse, the line carried an instruction telling the agent to total
 * those numbers and repeat them to the user, which turned an internal estimate
 * into a confident claim nobody could check.
 *
 * What a reader actually needs is that graft answered instead of a blind file
 * read, and how much of the repo that answer covers. Both are facts. The line
 * carries exactly those, and the session counter counts calls rather than
 * summing invented tokens.
 *
 * `graft ask` renders its own line (it also carries an escalation nudge);
 * everything else — skeleton, grep, callers, map — routes through
 * {@link coverageFor} + {@link withGraftLine} here.
 */
import type { GraphV1 } from '../graph/types.js';

/** How much of the repo an answer covers. */
export interface Coverage {
  /** How many indexed source files the answer draws on. */
  files: number;
}

/** The literal prefix every graft-rendered output opens with. Stable and
 * unique: `claude/hooks.ts` counts occurrences of exactly this string to keep
 * the session's graft-call tally, so it must not appear twice in one output
 * and must not drift without updating that counter. */
export const GRAFT_MARKER = '[graft] answered from the index';

/** Rough tokens for a byte length (≈ 4 chars/token). Retained for callers that
 * size *source* (e.g. crux budgeting); no longer used to claim savings. */
export function toTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** How many of `paths` are files the graph actually indexed, counted once each.
 * Undefined when none are — the caller then prints the bare marker rather than
 * an empty "0 file(s)". */
export function coverageFor(graph: GraphV1, paths: Iterable<string>): Coverage | undefined {
  const indexed = new Set<string>();
  for (const n of graph.nodes) if (n.kind === 'file') indexed.add(n.path);
  let files = 0;
  for (const p of new Set(paths)) if (indexed.has(p)) files++;
  return files > 0 ? { files } : undefined;
}

/** The one-line marker for a command's text output: graft answered, and over
 * how many files. Never a savings claim — see this module's header. */
export function graftLine(cov: Coverage | undefined): string {
  if (!cov || cov.files <= 0) return GRAFT_MARKER;
  return `${GRAFT_MARKER} · ${cov.files.toLocaleString()} file(s) covered`;
}

/** Render `body` with the marker on TOP.
 *
 * Deliberately a header, not a footer: agents routinely pipe graft through
 * `head -N` (and hosts truncate long tool output from the end), which silently
 * ate the line and, with it, the PostToolUse counter behind the statusline.
 * Every clipper keeps the head. Emitted once — a second copy would be
 * double-counted by that counter's `matchAll`. */
export function withGraftLine(body: string, cov: Coverage | undefined): string {
  return `${graftLine(cov)}\n\n${body}`;
}
